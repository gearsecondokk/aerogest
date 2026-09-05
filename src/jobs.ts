import { InlineKeyboard, InputFile, type Bot } from "grammy";
import { pushEvent } from "./bot.js";
import { config } from "./config.js";
import { describeError, getResult, getStatus } from "./provider.js";
import { getModel } from "./models.js";
import { formatUsd } from "./pricing.js";
import type { Job, Store } from "./store.js";
import { esc, truncate } from "./text.js";

/**
 * Boucle de suivi des générations : interroge fal.ai, met à jour le message
 * de statut et envoie la vidéo quand elle est prête. Reprend automatiquement
 * les jobs en cours après un redémarrage (ils sont persistés dans le store).
 */
export function startJobPoller(bot: Bot, store: Store): () => void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const jobs = store.activeJobs();
      await Promise.all(jobs.map((job) => pollJob(job).catch((err) => console.error(`Job ${job.id} :`, err))));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.POLL_INTERVAL_MS);
  void tick();

  async function pollJob(job: Job): Promise<void> {
    let status;
    try {
      status = await getStatus(job.provider ?? "fal", job.endpoint, job.requestId);
    } catch (err) {
      // 404/410 etc. : la tâche n'existe plus côté fournisseur
      const msg = describeError(job.provider ?? "fal", err);
      if (/\b(404|410)\b/.test(msg)) {
        await failJob(job, `Requête introuvable côté fournisseur (${msg})`);
      } else {
        console.warn(`Statut indisponible pour le job ${job.id} : ${msg}`);
      }
      return;
    }

    if (status.status === "IN_QUEUE") {
      if (job.status !== "queued" || job.queuePosition !== status.queue_position) {
        job.status = "queued";
        job.queuePosition = status.queue_position;
        store.saveJob(job);
        await updateStatusMessage(job, `⏳ En file d'attente (position ${status.queue_position})…`);
      }
      return;
    }

    if (status.status === "IN_PROGRESS") {
      if (job.status !== "running") {
        job.status = "running";
        store.saveJob(job);
        await updateStatusMessage(job, "⚙️ Génération en cours… (généralement 1 à 5 minutes)");
      }
      return;
    }

    // COMPLETED : on récupère le résultat (peut aussi contenir une erreur)
    try {
      const result = await getResult(job.provider ?? "fal", job.endpoint, job.requestId);
      job.status = "done";
      job.videoUrl = result.videoUrl;
      job.expandedPrompt = result.expandedPrompt ?? null;
      if (result.actualUsd != null) {
        // Coût réel communiqué par le fournisseur (TopView renvoie les crédits
        // débités) : on corrige la dépense du jour, comptée à l'estimation au lancement.
        job.actualUsd = result.actualUsd;
        store.addSpend(result.actualUsd - job.estimateUsd);
      }
      job.finishedAt = Date.now();
      store.saveJob(job);
      await deliverVideo(job);
      await askDuelVerdict(job).catch((e) => console.warn("verdict duel :", e));
    } catch (err) {
      await failJob(job, describeError(job.provider ?? "fal", err));
      await askDuelVerdict(job).catch(() => {});
    }
  }

  async function updateStatusMessage(job: Job, line: string): Promise<void> {
    if (!job.statusMessageId) return;
    const model = getModel(job.modelId);
    const text = `🚀 <b>Génération lancée</b> (${esc(model?.name ?? job.modelId)}, ~${formatUsd(job.estimateUsd)})\n${line}\n<i>Job ${job.id}</i>`;
    try {
      await bot.api.editMessageText(job.chatId, job.statusMessageId, text, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🛑 Annuler", `j:cancel:${job.id}`),
      });
    } catch (err) {
      // "message is not modified" ou message supprimé : sans gravité
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not modified/i.test(msg)) console.warn(`Édition du statut impossible (job ${job.id}) : ${msg}`);
    }
  }

  async function deliverVideo(job: Job): Promise<void> {
    const model = getModel(job.modelId);
    const elapsed = job.finishedAt ? Math.round((job.finishedAt - job.createdAt) / 1000) : null;
    const caption = [
      `✅ <b>Vidéo prête</b> — ${esc(model?.name ?? job.modelId)}`,
      `📝 <i>${esc(truncate(job.prompt, 700))}</i>`,
      `💰 ${job.actualUsd != null ? `${formatUsd(job.actualUsd)} (réel)` : `~${formatUsd(job.estimateUsd)}`}${elapsed != null ? ` · ⏱ ${elapsed}s` : ""}`,
    ].join("\n");

    const videoUrl = job.videoUrl!;
    try {
      // Telegram télécharge lui-même les fichiers < 20 Mo
      await bot.api.sendVideo(job.chatId, videoUrl, { caption, parse_mode: "HTML", supports_streaming: true });
    } catch (err1) {
      console.warn(`sendVideo par URL a échoué (job ${job.id}), tentative en upload :`, err1 instanceof Error ? err1.message : err1);
      try {
        await bot.api.sendVideo(job.chatId, new InputFile(new URL(videoUrl), `video-${job.id}.mp4`), {
          caption,
          parse_mode: "HTML",
          supports_streaming: true,
        });
      } catch (err2) {
        console.error(`Upload de la vidéo impossible (job ${job.id}) :`, err2);
        await bot.api.sendMessage(job.chatId, `${caption}\n\n📎 Télécharge-la ici : ${videoUrl}`, { parse_mode: "HTML" });
      }
    }

    if (job.statusMessageId) {
      try {
        await bot.api.editMessageText(job.chatId, job.statusMessageId, `✅ Terminé — <i>Job ${job.id}</i>`, { parse_mode: "HTML" });
      } catch {
        /* ignore */
      }
    }
    pushEvent(
      store,
      job.chatId,
      `La vidéo du job ${job.id} (${model?.name ?? job.modelId}) est prête et vient d'être envoyée à l'utilisateur. URL : ${videoUrl}` +
        (job.expandedPrompt
          ? `\nLe modèle a RÉÉCRIT le prompt avant génération. Texte réellement utilisé : « ${job.expandedPrompt.slice(0, 600)} ». Si le rendu s'éloigne du réalisme demandé, c'est probablement là que ça s'est joué — signale-le et propose de relancer avec la réécriture désactivée.`
          : ""),
    );
  }

  /**
   * Quand tous les concurrents d'un duel ont rendu leur copie, on demande le
   * verdict. Un modèle en échec ne bloque pas : il est écarté du choix mais
   * reste compté comme participant — planter, c'est perdre.
   */
  async function askDuelVerdict(job: Job): Promise<void> {
    if (!job.duelId) return;
    const siblings = store.jobsForDuel(job.duelId);
    if (siblings.some((j) => j.status !== "done" && j.status !== "failed")) return;
    const finished = siblings.filter((j) => j.status === "done");
    if (finished.length < 2) return;
    if (siblings.some((j) => j.verdictAsked)) return;
    for (const j of siblings) { j.verdictAsked = true; store.saveJob(j); }

    const kb = new InlineKeyboard();
    for (const j of finished) {
      kb.text(`🏆 ${getModel(j.modelId)?.name ?? j.modelId}`, `duel:win:${job.duelId}:${j.modelId}`).row();
    }
    const total = siblings.reduce((a, j) => a + j.estimateUsd, 0);
    await bot.api.sendMessage(
      job.chatId,
      `⚔️ <b>Duel terminé</b> — ${finished.length} vidéos sur la même tâche (<code>${esc(job.taskKind ?? "?")}</code>, ${formatUsd(total)}).\n\n` +
        `<b>Laquelle est la meilleure ?</b> Ta réponse alimente le classement : je m'en servirai pour te conseiller la prochaine fois.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }

  async function failJob(job: Job, reason: string): Promise<void> {
    job.status = "failed";
    job.error = reason;
    job.finishedAt = Date.now();
    store.saveJob(job);
    const text = `❌ <b>Échec de la génération</b> (Job ${job.id})\n${esc(truncate(reason, 500))}\n\nEn général le fournisseur ne facture pas les requêtes en erreur.`;
    pushEvent(store, job.chatId, `Le job ${job.id} a échoué : ${reason}`);
    if (job.statusMessageId) {
      try {
        await bot.api.editMessageText(job.chatId, job.statusMessageId, text, { parse_mode: "HTML" });
        return;
      } catch {
        /* on envoie un nouveau message */
      }
    }
    await bot.api.sendMessage(job.chatId, text, { parse_mode: "HTML" });
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
