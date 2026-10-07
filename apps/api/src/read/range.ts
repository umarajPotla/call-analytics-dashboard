import type { Db } from "../db/pool";
import { HttpError } from "../http/errors";

export type ResolvedRange = {
  timezone: string;
  /** Local calendar dates, inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  /** UTC instants of local midnight at `from` and local midnight after `to`: the half-open [fromUtc, toUtc). */
  fromUtc: Date;
  toUtc: Date;
  days: number;
  /** End of observed data: min(toUtc, now). A range that includes today is still filling up. */
  asOfUtc: Date;
  /** Conversions are counted only if known by this instant. `now` for the requested range; for a comparison
   * range, `now` shifted back by the same number of days, so late conversions don't bias the comparison. */
  knownAtUtc: Date;
};

/**
 * "Last 7 days" means 7 calendar days in the ACCOUNT's time zone, including today. Postgres does the zone math
 * (`local timestamp AT TIME ZONE tz`), so 23- and 25-hour DST days come out right without a JS date library.
 */
export async function resolveRange(
  db: Db,
  timezone: string,
  from: string | undefined,
  to: string | undefined,
  maxDays: number,
): Promise<ResolvedRange> {
  const { rows } = await db.query<{
    f: string;
    t: string;
    from_utc: Date;
    to_utc: Date;
    days: number;
    now: Date;
  }>(
    `SELECT f::text AS f, t::text AS t,
            (f::timestamp AT TIME ZONE $1) AS from_utc,
            ((t + 1)::timestamp AT TIME ZONE $1) AS to_utc,
            (t - f + 1) AS days, now() AS now
     FROM (SELECT COALESCE($2::date, (now() AT TIME ZONE $1)::date - 6) AS f,
                  COALESCE($3::date, (now() AT TIME ZONE $1)::date) AS t) x`,
    [timezone, from ?? null, to ?? null],
  );
  const r = rows[0]!;
  if (r.days < 1) throw new HttpError(400, "Invalid range", "`from` must be on or before `to`.");
  if (r.days > maxDays) {
    throw new HttpError(
      400,
      "Range too large",
      `This view supports at most ${maxDays} days; use a daily view or a shorter range.`,
    );
  }
  const asOfUtc = r.to_utc < r.now ? r.to_utc : r.now;
  return {
    timezone,
    from: r.f,
    to: r.t,
    fromUtc: r.from_utc,
    toUtc: r.to_utc,
    days: r.days,
    asOfUtc,
    knownAtUtc: r.now,
  };
}

/**
 * The range of the same length immediately before `range`, compared LIKE FOR LIKE:
 *  - if `range` includes today (partial), the previous range is cut at the same local time N days earlier
 *    ("this week so far" vs "last week up to the same hour"), not compared with a full week
 *  - its conversions are counted as they were known N days ago, because the current range is still gaining
 *    late conversions (up to 72 h) and the previous one has had time to collect them all
 * Shifts are in local wall-clock days, so DST weeks line up.
 */
export async function previousRange(db: Db, range: ResolvedRange): Promise<ResolvedRange> {
  const { rows } = await db.query<{ f: string; t: string; as_of: Date; known_at: Date }>(
    `SELECT ($1::date - $3::int)::text AS f, ($2::date - $3::int)::text AS t,
            (($4::timestamptz AT TIME ZONE $6) - make_interval(days => $3)) AT TIME ZONE $6 AS as_of,
            (($5::timestamptz AT TIME ZONE $6) - make_interval(days => $3)) AT TIME ZONE $6 AS known_at`,
    [range.from, range.to, range.days, range.asOfUtc, range.knownAtUtc, range.timezone],
  );
  const r = rows[0]!;
  const prev = await resolveRange(db, range.timezone, r.f, r.t, range.days);
  return { ...prev, asOfUtc: r.as_of, knownAtUtc: r.known_at };
}
