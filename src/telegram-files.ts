import type { Context } from "grammy";
import { config } from "./config.js";

export interface DownloadedImage {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  fileId: string;
}

const MAX_BYTES = 20 * 1024 * 1024; // limite Bot API pour getFile

/** Récupère l'image d'un message Telegram (photo ou document image). */
export async function downloadImageFromMessage(ctx: Context): Promise<DownloadedImage | null> {
  const msg = ctx.message;
  if (!msg) return null;

  let fileId: string | undefined;
  let mimeType = "image/jpeg";
  let filename = "image.jpg";

  if (msg.photo?.length) {
    // La dernière taille est la plus grande
    fileId = msg.photo[msg.photo.length - 1]!.file_id;
  } else if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    fileId = msg.document.file_id;
    mimeType = msg.document.mime_type;
    filename = msg.document.file_name ?? `image.${mimeType.split("/")[1] ?? "jpg"}`;
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      throw new Error("Image trop lourde (max 20 Mo via Telegram).");
    }
  }
  if (!fileId) return null;

  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram n'a pas renvoyé de chemin de fichier.");

  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement Telegram impossible (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());

  return { bytes, mimeType, filename, fileId };
}
