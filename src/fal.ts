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
  /** Image ou vidéo : déduit de la réponse, sert à choisir sendPhoto ou sendVideo. */
  mediaKind?: "image" | "video";
  /** Dimensions, durée (s) et taille quand le fournisseur les communique :
   *  Telegram en a besoin pour afficher la vidéo au bon format. */
  width?: number;
  height?: number;
  duration?: number;
  fileSize?: number;
  /** Coût réel en USD si le fournisseur le communique (TopView : crédits débités). */
  actualUsd?: number | null;
  raw: unknown;
}

export async function getResult(endpoint: string, requestId: string): Promise<VideoResult> {
  const res = await fal.queue.result(endpoint, { requestId });
  type Media = { url?: string; width?: number; height?: number; duration?: number; file_size?: number };
  const data = res.data as
    | { video?: Media; videos?: Media[]; images?: Media[]; expanded_prompt?: string | null }
    | undefined;
  const media = data?.video ?? data?.videos?.[0] ?? data?.images?.[0];
  const url = media?.url;
  if (!url) {
    throw new Error(`Réponse fal sans URL vidéo : ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  // Plusieurs modèles réécrivent le prompt avant génération et renvoient le
  // texte réellement utilisé. C'est la seule façon de voir ce que le
  // réécrivain a fait d'une formulation réaliste travaillée.
  return {
    videoUrl: url,
    mediaKind: data?.images ? "image" : "video",
    width: media?.width,
    height: media?.height,
    duration: media?.duration != null ? Math.round(Number(media.duration)) : undefined,
    fileSize: media?.file_size,
    expandedPrompt: data?.expanded_prompt ?? null,
    raw: res.data,
  };
}

export async function cancelRequest(endpoint: string, requestId: string): Promise<void> {
  await fal.queue.cancel(endpoint, { requestId });
}

/** Message d'erreur lisible pour l'utilisateur. */
export function describeFalError(err: unknown, kind: "image" | "video" = "video"): string {
  const hay = (() => {
    try {
      if (err instanceof ValidationError) return JSON.stringify(err.fieldErrors) + " " + err.message;
      if (err instanceof ApiError) return (typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? {})) + " " + err.message;
      return err instanceof Error ? err.message : String(err);
    } catch {
      return String(err);
    }
  })();
  // Deux refus différents se cachent derrière content_policy_violation :
  //  - le filtre « personne réelle » de ByteDance (partner_validation_failed,
  //    « likenesses of real people ») qui traverse fal tel quel ;
  //  - la modération générique du modèle (« flagged by a content checker »),
  //    sans motif — le 2026-09-05, Nano Banana, GPT Image et FLUX ont tous
  //    refusé un « remplace la femme de cette photo par celle du selfie ».
  if (/likenesses of real people|may contain real person|partner_validation_failed/i.test(hay)) {
    return (
      "Le fournisseur du modèle a refusé l'image d'entrée : son filtre y voit une personne réelle, " +
      "et un mannequin IA réaliste le déclenche aussi. Aucun réglage ne le lève. " +
      (kind === "video"
        ? "Pour animer cette image : Seedance via TopView, Wan 3.0, Kling 3.0, H3 Max, Grok ou Veo."
        : "Pour cette image : un autre modèle d'édition, ou Seedream via TopView.")
    );
  }
  if (/content_policy_violation|content checker/i.test(hay)) {
    return (
      "Refusé par le filtre de contenu du modèle — fal ne donne pas le motif (« flagged by a content checker »). " +
      (kind === "image"
        ? "Cause la plus fréquente : demander de REMPLACER une personne dans une photo existante ou d'échanger un visage — " +
          "Google, OpenAI et Black Forest Labs refusent ce type de requête. Ce qui passe : générer la scène à neuf avec les " +
          "références du mannequin (décrire le décor et la pose), sans photo à modifier. Les politiques diffèrent d'un modèle " +
          "à l'autre : un autre concurrent du duel a pu accepter."
        : "Causes fréquentes : personnage public ou marque reconnaissable, nudité, mineur, violence, ou une formulation " +
          "ambiguë. Reformule sans ces éléments, ou essaie un autre modèle du catalogue.")
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
