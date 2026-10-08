import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/pool";
import { computeFacts } from "../../src/insights/facts";
import { MetricsRepo } from "../../src/read/metricsRepo";
import type { ResolvedRange } from "../../src/read/range";
import { freshDb } from "../helpers/db";
import { ACME } from "../helpers/events";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse("2026-09-21T07:00:00Z"); // start of the "current" week
const range = (from: number, asOf: number, knownAt: number): ResolvedRange => ({
  timezone: ACME.timezone,
  from: "x",
  to: "x",
  fromUtc: new Date(from),
  toUtc: new Date(from + 7 * D),
  asOfUtc: new Date(asOf),
  knownAtUtc: new Date(knownAt),
  days: 7,
});

async function insertCalls(
  n: number,
  startAt: number,
  status: "connected" | "converted",
  convertedAfterMs = 0,
) {
  for (let i = 0; i < n; i++) {
    const started = new Date(startAt + i * 60_000);
    await db.query(
      `INSERT INTO calls (id, account_id, campaign_id, status, started_at, answered_at, converted_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [
        randomUUID(),
        ACME.id,
        ACME.campaigns[0]!.id,
        status,
        started,
        status === "converted" ? new Date(started.getTime() + convertedAfterMs) : null,
      ],
    );
  }
}

describe("insight facts compare like for like", () => {
  it("counts the previous period's conversions only as far as they were known at the same point", async () => {
    // "Now" is 2 days into the current week. The current week's calls so far: 100, 30 converted quickly.
    const now = T0 + 2 * D;
    await insertCalls(70, T0 + H, "connected");
    await insertCalls(30, T0 + 2 * H, "converted", 60_000);
    // Previous week, same two days: 100 calls, 30 converted quickly and 30 more that converted LATE (2.5 days
    // later), after the equivalent point in time. Counting them would make this week look much worse.
    await insertCalls(40, T0 - 7 * D + H, "connected");
    await insertCalls(30, T0 - 7 * D + 2 * H, "converted", 60_000);
    await insertCalls(30, T0 - 7 * D + 3 * H, "converted", 2.5 * D);
    // And previous-week calls after the equivalent cut-off must not count at all.
    await insertCalls(50, T0 - 7 * D + 3 * D, "connected");

    const facts = await computeFacts(
      db,
      ACME.id,
      range(T0, now, now),
      range(T0 - 7 * D, now - 7 * D, now - 7 * D),
    );
    const calls = facts.find((f) => f.id === "account:all:calls")!;
    const rate = facts.find((f) => f.id === "account:all:conversion_rate")!;
    expect([calls.current, calls.previous]).toEqual([100, 100]);
    expect(rate.current).toBeCloseTo(0.3);
    expect(rate.previous).toBeCloseTo(0.3); // not 0.6
    expect(rate.notable).toBe(false);
  });

  it("KPI totals for the comparison period use the same as-of rules (summary tiles)", async () => {
    // Reuses the calls inserted above: previous week, cut at the same point, conversions as known then.
    const now = T0 + 2 * D;
    const totals = await new MetricsRepo(db).totalsAsOf(
      ACME.id,
      range(T0 - 7 * D, now - 7 * D, now - 7 * D),
      null,
    );
    expect(totals).toEqual({ ringing: 0, connected: 70, missed: 0, converted: 30 });
  });
});
