import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN manquant"),
  FAL_KEY: z.string().min(10, "FAL_KEY manquant"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  ALLOWED_USER_IDS: z.string().default(""),
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

export const config = {
  ...parsed.data,
  allowedUserIds: new Set(
    parsed.data.ALLOWED_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  ),
};

export type Config = typeof config;
