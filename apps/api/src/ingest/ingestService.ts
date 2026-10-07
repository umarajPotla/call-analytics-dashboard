import type { CallEventInput, CallStatus, IngestOutcome } from "@calls/shared";
import type { Db, DbClient } from "../db/pool";
import { withTransaction } from "../db/pool";
import { maskCallerNumber } from "../domain/caller";
import { fieldsFor, transition } from "../domain/callStateMachine";
import type { CampaignDirectory } from "./campaignDirectory";
import { type CallRow, toFeedItem } from "./feedItem";

export const NOTIFY_CHANNEL = "call_updates";
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type IngestResult = { eventId: string; outcome: IngestOutcome; seq: number | null; reason?: string };

export interface IngestObserver {
  onResult(outcome: IngestOutcome, lagSeconds: number, reason?: string): void;
}

const CALL_COLUMNS =
  "id, account_id, campaign_id, status, started_at, answered_at, ended_at, converted_at, duration_sec, caller_masked, caller_region";

/**
 * Applies call lifecycle events. Delivery is at-least-once, so every event is idempotent by event_id, and
 * events may arrive out of order, so the state machine only moves forward.
 *
 * One transaction per event:
 *   1. per-call advisory lock (serialises events for the same call, even before the row exists)
 *   2. append to call_events; ON CONFLICT (event_id) DO NOTHING -> duplicate, stop
 *   3. state machine decides apply / noop / reject
 *   4. upsert the call (fields merged with COALESCE), apply -1/+1 to the hourly rollup
 *   5. pg_notify the live feed, delivered only if the transaction commits
 */
export class IngestService {
  constructor(
    private readonly db: Db,
    private readonly campaigns: CampaignDirectory,
    private readonly observer?: IngestObserver,
  ) {}

  async ingestBatch(events: CallEventInput[]): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    // Sequential on purpose: events in a batch are often for the same call and must apply in order.
    for (const e of events) results.push(await this.ingest(e));
    return results;
  }

  async ingest(event: CallEventInput): Promise<IngestResult> {
    const result = await this.ingestInner(event);
    const lag = (Date.now() - Date.parse(event.occurredAt)) / 1000;
    this.observer?.onResult(result.outcome, lag, result.reason);
    return result;
  }

  private async ingestInner(event: CallEventInput): Promise<IngestResult> {
    const reject = (reason: string): IngestResult => ({
      eventId: event.eventId,
      outcome: "rejected",
      seq: null,
      reason,
    });

    // Validation that needs no transaction. Rejected here = not stored.
    const campaign = await this.campaigns.get(event.call.campaignId);
    if (!campaign || campaign.accountId !== event.call.accountId) return reject("unknown_campaign");
    if (Date.parse(event.occurredAt) - Date.now() > MAX_CLOCK_SKEW_MS) return reject("occurred_in_future");

    return withTransaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [event.call.id]);

      const inserted = await tx.query<{ seq: number }>(
        `INSERT INTO call_events (event_id, account_id, call_id, type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING RETURNING seq`,
        [event.eventId, event.call.accountId, event.call.id, event.type, event.occurredAt, redact(event)],
      );
      const seq = inserted.rows[0]?.seq;
      if (seq === undefined) return { eventId: event.eventId, outcome: "duplicate" as const, seq: null };

      const prev = (
        await tx.query<CallRow>(`SELECT ${CALL_COLUMNS} FROM calls WHERE id = $1`, [event.call.id])
      ).rows[0];

      if (prev && (prev.account_id !== event.call.accountId || prev.campaign_id !== event.call.campaignId)) {
        return markRejected(tx, event, seq, "identity_mismatch");
      }

      const decision = transition(prev?.status ?? null, event.type);
      if (decision.kind === "reject") return markRejected(tx, event, seq, decision.reason);

      const patch = fieldsFor(event.type, event.occurredAt, event.data?.durationSec);
      const nextStatus: CallStatus = decision.kind === "apply" ? decision.next : (prev?.status ?? "ringing");
      const statusChanged = prev?.status !== nextStatus;
      const fieldsChanged =
        (patch.answeredAt !== undefined && !prev?.answered_at) ||
        (patch.endedAt !== undefined && !prev?.ended_at) ||
        (patch.convertedAt !== undefined && !prev?.converted_at) ||
        (patch.durationSec !== undefined && prev?.duration_sec == null);

      if (!statusChanged && !fieldsChanged) {
        return { eventId: event.eventId, outcome: "noop" as const, seq };
      }

      const row = prev
        ? (
            await tx.query<CallRow>(
              `UPDATE calls SET status = $2,
                 answered_at = COALESCE(answered_at, $3), ended_at = COALESCE(ended_at, $4),
                 converted_at = COALESCE(converted_at, $5), duration_sec = COALESCE(duration_sec, $6),
                 updated_at = now()
               WHERE id = $1 RETURNING ${CALL_COLUMNS}`,
              [
                event.call.id,
                nextStatus,
                patch.answeredAt ?? null,
                patch.endedAt ?? null,
                patch.convertedAt ?? null,
                patch.durationSec ?? null,
              ],
            )
          ).rows[0]!
        : (
            await tx.query<CallRow>(
              `INSERT INTO calls (id, account_id, campaign_id, status, started_at, answered_at, ended_at, converted_at,
                                  duration_sec, caller_masked, caller_region)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${CALL_COLUMNS}`,
              [
                event.call.id,
                event.call.accountId,
                event.call.campaignId,
                nextStatus,
                event.call.startedAt,
                patch.answeredAt ?? null,
                patch.endedAt ?? null,
                patch.convertedAt ?? null,
                patch.durationSec ?? null,
                maskCallerNumber(event.call.callerNumber),
                event.call.callerRegion ?? null,
              ],
            )
          ).rows[0]!;

      if (statusChanged) {
        await applyRollupDelta(tx, row, prev?.status ?? null, nextStatus);
      }

      await tx.query("SELECT pg_notify($1, $2)", [
        NOTIFY_CHANNEL,
        JSON.stringify({ a: row.account_id, s: seq, i: toFeedItem(row, campaign, seq) }),
      ]);
      return { eventId: event.eventId, outcome: "applied" as const, seq };
    });
  }
}

/** Raw caller numbers never reach storage; the event log keeps everything else for audit and replay. */
function redact(event: CallEventInput): CallEventInput {
  const { callerNumber: _drop, ...call } = event.call;
  return { ...event, call };
}

async function markRejected(
  tx: DbClient,
  event: CallEventInput,
  seq: number,
  reason: string,
): Promise<IngestResult> {
  await tx.query("UPDATE call_events SET applied = false, reject_reason = $2 WHERE seq = $1", [seq, reason]);
  return { eventId: event.eventId, outcome: "rejected", seq, reason };
}

/** Move one call from its old status column to the new one, in the hour bucket of the call's START time. */
async function applyRollupDelta(
  tx: DbClient,
  call: CallRow,
  from: CallStatus | null,
  to: CallStatus,
): Promise<void> {
  const delta = { ringing: 0, connected: 0, missed: 0, converted: 0 };
  if (from) delta[from] -= 1;
  delta[to] += 1;
  await tx.query(
    `INSERT INTO call_stats_hourly (account_id, bucket_start, campaign_id, ringing, connected, missed, converted)
     VALUES ($1, date_trunc('hour', $2::timestamptz, 'UTC'), $3, $4, $5, $6, $7)
     ON CONFLICT (account_id, bucket_start, campaign_id) DO UPDATE SET
       ringing   = call_stats_hourly.ringing   + EXCLUDED.ringing,
       connected = call_stats_hourly.connected + EXCLUDED.connected,
       missed    = call_stats_hourly.missed    + EXCLUDED.missed,
       converted = call_stats_hourly.converted + EXCLUDED.converted`,
    [
      call.account_id,
      call.started_at,
      call.campaign_id,
      delta.ringing,
      delta.connected,
      delta.missed,
      delta.converted,
    ],
  );
}
