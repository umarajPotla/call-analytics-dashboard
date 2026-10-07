import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_DIRECT: z.string().optional(),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().default("development"),
  WEB_DIST: z.string().optional(),
  GRAFANA_URL: z.string().optional(),
  SIM_ENABLED: bool,
  SIM_SEED: z.coerce.number().int().default(42),
  SIM_BACKFILL_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  SIM_RATE_MULTIPLIER: z.coerce.number().positive().default(1),
  SIM_DUPLICATE_RATE: z.coerce.number().min(0).max(0.5).default(0.02),
  SIM_REORDER_RATE: z.coerce.number().min(0).max(0.5).default(0.01),
  SIM_INGEST_URL: z.string().optional(),
  DEV_TOOLS: bool,
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(4),
  DATA_RETENTION_DAYS: z.coerce.number().int().min(8).default(35),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(8000),
  LLM_PRICE_INPUT_PER_MTOK: z.coerce.number().min(0).default(0),
  LLM_PRICE_OUTPUT_PER_MTOK: z.coerce.number().min(0).default(0),
  INSIGHTS_LLM_BUDGET_PER_HOUR: z.coerce.number().int().min(0).default(30),
});

export type Config = z.infer<typeof Env>;

/** Fail fast with a readable message instead of a stack trace when the environment is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  return parsed.data;
}
