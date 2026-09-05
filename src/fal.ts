import { createFalClient, ApiError, ValidationError, type QueueStatus } from "@fal-ai/client";
import { config } from "./config.js";

export const fal = createFalClient({ credentials: config.FAL_KEY });

/** Envoie une image dans le stockage fal et renvoie son URL publique. */
export async function uploadImage(bytes: Buffer, mimeType: string, filename: string): Promise<string> {
  const file = new File([new Uint8Array(bytes)], filename, { type: mimeType });
  return fal.storage.upload(file);
}

export async function submitVideo(endpoint: string, input: Record<string, unknown>): Promise<string> {
  const res = await fal.queue.submit(endpoint, { input });
  return res.request_id;
}

export async function getStatus(endpoint: string, requestId: string): Promise<QueueStatus> {
  return fal.queue.status(endpoint, { requestId, logs: false });
}

export interface VideoResult {
  /** Prompt après réécriture par le modèle, si communiqué. */
  expandedPrompt?: string | null;
  videoUrl: string;
  /** Coût réel en USD si le fournisseur le communique (TopView : crédits débités). */
  actualUsd?: number | null;
  raw: unknown;
}

export async function getResult(endpoint: string, requestId: string): Promise<VideoResult> {
  const res = await fal.queue.result(endpoint, { requestId });
  const data = res.data as
    | { video?: { url?: string }; videos?: Array<{ url?: string }>; expanded_prompt?: string | null }
    | undefined;
  const url = data?.video?.url ?? data?.videos?.[0]?.url;
  if (!url) {
    throw new Error(`Réponse fal sans URL vidéo : ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  // Plusieurs modèles réécrivent le prompt avant génération et renvoient le
  // texte réellement utilisé. C'est la seule façon de voir ce que le
  // réécrivain a fait d'une formulation réaliste travaillée.
  return { videoUrl: url, expandedPrompt: data?.expanded_prompt ?? null, raw: res.data };
}

export async function cancelRequest(endpoint: string, requestId: string): Promise<void> {
  await fal.queue.cancel(endpoint, { requestId });
}

/** Message d'erreur lisible pour l'utilisateur. */
export function describeFalError(err: unknown): string {
  // Le refus « personne réelle » de Seedance traverse fal tel quel
  // (content_policy_violation / partner_validation_failed) : le traduire
  // en clair vaut mieux qu'un « paramètres refusés » trompeur.
  const hay = (() => {
    try {
      if (err instanceof ValidationError) return JSON.stringify(err.fieldErrors) + " " + err.message;
      if (err instanceof ApiError) return (typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? {})) + " " + err.message;
      return err instanceof Error ? err.message : String(err);
    } catch {
      return String(err);
    }
  })();
  if (/content_policy_violation|likenesses of real people|may contain real person/i.test(hay)) {
    return (
      "Le fournisseur du modèle a refusé l'image d'entrée : son filtre y voit une personne réelle, " +
      "et un mannequin IA réaliste le déclenche aussi. Aucun réglage ne le lève. " +
      "Pour animer cette image : Wan 3.0, Kling 3.0, H3 Max ou Veo."
    );
  }
  if (err instanceof ValidationError) {
    const details = err.fieldErrors.map((e) => `${e.loc.join(".")}: ${e.msg}`).join(" ; ");
    return `Paramètres refusés par fal.ai (${details || err.message})`;
  }
  if (err instanceof ApiError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? {});
    return `Erreur fal.ai ${err.status} : ${body.slice(0, 300)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
