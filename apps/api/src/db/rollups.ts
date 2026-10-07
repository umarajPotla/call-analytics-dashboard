import type { Db, DbClient } from "./pool";

/**
 * Recompute the hourly rollup from the calls table for one account and time range. Used after a bulk backfill
 * and as the repair tool if the rollup ever drifts (`pnpm --filter @calls/api rebuild-rollups`).
 * Caller must make sure no live ingest writes to the same range concurrently.
 */
export async function rebuildRollups(
  client: Db | DbClient,
  accountId: string,
  from: Date,
  to: Date,
): Promise<void> {
  await client.query(
    "DELETE FROM call_stats_hourly WHERE account_id = $1 AND bucket_start >= date_trunc('hour', $2::timestamptz, 'UTC') AND bucket_start < $3",
    [accountId, from, to],
  );
  await client.query(
    `INSERT INTO call_stats_hourly (account_id, bucket_start, campaign_id, ringing, connected, missed, converted)
     SELECT account_id, date_trunc('hour', started_at, 'UTC'), campaign_id,
            count(*) FILTER (WHERE status = 'ringing'),
            count(*) FILTER (WHERE status = 'connected'),
            count(*) FILTER (WHERE status = 'missed'),
            count(*) FILTER (WHERE status = 'converted')
     FROM calls
     WHERE account_id = $1 AND started_at >= date_trunc('hour', $2::timestamptz, 'UTC') AND started_at < $3
     GROUP BY 1, 2, 3`,
    [accountId, from, to],
  );
}

/**
 * Number of (account, hour, campaign) buckets where the rollup disagrees with a fresh aggregation of calls.
 * Should always be 0; exported as a metric and alerted on.
 */
export async function rollupDrift(db: Db, since: Date): Promise<number> {
  const { rows } = await db.query<{ drift: number }>(
    `WITH truth AS (
       SELECT account_id, date_trunc('hour', started_at, 'UTC') AS bucket_start, campaign_id,
              count(*) FILTER (WHERE status = 'ringing')   AS ringing,
              count(*) FILTER (WHERE status = 'connected') AS connected,
              count(*) FILTER (WHERE status = 'missed')    AS missed,
              count(*) FILTER (WHERE status = 'converted') AS converted
       FROM calls WHERE started_at >= date_trunc('hour', $1::timestamptz, 'UTC') GROUP BY 1, 2, 3
     ), rolled AS (
       SELECT * FROM call_stats_hourly WHERE bucket_start >= date_trunc('hour', $1::timestamptz, 'UTC')
     )
     SELECT count(*) AS drift
     FROM truth t FULL OUTER JOIN rolled r USING (account_id, bucket_start, campaign_id)
     WHERE coalesce(t.ringing, 0)   <> coalesce(r.ringing, 0)
        OR coalesce(t.connected, 0) <> coalesce(r.connected, 0)
        OR coalesce(t.missed, 0)    <> coalesce(r.missed, 0)
        OR coalesce(t.converted, 0) <> coalesce(r.converted, 0)`,
    [since],
  );
  return rows[0]?.drift ?? 0;
}
