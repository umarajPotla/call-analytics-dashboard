/**
 * Run the traffic simulator as its own process, e.g. against an API whose in-process simulator is off:
 *   SIM_INGEST_URL=http://localhost:8080 pnpm --filter @calls/api simulate
 * It still needs DATABASE_URL: history is bulk-loaded (see backfill.ts) and its resume point is stored there.
 */
import { CATALOG } from "../catalog";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { createLogger } from "../observability/logger";
import { SimulatorRunner } from "./runner";
import { HttpSink } from "./sink";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = createPool(config.DATABASE_URL, 3);
const url = config.SIM_INGEST_URL ?? `http://127.0.0.1:${config.PORT}`;

const runner = new SimulatorRunner(
  db,
  new HttpSink(url),
  CATALOG,
  {
    seed: config.SIM_SEED,
    backfillDays: config.SIM_BACKFILL_DAYS,
    multiplier: config.SIM_RATE_MULTIPLIER,
    duplicateRate: config.SIM_DUPLICATE_RATE,
    reorderRate: config.SIM_REORDER_RATE,
  },
  log,
);
log.info({ url }, "simulator: sending events");
await runner.start();

const stop = async () => {
  runner.stop();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
