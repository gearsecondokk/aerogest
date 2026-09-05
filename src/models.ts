/**
 * Registre des modèles image → vidéo disponibles sur fal.ai.
 *
 * Les prix sont ceux affichés sur les pages fal.ai des modèles (septembre 2026).
 * Ils servent à l'estimation locale ; le tarif "live" est aussi interrogé
 * via l'API pricing de fal (voir pricing.ts) pour affichage.
 */

export type OptionValue = string | boolean;

export interface ModelOptionChoice {
  value: OptionValue;
  label: string;
}

export interface ModelOption {
  key: string;
  /** Question posée à l'utilisateur */
  label: string;
  choices: ModelOptionChoice[];
  default: OptionValue;
}

export type Options = Record<string, OptionValue>;

export interface VideoModel {
  /** Identifiant court utilisé dans les callbacks Telegram (max ~20 chars) */
  id: string;
  /** Endpoint fal.ai */
  endpoint: string;
  name: string;
  /** Une ligne : pour la liste des modèles */
  tagline: string;
  /** Résumé du tarif pour l'utilisateur */
  priceSummary: string;
  options: ModelOption[];
  /** Conseils de prompting spécifiques, donnés à Claude */
  promptGuide: string;
  maxPromptChars?: number;
  /** Durée facturée (secondes) pour ces options */
  billedSeconds: (opts: Options) => number;
  /** Estimation locale en USD */
  estimateUsd: (opts: Options) => number;
  /** Construit le payload d'entrée fal.ai */
  buildInput: (args: {
    imageUrl: string;
    prompt: string;
    negativePrompt?: string | null;
    opts: Options;
  }) => Record<string, unknown>;
}

const num = (v: OptionValue | undefined, fallback: number): number => {
  if (typeof v === "boolean" || v === undefined) return fallback;
  const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

const durationOption = (values: number[], def: number): ModelOption => ({
  key: "duration",
  label: "⏱ Durée de la vidéo ?",
  choices: values.map((v) => ({ value: String(v), label: `${v} s` })),
  default: String(def),
});

export const MODELS: VideoModel[] = [
  {
    id: "kling25",
    endpoint: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    name: "Kling 2.5 Turbo Pro",
    tagline: "Excellent rapport qualité/prix, mouvements naturels, 5 ou 10 s",
    priceSummary: "0,07 $/s → 5 s = 0,35 $ · 10 s = 0,70 $",
    options: [durationOption([5, 10], 5)],
    promptGuide:
      "Kling 2.5 Turbo Pro. Write 1-3 sentences in English: subject + precise motion + camera movement (slow push-in, orbit, handheld…) + atmosphere/lighting. " +
      "Keep the subject consistent with the image (do not describe a different scene). Avoid contradictory or too many simultaneous motions. " +
      "A negative_prompt is supported (default: 'blur, distort, and low quality'). No audio.",
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => num(o.duration, 5) * 0.07,
    buildInput: ({ imageUrl, prompt, negativePrompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: String(num(opts.duration, 5)),
      negative_prompt: negativePrompt || "blur, distort, and low quality",
      cfg_scale: 0.5,
    }),
  },
  {
    id: "veo31",
    endpoint: "fal-ai/veo3.1/image-to-video",
    name: "Google Veo 3.1",
    tagline: "Haut de gamme, génère aussi le son (ambiance, dialogues)",
    priceSummary: "0,20 $/s sans audio · 0,40 $/s avec audio (720p/1080p) · 4K : 0,40/0,60 $/s",
    options: [
      {
        key: "duration",
        label: "⏱ Durée de la vidéo ?",
        choices: [
          { value: "4s", label: "4 s" },
          { value: "6s", label: "6 s" },
          { value: "8s", label: "8 s" },
        ],
        default: "8s",
      },
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
          { value: "4k", label: "4K (plus cher)" },
        ],
        default: "1080p",
      },
      {
        key: "generate_audio",
        label: "🔊 Générer le son ?",
        choices: [
          { value: true, label: "Oui (×2 sur le prix)" },
          { value: false, label: "Non" },
        ],
        default: true,
      },
    ],
    promptGuide:
      "Google Veo 3.1 (image-to-video, native audio). Write a cinematic English prompt: subject, action, camera movement, lighting, mood. " +
      "If audio is enabled, describe ambient sound / SFX and put any dialogue in quotes with the speaker (e.g. The woman says: \"...\"). " +
      "Mention 'no subtitles' if dialogue is present. Keep the first frame consistent with the image.",
    billedSeconds: (o) => num(o.duration, 8),
    estimateUsd: (o) => {
      const sec = num(o.duration, 8);
      const audio = o.generate_audio !== false;
      const is4k = o.resolution === "4k";
      const rate = is4k ? (audio ? 0.6 : 0.4) : audio ? 0.4 : 0.2;
      return sec * rate;
    },
    buildInput: ({ imageUrl, prompt, negativePrompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: String(opts.duration ?? "8s"),
      resolution: String(opts.resolution ?? "1080p"),
      generate_audio: opts.generate_audio !== false,
      aspect_ratio: "auto",
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  },
  {
    id: "hailuo02s",
    endpoint: "fal-ai/minimax/hailuo-02/standard/image-to-video",
    name: "MiniMax Hailuo 02 Standard",
    tagline: "Le moins cher, bons mouvements de caméra, 6 ou 10 s",
    priceSummary: "768p : 0,045 $/s (6 s = 0,27 $) · 512p : 0,017 $/s",
    options: [
      durationOption([6, 10], 6),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "768P", label: "768p" },
          { value: "512P", label: "512p (économique)" },
        ],
        default: "768P",
      },
    ],
    promptGuide:
      "MiniMax Hailuo 02. Concise English prompt focused on ONE main motion plus the camera. " +
      "Camera instructions can be given in brackets, e.g. [Push in], [Pan left], [Tracking shot], [Zoom out], [Static shot]. " +
      "The model's prompt optimizer is enabled, so keep it clear and short (1-2 sentences). No audio.",
    billedSeconds: (o) => num(o.duration, 6),
    estimateUsd: (o) => num(o.duration, 6) * (o.resolution === "512P" ? 0.017 : 0.045),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: String(num(opts.duration, 6)),
      resolution: String(opts.resolution ?? "768P"),
      prompt_optimizer: true,
    }),
  },
  {
    id: "hailuo02p",
    endpoint: "fal-ai/minimax/hailuo-02/pro/image-to-video",
    name: "MiniMax Hailuo 02 Pro (1080p)",
    tagline: "Version Pro en 1080p, 6 s",
    priceSummary: "0,08 $/s → 6 s = 0,48 $",
    options: [],
    promptGuide:
      "MiniMax Hailuo 02 Pro (1080p, 6 seconds). Concise English prompt focused on ONE main motion plus the camera. " +
      "Camera instructions can be given in brackets, e.g. [Push in], [Pan left], [Tracking shot]. Prompt optimizer enabled. No audio.",
    billedSeconds: () => 6,
    estimateUsd: () => 6 * 0.08,
    buildInput: ({ imageUrl, prompt }) => ({
      prompt,
      image_url: imageUrl,
      prompt_optimizer: true,
    }),
  },
  {
    id: "wan25",
    endpoint: "fal-ai/wan-25-preview/image-to-video",
    name: "Wan 2.5",
    tagline: "Bon marché, jusqu'à 1080p, 5 ou 10 s",
    priceSummary: "480p : 0,05 $/s · 720p : 0,10 $/s · 1080p : 0,15 $/s",
    options: [
      durationOption([5, 10], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
    ],
    promptGuide:
      "Wan 2.5 (image-to-video). English prompt up to 1500 characters describing the motion of the subject, the camera movement and the mood. " +
      "Prompt expansion is enabled on the model side, so stay natural and specific. A negative_prompt (max 500 chars) is supported.",
    maxPromptChars: 1500,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      const rate = o.resolution === "1080p" ? 0.15 : o.resolution === "480p" ? 0.05 : 0.1;
      return num(o.duration, 5) * rate;
    },
    buildInput: ({ imageUrl, prompt, negativePrompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: String(num(opts.duration, 5)),
      resolution: String(opts.resolution ?? "720p"),
      enable_prompt_expansion: true,
      ...(negativePrompt ? { negative_prompt: negativePrompt.slice(0, 500) } : {}),
    }),
  },
  {
    id: "seedance1p",
    endpoint: "fal-ai/bytedance/seedance/v1/pro/image-to-video",
    name: "ByteDance Seedance 1.0 Pro",
    tagline: "Très bon en narration multi-plans, 2 à 12 s",
    priceSummary: "≈ 2,5 $ / million de tokens vidéo → 1080p 5 s ≈ 0,62 $ · 720p 5 s ≈ 0,27 $",
    options: [
      durationOption([3, 5, 8, 10, 12], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "1080p",
      },
    ],
    promptGuide:
      "ByteDance Seedance 1.0 Pro. English prompt describing action, camera and style; it handles multi-shot narration well " +
      "(you can describe 2-3 consecutive shots for longer durations). Keep the first shot consistent with the image. No audio.",
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      // tokens = (h × w × fps × durée) / 1024 ; 2,5 $ par million de tokens ; fps 24 ; dimensions 16:9
      const dims: Record<string, [number, number]> = {
        "480p": [864, 480],
        "720p": [1280, 720],
        "1080p": [1920, 1080],
      };
      const [w, h] = dims[String(opts(o))] ?? dims["1080p"];
      const tokens = (h * w * 24 * num(o.duration, 5)) / 1024;
      return (tokens / 1_000_000) * 2.5;
    },
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: String(num(opts.duration, 5)),
      resolution: String(opts.resolution ?? "1080p"),
      aspect_ratio: "auto",
    }),
  },
];

function opts(o: Options): OptionValue {
  return o.resolution ?? "1080p";
}

export function getModel(id: string): VideoModel | undefined {
  return MODELS.find((m) => m.id === id);
}

export function defaultOptions(model: VideoModel): Options {
  const out: Options = {};
  for (const opt of model.options) out[opt.key] = opt.default;
  return out;
}

export function describeOptions(model: VideoModel, options: Options): string {
  const parts: string[] = [];
  for (const opt of model.options) {
    const value = options[opt.key];
    const choice = opt.choices.find((c) => c.value === value);
    const label = opt.label.replace(/^[^\w]*|\s*\?$/g, "").trim();
    parts.push(`${label} : ${choice?.label ?? String(value)}`);
  }
  return parts.join(" · ");
}
