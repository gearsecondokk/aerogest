/**
 * Registre des modèles image → vidéo disponibles sur fal.ai.
 *
 * Les prix sont ceux affichés sur les pages fal.ai des modèles (septembre 2026).
 * Ils servent à l'estimation locale ; le tarif "live" est aussi interrogé
 * via l'API pricing de fal (voir pricing.ts) pour affichage.
 */

import { config } from "./config.js";

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
  /** Fournisseur d'exécution. Par défaut fal ; 'byteplus' appelle l'API
   *  ModelArk en direct, environ deux fois moins chère sur Seedance ;
   *  'topview' passe par api.topview.ai — la seule route Seedance qui accepte
   *  une image de personne (voir topview.ts). */
  provider?: "fal" | "byteplus" | "topview";
  /** Endpoint fal.ai */
  endpoint: string;
  name: string;
  /** Une ligne : pour la liste des modèles */
  tagline: string;
  /** Résumé du tarif pour l'utilisateur */
  priceSummary: string;
  /** true si le tarif unitaire varie selon les options (résolution, audio…) : le tarif live fal ne suffit pas à estimer */
  rateDependsOnOptions?: boolean;
  options: ModelOption[];
  /** Conseils de prompting spécifiques, donnés à Claude */
  promptGuide: string;
  maxPromptChars?: number;
  /** Durée facturée (secondes) pour ces options */
  billedSeconds: (opts: Options) => number;
  /** Estimation locale en USD (repli documenté, volontairement pessimiste) */
  estimateUsd: (opts: Options) => number;
  /** Rapport entre le palier choisi et le tarif de BASE renvoyé par l'API
   *  fal. Permet de chiffrer à partir du prix réel plutôt que d'une
   *  constante — donc de suivre automatiquement promos et changements de
   *  tarif. À ne définir QUE si le palier de base est identifié avec
   *  certitude, sinon on garde l'estimation documentée. */
  rateMultiplier?: (opts: Options) => number;
  /** Construit le payload d'entrée fal.ai */
  /** true = le modèle attend des images de RÉFÉRENCE (2 à 4 idéalement)
   *  et non une image de départ à animer. */
  needsReferences?: boolean;
  /** Le fournisseur refuse toute image d'ENTRÉE que son classifieur juge être
   *  la photo d'une personne réelle — un mannequin généré par IA assez
   *  réaliste suffit à déclencher le refus.
   *
   *  Mesuré le 2026-09-05 sur les deux mêmes images :
   *    - BytePlus direct, les 3 Seedance, en first_frame ET en
   *      reference_image → InputImageSensitiveContentDetected.PrivacyInformation
   *    - fal, seedance-2.5/reference-to-video → content_policy_violation
   *      (partner_validation_failed) : fal ne fait que relayer le refus
   *    - BytePlus en text-to-video avec un sujet humain → accepté
   *    - fal Wan 3.0 reference-to-video, mêmes images → vidéo produite
   *
   *  Il n'existe pas de réglage d'API ni de whitelist : la doc BytePlus ne
   *  propose que de changer d'image. Ces modèles restent donc bons pour le
   *  texte seul et pour les plans sans personne. */
  refusesHumanInputImages?: boolean;
  buildInput: (args: {
    imageUrl: string;
    imageUrls: string[];
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

/** Format de sortie. Décisif pour TikTok/Reels : en référence→vidéo il n'y a
 *  aucune image de départ dont hériter, donc sans ce réglage on tombe sur du
 *  paysage. Valeurs tirées du schéma OpenAPI de fal, endpoint par endpoint. */
const ratioOption = (values: string[], def: string): ModelOption => ({
  key: "aspect_ratio",
  label: "📐 Format ?",
  choices: values.map((v) => ({
    value: v,
    label: v === "9:16" ? "9:16 (TikTok/Reels)" : v === "adaptive" || v === "auto" ? `${v} (comme l'image)` : v,
  })),
  default: def,
});

const durationOption = (values: number[], def: number): ModelOption => ({
  key: "duration",
  label: "⏱ Durée de la vidéo ?",
  choices: values.map((v) => ({ value: String(v), label: `${v} s` })),
  default: String(def),
});

/** Crédits TopView par seconde de vidéo, par modèle et résolution. 2.5/480p et
 *  2.0/480p mesurés le 2026-09-05 (2,8 et 2,0 crédits pour 4 s) ; le reste vient
 *  de leur guide d'API. La valeur d'un crédit dépend du pack acheté
 *  (TOPVIEW_USD_PER_CREDIT) : relevé le 2026-09-05, 0,30 $ en pack de 100 à 500,
 *  0,199 $ le pack de 1000 réservé aux plans annuels, 0,39 $ le pack de 25. */
const TV_CREDITS_PER_SEC: Record<string, Record<string, number>> = {
  "Seedance 2.5": { "480p": 0.7, "720p": 1.5 },
  "Seedance 2.0": { "480p": 0.5, "720p": 1.0, "1080p": 2.0 },
};
const tvCost = (model: string, o: Options, def = 5): number => {
  const res = String(o.resolution ?? "720p");
  const perSec = TV_CREDITS_PER_SEC[model]?.[res] ?? TV_CREDITS_PER_SEC[model]?.["720p"] ?? 1.5;
  return num(o.duration, def) * perSec * config.TOPVIEW_USD_PER_CREDIT;
};


/* ── Tarification BytePlus ────────────────────────────────────────────
 * Facturation au token, formule officielle :
 *   tokens = (largeur × hauteur × durée × 24) / 1024
 * Vérifiée contre les chiffres publiés : 720p en Seedance 2.5 donne
 * 21 600 tokens/s, soit 0,231 $/s au tarif de 10,70 $/M — exactement ce
 * qu'annonce BytePlus. L'aire étant identique en 16:9 et en 9:16, le format
 * ne change pas le prix.
 */
const BP_PIXELS: Record<string, number> = { "480p": 854 * 480, "720p": 1280 * 720, "1080p": 1920 * 1080 };
const bpTokensPerSec = (res: string) => ((BP_PIXELS[res] ?? BP_PIXELS["720p"]) * 24) / 1024;
/** usdPerMillion peut dépendre du palier (promo 1080p sur la 2.5). */
const bpCost = (o: Options, usdPerMillion: (res: string) => number, def = 5) => {
  const res = String(o.resolution ?? "720p");
  return num(o.duration, def) * bpTokensPerSec(res) * (usdPerMillion(res) / 1_000_000);
};

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
    rateDependsOnOptions: true,
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
    rateDependsOnOptions: true,
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
    rateDependsOnOptions: true,
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
    rateMultiplier: (o) => (o.resolution === "1080p" ? 3 : o.resolution === "480p" ? 1 : 2),
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
    id: "wan3",
    rateDependsOnOptions: true,
    endpoint: "alibaba/wan-3.0/image-to-video",
    name: "Wan 3.0",
    tagline: "Dernier Wan — jusqu'à 1080p, audio inclus, 2 à 30 s",
    priceSummary: "480p : 0,05 $/s · 720p : 0,10 $/s · 1080p : 0,20 $/s (audio inclus)",
    options: [
      ratioOption(["adaptive", "9:16", "16:9", "1:1", "4:3", "3:4"], "adaptive"),
      { key: "rewrite", label: "✍️ Réécriture auto du prompt ?", choices: [{ value: "true", label: "Oui (défaut)" }, { value: "false", label: "Non — garder mon prompt tel quel" }], default: "true" },
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
      { key: "audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Wan 3.0 (image-to-video, audio natif). Structure en 4 blocs DANS CET ORDRE : mouvement du sujet, " +
      "mouvement de caméra, environnement, rythme. Le modèle lit le début du prompt avec le plus d'attention. " +
      "Garder la caméra quasi immobile. ⚠️ le champ image s'appelle start_image_url.",
    maxPromptChars: 8000, // limite officielle 20 000 ; on plafonne bien en dessous
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      const rate = o.resolution === "1080p" ? 0.2 : o.resolution === "480p" ? 0.05 : 0.1;
      return num(o.duration, 5) * rate;
    },
    rateMultiplier: (o) => (o.resolution === "1080p" ? 4 : o.resolution === "480p" ? 1 : 2),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      // ⚠️ Wan 3.0 attend start_image_url et NON image_url (vérifié via l'erreur
      // de validation de l'API fal : "start_image_url Field required").
      start_image_url: imageUrl,
      duration: num(opts.duration, 5),
      resolution: String(opts.resolution ?? "720p"),
      aspect_ratio: String(opts.aspect_ratio ?? "adaptive"),
      audio: String(opts.audio ?? "true") === "true",
      // Le réécrivain de prompt est activé par défaut chez Alibaba et peut
      // défaire une formulation réaliste travaillée. On le rend débrayable.
      enable_prompt_expansion: String(opts.rewrite ?? "true") === "true",
    }),
  },
  {
    id: "h3max",
    rateDependsOnOptions: true,
    endpoint: "minimax/h3-max/image-to-video",
    name: "MiniMax H3 Max",
    tagline: "Hailuo 3 Max — 5 à 15 s, audio inclus, très bon rapport qualité/prix",
    priceSummary: "480p : 0,05 $/s · 768p : 0,08 $/s (audio inclus)",
    options: [
      { key: "expansion", label: "✍️ Réécriture du prompt ?", choices: [{ value: "balanced", label: "Rapide (~1 s)" }, { value: "quality", label: "Soignée (~30 s)" }], default: "balanced" },
      durationOption([5, 10, 15], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "768p", label: "768p" },
        ],
        default: "768p",
      },
    ],
    promptGuide:
      "MiniMax H3 Max (image-to-video, audio natif). Trois blocs : sujet+action, direction caméra, ambiance. " +
      "UNE SEULE instruction de caméra dominante (plan fixe OU lent travelling) — empiler les mouvements est " +
      "la première cause d'échec. Écrire la caméra en langage de tournage naturel. Préciser ce qui reste STABLE.",
    maxPromptChars: 1500,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => num(o.duration, 5) * (o.resolution === "480p" ? 0.05 : 0.08),
    rateMultiplier: (o) => (o.resolution === "480p" ? 1 : 1.6),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      // Schéma fal : duration est un ENTIER ici (et une chaîne chez Seedance).
      duration: num(opts.duration, 5),
      // ⚠️ H3 Max exige un P MAJUSCULE : "480P" / "768P".
      resolution: String(opts.resolution ?? "768p").replace(/p$/, "P"),
      // Listé comme requis dans le schéma fal.
      prompt_expansion_mode: String(opts.expansion ?? "balanced"),
    }),
  },

  {
    id: "wan3ref",
    rateDependsOnOptions: true,
    needsReferences: true,
    endpoint: "alibaba/wan-3.0-prime/reference-to-video",
    name: "Wan 3.0 Prime — référence",
    tagline: "RÉFÉRENCE→VIDÉO : garde le même personnage d'un clip à l'autre",
    priceSummary: "480p : 0,068 $/s · 720p : 0,14 $/s · 1080p : 0,28 $/s (audio inclus)",
    options: [
      ratioOption(["9:16", "16:9", "1:1", "4:3", "3:4", "adaptive"], "9:16"),
      { key: "rewrite", label: "✍️ Réécriture auto du prompt ?", choices: [{ value: "true", label: "Oui (défaut)" }, { value: "false", label: "Non — garder mon prompt tel quel" }], default: "true" },
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
      "Wan 3.0 Prime (reference-to-video). Prend 2 à 4 images du MÊME sujet pour tenir son identité d'un clip " +
      "à l'autre. Contrairement à l'image→vidéo, il FAUT décrire le personnage (traits invariants : coupe, " +
      "couleur des yeux, morphologie) en plus de l'action, sinon la cohérence se perd. Structure Wan classique : " +
      "action du sujet, caméra, environnement, rythme.",
    maxPromptChars: 8000, // limite officielle 20 000 ; on plafonne bien en dessous
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      const rate = o.resolution === "1080p" ? 0.28 : o.resolution === "480p" ? 0.068 : 0.14;
      return num(o.duration, 5) * rate;
    },
    buildInput: ({ imageUrls, prompt, opts }) => ({
      prompt,
      reference_image_urls: imageUrls,
      duration: num(opts.duration, 5),
      resolution: String(opts.resolution ?? "720p"),
      aspect_ratio: String(opts.aspect_ratio ?? "9:16"),
      enable_prompt_expansion: String(opts.rewrite ?? "true") === "true",
    }),
  },
  {
    id: "h3maxref",
    rateDependsOnOptions: true,
    needsReferences: true,
    endpoint: "minimax/h3-max/reference-to-video",
    name: "MiniMax H3 Max — référence",
    tagline: "RÉFÉRENCE→VIDÉO le moins cher — 4 premières images offertes",
    priceSummary: "480p : 0,05 $/s · 768p : 0,08 $/s · références : 4 premières offertes",
    options: [
      { key: "expansion", label: "✍️ Réécriture du prompt ?", choices: [{ value: "balanced", label: "Rapide (~1 s)" }, { value: "quality", label: "Soignée (~30 s)" }], default: "balanced" },
      ratioOption(["9:16", "16:9", "21:9", "1:1", "4:3", "3:4", "adaptive"], "9:16"),
      durationOption([5, 10], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "768p", label: "768p" },
        ],
        default: "768p",
      },
    ],
    promptGuide:
      "MiniMax H3 Max (reference-to-video). Le « H3 Max » de fal est un variant POST-ENTRAÎNÉ de MiniMax H3 "
      +
      "(pas le H3-Max natif, qui lui ne fait pas de référence) : réglé pour mieux suivre le prompt et pour "
      +
      "l esthétique. Références désignées dans le prompt par Image 1, Image 2, Video 1, Audio 1 selon l ordre "
      +
      "d envoi. Limite fal : 12 fichiers de référence au TOTAL (images + vidéos + audios). Un audio ne peut "
      +
      "jamais être la seule référence. 4 premières images non facturées. " +
      "Décrire le personnage ET l'action. UNE SEULE instruction de caméra dominante, comme en image→vidéo.",
    maxPromptChars: 1500,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => num(o.duration, 5) * (o.resolution === "480p" ? 0.05 : 0.08),
    buildInput: ({ imageUrls, prompt, opts }) => ({
      prompt,
      reference_image_urls: imageUrls,
      duration: num(opts.duration, 5),
      // ⚠️ P majuscule exigé (vérifié via la validation fal).
      resolution: String(opts.resolution ?? "768p").replace(/p$/, "P"),
      aspect_ratio: String(opts.aspect_ratio ?? "9:16"),
      prompt_expansion_mode: String(opts.expansion ?? "balanced"),
    }),
  },

  {
    id: "grok15",
    rateDependsOnOptions: true,
    endpoint: "xai/grok-imagine-video/v1.5/image-to-video",
    name: "Grok Imagine 1.5",
    tagline: "xAI — prompt en langage naturel, pas de negative prompt",
    priceSummary: "480p : 0,08 $/s · 720p : 0,14 $/s · 1080p : 0,25 $/s",
    options: [
      durationOption([6, 10], 6),
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
      "Grok Imagine 1.5 (image-to-video). Prompt en LANGAGE NATUREL, comme un brief à un photographe — 30 à 80 " +
      "mots, pas d'empilement de mots-clés. ⚠️ Grok IGNORE les negative prompts : tout doit être formulé en " +
      "POSITIF (« clear natural skin » et non « no blemishes »). Aucun paramètre de format : le cadrage est " +
      "hérité de l'image d'entrée. Prompt limité à 4096 caractères.",
    maxPromptChars: 4096,
    billedSeconds: (o) => num(o.duration, 6),
    // ⚠️ PAS de rateMultiplier ici. L'API de tarification de fal renvoie 0,01 $/s
    // pour cet endpoint, mais ce n'est PAS le tarif vidéo : c'est le supplément
    // par image de référence. Le vrai tarif est 0,08 / 0,14 / 0,25 selon le
    // palier. S'y fier aurait sous-estimé le coût d'un facteur 8 à 25.
    estimateUsd: (o) =>
      num(o.duration, 6) * (o.resolution === "1080p" ? 0.25 : o.resolution === "480p" ? 0.08 : 0.14),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: num(opts.duration, 6),
      resolution: String(opts.resolution ?? "720p"),
    }),
  },
  {
    id: "bp25",
    provider: "byteplus",
    refusesHumanInputImages: true,
    rateDependsOnOptions: true,
    endpoint: "dreamina-seedance-2-5-260628",
    name: "Seedance 2.5 (BytePlus direct)",
    tagline: "Même modèle que sur fal, moitié prix — audio, jusqu'à 30 s",
    priceSummary: "≈ 0,103 $/s en 480p · 0,231 $/s en 720p · 0,41 $/s en 1080p (promo −28 % jusqu'au 17/09)",
    options: [
      durationOption([4, 5, 10], 5),
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
      { key: "generate_audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
      { key: "camera_fixed", label: "🎥 Caméra fixe ?", choices: [{ value: "false", label: "Non (mouvement libre)" }, { value: "true", label: "Oui — plan verrouillé" }], default: "false" },
    ],
    promptGuide:
      "Seedance 2.5 via l'API BytePlus. Mêmes règles de rédaction que la version fal (résumé en une phrase " +
      "Sujet + Lieu + Événement + Style + Caméra, puis découpage horodaté en secondes entières sans trou). " +
      "⚠️ Ici les références se désignent par @Image1, @Video1 dans le prompt (et non « Image 1 » comme chez fal). " +
      "Négatif possible uniquement sur sous-titres et audio. camera_fixed verrouille le plan — utile pour le réalisme.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => bpCost(o, (res) => (res === "1080p" ? 11.7 * 0.72 : 10.7)),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
      ],
      resolution: String(opts.resolution ?? "720p"),
      // Le mode première image VERROUILLE le format sur celui de l'image :
      // la doc impose ratio=adaptive, toute autre valeur serait ignorée.
      ratio: "adaptive",
      duration: num(opts.duration, 5),
      generate_audio: String(opts.generate_audio ?? "true") === "true",
      camera_fixed: String(opts.camera_fixed ?? "false") === "true",
      watermark: false,
    }),
  },
  {
    id: "bp25ref",
    provider: "byteplus",
    refusesHumanInputImages: true,
    rateDependsOnOptions: true,
    needsReferences: true,
    endpoint: "dreamina-seedance-2-5-260628",
    name: "Seedance 2.5 référence (BytePlus direct)",
    tagline: "RÉFÉRENCE→VIDÉO, moitié prix de fal — personnage cohérent",
    priceSummary: "≈ 0,103 $/s en 480p · 0,231 $/s en 720p",
    options: [
      durationOption([4, 5, 10], 5),
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
      ratioOption(["9:16", "16:9", "21:9", "1:1", "4:3", "3:4", "adaptive"], "9:16"),
      { key: "generate_audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Seedance 2.5 référence via BytePlus. Les images sont désignées dans le prompt par @Image1, @Image2… " +
      "selon l'ordre d'envoi — syntaxe DIFFÉRENTE de celle de fal. Lier explicitement chaque référence " +
      "(« @Image1 est la protagoniste »). Décrire le personnage en plus de l'action. Jusqu'à 30 images.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => bpCost(o, (res) => (res === "1080p" ? 11.7 * 0.72 : 10.7)),
    buildInput: ({ imageUrls, prompt, opts }) => ({
      content: [
        { type: "text", text: prompt },
        ...imageUrls.map((url) => ({ type: "image_url", image_url: { url }, role: "reference_image" })),
      ],
      resolution: String(opts.resolution ?? "720p"),
      ratio: String(opts.aspect_ratio ?? "9:16"),
      duration: num(opts.duration, 5),
      generate_audio: String(opts.generate_audio ?? "true") === "true",
      omni_reference_task_type: "reference",
      watermark: false,
    }),
  },
  {
    id: "bp20fast",
    provider: "byteplus",
    refusesHumanInputImages: true,
    rateDependsOnOptions: true,
    endpoint: "dreamina-seedance-2-0-fast-260128",
    name: "Seedance 2.0 fast (BytePlus)",
    tagline: "Bon compromis — environ 0,09 $/s en 720p (promo −25 % jusqu'au 07/10)",
    priceSummary: "≈ 0,04 $/s en 480p · 0,09 $/s en 720p",
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
      { key: "generate_audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Seedance 2.0 fast. ⚠️ La 2.0 NE COMPREND PAS les horodatages (« 0-3s : … ») — seulement les numéros " +
      "de plan (« Shot 1 »). Sinon, mêmes règles de rédaction que la 2.5.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => bpCost(o, () => 4.17),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
      ],
      resolution: String(opts.resolution ?? "720p"),
      ratio: "adaptive",
      duration: num(opts.duration, 5),
      generate_audio: String(opts.generate_audio ?? "true") === "true",
      watermark: false,
    }),
  },
  {
    id: "bp20mini",
    provider: "byteplus",
    refusesHumanInputImages: true,
    rateDependsOnOptions: true,
    endpoint: "dreamina-seedance-2-0-mini-260615",
    name: "Seedance 2.0 mini (BytePlus)",
    tagline: "LE MOINS CHER DU CATALOGUE — ~0,03 $/s en 720p (promo −60 % jusqu'au 07/10)",
    priceSummary: "≈ 0,013 $/s en 480p · 0,03 $/s en 720p — 5 s = 0,15 $",
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
      { key: "generate_audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Seedance 2.0 mini. Le moins cher de tout le catalogue : à privilégier pour ITÉRER sur un prompt avant " +
      "de refaire la prise sur un modèle haut de gamme. ⚠️ Pas d'horodatages, uniquement « Shot 1 », « Shot 2 ».",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => bpCost(o, () => 1.39),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
      ],
      resolution: String(opts.resolution ?? "720p"),
      ratio: "adaptive",
      duration: num(opts.duration, 5),
      generate_audio: String(opts.generate_audio ?? "true") === "true",
      watermark: false,
    }),
  },

  // ── TopView : la route Seedance qui accepte les images de personnes ──────
  {
    id: "tv25",
    provider: "topview",
    rateDependsOnOptions: true,
    endpoint: "Seedance 2.5",
    name: "Seedance 2.5 (TopView)",
    tagline: "Le Seedance qui ACCEPTE les images de personnes — image→vidéo, 4 à 15 s",
    priceSummary: "≈ 0,7 crédit/s en 480p · 1,5 crédit/s en 720p — au pack de 1000 (0,199 $ le crédit) : ~0,70 $ la vidéo 480p de 5 s, ~1,50 $ en 720p",
    options: [
      durationOption([4, 5, 8, 10, 15], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "720p",
      },
      { key: "sound", label: "🔊 Générer l'audio ?", choices: [{ value: "off", label: "Non" }, { value: "on", label: "Oui" }], default: "off" },
    ],
    promptGuide:
      "Seedance 2.5 via TopView : même modèle, mêmes règles de rédaction (résumé Sujet + Lieu + Événement + " +
      "Style + Caméra, puis découpage horodaté en secondes entières). C'est la SEULE route Seedance qui " +
      "accepte une image de personne réaliste : c'est lui qu'il faut proposer pour animer un mannequin. " +
      "Le format est celui de l'image (aucun choix de ratio). Compter 3 à 4 minutes de génération.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => tvCost("Seedance 2.5", o),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      mode: "i2v",
      imageUrls: [imageUrl],
      prompt,
      resolution: parseInt(String(opts.resolution ?? "720p"), 10),
      duration: num(opts.duration, 5),
      sound: String(opts.sound ?? "off"),
    }),
  },
  {
    id: "tv25ref",
    provider: "topview",
    rateDependsOnOptions: true,
    needsReferences: true,
    endpoint: "Seedance 2.5",
    name: "Seedance 2.5 référence (TopView)",
    tagline: "RÉFÉRENCE→VIDÉO avec des personnes — 2 images ou plus du même sujet",
    priceSummary: "≈ 0,7 crédit/s en 480p · 1,5 crédit/s en 720p — au pack de 1000 : ~0,70 $ (480p) à 1,50 $ (720p) la vidéo de 5 s",
    options: [
      durationOption([4, 5, 8, 10, 15], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "720p",
      },
      ratioOption(["9:16", "16:9", "1:1", "3:4", "4:3"], "9:16"),
      { key: "sound", label: "🔊 Générer l'audio ?", choices: [{ value: "off", label: "Non" }, { value: "on", label: "Oui" }], default: "off" },
    ],
    promptGuide:
      "Seedance 2.5 référence via TopView. Désigner les images par @Image1, @Image2… dans l'ordre d'envoi " +
      "et lier explicitement chaque référence (« @Image1 est la protagoniste, @Image2 le décor »). " +
      "Décrire le personnage en plus de l'action. Il faut AU MOINS 2 images. Accepte les visages réalistes.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => tvCost("Seedance 2.5", o),
    buildInput: ({ imageUrls, prompt, opts }) => ({
      mode: "r2v",
      imageUrls,
      prompt,
      resolution: parseInt(String(opts.resolution ?? "720p"), 10),
      duration: num(opts.duration, 5),
      sound: String(opts.sound ?? "off"),
      aspectRatio: String(opts.aspect_ratio ?? "9:16"),
    }),
  },
  {
    id: "tv20",
    provider: "topview",
    rateDependsOnOptions: true,
    endpoint: "Seedance 2.0",
    name: "Seedance 2.0 (TopView)",
    tagline: "Le palier en dessous, pour vérifier si la 2.5 se voit vraiment — accepte les personnes",
    priceSummary: "≈ 0,5 crédit/s en 480p · 1 crédit/s en 720p · 2 crédits/s en 1080p — au pack de 1000 : ~0,50 $ (480p) à 1,00 $ (720p) la vidéo de 5 s",
    options: [
      durationOption([4, 5, 8, 10, 15], 5),
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
      { key: "sound", label: "🔊 Générer l'audio ?", choices: [{ value: "off", label: "Non" }, { value: "on", label: "Oui" }], default: "off" },
    ],
    promptGuide:
      "Seedance 2.0 via TopView : mêmes règles que la 2.5, mêmes forces sur les visages réalistes. " +
      "À mettre face à la 2.5 sur la même demande : si la différence ne se voit pas, c'est lui qu'on garde. " +
      "Format = celui de l'image.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => tvCost("Seedance 2.0", o),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      mode: "i2v",
      imageUrls: [imageUrl],
      prompt,
      resolution: parseInt(String(opts.resolution ?? "720p"), 10),
      duration: num(opts.duration, 5),
      sound: String(opts.sound ?? "off"),
    }),
  },
  {
    id: "kling3",
    rateDependsOnOptions: true,
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    name: "Kling 3.0 Pro",
    tagline: "Dernier Kling — audio natif, jusqu'à 15 s, excellent sur tissus et cheveux",
    priceSummary: "0,112 $/s sans audio · 0,168 $/s avec (5 s = 0,56 / 0,84 $)",
    options: [
      durationOption([5, 10], 5),
      { key: "audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Kling 3.0 Pro. Formule Kling : Sujet + Mouvement du sujet + Décor + (Caméra + Lumière + Ambiance). " +
      "60 à 100 mots donnent de meilleurs résultats qu'un prompt saturé. Très bon sur la physique des tissus " +
      "et des cheveux — donc sur ce qui trahit une vidéo IA en plan mode. negative_prompt supporté (défaut " +
      "« blur, distort, and low quality »). Pas de réglage de résolution ni de format : hérités de l'image.",
    maxPromptChars: 2500,
    billedSeconds: (o) => num(o.duration, 5),
    // Tarifs relevés sur la page fal ; l API de tarification renvoie 0,14 qui ne
    // correspond à aucun des deux paliers — pas de rateMultiplier ici.
    estimateUsd: (o) => num(o.duration, 5) * (String(o.audio ?? "true") === "true" ? 0.168 : 0.112),
    buildInput: ({ imageUrl, prompt, negativePrompt, opts }) => ({
      prompt,
      start_image_url: imageUrl,
      duration: String(num(opts.duration, 5)),
      generate_audio: String(opts.audio ?? "true") === "true",
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  },
  {
    id: "kling3s",
    rateDependsOnOptions: true,
    endpoint: "fal-ai/kling-video/v3/standard/image-to-video",
    name: "Kling 3.0 Standard",
    tagline: "Même génération que le Pro, palier économique — à comparer au Pro",
    priceSummary: "moins cher que le Pro à qualité proche — à vérifier par un duel",
    options: [
      durationOption([5, 10], 5),
      { key: "audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Kling 3.0 Standard. Mêmes règles que le Pro. Intérêt : vérifier par un duel si l'écart de rendu justifie " +
      "l'écart de prix sur TES demandes — souvent le palier économique suffit.",
    maxPromptChars: 2500,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => num(o.duration, 5) * (String(o.audio ?? "true") === "true" ? 0.084 : 0.056),
    buildInput: ({ imageUrl, prompt, negativePrompt, opts }) => ({
      prompt,
      start_image_url: imageUrl,
      duration: String(num(opts.duration, 5)),
      generate_audio: String(opts.audio ?? "true") === "true",
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  },
  {
    id: "wan3prime",
    rateDependsOnOptions: true,
    endpoint: "alibaba/wan-3.0-prime/image-to-video",
    name: "Wan 3.0 Prime",
    tagline: "Variante rapide du Wan 3.0, mêmes capacités — audio inclus",
    priceSummary: "0,068 $/s en 480p · 0,14 $/s en 720p · 0,28 $/s en 1080p",
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
      ratioOption(["adaptive", "9:16", "16:9", "1:1", "4:3", "3:4"], "adaptive"),
      { key: "rewrite", label: "✍️ Réécriture auto du prompt ?", choices: [{ value: "true", label: "Oui (défaut)" }, { value: "false", label: "Non — garder mon prompt" }], default: "true" },
      { key: "audio", label: "🔊 Générer l'audio ?", choices: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }], default: "true" },
    ],
    promptGuide:
      "Wan 3.0 Prime (image→vidéo). Structure Wan en 4 blocs : mouvement du sujet, caméra, environnement, " +
      "rythme — l'action du sujet en PREMIER, le modèle lit le début avec le plus d'attention. Le réécrivain " +
      "est actif par défaut et peut défaire une formulation réaliste travaillée : le couper si le rendu " +
      "part en esthétique de pub.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => num(o.duration, 5) * (o.resolution === "1080p" ? 0.28 : o.resolution === "480p" ? 0.068 : 0.14),
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      start_image_url: imageUrl,
      duration: num(opts.duration, 5),
      resolution: String(opts.resolution ?? "720p"),
      aspect_ratio: String(opts.aspect_ratio ?? "adaptive"),
      audio: String(opts.audio ?? "true") === "true",
      enable_prompt_expansion: String(opts.rewrite ?? "true") === "true",
    }),
  },
  {
    id: "h3",
    rateDependsOnOptions: true,
    endpoint: "minimax/h3/image-to-video",
    name: "MiniMax H3 (jusqu'en 4K)",
    tagline: "Le H3 complet — seul du catalogue à monter en 2K et 4K",
    priceSummary: "0,05 $/s en 480P · 0,06 en 768P · 0,13 en 2K · 0,16 en 4K",
    options: [
      durationOption([5, 10], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480P", label: "480p" },
          { value: "768P", label: "768p" },
          { value: "2K", label: "2K" },
          { value: "4K", label: "4K" },
        ],
        default: "2K",
      },
      { key: "expansion", label: "✍️ Réécriture du prompt ?", choices: [{ value: "balanced", label: "Rapide (~1 s)" }, { value: "quality", label: "Soignée (~30 s)" }], default: "balanced" },
    ],
    promptGuide:
      "MiniMax H3 complet (image→vidéo). Trois blocs : sujet+action, direction caméra, ambiance. UNE SEULE " +
      "instruction de caméra dominante — empiler les mouvements est la première cause d'échec. Le seul modèle " +
      "du catalogue qui monte en 2K et 4K. Le format est TOUJOURS hérité de l'image d'entrée.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      const r = String(o.resolution ?? "2K");
      const rate = r === "4K" ? 0.16 : r === "2K" ? 0.13 : r === "768P" ? 0.06 : 0.05;
      return num(o.duration, 5) * rate;
    },
    // Tarif live 0,05 = le palier 480P, confirmé par la page : ratios sûrs.
    rateMultiplier: (o) => {
      const r = String(o.resolution ?? "2K");
      return r === "4K" ? 3.2 : r === "2K" ? 2.6 : r === "768P" ? 1.2 : 1;
    },
    buildInput: ({ imageUrl, prompt, opts }) => ({
      prompt,
      image_url: imageUrl,
      duration: num(opts.duration, 5),
      resolution: String(opts.resolution ?? "2K"),
      prompt_expansion_mode: String(opts.expansion ?? "balanced"),
    }),
  },
  {
    id: "h3ref",
    rateDependsOnOptions: true,
    needsReferences: true,
    endpoint: "minimax/h3/reference-to-video",
    name: "MiniMax H3 — référence (jusqu'en 4K)",
    tagline: "RÉFÉRENCE→VIDÉO en 2K/4K — personnage cohérent en haute définition",
    priceSummary: "0,05 $/s en 480P · 0,06 en 768P · 0,13 en 2K · 0,16 en 4K",
    options: [
      durationOption([5, 10], 5),
      {
        key: "resolution",
        label: "🖥 Résolution ?",
        choices: [
          { value: "480P", label: "480p" },
          { value: "768P", label: "768p" },
          { value: "2K", label: "2K" },
          { value: "4K", label: "4K" },
        ],
        default: "2K",
      },
      ratioOption(["9:16", "16:9", "21:9", "1:1", "4:3", "3:4", "adaptive"], "9:16"),
    ],
    promptGuide:
      "MiniMax H3 référence. Références désignées dans le prompt par Image 1, Image 2, Video 1, Audio 1 selon " +
      "l'ordre d'envoi. Décrire le personnage ET l'action. Modes exclusifs : on ne mélange pas première image " +
      "et références. Jusqu'en 4K, ce qu'aucun autre modèle référence du catalogue ne fait.",
    maxPromptChars: 8000,
    billedSeconds: (o) => num(o.duration, 5),
    estimateUsd: (o) => {
      const r = String(o.resolution ?? "2K");
      const rate = r === "4K" ? 0.16 : r === "2K" ? 0.13 : r === "768P" ? 0.06 : 0.05;
      return num(o.duration, 5) * rate;
    },
    buildInput: ({ imageUrls, prompt, opts }) => ({
      prompt,
      reference_image_urls: imageUrls,
      duration: num(opts.duration, 5),
      resolution: String(opts.resolution ?? "2K"),
      aspect_ratio: String(opts.aspect_ratio ?? "9:16"),
      prompt_expansion_mode: "balanced",
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
