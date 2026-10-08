import { buildApp } from "./app";
import { CATALOG } from "./catalog";
import { loadConfig } from "./config";
import { migrate } from "./db/migrate";
import { createPool, type Db } from "./db/pool";
import { seedReferenceData } from "./db/seed";
import { CampaignDirectory } from "./ingest/campaignDirectory";
import { IngestService } from "./ingest/ingestService";
import { CircuitBreaker, LlmGateway, OpenAICompatibleProvider } from "./insights/gateway";
import { InsightGenerator, loadPrompt } from "./insights/generator";
import { InsightsService } from "./insights/service";
import { startJobs } from "./jobs";
import { createLogger } from "./observability/logger";
import { Metrics } from "./observability/metrics";
import { PgListener } from "./realtime/pgListener";
import { SseHub } from "./realtime/sseHub";
import { SimulatorRunner } from "./simulator/runner";
import { HttpSink } from "./simulator/sink";

/**
 * Production wiring. Everything is constructed here and passed down explicitly; no module reaches for globals,
 * which is what lets the integration tests build the same app against a test database.
 */
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);

const db = createPool(config.DATABASE_URL);
await waitForDatabase(db);
{
  // Migrations hold a session-level advisory lock, so they need a real session: on Neon that is the direct
  // (non-pooled) URL. Locally both URLs are the same database.
  const direct = config.DATABASE_URL_DIRECT ? createPool(config.DATABASE_URL_DIRECT, 1) : db;
  const applied = await migrate(direct);
  if (applied.length) log.info({ applied }, "migrations applied");
  if (direct !== db) await direct.end();
}
await seedReferenceData(db);

const campaigns = new CampaignDirectory(db);
await campaigns.load();
const metrics = new Metrics();
const hub = new SseHub(metrics.hubObserver);
const ingest = new IngestService(db, campaigns, metrics.ingestObserver);

const gateway =
  config.LLM_BASE_URL && config.LLM_MODEL
    ? new LlmGateway(
        new OpenAICompatibleProvider({
          baseUrl: config.LLM_BASE_URL,
          model: config.LLM_MODEL,
          apiKey: config.LLM_API_KEY,
          timeoutMs: config.LLM_TIMEOUT_MS,
        }),
        new CircuitBreaker(5, 60_000, 30_000),
        metrics.gatewayObserver({
          inputPerMTok: config.LLM_PRICE_INPUT_PER_MTOK,
          outputPerMTok: config.LLM_PRICE_OUTPUT_PER_MTOK,
        }),
      )
    : null;
const insights = new InsightsService(
  db,
  new InsightGenerator(gateway, loadPrompt(), 2 * config.LLM_TIMEOUT_MS),
  {
    metrics,
    log,
    budgetPerHour: config.INSIGHTS_LLM_BUDGET_PER_HOUR,
  },
);
log.info(
  { model: gateway?.model ?? null },
  gateway ? "insights: LLM enabled" : "insights: template only (no LLM configured)",
);

let simulator: SimulatorRunner | undefined;
const app = await buildApp({
  config,
  db,
  campaigns,
  ingest,
  hub,
  metrics,
  insights,
  logger: log,
  spike: (accountId) => simulator?.spike(accountId),
});

// Live feed: one LISTEN connection per instance. It needs a real session, so on Neon use the direct (non-pooled) URL.
const listener = new PgListener(
  config.DATABASE_URL_DIRECT || config.DATABASE_URL,
  (u) => hub.publish(u),
  log,
  () => hub.resyncAll(),
);
await listener.start();

await app.listen({ port: config.PORT, host: config.HOST });
const stopJobs = startJobs(db, metrics, log, {
  eventRetentionDays: config.EVENT_RETENTION_DAYS,
  dataRetentionDays: config.DATA_RETENTION_DAYS,
});

if (config.SIM_ENABLED) {
  // The simulator is a client of the public ingest API, exactly like a telephony integration would be.
  const sink = new HttpSink(config.SIM_INGEST_URL ?? `http://127.0.0.1:${config.PORT}`);
  simulator = new SimulatorRunner(
    db,
    sink,
    CATALOG,
    {
      seed: config.SIM_SEED,
      backfillDays: config.SIM_BACKFILL_DAYS,
      multiplier: config.SIM_RATE_MULTIPLIER,
      duplicateRate: config.SIM_DUPLICATE_RATE,
      reorderRate: config.SIM_REORDER_RATE,
    },
    log.child({ component: "simulator" }),
  );
  // Don't block readiness on history loading; the API serves whatever is there.
  simulator.start().catch((err) => log.error({ err }, "simulator failed to start"));
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  simulator?.stop();
  stopJobs();
  hub.close(); // tells browsers to reconnect (to the next instance) in 2 s
  await app.close();
  await listener.stop();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** Free-tier databases (Neon) cold-start in a few seconds; Docker Compose may start us first. Wait, don't crash-loop. */
async function waitForDatabase(pool: Db, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn({ attempt: i, err: (err as Error).message }, "database not reachable yet, retrying");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
