/**
 * Adaptateur BytePlus ModelArk (API directe, sans passer par fal).
 *
 * Pourquoi : fal facture Seedance 2.5 exactement le DOUBLE du tarif BytePlus
 * (21,40 $ contre 10,70 $ par million de tokens). Et BytePlus expose des
 * paliers que fal ne revend pas — Seedance 2.0 mini et fast, en promotion,
 * jusqu'à quinze fois moins chers que la 2.5.
 *
 * L'interface est calquée sur celle de fal.ts pour que jobs.ts ne fasse aucune
 * différence entre les deux fournisseurs.
 *
 * Les images continuent d'être hébergées par le stockage fal : BytePlus accepte
 * n'importe quelle URL publique, inutile de monter un second hébergement.
 */

import { config } from "./config.js";
import type { VideoResult } from "./fal.js";

const BASE = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

function key(): string {
  if (!config.BYTEPLUS_API_KEY) {
    throw new Error("BYTEPLUS_API_KEY absente du .env — les modèles BytePlus sont indisponibles.");
  }
  return config.BYTEPLUS_API_KEY;
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.error?.message ?? body?.message ?? text.slice(0, 300);
    throw new Error(`BytePlus ${res.status} : ${detail}`);
  }
  return body;
}

/** Crée la tâche et renvoie son id (format "cgt-…"). */
export async function submitVideo(model: string, input: Record<string, unknown>): Promise<string> {
  const body = await call("", { method: "POST", body: JSON.stringify({ model, ...input }) });
  if (!body?.id) throw new Error(`BytePlus n'a pas renvoyé d'id de tâche : ${JSON.stringify(body).slice(0, 200)}`);
  return String(body.id);
}

/** Statut traduit dans le vocabulaire de fal, pour que jobs.ts reste inchangé. */
export async function getStatus(_model: string, taskId: string): Promise<{ status: string; queue_position?: number }> {
  const body = await call(`/${encodeURIComponent(taskId)}`, { method: "GET" });
  const s = String(body?.status ?? "").toLowerCase();
  if (s === "queued") return { status: "IN_QUEUE", queue_position: 0 };
  if (s === "running") return { status: "IN_PROGRESS" };
  return { status: "COMPLETED" }; // succeeded / failed / cancelled : traités au résultat
}

export async function getResult(_model: string, taskId: string): Promise<VideoResult> {
  const body = await call(`/${encodeURIComponent(taskId)}`, { method: "GET" });
  const status = String(body?.status ?? "").toLowerCase();
  if (status !== "succeeded") {
    const err = body?.error?.message ?? body?.error?.code ?? (status || "statut inconnu");
    throw new Error(`Tâche BytePlus ${status || "?"} : ${err}`);
  }
  const url = body?.content?.video_url;
  if (!url) throw new Error(`Réponse BytePlus sans URL vidéo : ${JSON.stringify(body).slice(0, 300)}`);
  return { videoUrl: String(url), expandedPrompt: null, raw: body };
}

/** Nombre de tokens réellement facturés, disponible une fois la tâche finie. */
export function usedTokens(raw: unknown): number | null {
  const u = (raw as any)?.usage;
  const n = u?.total_tokens ?? u?.completion_tokens;
  return typeof n === "number" ? n : null;
}

/** Pixels par palier de résolution (16:9 ; l'aire est identique en 9:16). */
const PIXELS: Record<string, number> = { "480p": 854 * 480, "720p": 1280 * 720, "1080p": 1920 * 1080 };

/**
 * Tokens consommés par seconde de vidéo.
 * Formule officielle : (hauteur × largeur × durée × 24) / 1024.
 * Vérifiée contre les chiffres publiés : 720p en Seedance 2.5 donne
 * 21 600 tokens/s × 10,70 $/M = 0,231 $/s, ce qu'annonce BytePlus.
 */
export function tokensPerSecond(resolution: string): number {
  return ((PIXELS[resolution] ?? PIXELS["720p"]) * 24) / 1024;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
