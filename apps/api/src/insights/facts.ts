import {
  addCounts,
  emptyCounts,
  type Fact,
  LOW_VOLUME_THRESHOLD,
  resolvedCalls,
  SOURCE_LABELS,
  type Source,
  type StatusCounts,
  totalCalls,
} from "@calls/shared";
import type { Db } from "../db/pool";
import type { ResolvedRange } from "../read/range";

/**
 * Deterministic facts for the insights panel. Every number an insight may mention is computed here, in SQL and
 * plain arithmetic, and pre-formatted into `display`. The language model never does math.
 *
 * A fact is "notable" only if the change is big enough to matter AND unlikely to be noise:
 *   counts: |change| >= 15%, >= 30 in both periods, and Poisson z = |a - b| / sqrt(a + b) >= 3
 *   rates:  |change| >= 2 points, >= 30 resolved calls in both periods, and two-proportion |z| >= 3
 * Why z >= 3 and not the textbook 2: one view tests ~50 facts at once. At z >= 2 (p ~ 0.05) that is ~2 false
 * alarms per view from noise alone; at z >= 3 (p ~ 0.003) it is ~0.1 (a Bonferroni-style correction).
 */

const MIN_CHANGE = 0.15;
const MIN_RATE_CHANGE = 0.02;
const MIN_Z = 3;

type Group = {
  key: string;
  label: string;
  dimension: Fact["dimension"];
  cur: StatusCounts;
  prev: StatusCounts;
};

const zero = emptyCounts;

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const fmtChange = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
export const fmtPts = (x: number) => `${Math.abs(x * 100).toFixed(1)} pts`;

export function twoProportionZ(c1: number, n1: number, c2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (c1 / n1 - c2 / n2) / se;
}

/** How surprising a change between two counts is, if both were draws of the same Poisson rate. */
export const poissonZ = (a: number, b: number) => (a + b === 0 ? 0 : Math.abs(a - b) / Math.sqrt(a + b));

/**
 * Ranking. Every fact's impact is in one unit, ESTIMATED CONVERSIONS GAINED OR LOST, so a volume change, a
 * missed-call change and a conversion-rate change can be compared fairly:
 *   calls: |delta calls| x conversion rate     missed: |delta missed| x conversion rate of answered calls
 *   rate:  |delta rate| x resolved calls       peak window: excess missed x conversion rate of answered calls
 */
type Value = { perCall: number; perAnswered: number };

function countFact(g: Group, metric: "calls" | "missed", value: Value): Fact {
  const cur = metric === "calls" ? totalCalls(g.cur) : g.cur.missed;
  const prev = metric === "calls" ? totalCalls(g.prev) : g.prev.missed;
  const change = prev > 0 ? (cur - prev) / prev : null;
  const notable =
    change !== null &&
    Math.abs(change) >= MIN_CHANGE &&
    cur >= LOW_VOLUME_THRESHOLD &&
    prev >= LOW_VOLUME_THRESHOLD &&
    poissonZ(cur, prev) >= MIN_Z;
  return {
    id: `${g.dimension}:${g.key}:${metric}`,
    metric,
    dimension: g.dimension,
    label: `${metric === "calls" ? "Calls" : "Missed calls"} · ${g.label}`,
    current: cur,
    previous: prev,
    changePct: change,
    volume: cur,
    notable,
    impact:
      change === null ? 0 : Math.abs(cur - prev) * (metric === "calls" ? value.perCall : value.perAnswered),
    display: [fmtInt(cur), fmtInt(prev), ...(change === null ? [] : [fmtChange(change)])],
    detail: change === null ? null : `${change >= 0 ? "up" : "down"} vs previous period`,
  };
}

function rateFact(g: Group): Fact {
  const n1 = resolvedCalls(g.cur);
  const n2 = resolvedCalls(g.prev);
  const r1 = n1 ? g.cur.converted / n1 : 0;
  const r2 = n2 ? g.prev.converted / n2 : 0;
  const z = twoProportionZ(g.cur.converted, n1, g.prev.converted, n2);
  const enough = n1 >= LOW_VOLUME_THRESHOLD && n2 >= LOW_VOLUME_THRESHOLD;
  return {
    id: `${g.dimension}:${g.key}:conversion_rate`,
    metric: "conversion_rate",
    dimension: g.dimension,
    label: `Conversion rate · ${g.label}`,
    current: r1,
    previous: n2 ? r2 : null,
    changePct: n2 ? r1 - r2 : null,
    volume: n1,
    notable: enough && Math.abs(r1 - r2) >= MIN_RATE_CHANGE && Math.abs(z) >= MIN_Z,
    impact: Math.abs(r1 - r2) * n1,
    display: [fmtPct(r1), fmtPct(r2), fmtPts(r1 - r2), fmtInt(n1)],
    detail: `${r1 >= r2 ? "up" : "down"} vs previous period; z=${z.toFixed(1)}`,
  };
}

const hourLabel = (h: number) => {
  const hh = h % 24;
  const suffix = hh < 12 ? "am" : "pm";
  return `${hh % 12 === 0 ? 12 : hh % 12} ${suffix}`;
};

/** Per-campaign counts for the current and previous period: the only input the fact rules need. */
export type CampaignCounts = {
  id: string;
  name: string;
  source: Source;
  cur: StatusCounts;
  prev: StatusCounts;
};
/** Current-period resolved and missed calls by local hour of day (0..23). */
export type HourCounts = { h: number; missed: number; resolved: number };

export async function computeFacts(
  db: Db,
  accountId: string,
  range: ResolvedRange,
  previous: ResolvedRange,
): Promise<Fact[]> {
  // Read from `calls`, not the rollup: the comparison needs each call's status AS IT WAS KNOWN at a point in time
  // (see previousRange). A conversion not yet known at `knownAt` counts as the connected call it was then.
  const { rows } = await db.query<
    StatusCounts & { id: string; name: string; source: Source; period: "cur" | "prev" }
  >(
    `WITH p(period, from_utc, as_of, known_at) AS (VALUES ('cur', $2::timestamptz, $3::timestamptz, $4::timestamptz),
                                                           ('prev', $5::timestamptz, $6::timestamptz, $7::timestamptz))
     SELECT c.id, c.name, c.source, p.period,
            count(*) FILTER (WHERE k.status = 'ringing') AS ringing,
            count(*) FILTER (WHERE k.status = 'connected' OR (k.status = 'converted' AND k.converted_at > p.known_at)) AS connected,
            count(*) FILTER (WHERE k.status = 'missed') AS missed,
            count(*) FILTER (WHERE k.status = 'converted' AND k.converted_at <= p.known_at) AS converted
     FROM p JOIN calls k ON k.account_id = $1 AND k.started_at >= p.from_utc AND k.started_at < p.as_of
     JOIN campaigns c ON c.id = k.campaign_id
     GROUP BY 1, 2, 3, 4`,
    [
      accountId,
      range.fromUtc,
      range.asOfUtc,
      range.knownAtUtc,
      previous.fromUtc,
      previous.asOfUtc,
      previous.knownAtUtc,
    ],
  );
  const byCampaign = new Map<string, CampaignCounts>();
  for (const r of rows) {
    const c = byCampaign.get(r.id) ?? { id: r.id, name: r.name, source: r.source, cur: zero(), prev: zero() };
    c[r.period] = addCounts(c[r.period], r);
    byCampaign.set(r.id, c);
  }

  const hours = await db.query<HourCounts>(
    `SELECT extract(hour FROM s.bucket_start AT TIME ZONE $4)::int AS h,
            sum(s.missed) AS missed, sum(s.connected + s.missed + s.converted) AS resolved
     FROM call_stats_hourly s WHERE s.account_id = $1 AND s.bucket_start >= $2 AND s.bucket_start < $3 GROUP BY 1`,
    [accountId, range.fromUtc, range.toUtc, range.timezone],
  );
  return factsFromCounts([...byCampaign.values()], hours.rows);
}

/** The fact rules, pure: counts in, facts out. Production and the eval fixtures both go through here. */
export function factsFromCounts(campaignCounts: CampaignCounts[], hours: HourCounts[]): Fact[] {
  const account: Group = {
    key: "all",
    label: "All campaigns",
    dimension: "account",
    cur: zero(),
    prev: zero(),
  };
  const sources = new Map<string, Group & { campaigns: number }>();
  for (const c of campaignCounts) {
    const s = sources.get(c.source) ?? {
      key: c.source,
      label: SOURCE_LABELS[c.source],
      dimension: "source" as const,
      cur: zero(),
      prev: zero(),
      campaigns: 0,
    };
    s.campaigns++;
    for (const g of [account, s]) {
      g.cur = addCounts(g.cur, c.cur);
      g.prev = addCounts(g.prev, c.prev);
    }
    sources.set(c.source, s);
  }

  const answered = account.cur.connected + account.cur.converted;
  const value: Value = {
    perCall: resolvedCalls(account.cur) ? account.cur.converted / resolvedCalls(account.cur) : 0,
    perAnswered: answered ? account.cur.converted / answered : 0,
  };
  const facts: Fact[] = [
    countFact(account, "calls", value),
    countFact(account, "missed", value),
    rateFact(account),
  ];
  for (const g of sources.values()) {
    facts.push(countFact(g, "calls", value), countFact(g, "missed", value), rateFact(g));
  }
  for (const c of campaignCounts) {
    // A campaign that is its source's only campaign would repeat the source's facts word for word.
    if ((sources.get(c.source)?.campaigns ?? 0) < 2) continue;
    const g: Group = { key: c.id, label: c.name, dimension: "campaign", cur: c.cur, prev: c.prev };
    facts.push(countFact(g, "missed", value), rateFact(g));
  }

  // When do missed calls cluster? The local 2-hour window with the most EXCESS missed calls (missed beyond what
  // the overall miss rate predicts): a high rate on a handful of 3 am calls matters less than a busy evening.
  const byHour = new Map(hours.map((r) => [r.h, r]));
  const overall = resolvedCalls(account.cur) ? account.cur.missed / resolvedCalls(account.cur) : 0;
  const excess = (x: HourCounts) => x.missed - overall * x.resolved;
  let best: HourCounts | null = null;
  for (let h = 0; h < 24; h++) {
    const a = byHour.get(h);
    const b = byHour.get((h + 1) % 24);
    const w = {
      h,
      missed: (a?.missed ?? 0) + (b?.missed ?? 0),
      resolved: (a?.resolved ?? 0) + (b?.resolved ?? 0),
    };
    if (w.resolved >= LOW_VOLUME_THRESHOLD && (!best || excess(w) > excess(best))) best = w;
  }
  if (best && overall > 0) {
    const rate = best.missed / best.resolved;
    const windowLabel = `${hourLabel(best.h)}–${hourLabel(best.h + 2)}`;
    facts.push({
      id: "account:all:missed_peak_window",
      metric: "missed_peak_window",
      dimension: "account",
      label: `Missed-call peak (2-hour window) · ${windowLabel}`,
      current: rate,
      previous: overall,
      changePct: rate - overall,
      volume: best.missed,
      notable: excess(best) >= LOW_VOLUME_THRESHOLD && rate >= overall * 1.3,
      impact: excess(best) * value.perAnswered,
      display: [windowLabel, fmtPct(rate), fmtPct(overall), fmtInt(best.missed)],
      detail: "share of resolved calls that were missed, in this local 2-hour window vs all hours",
    });
  }
  return facts;
}
