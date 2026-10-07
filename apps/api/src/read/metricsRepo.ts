import {
  type ConversionGroup,
  conversionRate,
  conversionRateOfAnswered,
  emptyCounts,
  isLowVolume,
  resolvedCalls,
  SOURCE_LABELS,
  type Source,
  type StatusCounts,
  type VolumePoint,
} from "@calls/shared";
import type { Db } from "../db/pool";
import type { ResolvedRange } from "./range";

const COUNTS = `COALESCE(sum(s.ringing), 0) AS ringing, COALESCE(sum(s.connected), 0) AS connected,
                COALESCE(sum(s.missed), 0) AS missed, COALESCE(sum(s.converted), 0) AS converted`;

type CountsRow = StatusCounts & { bucket: string };

const toPoint = (r: CountsRow): VolumePoint => ({
  bucket: r.bucket,
  ringing: r.ringing,
  connected: r.connected,
  missed: r.missed,
  converted: r.converted,
  total: r.ringing + r.connected + r.missed + r.converted,
});

/** All reads come from the hourly rollup: a week is ~168 rows per campaign, not every call. */
export class MetricsRepo {
  constructor(private readonly db: Db) {}

  /** Hourly series in UTC buckets (the client formats them in the account's zone), zero-filled. */
  async hourly(
    accountId: string,
    range: ResolvedRange,
    campaignIds: string[] | null,
  ): Promise<VolumePoint[]> {
    const { rows } = await this.db.query<CountsRow>(
      `SELECT to_char(g.h AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket, ${COUNTS}
       FROM generate_series($2::timestamptz, $3::timestamptz - interval '1 hour', interval '1 hour') AS g(h)
       LEFT JOIN call_stats_hourly s
         ON s.account_id = $1 AND s.bucket_start = g.h AND ($4::uuid[] IS NULL OR s.campaign_id = ANY($4))
       GROUP BY g.h ORDER BY g.h`,
      [accountId, range.fromUtc, range.toUtc, campaignIds],
    );
    return rows.map(toPoint);
  }

  /** Daily series grouped by LOCAL calendar day in the account's zone, zero-filled. */
  async daily(accountId: string, range: ResolvedRange, campaignIds: string[] | null): Promise<VolumePoint[]> {
    const { rows } = await this.db.query<CountsRow>(
      `WITH d AS (
         SELECT (s.bucket_start AT TIME ZONE $5)::date AS day, s.ringing, s.connected, s.missed, s.converted
         FROM call_stats_hourly s
         WHERE s.account_id = $1 AND s.bucket_start >= $2 AND s.bucket_start < $3
           AND ($4::uuid[] IS NULL OR s.campaign_id = ANY($4))
       )
       SELECT g.day::date::text AS bucket, ${COUNTS}
       FROM generate_series($6::date, $7::date, interval '1 day') AS g(day)
       LEFT JOIN d s ON s.day = g.day::date
       GROUP BY g.day ORDER BY g.day`,
      [accountId, range.fromUtc, range.toUtc, campaignIds, range.timezone, range.from, range.to],
    );
    return rows.map(toPoint);
  }

  /** Totals up to the range's `asOf` (hour precision), so a partial current period compares fairly with the
   * previous one cut at the same point. */
  async totals(accountId: string, range: ResolvedRange, campaignIds: string[] | null): Promise<StatusCounts> {
    const { rows } = await this.db.query<StatusCounts>(
      `SELECT ${COUNTS} FROM call_stats_hourly s
       WHERE s.account_id = $1 AND s.bucket_start >= $2 AND s.bucket_start < $3
         AND ($4::uuid[] IS NULL OR s.campaign_id = ANY($4))`,
      [accountId, range.fromUtc, range.asOfUtc, campaignIds],
    );
    return rows[0] ?? emptyCounts();
  }

  async conversion(
    accountId: string,
    range: ResolvedRange,
    groupBy: "source" | "campaign",
    campaignIds: string[] | null,
  ): Promise<ConversionGroup[]> {
    const { rows } = await this.db.query<StatusCounts & { key: string; name: string; source: Source }>(
      `SELECT ${groupBy === "source" ? "c.source AS key, c.source AS name" : "c.id::text AS key, c.name"}, min(c.source) AS source, ${COUNTS}
       FROM call_stats_hourly s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.account_id = $1 AND s.bucket_start >= $2 AND s.bucket_start < $3
         AND ($4::uuid[] IS NULL OR s.campaign_id = ANY($4))
       GROUP BY 1, 2`,
      [accountId, range.fromUtc, range.toUtc, campaignIds],
    );
    return rows
      .map((r) => ({
        key: r.key,
        label: groupBy === "source" ? SOURCE_LABELS[r.source] : r.name,
        source: r.source,
        resolved: resolvedCalls(r),
        answered: r.connected + r.converted,
        converted: r.converted,
        missed: r.missed,
        conversionRate: conversionRate(r),
        conversionRateOfAnswered: conversionRateOfAnswered(r),
        lowVolume: isLowVolume(r),
      }))
      .sort((a, b) => (b.conversionRate ?? -1) - (a.conversionRate ?? -1) || b.resolved - a.resolved);
  }
}
