import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { cancelRequest, describeFalError } from "./fal.js";
import { MODELS, defaultOptions, getModel, type Options, type OptionValue, type VideoModel } from "./models.js";
import { estimateCost, formatUsd } from "./pricing.js";
import type { HistoryMessage, PendingDuel, PendingGeneration, Session, Store } from "./store.js";
import { REALISM_PLAYBOOK, MODEL_PLAYBOOK } from "./prompting.js";

const client = new Anthropic(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {});

/** Repli serveur en cas de refus de Claude ; désactivé après un 400 (organisation sans accès). */
let fallbacksSupported = true;

/** Ce que le bot Telegram doit savoir faire pour l'agent. */
export interface AgentHooks {
  showDuelConfirmation(session: Session, duel: PendingDuel): Promise<number | undefined>;
  /** Affiche la carte de confirmation (coût + boutons ✅/❌) et renvoie l'id du message. */
  showConfirmation: (session: Session, pending: PendingGeneration) => Promise<number>;
}

// ---------------------------------------------------------------------------
// System prompt (statique → mis en cache)
// ---------------------------------------------------------------------------

function modelCatalog(): string {
  return MODELS.map((m) => {
    const opts = m.options.length
      ? m.options
          .map((o) => `${o.key} ∈ {${o.choices.map((c) => JSON.stringify(c.value)).join(", ")}} (défaut ${JSON.stringify(o.default)})`)
          .join(" ; ")
      : "aucune option";
    return `• model_id="${m.id}" — ${m.name} : ${m.tagline}\n  Tarif : ${m.priceSummary}\n  Options : ${opts}\n  Guide de prompt : ${m.promptGuide}`;
  }).join("\n\n");
}

const SYSTEM_PROMPT = `Tu es l'assistant d'un bot Telegram qui transforme des images en vidéos IA via l'API fal.ai. Tu discutes en français, tu tutoies, tu es direct et concis (Telegram = messages courts). Tu es un expert en prompting pour les modèles image → vidéo, SPÉCIALISÉ dans le contenu réaliste pour TikTok et Reels Instagram : des vidéos de modèle féminin qui doivent passer pour de vraies captations au téléphone, jamais pour des rendus IA ni des pubs de cosmétique. Tu connais par cœur les guides de prompting ci-dessous et tu les appliques sans qu'on te le demande.

FORMAT DES RÉPONSES
- Texte brut uniquement : pas de Markdown (pas de **, pas de #, pas de tableaux). Les emojis et retours à la ligne sont bienvenus.
- Quand tu montres un prompt vidéo, mets-le sur ses propres lignes entre guillemets « … ».
- Ne répète pas tout le catalogue à chaque message ; cite seulement ce qui est utile.

DÉROULÉ TYPIQUE
1. L'utilisateur envoie une image (tu la vois dans la conversation). Décris en une phrase ce que tu vois, puis demande ce qu'il veut (mouvement, ambiance, durée) s'il ne l'a pas dit.
2. Conseille un modèle adapté au besoin et au budget (donne le prix). Appelle estimate_cost si tu as besoin d'un chiffre précis pour des options données.
3. Rédige le prompt vidéo EN ANGLAIS (30 à 120 mots sauf indication du guide du modèle), en appliquant la DOCTRINE DU RÉALISME et la structure propre au modèle choisi. En image→vidéo, ne redécris PAS le sujet en détail (le modèle voit l'image) : décris ce qui bouge, comment, et ce qui reste stable. Ajoute systématiquement les marqueurs de texture (peau, cheveux, caméra téléphone) et un negative_prompt quand le modèle le supporte. Montre le prompt à l'utilisateur et explique tes choix en 1-2 phrases en français.
4. Quand l'utilisateur est d'accord (ou qu'il te dit clairement de lancer), appelle propose_generation avec le model_id, les options, le prompt (et negative_prompt si utile). Cela affiche à l'utilisateur une carte avec le coût exact et des boutons ✅ / ❌. Dis-lui ensuite d'appuyer sur ✅ pour lancer.
5. La génération ne démarre QUE si l'utilisateur appuie sur ✅. Ne prétends jamais qu'une vidéo est lancée ou prête tant qu'un message [Événement] ne le confirme pas.

PHASE DE TEST ET CLASSEMENT
- On est en phase de comparaison : aucun modèle n'est « le meilleur » dans l'absolu, ça dépend du type de
  demande et du goût de l'utilisateur. Par défaut, propose un DUEL (propose_duel) plutôt qu'une génération
  isolée : 2 à 4 modèles comparables sur la MÊME tâche, même prompt, mêmes options.
- Tu PROPOSES, l'utilisateur DISPOSE : la carte de duel est interactive, il coche et décoche les modèles et
  peut en ajouter. Explique en une phrase pourquoi tu retiens ces concurrents-là, puis laisse-le ajuster.
  N'insiste pas s'il retire un modèle que tu jugeais bon.
- Fais concourir les MEILLEURS modèles, pas les moins chers. L'objet du duel est de savoir ce que la
  technologie sait faire de mieux sur cette demande : un duel entre modèles bon marché n'apprend que
  lequel des bon marché gagne, et si aucun n'est exploitable l'argent est perdu, pas économisé.
- Pour du réalisme haut de gamme, les concurrents naturels sont Veo 3.1, Seedance 2.5 (BytePlus direct),
  Kling 2.5 Turbo Pro et Wan 3.0. Annonce le coût total sans en faire un obstacle : c'est une information,
  pas un critère de sélection.
- Les modèles économiques (Seedance 2.0 mini, Hailuo 02) servent à ITÉRER sur la formulation d'un prompt
  une fois qu'on sait quel modèle vise juste — pas à choisir ce modèle.
- Renseigne task_kind avec le type de demande : 'i2v' (image de départ), 'r2v' (référence), et précise si
  c'est utile ('i2v-portrait-realiste', 'r2v-personnage-recurrent'). C'est la clé du classement.
- Consulte model_ratings AVANT de recommander : les verdicts passés de l'utilisateur priment sur les
  caractéristiques annoncées. S'il a déjà tranché sur ce type de tâche, dis-le et propose le vainqueur.
- Quand un verdict tombe, ne le commente pas longuement : note ce qui a plu, et propose la suite.
- Quand le classement est net sur un type de tâche (plusieurs duels, un vainqueur récurrent), propose de
  passer en génération simple sur ce modèle plutôt que de continuer à payer des duels.

MODE RÉFÉRENCE→VIDÉO (modèles marqués RÉFÉRENCE dans le catalogue)
- Ces modèles ne prennent PAS une image à animer : ils prennent 2 à 4 photos du MÊME sujet pour tenir
  son identité d'un clip à l'autre. C'est le mode à conseiller dès que l'utilisateur veut une SÉRIE sur
  le même modèle : sinon le visage change d'un post à l'autre et l'illusion tombe.
- Toutes les images envoyées dans la conversation sont empilées et transmises ensemble (8 max). Si tu
  n'en as qu'une, demande-en d'autres : de face, de trois quarts, de profil, et un plan plus large.
- Ici il FAUT décrire le personnage (coupe, couleur des yeux, morphologie, tenue) en plus de l'action —
  l'inverse de l'image→vidéo où redécrire le sujet fait dériver le visage.
- Sur Seedance 2.5 référence, on désigne les images dans le prompt par [Image1], [Image2]… dans l'ordre
  d'envoi. C'est le contrôle le plus fin du catalogue.
- /new remet la pile d'images à zéro : à conseiller quand on change de personnage.

RÈGLES
- Sans image, tu ne peux rien générer : demande-en une (photo ou fichier).
- Les messages qui commencent par [Événement] sont des notifications système (confirmation, refus, vidéo prête, échec), pas des paroles de l'utilisateur. Réagis-y naturellement.
- Respecte les limites de budget renvoyées par les outils ; propose une alternative moins chère si besoin.
- Si l'utilisateur veut relancer avec la même image mais un autre prompt/modèle, enchaîne directement.
- N'invente pas de modèles ou d'options hors catalogue.

CATALOGUE DES MODÈLES (fal.ai)
${modelCatalog()}
${REALISM_PLAYBOOK}
${MODEL_PLAYBOOK}`;

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

const OptionsSchema = z
  .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
  .describe("Options du modèle, ex. {\"duration\":\"5\",\"resolution\":\"720p\",\"generate_audio\":true}. Options omises = valeurs par défaut.");

/** Valide et normalise les options pour un modèle donné. Renvoie une erreur lisible sinon. */
function normalizeOptions(model: VideoModel, raw: Record<string, string | boolean | number>): { options: Options } | { error: string } {
  const options = defaultOptions(model);
  for (const [key, value] of Object.entries(raw)) {
    const opt = model.options.find((o) => o.key === key);
    if (!opt) {
      return { error: `Option inconnue "${key}" pour ${model.name}. Options valides : ${model.options.map((o) => o.key).join(", ") || "aucune"}.` };
    }
    const normalized: OptionValue =
      typeof value === "boolean"
        ? value
        : typeof value === "number"
          ? String(value)
          : /^(true|false)$/i.test(value)
            ? value.toLowerCase() === "true"
            : value;
    const match = opt.choices.find((c) => c.value === normalized || String(c.value).toLowerCase() === String(normalized).toLowerCase());
    if (!match) {
      return { error: `Valeur "${String(value)}" invalide pour "${key}". Choix : ${opt.choices.map((c) => JSON.stringify(c.value)).join(", ")}.` };
    }
    options[key] = match.value;
  }
  return { options };
}

function buildTools(session: Session, store: Store, hooks: AgentHooks) {
  const estimateCostTool = betaZodTool({
    name: "estimate_cost",
    description: "Calcule le coût estimé (USD) d'une génération pour un modèle et des options donnés, avant de proposer quoi que ce soit.",
    inputSchema: z.object({
      model_id: z.string().describe("Identifiant du modèle (model_id du catalogue)"),
      options: OptionsSchema.optional(),
    }),
    run: async ({ model_id, options }) => {
      const model = getModel(model_id);
      if (!model) return `Erreur : model_id "${model_id}" inconnu.`;
      const refCount = (session.imageUrls ?? [session.imageUrl]).length;
      if (model.needsReferences && refCount < 2) {
        return `Erreur : ${model.name} est un modèle référence→vidéo, il lui faut au moins 2 images du même sujet (${refCount} disponible). Demande à l'utilisateur d'en envoyer d'autres, ou choisis un modèle image→vidéo.`;
      }
      const norm = normalizeOptions(model, options ?? {});
      if ("error" in norm) return `Erreur : ${norm.error}`;
      const est = await estimateCost(model, norm.options);
      return JSON.stringify({
        model: model.name,
        options: norm.options,
        estimated_usd: Number(est.usd.toFixed(3)),
        billed_seconds: est.billedSeconds,
        live_fal_unit_price: est.live ?? null,
        live_estimate_usd: est.liveUsd != null ? Number(est.liveUsd.toFixed(3)) : null,
        max_per_video_usd: config.MAX_COST_PER_VIDEO_USD,
        spent_today_usd: Number(store.spentToday().toFixed(3)),
        daily_budget_usd: config.DAILY_BUDGET_USD ?? null,
      });
    },
  });

  const proposeGenerationTool = betaZodTool({
    name: "propose_generation",
    description:
      "Propose une génération vidéo à l'utilisateur : affiche une carte récapitulative avec le coût et des boutons ✅/❌. " +
      "La génération ne démarre que si l'utilisateur appuie sur ✅. À appeler uniquement quand le prompt est validé ou que l'utilisateur demande de lancer.",
    inputSchema: z.object({
      model_id: z.string().describe("Identifiant du modèle (model_id du catalogue)"),
      options: OptionsSchema.optional(),
      prompt: z.string().min(3).describe("Prompt vidéo final, en anglais"),
      negative_prompt: z.string().nullable().optional().describe("Negative prompt (anglais) si le modèle le supporte, sinon null"),
    }),
    run: async ({ model_id, options, prompt, negative_prompt }) => {
      if (!session.imageUrl) return "Erreur : aucune image dans la conversation. Demande une image à l'utilisateur.";
      const model = getModel(model_id);
      if (!model) return `Erreur : model_id "${model_id}" inconnu.`;
      const norm = normalizeOptions(model, options ?? {});
      if ("error" in norm) return `Erreur : ${norm.error}`;

      const finalPrompt = model.maxPromptChars ? prompt.trim().slice(0, model.maxPromptChars) : prompt.trim();
      const est = await estimateCost(model, norm.options);
      const worst = Math.max(est.usd, est.liveUsd ?? 0);

      if (worst > config.MAX_COST_PER_VIDEO_USD) {
        return `Refusé : coût estimé ${formatUsd(worst)} > plafond par vidéo ${formatUsd(config.MAX_COST_PER_VIDEO_USD)} (MAX_COST_PER_VIDEO_USD). Propose une durée/résolution/modèle moins cher.`;
      }
      if (config.DAILY_BUDGET_USD != null && store.spentToday() + worst > config.DAILY_BUDGET_USD) {
        return `Refusé : budget journalier ${formatUsd(config.DAILY_BUDGET_USD)} dépassé (déjà ${formatUsd(store.spentToday())} aujourd'hui).`;
      }

      const pending: PendingGeneration = {
        modelId: model.id,
        options: norm.options,
        prompt: finalPrompt,
        negativePrompt: negative_prompt?.trim() || null,
        // Le tarif live de fal fait foi quand on sait le rattacher au palier
        // choisi ; sinon on retombe sur l estimation documentee (pessimiste).
        estimateUsd: Number((est.liveUsd ?? est.usd).toFixed(4)),
        billedSeconds: est.billedSeconds,
        createdAt: Date.now(),
      };
      pending.messageId = await hooks.showConfirmation(session, pending);
      session.pending = pending;
      store.saveSession(session);

      return `Carte de confirmation affichée à l'utilisateur (${model.name}, ${formatUsd(est.usd)}). Il doit appuyer sur ✅ pour lancer. Réponds brièvement, sans reproduire le prompt ni le récapitulatif, et attends sa décision.`;
    },
  });


  /* ── Duel : plusieurs modèles sur la même tâche ─────────────────────
   * Aucun modèle n'est « le meilleur » dans l'absolu : ça dépend du type de
   * demande et des goûts de l'utilisateur. On les met en concurrence, il
   * tranche, et le classement se construit sur SES verdicts. */
  const proposeDuelTool = betaZodTool({
    name: "propose_duel",
    description:
      "Propose de lancer PLUSIEURS modèles sur la MÊME tâche pour les comparer. À utiliser en phase de test, " +
      "ou dès que l'utilisateur demande quel modèle est le meilleur. Une fois les vidéos prêtes, il désignera " +
      "le gagnant et le classement interne se mettra à jour. Affiche une carte avec le coût TOTAL et des boutons.",
    inputSchema: z.object({
      model_ids: z.array(z.string()).min(2).max(4).describe("2 à 4 model_id du catalogue, à conditions comparables"),
      options: OptionsSchema.optional().describe("Options communes à tous (durée, résolution…)"),
      prompt: z.string().min(3).describe("Le MÊME prompt pour tous, en anglais"),
      negative_prompt: z.string().nullable().optional(),
      task_kind: z
        .string()
        .describe("Type de tâche, clé du classement : 'i2v' (image de départ), 'r2v' (référence), ou plus précis comme 'i2v-portrait-realiste'"),
    }),
    run: async ({ model_ids, options, prompt, negative_prompt, task_kind }) => {
      if (!session.imageUrl) return "Erreur : aucune image dans la conversation. Demande une image à l'utilisateur.";
      const refCount = (session.imageUrls ?? [session.imageUrl]).length;
      const models = [];
      for (const id of model_ids) {
        const m = getModel(id);
        if (!m) return `Erreur : model_id "${id}" inconnu.`;
        if (m.needsReferences && refCount < 2) {
          return `Erreur : ${m.name} exige au moins 2 images de référence (${refCount} disponible). Retire-le du duel ou demande d'autres images.`;
        }
        models.push(m);
      }
      let total = 0;
      const lines: string[] = [];
      for (const m of models) {
        const norm = normalizeOptions(m, options ?? {});
        if ("error" in norm) return `Erreur sur ${m.name} : ${norm.error}`;
        const est = await estimateCost(m, norm.options);
        total += est.liveUsd ?? est.usd;
        lines.push(`${m.name} ${formatUsd(est.liveUsd ?? est.usd)}`);
      }
      const duelCap = config.MAX_COST_PER_DUEL_USD ?? config.MAX_COST_PER_VIDEO_USD * 4;
      if (total > duelCap) {
        return `Refusé : le duel coûterait ${formatUsd(total)}, au-dessus du plafond de duel (${formatUsd(duelCap)}). Retire un modèle, raccourcis, ou baisse la résolution — mais ne sacrifie pas la qualité des concurrents juste pour tenir dans le budget.`;
      }
      if (config.DAILY_BUDGET_USD != null && store.spentToday() + total > config.DAILY_BUDGET_USD) {
        return `Refusé : budget journalier dépassé (déjà ${formatUsd(store.spentToday())}).`;
      }
      const duel: PendingDuel = {
        // Tous proposés et cochés d'office : l'utilisateur décoche ce qu'il
        // ne veut pas et peut en ajouter d'autres depuis la carte.
        candidates: models.map((m) => m.id),
        selected: models.map((m) => m.id),
        options: options ? (normalizeOptions(models[0]!, options) as { options: Options }).options : {},
        prompt: prompt.trim(),
        negativePrompt: negative_prompt?.trim() || null,
        taskKind: task_kind,
        totalUsd: Number(total.toFixed(4)),
        createdAt: Date.now(),
      };
      duel.messageId = await hooks.showDuelConfirmation(session, duel);
      session.pendingDuel = duel;
      session.pending = undefined;
      store.saveSession(session);
      return `Duel proposé : ${lines.join(" · ")} — total ${formatUsd(total)}. La carte est INTERACTIVE : il peut décocher des modèles, en ajouter d'autres, et le total se recalcule. Dis-lui en une phrase pourquoi tu as retenu ces concurrents-là, puis laisse-le ajuster et lancer.`;
    },
  });

  const ratingsTool = betaZodTool({
    name: "model_ratings",
    description:
      "Classement interne des modèles, construit sur les verdicts passés de l'utilisateur. À consulter AVANT " +
      "de recommander un modèle : ses préférences réelles priment sur les caractéristiques annoncées.",
    inputSchema: z.object({
      task_kind: z.string().nullable().optional().describe("Filtrer sur un type de tâche, ou null pour tout voir"),
    }),
    run: async ({ task_kind }) => {
      const r = store.ratings(task_kind ?? undefined);
      if (Object.keys(r).length === 0) return "Aucun verdict enregistré pour l'instant : lance un duel pour commencer à construire le classement.";
      const out: string[] = [];
      for (const [kind, rows] of Object.entries(r)) {
        out.push(
          `${kind} : ` +
            rows.map((x) => `${getModel(x.modelId)?.name ?? x.modelId} ${x.wins}/${x.runs} (${Math.round(x.rate * 100)} %)`).join(" · "),
        );
      }
      return out.join("\n");
    },
  });

  const listJobsTool = betaZodTool({
    name: "list_jobs",
    description: "Liste les dernières générations de cette conversation (en cours, terminées, échouées) avec leur statut.",
    inputSchema: z.object({}),
    run: async () => {
      const jobs = store.jobsForChat(session.chatId, 10);
      if (jobs.length === 0) return "Aucune génération pour cette conversation.";
      return JSON.stringify(
        jobs.map((j) => ({
          job_id: j.id,
          model: getModel(j.modelId)?.name ?? j.modelId,
          status: j.status,
          queue_position: j.queuePosition ?? null,
          estimated_usd: j.estimateUsd,
          prompt: j.prompt,
          video_url: j.videoUrl ?? null,
          error: j.error ?? null,
          created_at: new Date(j.createdAt).toISOString(),
        })),
      );
    },
  });

  const cancelJobTool = betaZodTool({
    name: "cancel_job",
    description: "Annule une génération en cours (job_id de list_jobs), à la demande de l'utilisateur.",
    inputSchema: z.object({ job_id: z.string() }),
    run: async ({ job_id }) => {
      const job = store.getJob(job_id);
      if (!job || job.chatId !== session.chatId) return `Erreur : job "${job_id}" introuvable.`;
      if (job.status !== "queued" && job.status !== "running") return `Le job ${job_id} est déjà ${job.status}.`;
      try {
        await cancelRequest(job.endpoint, job.requestId);
        job.status = "cancelled";
        store.saveJob(job);
        return `Job ${job_id} annulé (si la génération avait déjà démarré côté fal, elle peut être facturée).`;
      } catch (err) {
        return `Erreur d'annulation : ${describeFalError(err)}`;
      }
    },
  });

  return [proposeDuelTool,
    ratingsTool,
    estimateCostTool, proposeGenerationTool, listJobsTool, cancelJobTool];
}

// ---------------------------------------------------------------------------
// Boucle de l'agent
// ---------------------------------------------------------------------------

/** Garde l'historique borné, en repartant toujours d'un vrai message utilisateur. */
function trimHistory(history: HistoryMessage[], imageUrl: string | undefined): HistoryMessage[] {
  const max = config.HISTORY_MAX_MESSAGES;
  if (history.length <= max) return history;

  let start = history.length - max;
  const isPlainUser = (m: HistoryMessage) =>
    m.role === "user" &&
    (typeof m.content === "string" || m.content.every((b) => b.type === "text" || b.type === "image"));
  while (start < history.length && !isPlainUser(history[start]!)) start++;
  const kept = history.slice(start);

  // L'image d'origine a pu sortir de la fenêtre : on la réinjecte pour que Claude la voie encore.
  const stillHasImage = kept.some(
    (m) => m.role === "user" && typeof m.content !== "string" && m.content.some((b) => b.type === "image"),
  );
  if (imageUrl && !stillHasImage) {
    kept.unshift({
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: "[Événement] Rappel de l'image courante de la conversation (historique tronqué)." },
      ],
    });
  }
  return kept;
}

export interface AgentTurnResult {
  text: string;
}

/**
 * Fait répondre Claude au dernier message ajouté à `session.history`.
 * L'historique complet (outils compris) est réécrit dans la session.
 */
export async function runAgentTurn(session: Session, store: Store, hooks: AgentHooks): Promise<AgentTurnResult> {
  const tools = buildTools(session, store, hooks);
  const messages = trimHistory(session.history, session.imageUrl);

  const baseParams = {
    model: config.CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: config.CLAUDE_EFFORT },
    system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
    tools,
    messages,
    max_iterations: 8,
  };

  const run = async (withFallbacks: boolean) => {
    const runner = client.beta.messages.toolRunner(
      withFallbacks
        ? { ...baseParams, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
        : baseParams,
    );
    const final = await runner.runUntilDone();
    return { final, history: [...runner.params.messages] };
  };

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(fallbacksSupported);
  } catch (err) {
    // Si l'organisation n'a pas accès au fallback serveur, on réessaie sans (et on s'en souvient).
    if (fallbacksSupported && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
      console.warn("Repli serveur (fallbacks) indisponible pour cette organisation : désactivé.");
      fallbacksSupported = false;
      result = await run(false);
    } else {
      throw err;
    }
  }

  session.history = result.history;
  store.saveSession(session);

  const { final } = result;
  if (final.stop_reason === "refusal") {
    const why = final.stop_details?.explanation ? ` (${final.stop_details.explanation})` : "";
    return { text: `Je ne peux pas t'aider sur cette demande${why}.` };
  }

  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text && final.stop_reason === "max_tokens") return { text: "Ma réponse était trop longue, reformule ta demande plus simplement." };
  return { text: text || "👍" };
}

export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Clé API Anthropic invalide (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.RateLimitError) return "Claude est saturé (rate limit), réessaie dans un instant.";
  if (err instanceof Anthropic.APIConnectionError) return "Impossible de joindre l'API Claude (réseau).";
  if (err instanceof Anthropic.APIError) return `Erreur Claude ${err.status ?? ""}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
