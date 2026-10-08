import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db/pool";
import { rollupDrift } from "./db/rollups";
import type { Metrics } from "./observability/metrics";

const DAY = 86_400_000;
const BATCH = 10_000;

export type JobOptions = { eventRetentionDays: number; dataRetentionDays: number };

/**
 * Background housekeeping, run in-process (one instance in the demo; with several instances these would take an
 * advisory lock or move to a scheduled worker).
 *  - drift check every 5 min: the rollup must equal a recount of calls; exported as a gauge and alerted on
 *  - retention every hour: keeps the free-tier database small. The event log is kept 4 days, longer than the
 *    72 h late-conversion window, so idempotency by event id covers every realistic redelivery; anything older
 *    is still harmless because the state machine only moves forward.
 */
export function startJobs(db: Db, metrics: Metrics, log: FastifyBaseLogger, opts: JobOptions): () => void {
  const drift = async () => {
    try {
      const n = await rollupDrift(db, new Date(Date.now() - 2 * DAY));
      metrics.rollupDrift.set(n);
      if (n > 0) log.error({ buckets: n }, "rollup drift detected");
    } catch (err) {
      log.warn({ err }, "drift check failed");
    }
  };
  const retention = async () => {
    try {
      const deleted = await prune(db, opts);
      if (deleted.events + deleted.calls > 0) log.info(deleted, "retention: pruned old rows");
    } catch (err) {
      log.warn({ err }, "retention job failed");
    }
  };

  const t1 = setTimeout(drift, 30_000);
  const i1 = setInterval(drift, 5 * 60_000);
  const t2 = setTimeout(retention, 60_000);
  const i2 = setInterval(retention, 60 * 60_000);
  for (const t of [t1, i1, t2, i2]) t.unref();
  return () => {
    clearTimeout(t1);
    clearTimeout(t2);
    clearInterval(i1);
    clearInterval(i2);
  };
}

export async function prune(db: Db, opts: JobOptions): Promise<{ events: number; calls: number }> {
  const eventCutoff = new Date(Date.now() - opts.eventRetentionDays * DAY);
  // Whole UTC hours, so calls and their rollup buckets are removed together and never drift apart.
  const dataCutoff = new Date(
    Math.floor((Date.now() - opts.dataRetentionDays * DAY) / 3_600_000) * 3_600_000,
  );
  let events = 0;
  for (;;) {
    const r = await db.query(
      "DELETE FROM call_events WHERE seq IN (SELECT seq FROM call_events WHERE received_at < $1 LIMIT $2)",
      [eventCutoff, BATCH],
    );
    events += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  let calls = 0;
  for (;;) {
    const r = await db.query(
      "DELETE FROM calls WHERE id IN (SELECT id FROM calls WHERE started_at < $1 LIMIT $2)",
      [dataCutoff, BATCH],
    );
    calls += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  await db.query("DELETE FROM call_stats_hourly WHERE bucket_start < $1", [dataCutoff]);
  // Feedback keeps its own snapshot, so expired generations can go (their scope rows cascade).
  await db.query("DELETE FROM insight_generations WHERE expires_at < now() - interval '1 day'");
  return { events, calls };
}
