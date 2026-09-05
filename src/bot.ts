import { Bot, InlineKeyboard, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import { describeClaudeError, runAgentTurn, type AgentHooks } from "./agent.js";
import { config } from "./config.js";
import { cancelRequest, describeFalError, submitVideo, uploadImage } from "./fal.js";
import { MODELS, describeOptions, getModel } from "./models.js";
import { formatUsd } from "./pricing.js";
import type { HistoryMessage, Job, PendingGeneration, Session, Store } from "./store.js";
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

  async function launchJob(ctx: Context, session: Session, pending: PendingGeneration): Promise<void> {
    const model = getModel(pending.modelId)!;
    const input = model.buildInput({
      imageUrl: session.imageUrl!,
      prompt: pending.prompt,
      negativePrompt: pending.negativePrompt,
      opts: pending.options,
    });

    let requestId: string;
    try {
      requestId = await submitVideo(model.endpoint, input);
    } catch (err) {
      console.error("Erreur submit fal :", err);
      const reason = describeFalError(err);
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
