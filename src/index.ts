import { config } from "./config.js";
import { createBot } from "./bot.js";
import { startJobPoller } from "./jobs.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  const store = new Store(config.DATA_DIR);
  const bot = createBot(store);

  if (config.allowedUserIds.size === 0) {
    console.warn("⚠️  ALLOWED_USER_IDS est vide : n'importe qui peut utiliser le bot (et dépenser tes crédits fal.ai).");
  }

  await bot.api.setMyCommands([
    { command: "start", description: "Présentation du bot" },
    { command: "models", description: "Modèles disponibles et tarifs" },
    { command: "again", description: "Nouvelle vidéo avec la dernière image" },
    { command: "jobs", description: "Générations en cours" },
    { command: "history", description: "Dernières générations" },
    { command: "cancel", description: "Annuler l'étape en cours" },
    { command: "id", description: "Afficher mon ID Telegram" },
  ]);

  const stopPoller = startJobPoller(bot, store);
  const active = store.activeJobs().length;
  if (active > 0) console.log(`↻ ${active} génération(s) en cours reprise(s) après redémarrage.`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} reçu, arrêt…`);
    stopPoller();
    await bot.stop();
    store.flush();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  const me = await bot.api.getMe();
  console.log(`🤖 Bot @${me.username} démarré (modèle Claude : ${config.CLAUDE_MODEL}).`);
  await bot.start({ drop_pending_updates: false });
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
