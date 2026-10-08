import type { CallStatus, FeedItem } from "@calls/shared";
import type { Db } from "../db/pool";
import { HttpError } from "../http/errors";
import type { CampaignDirectory } from "../ingest/campaignDirectory";
import { type CallRow, toFeedItem } from "../ingest/feedItem";
import type { ResolvedRange } from "./range";

const COLUMNS =
  "c.id, c.account_id, c.campaign_id, c.status, c.started_at, c.answered_at, c.ended_at, c.converted_at, c.duration_sec, c.caller_masked, c.caller_region";

/**
 * Opaque keyset cursor: (started_at, id) of the last row. Stable while new calls stream in, unlike OFFSET.
 * The timestamp keeps Postgres's full microsecond precision; a millisecond JS Date could skip rows.
 */
const encodeCursor = (row: CallRow & { cursor_ts: string }) =>
  Buffer.from(`${row.cursor_ts}|${row.id}`).toString("base64url");
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(cursor: string): [string, string] {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!ts || !id || !CURSOR_TS.test(ts) || !UUID.test(id)) throw new HttpError(400, "Invalid cursor");
  return [ts, id];
}

export class CallsRepo {
  constructor(
    private readonly db: Db,
    private readonly campaigns: CampaignDirectory,
  ) {}

  async page(
    accountId: string,
    range: ResolvedRange,
    filters: { campaignIds: string[] | null; outcomes: CallStatus[] | null },
    limit: number,
    cursor: string | undefined,
  ): Promise<{ items: FeedItem[]; nextCursor: string | null; asOfSeq: number }> {
    const [cTs, cId] = cursor ? decodeCursor(cursor) : [null, null];
    // Read the sequence first: any change after it is delivered by the live feed's catch-up, so nothing falls
    // between this page and the stream.
    const asOfSeq = await this.latestSeq(accountId);
    const { rows } = await this.db.query<CallRow & { cursor_ts: string }>(
      `SELECT ${COLUMNS}, to_char(c.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
       FROM calls c
       WHERE c.account_id = $1 AND c.started_at >= $2 AND c.started_at < $3
         AND ($4::uuid[] IS NULL OR c.campaign_id = ANY($4))
         AND ($5::text[] IS NULL OR c.status = ANY($5))
         AND ($6::timestamptz IS NULL OR (c.started_at, c.id) < ($6, $7::uuid))
       ORDER BY c.started_at DESC, c.id DESC
       LIMIT $8`,
      [accountId, range.fromUtc, range.toUtc, filters.campaignIds, filters.outcomes, cTs, cId, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: await this.toItems(page),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      asOfSeq,
    };
  }

  /** Current state of calls touched by events after `afterSeq` (live-feed replay and polling fallback). */
  async changesSince(
    accountId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ items: FeedItem[]; truncated: boolean }> {
    const { rows } = await this.db.query<CallRow & { seq: number }>(
      `SELECT ${COLUMNS}, e.seq FROM (
         SELECT DISTINCT ON (call_id) call_id, seq FROM call_events
         WHERE account_id = $1 AND seq > $2 AND applied
         ORDER BY call_id, seq DESC
       ) e JOIN calls c ON c.id = e.call_id
       ORDER BY e.seq ASC LIMIT $3`,
      [accountId, afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async (r) => {
        const campaign = await this.campaigns.get(r.campaign_id);
        return toFeedItem(r, campaign!, r.seq);
      }),
    );
    return { items, truncated: rows.length > limit };
  }

  async latestSeq(accountId: string): Promise<number> {
    const { rows } = await this.db.query<{ seq: number | null }>(
      "SELECT max(seq) AS seq FROM call_events WHERE account_id = $1",
      [accountId],
    );
    return rows[0]?.seq ?? 0;
  }

  private async toItems(rows: CallRow[]): Promise<FeedItem[]> {
    return Promise.all(
      rows.map(async (r) => {
        const campaign = await this.campaigns.get(r.campaign_id);
        return toFeedItem(r, campaign!, null);
      }),
    );
  }
}
