/**
 * Repair tool for the hourly rollup (see docs/RUNBOOK.md#rollup-drift).
 *   pnpm --filter @calls/api rebuild-rollups -- --since 2026-10-01T00:00:00Z [--account <uuid>]
 * Recomputes call_stats_hourly from `calls` for the range, one account per transaction. Run it when the drift
 * gauge is above 0. Ingest keeps working: its rollup writes wait on the table lock for the few seconds a rebuild
 * takes, then apply on top of the corrected rows.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { createPool, withTransaction } from "./pool";
import { rebuildRollups, rollupDrift } from "./rollups";

const { values } = parseArgs({
  options: { since: { type: "string" }, account: { type: "string" } },
});
const since = new Date(values.since ?? Date.now() - 2 * 86_400_000);
if (Number.isNaN(since.getTime())) throw new Error("--since must be an ISO timestamp");

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 2);
const accounts = values.account
  ? [values.account]
  : (await db.query<{ id: string }>("SELECT id FROM accounts ORDER BY name")).rows.map((r) => r.id);

console.log(`drift before: ${await rollupDrift(db, since)} bucket(s) since ${since.toISOString()}`);
for (const accountId of accounts) {
  await withTransaction(db, async (client) => {
    // Ingest writes wait (not fail) behind these locks, so no increment is lost or double-counted. Same order as
    // ingest takes them (calls, then the rollup), so the two can't deadlock.
    await client.query("LOCK TABLE calls IN SHARE MODE");
    await client.query("LOCK TABLE call_stats_hourly IN SHARE ROW EXCLUSIVE MODE");
    await rebuildRollups(client, accountId, since, new Date(Date.now() + 3_600_000));
  });
  console.log(`rebuilt ${accountId}`);
}
console.log(`drift after: ${await rollupDrift(db, since)}`);
await db.end();
