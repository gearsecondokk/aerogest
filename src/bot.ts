import { Bot, InlineKeyboard, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import { describeClaudeError, runAgentTurn, type AgentHooks } from "./agent.js";
import { config } from "./config.js";
import { cancelRequest, describeFalError, uploadImage } from "./fal.js";
import { submitVideo, describeError } from "./provider.js";
import { MODELS, defaultOptions, describeOptions, getModel } from "./models.js";
import { estimateCost, formatUsd } from "./pricing.js";
import type { HistoryMessage, Job, PendingDuel, PendingGeneration, Session, Store } from "./store.js";
import { downloadImageFromMessage } from "./telegram-files.js";
import { esc, truncate } from "./text.js";

const TELEGRAM_MAX = 4000;

/** Ajoute une note système ([Événement]) dans la conversation d'un chat. */
export function pushEvent(store: Store, chatId: number, text: string): void {
  const session = store.getSession(chatId);
  session.history.push({ role: "user", content: `[Événement] ${text}` });
  store.saveSession(session);
}

export function createBot(store: Store): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  /** Un seul tour d'agent à la fois par chat */
  const busy = new Set<number>();

  // ---- Contrôle d'accès ----------------------------------------------------
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;

    // Verrou par CHAT : le bot ne répond que dans les chats listés. On sort en
    // silence ailleurs — pas de message d'erreur, qui ne ferait que signaler
    // son existence à qui l'aurait ajouté sans autorisation. Le /id reste
    // joignable en privé pour pouvoir récupérer un identifiant.
    const chatId = ctx.chat?.id;
    if (config.allowedChatIds.size > 0 && chatId !== undefined && !config.allowedChatIds.has(chatId)) {
      if (ctx.hasCommand("id") && ctx.chat?.type === "private") return next();
      return;
    }

    if (ctx.hasCommand("id")) return next();
    if (config.allowedUserIds.size > 0 && (!uid || !config.allowedUserIds.has(uid))) {
      if (ctx.message) {
        await ctx.reply(
          `⛔️ Accès refusé. Ton ID Telegram est <code>${uid ?? "?"}</code> : ajoute-le à ALLOWED_USER_IDS dans le .env.`,
          { parse_mode: "HTML" },
        );
      } else if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Accès refusé." });
      }
      return;
    }
    return next();
  });

  bot.catch((err) => {
    console.error("Erreur non gérée dans un handler :", err.error);
  });

  // ---- Commandes -----------------------------------------------------------
  bot.command("start", async (ctx) => {
    store.resetSession(ctx.chat.id);
    await ctx.reply(
      [
        "👋 Salut ! Je suis Claude, et je transforme tes <b>images en vidéos IA</b> via fal.ai.",
        "",
        "Envoie-moi une image et parle-moi normalement : dis-moi ce que tu veux voir bouger, l'ambiance, la durée… Je te conseille un modèle, je rédige le prompt avec toi, je t'annonce le <b>coût</b> et je lance la génération quand tu appuies sur ✅. La vidéo arrive ici dès qu'elle est prête 🎬",
        "",
        "Commandes : /models (tarifs) · /jobs · /history · /new (nouvelle conversation) · /id",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`Ton ID Telegram : <code>${ctx.from?.id}</code>\nID du chat : <code>${ctx.chat.id}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command(["new", "cancel", "reset"], async (ctx) => {
    store.resetSession(ctx.chat.id);
    busy.delete(ctx.chat.id);
    await ctx.reply("🧹 Nouvelle conversation. Envoie-moi une image pour commencer.");
  });

  bot.command("stats", async (ctx) => {
    const all = store.ratings();
    if (Object.keys(all).length === 0) {
      await ctx.reply("Aucun verdict enregistré. Lance un duel (⚔️) pour commencer à construire le classement.");
      return;
    }
    const blocks = Object.entries(all).map(([kind, rows]) => {
      const lines = rows.map((x, i) => `${i + 1}. ${getModel(x.modelId)?.name ?? x.modelId} — ${x.wins}/${x.runs} (${Math.round(x.rate * 100)} %)`);
      return `<b>${esc(kind)}</b>\n${esc(lines.join("\n"))}`;
    });
    await ctx.reply(`📊 <b>Classement interne</b>\n\n${blocks.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("models", async (ctx) => {
    const lines = MODELS.map((m) => `• <b>${esc(m.name)}</b> — ${esc(m.tagline)}\n   💰 ${esc(m.priceSummary)}`);
    await ctx.reply(`🎬 <b>Modèles disponibles</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("jobs", async (ctx) => {
    const jobs = store.activeJobs().filter((j) => j.chatId === ctx.chat.id);
    if (jobs.length === 0) {
      await ctx.reply("Aucune génération en cours.");
      return;
    }
    const lines = jobs.map((j) => {
      const m = getModel(j.modelId);
      const st = j.status === "queued" ? `⏳ file d'attente${j.queuePosition != null ? ` (pos. ${j.queuePosition})` : ""}` : "⚙️ en cours";
      return `• <b>${esc(m?.name ?? j.modelId)}</b> — ${st} — ${formatUsd(j.estimateUsd)}\n   <i>${esc(truncate(j.prompt, 80))}</i>`;
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("history", async (ctx) => {
    const jobs = store.jobsForChat(ctx.chat.id, 10);
    if (jobs.length === 0) {
      await ctx.reply("Aucune génération pour l'instant.");
      return;
    }
    const icons: Record<Job["status"], string> = { queued: "⏳", running: "⚙️", done: "✅", failed: "❌", cancelled: "🛑" };
    const lines = jobs.map((j) => {
      const m = getModel(j.modelId);
      const date = new Date(j.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
      const link = j.videoUrl ? ` — <a href="${j.videoUrl}">vidéo</a>` : "";
      return `${icons[j.status]} ${date} · <b>${esc(m?.name ?? j.modelId)}</b> · ${formatUsd(j.estimateUsd)}${link}\n   <i>${esc(truncate(j.prompt, 80))}</i>`;
    });
    await ctx.reply(
      `📜 <b>Dernières générations</b>\n\n${lines.join("\n")}\n\n💸 Dépensé aujourd'hui (estimé) : ${formatUsd(store.spentToday())}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  // ---- Image → on la montre à Claude ---------------------------------------
  bot.on(["message:photo", "message:document"], async (ctx) => {
    let img;
    try {
      img = await downloadImageFromMessage(ctx);
    } catch (err) {
      await ctx.reply(`❌ ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" });
      return;
    }
    if (!img) {
      await ctx.reply("Je ne prends que des images (photo ou fichier image).");
      return;
    }

    await ctx.replyWithChatAction("upload_photo");
    let imageUrl: string;
    try {
      imageUrl = await uploadImage(img.bytes, img.mimeType, img.filename);
    } catch (err) {
      await ctx.reply(`❌ Upload vers fal.ai impossible : ${esc(describeFalError(err))}`, { parse_mode: "HTML" });
      return;
    }

    const session = store.getSession(ctx.chat.id);
    session.imageUrl = imageUrl;
    // On EMPILE au lieu d'écraser : le mode référence→vidéo a besoin de
    // plusieurs vues du même personnage. Plafonné pour ne pas gonfler
    // l'état indéfiniment ; /new repart de zéro.
    session.imageUrls = [...(session.imageUrls ?? []), imageUrl].slice(-8);
    session.imageFileId = img.fileId;
    session.pending = undefined;
    const caption = ctx.message.caption?.trim();
    const message: HistoryMessage = {
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        {
          type: "text",
          text: caption
            ? `[Événement] Nouvelle image envoyée (elle devient l'image courante). Message joint : ${caption}`
            : "[Événement] Nouvelle image envoyée (elle devient l'image courante).",
        },
      ],
    };
    await converse(ctx, session, message);
  });

  // ---- Texte libre → Claude -------------------------------------------------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // commande inconnue
    const session = store.getSession(ctx.chat.id);
    await converse(ctx, session, { role: "user", content: text });
  });

  // ---- Boutons de confirmation ---------------------------------------------
  bot.callbackQuery("go:yes", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const pending = session.pending;
    if (!pending || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Cette proposition n'est plus valable." });
      return;
    }
    await ctx.answerCallbackQuery();
    session.pending = undefined;
    store.saveSession(session);
    await launchJob(ctx, session, pending);
  });

  bot.callbackQuery(/^duel:t:(.+)$/, async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const duel = session.pendingDuel;
    if (!duel) { await ctx.answerCallbackQuery({ text: "Ce duel n'est plus valable." }); return; }
    const id = ctx.match[1]!;
    duel.selected = duel.selected.includes(id) ? duel.selected.filter((x) => x !== id) : [...duel.selected, id];
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    await refreshDuelCard(ctx, duel);
  });

  bot.callbackQuery("duel:more", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const duel = session.pendingDuel;
    if (!duel) { await ctx.answerCallbackQuery({ text: "Ce duel n'est plus valable." }); return; }
    const refCount = (session.imageUrls ?? []).length;
    // On n'ajoute au choix que ce qui est réellement lançable ici : un modèle
    // référence sans assez d'images ferait échouer le duel au lancement.
    const rest = MODELS.filter((m) => !duel.candidates.includes(m.id) && (!m.needsReferences || refCount >= 2));
    if (rest.length === 0) { await ctx.answerCallbackQuery({ text: "Tout le catalogue est déjà proposé." }); return; }
    const kb = new InlineKeyboard();
    for (const m of rest) kb.text(`➕ ${m.name}`, `duel:a:${m.id}`).row();
    kb.text("↩︎ Retour", "duel:back");
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("Quel modèle ajouter au duel ?", { reply_markup: kb });
    } catch { /* ignoré */ }
  });

  bot.callbackQuery(/^duel:a:(.+)$/, async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const duel = session.pendingDuel;
    if (!duel) { await ctx.answerCallbackQuery({ text: "Ce duel n'est plus valable." }); return; }
    const id = ctx.match[1]!;
    if (!duel.candidates.includes(id)) duel.candidates.push(id);
    if (!duel.selected.includes(id)) duel.selected.push(id);
    store.saveSession(session);
    await ctx.answerCallbackQuery({ text: "Ajouté" });
    await refreshDuelCard(ctx, duel);
  });

  bot.callbackQuery("duel:back", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const duel = session.pendingDuel;
    if (!duel) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await refreshDuelCard(ctx, duel);
  });

  bot.callbackQuery("duel:go", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const duel = session.pendingDuel;
    if (!duel || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Ce duel n'est plus valable." });
      return;
    }
    const cap = config.MAX_COST_PER_DUEL_USD ?? config.MAX_COST_PER_VIDEO_USD * 4;
    if (duel.selected.length < 2) {
      await ctx.answerCallbackQuery({ text: "Coche au moins 2 modèles pour comparer.", show_alert: true });
      return;
    }
    if (duel.totalUsd > cap) {
      await ctx.answerCallbackQuery({ text: `Total ${duel.totalUsd.toFixed(2)} $ > plafond ${cap} $. Décoche un modèle.`, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    session.pendingDuel = undefined;
    store.saveSession(session);
    await launchDuel(ctx, session, duel);
  });

  bot.callbackQuery(/^duel:win:([^:]+):(.+)$/, async (ctx) => {
    const duelId = ctx.match[1]!;
    const winnerId = ctx.match[2]!;
    const jobs = store.jobsForDuel(duelId);
    if (jobs.length === 0) {
      await ctx.answerCallbackQuery({ text: "Duel introuvable." });
      return;
    }
    const kind = jobs[0]!.taskKind ?? "inconnu";
    store.recordDuelWinner(kind, winnerId, jobs.map((j) => j.modelId));
    await ctx.answerCallbackQuery({ text: "Verdict enregistré 🏆" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch { /* déjà modifié */ }
    const board = store.ratings(kind)[kind] ?? [];
    const standing = board
      .map((x, i) => `${i + 1}. ${getModel(x.modelId)?.name ?? x.modelId} — ${x.wins}/${x.runs} (${Math.round(x.rate * 100)} %)`)
      .join("\n");
    await ctx.reply(
      `🏆 <b>${esc(getModel(winnerId)?.name ?? winnerId)}</b> retenu pour <code>${esc(kind)}</code>.\n\n<b>Classement</b>\n${esc(standing)}`,
      { parse_mode: "HTML" },
    );
    const session = store.getSession(ctx.chat!.id);
    pushEvent(
      store,
      session.chatId,
      `[Événement] L'utilisateur a désigné ${getModel(winnerId)?.name ?? winnerId} comme meilleur sur la tâche « ${kind} ». Classement mis à jour. Tiens-en compte pour tes prochaines recommandations.`,
    );
  });

  bot.callbackQuery("go:no", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    if (!session.pending) {
      await ctx.answerCallbackQuery({ text: "Rien à annuler." });
      return;
    }
    session.pending = undefined;
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      /* déjà modifié */
    }
    await converse(ctx, session, {
      role: "user",
      content: "[Événement] L'utilisateur a refusé la génération proposée (❌). Demande-lui ce qu'il veut changer.",
    });
  });

  bot.callbackQuery(/^j:cancel:(.+)$/, async (ctx) => {
    const job = store.getJob(ctx.match[1]!);
    if (!job || job.chatId !== ctx.chat!.id) {
      await ctx.answerCallbackQuery({ text: "Job introuvable." });
      return;
    }
    if (job.status !== "queued" && job.status !== "running") {
      await ctx.answerCallbackQuery({ text: "Ce job est déjà terminé." });
      return;
    }
    try {
      await cancelRequest(job.endpoint, job.requestId);
      job.status = "cancelled";
      store.saveJob(job);
      await ctx.answerCallbackQuery({ text: "Annulation demandée." });
      await ctx.editMessageText("🛑 Génération annulée (si elle avait déjà démarré côté fal, elle peut quand même être facturée).");
      pushEvent(store, job.chatId, `L'utilisateur a annulé le job ${job.id}.`);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: "Impossible d'annuler : " + truncate(describeFalError(err), 150) });
    }
  });

  // ---- Helpers -------------------------------------------------------------

  const hooks: AgentHooks = {
    showDuelConfirmation: async (session, duel) => showDuelCard(session, duel),
    showConfirmation: async (session, pending) => {
      const model = getModel(pending.modelId)!;
      const lines = [
        "🧾 <b>Récapitulatif</b>",
        `🎬 Modèle : <b>${esc(model.name)}</b>`,
      ];
      if (model.options.length) lines.push(`⚙️ ${esc(describeOptions(model, pending.options))}`);
      lines.push(`📝 Prompt : <code>${esc(truncate(pending.prompt, 700))}</code>`);
      if (pending.negativePrompt) lines.push(`🚫 Negative : <code>${esc(truncate(pending.negativePrompt, 200))}</code>`);
      lines.push("", `💰 <b>Coût estimé : ${formatUsd(pending.estimateUsd)}</b> (${pending.billedSeconds} s facturées)`, "", "<b>On lance ?</b>");
      const kb = new InlineKeyboard().text("✅ Oui, générer", "go:yes").text("❌ Non", "go:no");
      const msg = await bot.api.sendMessage(session.chatId, lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return msg.message_id;
    },
  };

  /** Ajoute un message à la conversation, fait répondre Claude, envoie la réponse. */
  async function converse(ctx: Context, session: Session, message: HistoryMessage): Promise<void> {
    const chatId = session.chatId;
    if (busy.has(chatId)) {
      // On garde le message pour le prochain tour plutôt que de le perdre.
      session.history.push(message);
      store.saveSession(session);
      await ctx.reply("⏳ Je finis de répondre à ton message précédent, je prends celui-ci juste après.");
      return;
    }
    busy.add(chatId);
    session.history.push(message);
    store.saveSession(session);

    const typing = setInterval(() => void ctx.api.sendChatAction(chatId, "typing").catch(() => {}), 4000);
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    try {
      const { text } = await runAgentTurn(session, store, hooks);
      for (const chunk of splitMessage(text)) {
        await ctx.api.sendMessage(chatId, chunk);
      }
    } catch (err) {
      console.error("Erreur agent :", err);
      await ctx.api.sendMessage(chatId, `❌ ${describeClaudeError(err)}`);
    } finally {
      clearInterval(typing);
      busy.delete(chatId);
    }
  }

  /* ── Duels ─────────────────────────────────────────────────────────
   * Plusieurs modèles sur la même tâche, l'utilisateur tranche, le classement
   * se construit sur ses verdicts. Aucun modèle n'est meilleur dans l'absolu :
   * ça dépend du type de demande et de son goût à lui. */

  /** Coût d'un modèle aux options du duel. */
  async function duelLineCost(modelId: string, opts: PendingDuel["options"]): Promise<number> {
    const m = getModel(modelId);
    if (!m) return 0;
    const est = await estimateCost(m, { ...defaultOptions(m), ...opts });
    return est.liveUsd ?? est.usd;
  }

  /** Texte + clavier de la carte, recalculés à chaque coche. */
  async function duelCard(duel: PendingDuel): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const kb = new InlineKeyboard();
    let total = 0;
    const lines: string[] = [];
    for (const id of duel.candidates) {
      const m = getModel(id);
      if (!m) continue;
      const c = await duelLineCost(id, duel.options);
      const on = duel.selected.includes(id);
      if (on) total += c;
      // Seedance refuse les images de personnes : autant le dire sur la carte
      // plutôt que de laisser un concurrent mourir au lancement.
      const veto = duel.withImages && m.refusesHumanInputImages;
      lines.push(`${on ? "☑️" : "☐"} <b>${esc(m.name)}</b> — ${formatUsd(c)}${veto ? " 🚫 <i>refusera une image de personne</i>" : ""}`);
      kb.text(`${on ? "☑️" : "☐"} ${m.name}${veto ? " 🚫" : ""} · ${c.toFixed(2)} $`, `duel:t:${id}`).row();
    }
    const cap = config.MAX_COST_PER_DUEL_USD ?? config.MAX_COST_PER_VIDEO_USD * 4;
    const over = total > cap;
    kb.text("➕ Ajouter un modèle", "duel:more").row();
    kb.text(duel.selected.length >= 2 && !over ? "✅ Lancer" : "✅ Lancer (indisponible)", "duel:go").text("❌ Annuler", "go:no");
    const warn = over
      ? `\n\n⚠️ ${formatUsd(total)} dépasse le plafond de duel (${formatUsd(cap)}) — décoche un modèle.`
      : duel.selected.length < 2
        ? "\n\n⚠️ Il faut au moins 2 modèles pour comparer."
        : "";
    const text =
      `⚔️ <b>Duel — coche les modèles à comparer</b>\n\n${lines.join("\n")}\n\n` +
      `🏷 Type : <code>${esc(duel.taskKind)}</code>\n` +
      `💰 <b>Total sélectionné : ${formatUsd(total)}</b> (${duel.selected.length} modèle${duel.selected.length > 1 ? "s" : ""})${warn}`;
    duel.totalUsd = Number(total.toFixed(4));
    return { text, keyboard: kb };
  }

  async function showDuelCard(session: Session, duel: PendingDuel): Promise<number | undefined> {
    const { text, keyboard } = await duelCard(duel);
    const msg = await bot.api.sendMessage(session.chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    return msg.message_id;
  }

  async function refreshDuelCard(ctx: Context, duel: PendingDuel): Promise<void> {
    const { text, keyboard } = await duelCard(duel);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch { /* contenu identique */ }
  }

  async function launchDuel(ctx: Context, session: Session, duel: PendingDuel): Promise<void> {
    const duelId = randomUUID().slice(0, 8);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch { /* déjà modifié */ }

    const launched: string[] = [];
    for (const modelId of duel.selected) {
      const model = getModel(modelId);
      if (!model) continue;
      const opts = { ...defaultOptions(model), ...duel.options };
      const input = model.buildInput({
        imageUrl: session.imageUrl!,
        imageUrls: session.imageUrls ?? [session.imageUrl!],
        prompt: duel.prompt,
        negativePrompt: duel.negativePrompt,
        opts,
      });
      let requestId: string;
      try {
        requestId = await submitVideo(model.provider ?? "fal", model.endpoint, input);
      } catch (err) {
        // Un concurrent qui tombe ne doit pas faire échouer tout le duel.
        await ctx.reply(`⚠️ ${esc(model.name)} n'a pas pu être lancé : ${esc(describeError(model.provider ?? "fal", err))}`, { parse_mode: "HTML" });
        continue;
      }
      const est = await estimateCost(model, opts);
      const job: Job = {
        id: randomUUID().slice(0, 8),
        chatId: session.chatId,
        userId: ctx.from!.id,
        requestId,
        modelId: model.id,
        endpoint: model.endpoint,
        provider: model.provider ?? "fal",
        input,
        prompt: duel.prompt,
        estimateUsd: Number((est.liveUsd ?? est.usd).toFixed(4)),
        status: "queued",
        duelId,
        taskKind: duel.taskKind,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.addJob(job);
      store.addSpend(job.estimateUsd);
      launched.push(model.name);
    }

    if (launched.length === 0) {
      await ctx.reply("❌ Aucun modèle n'a pu être lancé.");
      return;
    }
    await ctx.reply(
      `⚔️ <b>Duel lancé</b> (${launched.length} modèles)\n⏳ Les vidéos arrivent au fur et à mesure. Je te demanderai laquelle est la meilleure quand tout sera prêt.`,
      { parse_mode: "HTML" },
    );
    pushEvent(
      store,
      session.chatId,
      `[Événement] Duel ${duelId} lancé sur ${launched.join(", ")} (tâche « ${duel.taskKind} »). L'utilisateur désignera le gagnant à la fin.`,
    );
  }

  async function launchJob(ctx: Context, session: Session, pending: PendingGeneration): Promise<void> {
    const model = getModel(pending.modelId)!;
    const input = model.buildInput({
      imageUrl: session.imageUrl!,
      imageUrls: session.imageUrls ?? [session.imageUrl!],
      prompt: pending.prompt,
      negativePrompt: pending.negativePrompt,
      opts: pending.options,
    });

    let requestId: string;
    try {
      requestId = await submitVideo(model.provider ?? "fal", model.endpoint, input);
    } catch (err) {
      console.error("Erreur submit :", err);
      const reason = describeError(model.provider ?? "fal", err);
      await ctx.reply(`❌ Impossible de lancer la génération : ${esc(reason)}`, { parse_mode: "HTML" });
      await converse(ctx, session, {
        role: "user",
        content: `[Événement] Le lancement a échoué côté fal.ai : ${reason}. Explique et propose une correction.`,
      });
      return;
    }

    const job: Job = {
      id: randomUUID().slice(0, 8),
      chatId: session.chatId,
      userId: ctx.from!.id,
      requestId,
      modelId: model.id,
      endpoint: model.endpoint,
      provider: model.provider ?? "fal",
      input,
      prompt: pending.prompt,
      estimateUsd: pending.estimateUsd,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.addJob(job);
    store.addSpend(job.estimateUsd);

    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      /* message déjà modifié */
    }

    const statusMsg = await ctx.reply(
      `🚀 <b>Génération lancée</b> (${esc(model.name)}, ~${formatUsd(job.estimateUsd)})\n⏳ En file d'attente… je te préviens dès que c'est prêt.\n<i>Job ${job.id}</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🛑 Annuler", `j:cancel:${job.id}`) },
    );
    job.statusMessageId = statusMsg.message_id;
    store.saveJob(job);

    pushEvent(
      store,
      session.chatId,
      `L'utilisateur a confirmé (✅). Génération lancée : job ${job.id}, ${model.name}, ~${formatUsd(job.estimateUsd)}. Il sera prévenu automatiquement quand la vidéo sera prête.`,
    );
  }

  return bot;
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX);
    if (cut < TELEGRAM_MAX / 2) cut = TELEGRAM_MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
