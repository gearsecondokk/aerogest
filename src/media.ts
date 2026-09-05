/**
 * Livraison vidéo robuste vers Telegram.
 *
 * Constat du 2026-09-05 : Kling (23 Mo) et Wan (22 Mo) dépassaient la limite
 * de 20 Mo de l'envoi par URL ; on basculait en upload SANS largeur/hauteur,
 * et Telegram affichait la vidéo aplatie. Grok et TopView (11-15 Mo) passaient
 * par URL, Telegram lisait le fichier lui-même, et tout allait bien.
 *
 * Règles : toujours fournir width/height/duration (du résultat du fournisseur,
 * sinon d'un ffprobe sur l'URL — les fichiers sont en faststart, quelques
 * centaines de Ko suffisent), joindre une vignette au bon format, et ne pas
 * tenter l'URL au-delà de 20 Mo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InputFile, type Api } from "grammy";

const run = promisify(execFile);

export interface VideoMeta {
  width?: number;
  height?: number;
  /** Durée en secondes (entières, comme l'attend Telegram). */
  duration?: number;
  fileSize?: number;
}

/** Au-dessus, Telegram refuse de télécharger l'URL lui-même. */
const URL_LIMIT = 20 * 1024 * 1024;

export async function probeVideo(url: string): Promise<VideoMeta> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration,size", "-of", "json", url],
      { timeout: 30_000 },
    );
    const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string; size?: string } };
    const s = j.streams?.[0] ?? {};
    const f = j.format ?? {};
    return {
      width: s.width,
      height: s.height,
      duration: f.duration ? Math.round(Number(f.duration)) : undefined,
      fileSize: f.size ? Number(f.size) : undefined,
    };
  } catch (err) {
    console.warn("ffprobe indisponible ou en échec :", err instanceof Error ? err.message : err);
    return {};
  }
}

/** Première image en JPEG ≤ 320 px de côté : Telegram s'en sert pour cadrer
 *  la bulle avant même que la vidéo soit chargée. */
export async function videoThumbnail(url: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run(
      "ffmpeg",
      ["-v", "error", "-ss", "0.5", "-i", url, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
      { timeout: 45_000, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
    );
    // Telegram limite la vignette à 200 Ko.
    return stdout.length > 0 && stdout.length < 200 * 1024 ? stdout : null;
  } catch (err) {
    console.warn("vignette impossible :", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Envoie une vidéo avec ses dimensions et une vignette. Par URL quand Telegram
 * peut la télécharger lui-même, sinon en upload (jusqu'à 50 Mo).
 */
export async function sendVideoSmart(api: Api, chatId: number, url: string, caption: string, meta: VideoMeta, fileName: string): Promise<void> {
  const m: VideoMeta = meta.width && meta.height ? { ...meta } : { ...meta, ...(await probeVideo(url)) };
  const thumb = await videoThumbnail(url);
  const opts = {
    caption,
    parse_mode: "HTML" as const,
    supports_streaming: true,
    width: m.width,
    height: m.height,
    duration: m.duration,
    ...(thumb ? { thumbnail: new InputFile(thumb, "thumb.jpg") } : {}),
  };
  if (!m.fileSize || m.fileSize <= URL_LIMIT) {
    try {
      await api.sendVideo(chatId, url, opts);
      return;
    } catch (err) {
      console.warn(`sendVideo par URL refusé, passage en upload :`, err instanceof Error ? err.message : err);
    }
  }
  await api.sendVideo(chatId, new InputFile(new URL(url), fileName), opts);
}
