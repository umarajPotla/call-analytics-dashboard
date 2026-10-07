import type { AccountProfile } from "../catalog";
import type { Db } from "../db/pool";
import { withTransaction } from "../db/pool";
import { rebuildRollups } from "../db/rollups";
import { maskCallerNumber } from "../domain/caller";
import { foldAsOf, generateMinute } from "./model";

const MINUTE = 60_000;
const CHUNK = 2_000;

/**
 * Bulk-load simulated history for [fromMs, toMs), as it would look at `asOf`.
 *
 * Trade-off (documented in the README): live traffic goes through the public ingest API, but 14 days of history
 * is ~100k calls; pushing that through per-event transactions against a remote free-tier database would take
 * far too long on every cold start. History therefore takes a bulk path, like an initial data import: calls are
 * folded with the SAME state machine, inserted set-based, and the rollup is rebuilt from them.
 */
export async function bulkLoadHistory(
  db: Db,
  account: AccountProfile,
  fromMs: number,
  toMs: number,
  asOf: number,
  seed: number,
  multiplier: number,
): Promise<number> {
  type Row = [
    string,
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    string | null,
    number | null,
    string | null,
    string,
  ];
  const rows: Row[] = [];
  for (let m = fromMs; m < toMs; m += MINUTE) {
    for (const call of generateMinute(account, m, seed, multiplier)) {
      const state = foldAsOf(call, asOf);
      if (!state) continue;
      rows.push([
        call.id,
        account.id,
        call.campaignId,
        state.status,
        new Date(call.startedAt).toISOString(),
        state.answeredAt,
        state.endedAt,
        state.convertedAt,
        state.durationSec,
        maskCallerNumber(call.callerNumber),
        call.callerRegion,
      ]);
    }
  }

  await withTransaction(db, async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const col = (k: number) => chunk.map((r) => r[k]);
      await tx.query(
        `INSERT INTO calls (id, account_id, campaign_id, status, started_at, answered_at, ended_at, converted_at,
                            duration_sec, caller_masked, caller_region)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[], $6::timestamptz[],
                              $7::timestamptz[], $8::timestamptz[], $9::int[], $10::text[], $11::text[])
         ON CONFLICT (id) DO NOTHING`,
        [col(0), col(1), col(2), col(3), col(4), col(5), col(6), col(7), col(8), col(9), col(10)],
      );
    }
    await rebuildRollups(tx, account.id, new Date(fromMs), new Date(toMs));
  });
  return rows.length;
}
