/**
 * Résumé des réglages d'un job, lisible par l'agent. Il en a besoin pour
 * « refaire la même » : le 2026-09-05 l'utilisateur a payé 4,48 $ au lieu de
 * 2,99 $ parce que l'agent était reparti sur les 15 s de la demande initiale
 * alors que la vidéo qu'il avait vue — et validée — faisait 10 s.
 */
import { getModel } from "./models.js";
import { formatUsd } from "./pricing.js";
import type { Job } from "./store.js";

export function describeJobSettings(job: Job): string {
  const inp = job.input ?? {};
  const model = getModel(job.modelId);
  const parts: string[] = [`model_id=${job.modelId}${model ? ` (${model.name})` : ""}`];
  const mode = inp.task === "omni" || inp.mode === "r2v" || inp.reference_image_urls || inp.omni_reference_task_type
    ? "référence→vidéo"
    : inp.task === "t2i" ? "texte→image" : inp.task === "i2i" || (job.mediaKind === "image" && inp.image_urls) ? "édition d'après références"
    : job.mediaKind === "image" ? "texte→image" : "image→vidéo";
  parts.push(`mode=${mode}`);
  if (inp.duration != null) parts.push(`duration=${inp.duration}`);
  if (inp.resolution != null) parts.push(`resolution=${inp.resolution}`);
  const ratio = inp.aspect_ratio ?? inp.aspectRatio ?? inp.ratio;
  if (ratio != null) parts.push(`aspect_ratio=${ratio}`);
  const audio = inp.generate_audio ?? inp.audio ?? inp.sound;
  if (audio != null) parts.push(`audio=${audio}`);
  if (inp.quality != null) parts.push(`quality=${inp.quality}`);
  const refs = (inp.reference_image_urls ?? inp.imageUrls ?? inp.image_urls) as unknown[] | undefined;
  if (Array.isArray(refs)) parts.push(`${refs.length} image(s) en entrée`);
  parts.push(`coût ${formatUsd(job.actualUsd ?? job.estimateUsd)}${job.actualUsd != null ? " réel" : " estimé"}`);
  return parts.join(", ");
}
