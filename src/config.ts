import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN manquant"),
  FAL_KEY: z.string().min(10, "FAL_KEY manquant"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Clé BytePlus ModelArk. Absente = les modèles BytePlus sont masqués. */
  BYTEPLUS_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  HISTORY_MAX_MESSAGES: z.coerce.number().int().min(10).default(40),
  ALLOWED_USER_IDS: z.string().default(""),
  // Chats où le bot a le droit de répondre. Vide = partout.
  ALLOWED_CHAT_IDS: z.string().default(""),
  MAX_COST_PER_VIDEO_USD: z.coerce.number().positive().default(5),
  DAILY_BUDGET_USD: z.coerce.number().positive().optional(),
  DATA_DIR: z.string().default("./data"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(2000).default(5000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuration invalide (.env) :");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const toIdSet = (raw: string) =>
  new Set(
    raw.split(",").map((v) => v.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)),
  );

export const config = {
  ...parsed.data,
  allowedChatIds: toIdSet(parsed.data.ALLOWED_CHAT_IDS),
  allowedUserIds: new Set(
    parsed.data.ALLOWED_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  ),
};

export type Config = typeof config;
