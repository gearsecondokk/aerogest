import { Bot, InlineKeyboard, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { describeFalError, submitVideo, uploadImage } from "./fal.js";
import { MODELS, defaultOptions, describeOptions, getModel, type OptionValue, type VideoModel } from "./models.js";
import { estimateCost, formatUsd } from "./pricing.js";
import { describeClaudeError, proposePrompt } from "./prompter.js";
import type { Job, Session, Store } from "./store.js";
import { downloadImageFromMessage } from "./telegram-files.js";
import { esc, truncate } from "./text.js";

export function createBot(store: Store): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ---- Contrôle d'accès ----------------------------------------------------
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
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
        "👋 Salut ! Je transforme tes <b>images en vidéos IA</b> via fal.ai.",
        "",
        "<b>Comment ça marche :</b>",
        "1️⃣ Envoie-moi une image (photo ou fichier)",
        "2️⃣ Choisis un modèle et ses options (durée, résolution…)",
        "3️⃣ Décris ce que tu veux : je te propose un prompt optimisé, qu'on affine ensemble",
        "4️⃣ Je t'annonce le <b>coût estimé</b> → tu confirmes ✅ / ❌",
        "5️⃣ Je t'envoie la vidéo dès qu'elle est prête 🎬",
        "",
        "Commandes : /models (modèles &amp; tarifs) · /jobs (générations en cours) · /history · /cancel · /id",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`Ton ID Telegram : <code>${ctx.from?.id}</code>\nID du chat : <code>${ctx.chat.id}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("models", async (ctx) => {
    const lines = MODELS.map((m) => `• <b>${esc(m.name)}</b> — ${esc(m.tagline)}\n   💰 ${esc(m.priceSummary)}`);
    await ctx.reply(`🎬 <b>Modèles disponibles</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    const s = store.getSession(ctx.chat.id);
    const hadImage = Boolean(s.imageUrl);
    store.resetSession(ctx.chat.id, hadImage);
    await ctx.reply(
      hadImage
        ? "❌ Annulé. Ton image est conservée : /again pour relancer avec, ou envoie une nouvelle image."
        : "❌ Annulé. Envoie-moi une image pour recommencer.",
    );
  });

  bot.command("again", async (ctx) => {
    const s = store.getSession(ctx.chat.id);
    if (!s.imageUrl) {
      await ctx.reply("Je n'ai pas d'image en mémoire. Envoie-m'en une !");
      return;
    }
    const fresh = store.resetSession(ctx.chat.id, true);
    await askModel(ctx, fresh);
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
    await ctx.reply(`📜 <b>Dernières générations</b>\n\n${lines.join("\n")}\n\n💸 Dépensé aujourd'hui (estimé) : ${formatUsd(store.spentToday())}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // ---- Réception d'une image ----------------------------------------------
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

    const session = store.resetSession(ctx.chat.id);
    session.imageUrl = imageUrl;
    session.imageFileId = img.fileId;
    store.saveSession(session);

    await askModel(ctx, session);
  });

  // ---- Callbacks -----------------------------------------------------------
  bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const model = getModel(ctx.match[1]!);
    if (!model || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Session expirée, renvoie une image." });
      return;
    }
    session.modelId = model.id;
    session.options = defaultOptions(model);
    session.history = [];
    session.proposal = undefined;
    session.state = "awaiting_options";
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🎬 Modèle : <b>${esc(model.name)}</b>\n💰 ${esc(model.priceSummary)}`, { parse_mode: "HTML" });
    await askNextOption(ctx, session, model, 0);
  });

  bot.callbackQuery(/^o:(\d+):(\d+)$/, async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const model = session.modelId ? getModel(session.modelId) : undefined;
    if (!model || session.state !== "awaiting_options") {
      await ctx.answerCallbackQuery({ text: "Cette étape n'est plus active." });
      return;
    }
    const optIndex = Number(ctx.match[1]);
    const choiceIndex = Number(ctx.match[2]);
    const opt = model.options[optIndex];
    const choice = opt?.choices[choiceIndex];
    if (!opt || !choice) {
      await ctx.answerCallbackQuery({ text: "Option inconnue." });
      return;
    }
    session.options[opt.key] = choice.value;
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`${esc(opt.label)} → <b>${esc(choice.label)}</b>`, { parse_mode: "HTML" });
    await askNextOption(ctx, session, model, optIndex + 1);
  });

  bot.callbackQuery("p:use", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const model = session.modelId ? getModel(session.modelId) : undefined;
    if (!model || !session.proposal || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Pas de prompt en attente." });
      return;
    }
    await ctx.answerCallbackQuery();
    await showCostAndConfirm(ctx, session, model);
  });

  bot.callbackQuery("p:redo", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    if (session.state !== "refining") {
      await ctx.answerCallbackQuery({ text: "Pas de prompt en attente." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Je cherche une autre approche…" });
    await runPrompter(ctx, session, "Propose une variante clairement différente (autre mouvement de caméra ou autre rythme), en gardant mon idée.");
  });

  bot.callbackQuery("p:manual", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    if (!session.modelId || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Session expirée." });
      return;
    }
    session.state = "awaiting_manual";
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    await ctx.reply("✍️ Envoie-moi le prompt exact à utiliser (en anglais de préférence).");
  });

  bot.callbackQuery("go:yes", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    const model = session.modelId ? getModel(session.modelId) : undefined;
    if (session.state !== "awaiting_confirm" || !model || !session.proposal || !session.imageUrl) {
      await ctx.answerCallbackQuery({ text: "Rien à confirmer." });
      return;
    }
    await ctx.answerCallbackQuery();
    await launchJob(ctx, session, model);
  });

  bot.callbackQuery("go:no", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    if (session.state !== "awaiting_confirm") {
      await ctx.answerCallbackQuery({ text: "Rien à annuler." });
      return;
    }
    session.state = "refining";
    store.saveSession(session);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("❌ Génération annulée. Tu peux modifier le prompt (envoie tes remarques) ou revalider.", {
      reply_markup: proposalKeyboard(),
    });
  });

  bot.callbackQuery("flow:cancel", async (ctx) => {
    const session = store.getSession(ctx.chat!.id);
    store.resetSession(ctx.chat!.id, Boolean(session.imageUrl));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("❌ Annulé. Envoie une nouvelle image, ou /again pour réutiliser la dernière.");
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
      const { cancelRequest } = await import("./fal.js");
      await cancelRequest(job.endpoint, job.requestId);
      job.status = "cancelled";
      store.saveJob(job);
      await ctx.answerCallbackQuery({ text: "Annulation demandée." });
      await ctx.editMessageText("🛑 Génération annulée (si elle avait déjà démarré côté fal, elle peut quand même être facturée).");
    } catch (err) {
      await ctx.answerCallbackQuery({ text: "Impossible d'annuler : " + truncate(describeFalError(err), 150) });
    }
  });

  // ---- Messages texte (état de la session) ---------------------------------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // commande inconnue
    const session = store.getSession(ctx.chat.id);
    const model = session.modelId ? getModel(session.modelId) : undefined;

    switch (session.state) {
      case "awaiting_idea":
      case "refining":
        if (!model || !session.imageUrl) break;
        await runPrompter(ctx, session, text);
        return;

      case "awaiting_manual":
        if (!model || !session.imageUrl) break;
        session.proposal = {
          prompt: model.maxPromptChars ? text.slice(0, model.maxPromptChars) : text,
          negative_prompt: null,
          explanation: "Prompt saisi manuellement.",
          question: null,
        };
        session.state = "refining";
        store.saveSession(session);
        await showCostAndConfirm(ctx, session, model);
        return;

      case "awaiting_model":
        await ctx.reply("Choisis d'abord un modèle avec les boutons ci-dessus 👆");
        return;

      case "awaiting_options":
        await ctx.reply("Réponds avec les boutons pour choisir les options 👆");
        return;

      case "awaiting_confirm":
        await ctx.reply("Confirme ou annule avec les boutons ✅ / ❌");
        return;

      default:
        break;
    }
    await ctx.reply("Envoie-moi une image pour commencer 🖼 (ou /again pour réutiliser la dernière).");
  });

  // ---- Helpers -------------------------------------------------------------

  async function askModel(ctx: Context, session: Session): Promise<void> {
    const kb = new InlineKeyboard();
    for (const m of MODELS) kb.text(`${m.name}`, `m:${m.id}`).row();
    kb.text("❌ Annuler", "flow:cancel");
    session.state = "awaiting_model";
    store.saveSession(session);
    const lines = MODELS.map((m) => `• <b>${esc(m.name)}</b> : ${esc(m.tagline)}\n   💰 ${esc(m.priceSummary)}`);
    await ctx.reply(`✅ Image reçue !\n\n<b>Quel modèle utiliser ?</b>\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }

  async function askNextOption(ctx: Context, session: Session, model: VideoModel, fromIndex: number): Promise<void> {
    const opt = model.options[fromIndex];
    if (opt) {
      const kb = new InlineKeyboard();
      opt.choices.forEach((c, i) => {
        kb.text(c.label, `o:${fromIndex}:${i}`);
        if (opt.choices.length > 3 && i % 2 === 1) kb.row();
      });
      kb.row().text("❌ Annuler", "flow:cancel");
      await ctx.reply(opt.label, { reply_markup: kb });
      return;
    }
    session.state = "awaiting_idea";
    store.saveSession(session);
    const summary = model.options.length ? `\n⚙️ ${esc(describeOptions(model, session.options))}` : "";
    const est = model.estimateUsd(session.options);
    await ctx.reply(
      [
        `🎬 <b>${esc(model.name)}</b>${summary}`,
        `💰 Coût estimé : <b>${formatUsd(est)}</b>`,
        "",
        "💡 <b>Décris-moi ce que tu veux voir</b> (mouvement du sujet, caméra, ambiance…). Même une idée vague suffit : je regarde l'image et je te propose un prompt optimisé pour ce modèle.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  async function runPrompter(ctx: Context, session: Session, userText: string): Promise<void> {
    const model = getModel(session.modelId!)!;
    const thinking = await ctx.reply("🤔 J'analyse l'image et je rédige le prompt…");
    await ctx.replyWithChatAction("typing");
    try {
      const { proposal, history } = await proposePrompt({
        model,
        options: session.options,
        imageUrl: session.imageUrl!,
        history: session.history,
        userText,
      });
      session.history = history;
      session.proposal = proposal;
      session.state = "refining";
      store.saveSession(session);

      const parts = [
        `📝 <b>Prompt proposé</b> (${esc(model.name)})`,
        `<code>${esc(proposal.prompt)}</code>`,
      ];
      if (proposal.negative_prompt) parts.push(`\n🚫 <b>Negative prompt</b>\n<code>${esc(proposal.negative_prompt)}</code>`);
      parts.push(`\n💬 ${esc(proposal.explanation)}`);
      if (proposal.question) parts.push(`\n❓ ${esc(proposal.question)}`);
      parts.push("\n👉 Valide, demande une variante, ou envoie-moi tes remarques pour l'affiner.");

      await ctx.api.editMessageText(thinking.chat.id, thinking.message_id, parts.join("\n"), {
        parse_mode: "HTML",
        reply_markup: proposalKeyboard(),
      });
    } catch (err) {
      console.error("Erreur prompter :", err);
      await ctx.api.editMessageText(
        thinking.chat.id,
        thinking.message_id,
        `❌ ${esc(describeClaudeError(err))}\n\nTu peux réessayer, ou écrire le prompt toi-même.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✍️ Écrire le prompt moi-même", "p:manual") },
      );
    }
  }

  async function showCostAndConfirm(ctx: Context, session: Session, model: VideoModel): Promise<void> {
    const proposal = session.proposal!;
    const est = await estimateCost(model, session.options);
    session.estimateUsd = est.usd;
    session.state = "awaiting_confirm";
    store.saveSession(session);

    const lines = [
      "🧾 <b>Récapitulatif</b>",
      `🎬 Modèle : <b>${esc(model.name)}</b>`,
    ];
    if (model.options.length) lines.push(`⚙️ ${esc(describeOptions(model, session.options))}`);
    lines.push(`📝 Prompt : <code>${esc(truncate(proposal.prompt, 600))}</code>`);
    if (proposal.negative_prompt) lines.push(`🚫 Negative : <code>${esc(truncate(proposal.negative_prompt, 200))}</code>`);
    lines.push("");
    lines.push(`💰 <b>Coût estimé : ${formatUsd(est.usd)}</b> (${est.billedSeconds} s facturées)`);
    if (est.live) {
      const liveLine = est.liveUsd != null ? ` → ${formatUsd(est.liveUsd)}` : "";
      lines.push(`   <i>Tarif fal.ai actuel : ${est.live.unit_price} ${esc(est.live.currency)} / ${esc(est.live.unit)}${liveLine}</i>`);
    }

    const warnings: string[] = [];
    const worst = Math.max(est.usd, est.liveUsd ?? 0);
    if (worst > config.MAX_COST_PER_VIDEO_USD) {
      warnings.push(`⛔️ Dépasse la limite par vidéo (${formatUsd(config.MAX_COST_PER_VIDEO_USD)}, MAX_COST_PER_VIDEO_USD).`);
    }
    if (config.DAILY_BUDGET_USD != null && store.spentToday() + worst > config.DAILY_BUDGET_USD) {
      warnings.push(
        `⛔️ Budget du jour dépassé : ${formatUsd(store.spentToday())} déjà engagés sur ${formatUsd(config.DAILY_BUDGET_USD)}.`,
      );
    }

    const kb = new InlineKeyboard();
    if (warnings.length === 0) {
      lines.push("", "<b>On lance la génération ?</b>");
      kb.text("✅ Oui, générer", "go:yes").text("❌ Non", "go:no");
    } else {
      lines.push("", ...warnings);
      kb.text("↩️ Modifier", "go:no");
    }
    kb.row().text("🗑 Tout annuler", "flow:cancel");

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  }

  async function launchJob(ctx: Context, session: Session, model: VideoModel): Promise<void> {
    const proposal = session.proposal!;
    const input = model.buildInput({
      imageUrl: session.imageUrl!,
      prompt: proposal.prompt,
      negativePrompt: proposal.negative_prompt,
      opts: session.options,
    });

    let requestId: string;
    try {
      requestId = await submitVideo(model.endpoint, input);
    } catch (err) {
      console.error("Erreur submit fal :", err);
      await ctx.reply(`❌ Impossible de lancer la génération : ${esc(describeFalError(err))}`, { parse_mode: "HTML" });
      session.state = "refining";
      store.saveSession(session);
      return;
    }

    const job: Job = {
      id: randomUUID().slice(0, 8),
      chatId: ctx.chat!.id,
      userId: ctx.from!.id,
      requestId,
      modelId: model.id,
      endpoint: model.endpoint,
      input,
      prompt: proposal.prompt,
      estimateUsd: session.estimateUsd ?? model.estimateUsd(session.options),
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

    // On garde l'image et le modèle pour enchaîner facilement.
    const fresh = store.resetSession(ctx.chat!.id, true);
    fresh.modelId = model.id;
    fresh.options = { ...session.options };
    store.saveSession(fresh);
  }

  return bot;
}

function proposalKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Valider ce prompt", "p:use")
    .row()
    .text("🔄 Autre proposition", "p:redo")
    .text("✍️ Prompt manuel", "p:manual")
    .row()
    .text("❌ Annuler", "flow:cancel");
}

export type { OptionValue };
