/**
 * Adaptateur TopView (api.topview.ai) — troisième route vers Seedance.
 *
 * Pourquoi : BytePlus, en direct comme via fal, refuse toute image d'entrée où
 * son filtre voit une personne réelle — mannequins IA compris. TopView accepte
 * ces mêmes images : vérifié le 2026-09-05 avec Seedance 2.0 et 2.5, identité
 * du personnage préservée. On le paie un peu plus cher que le direct (≈ 1,3 à
 * 1,5 $ la vidéo 720p de 5 s contre 1,16 $) et 3 à 4 minutes de génération.
 *
 * Particularités mesurées :
 *  - la clé du compte gratuit suffit pour l'API ; l'Uid se lit sur
 *    GET /user/credit/detail quand il n'est pas dans le .env ;
 *  - les images passent par leur stockage : credential → PUT S3 → check → fileId ;
 *  - en image→vidéo, NE PAS envoyer aspectRatio (code 4000 : le format vient de
 *    l'image) ;
 *  - la sortie est ré-encodée en h264 (manifeste C2PA effacé) et servie par une
 *    URL CloudFront signée à durée de vie limitée : on l'envoie tout de suite.
 *
 * L'interface est calquée sur byteplus.ts pour que jobs.ts ne fasse aucune
 * différence entre les fournisseurs.
 */

import { config } from "./config.js";
import type { VideoResult } from "./fal.js";

const BASE = "https://api.topview.ai";

function key(): string {
  if (!config.TOPVIEW_API_KEY) {
    throw new Error("TOPVIEW_API_KEY absente du .env — les modèles TopView sont indisponibles.");
  }
  return config.TOPVIEW_API_KEY;
}

let cachedUid: string | null = config.TOPVIEW_UID ?? null;

async function fetchUid(): Promise<string> {
  const res = await fetch(`${BASE}/user/credit/detail`, {
    headers: { Authorization: `Bearer ${key()}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  const uid = body?.result?.uid;
  if (!uid) throw new Error(`TopView : Uid illisible (HTTP ${res.status}) — renseigne TOPVIEW_UID dans le .env.`);
  return String(uid);
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!cachedUid) cachedUid = await fetchUid();
  return { Authorization: `Bearer ${key()}`, "Topview-Uid": cachedUid };
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(await authHeaders()), "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`TopView HTTP ${res.status} : ${text.slice(0, 300)}`);
  // TopView répond HTTP 200 même en erreur : le vrai statut est dans `code`.
  if (String(body?.code ?? "200") !== "200") {
    throw new Error(`TopView ${body.code} : ${body.message ?? text.slice(0, 300)}`);
  }
  return body;
}

/** URL source → fileId TopView. Une même image de référence sert à tous les
 *  concurrents d'un duel : inutile de l'uploader à chaque fois. */
const fileIds = new Map<string, string>();

async function uploadFromUrl(url: string): Promise<string> {
  const hit = fileIds.get(url);
  if (hit) return hit;

  const src = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!src.ok) throw new Error(`TopView : image source inaccessible (HTTP ${src.status}) ${url}`);
  const bytes = Buffer.from(await src.arrayBuffer());
  const ct = src.headers.get("content-type") ?? "";
  const fromUrl = url.match(/\.(png|webp|jpe?g)(\?|$)/i)?.[1]?.toLowerCase() ?? "jpg";
  const format = /png/.test(ct) ? "png" : /webp/.test(ct) ? "webp" : /jpe?g/.test(ct) ? "jpg" : fromUrl.replace("jpeg", "jpg");

  const cred = await call(`/v1/upload/credential?format=${format}&needAccelerateUrl=false`, { method: "GET" });
  const fileId = cred?.result?.fileId;
  const uploadUrl = cred?.result?.uploadUrl;
  if (!fileId || !uploadUrl) throw new Error(`TopView : credential d'upload incomplet ${JSON.stringify(cred).slice(0, 200)}`);

  // URL présignée S3 (seul `host` est signé) : un PUT nu suffit.
  const put = await fetch(uploadUrl, { method: "PUT", body: bytes, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new Error(`TopView : upload S3 refusé (HTTP ${put.status})`);

  const check = await call(`/v1/upload/check?fileId=${encodeURIComponent(fileId)}`, { method: "GET" });
  if (check?.result !== true) throw new Error(`TopView : fichier non confirmé après upload (${JSON.stringify(check?.result)})`);

  fileIds.set(url, String(fileId));
  return String(fileId);
}

/**
 * `model` est le nom affiché par TopView ("Seedance 2.5", "Seedance 2.0"…).
 * `input` vient de models.ts : { mode: "i2v" | "r2v", imageUrls, prompt,
 * resolution (480|720|1080), duration, sound ("on"|"off"), aspectRatio? }.
 */
export async function submitVideo(model: string, input: Record<string, unknown>): Promise<string> {
  const urls = (input.imageUrls as string[] | undefined) ?? [];
  if (urls.length === 0) throw new Error("TopView : aucune image fournie.");
  const ids: string[] = [];
  for (const u of urls) ids.push(await uploadFromUrl(u));

  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    resolution: input.resolution,
    duration: input.duration,
    sound: input.sound ?? "off",
    generatingCount: 1,
  };
  if (input.mode === "r2v") {
    body.referenceImageFileIds = ids;
    if (input.aspectRatio) body.aspectRatio = input.aspectRatio;
  } else {
    body.firstFrameFileId = ids[0];
  }

  let res: any;
  try {
    res = await call("/v2/common_task/image2video/task/submit", { method: "POST", body: JSON.stringify(body) });
  } catch (err) {
    // En référence le format n'est pas déductible d'une seule image ; si TopView
    // refuse quand même aspectRatio, on le retire et on réessaie une fois.
    if (body.aspectRatio && /aspectRatio/i.test(String(err))) {
      delete body.aspectRatio;
      res = await call("/v2/common_task/image2video/task/submit", { method: "POST", body: JSON.stringify(body) });
    } else {
      throw err;
    }
  }
  const taskId = res?.result?.taskId;
  if (!taskId) throw new Error(`TopView n'a pas renvoyé de taskId : ${JSON.stringify(res).slice(0, 200)}`);
  return String(taskId);
}

async function query(taskId: string): Promise<any> {
  return call(`/v2/common_task/image2video/task/query?taskId=${encodeURIComponent(taskId)}&needCloudFrontUrl=true`, { method: "GET" });
}

/** Statut traduit dans le vocabulaire de fal, pour que jobs.ts reste inchangé. */
export async function getStatus(_model: string, taskId: string): Promise<{ status: string; queue_position?: number }> {
  const body = await query(taskId);
  const s = String(body?.result?.status ?? "").toLowerCase();
  if (s === "init") return { status: "IN_QUEUE", queue_position: 0 };
  if (s === "running") return { status: "IN_PROGRESS" };
  return { status: "COMPLETED" }; // success / fail : traités au résultat
}

export async function getResult(_model: string, taskId: string): Promise<VideoResult> {
  const body = await query(taskId);
  const r = body?.result ?? {};
  const status = String(r.status ?? "").toLowerCase();
  if (status !== "success") {
    const videoErr = Array.isArray(r.videos) ? r.videos.find((v: any) => v?.errorMsg)?.errorMsg : undefined;
    throw new Error(`Tâche TopView ${status || "?"} : ${r.errorMsg ?? videoErr ?? "sans message"}`);
  }
  const url = r.videos?.[0]?.filePath;
  if (!url) throw new Error(`Réponse TopView sans URL vidéo : ${JSON.stringify(body).slice(0, 300)}`);
  const credits = typeof r.costCredit === "number" ? r.costCredit : null;
  return {
    videoUrl: String(url),
    expandedPrompt: null,
    actualUsd: credits != null ? Number((credits * config.TOPVIEW_USD_PER_CREDIT).toFixed(4)) : null,
    raw: body,
  };
}

export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient|not enough|credit/i.test(msg) && !/credential/i.test(msg)) {
    return `TopView : crédits insuffisants — recharge le compte (Buy Credits) puis relance. (${msg})`;
  }
  return msg;
}
