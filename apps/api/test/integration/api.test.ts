import type {
  ConversionResponse,
  FeedItem,
  InsightsResponse,
  SummaryResponse,
  VolumeResponse,
} from "@calls/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/pool";
import { bulkLoadHistory } from "../../src/simulator/backfill";
import { type TestApp, testApp } from "../helpers/app";
import { freshDb } from "../helpers/db";
import { ACME, ev, NORTHWIND, newCall } from "../helpers/events";

let db: Db;
let t: TestApp;
const A = `/api/v1/accounts/${ACME.id}`;
// A fixed, fully past fortnight (no DST change in it), so the assertions don't depend on today's date.
const WEEK = "from=2026-09-21&to=2026-09-27";

beforeAll(async () => {
  db = await freshDb();
  const from = Date.parse("2026-09-14T00:00:00Z");
  const to = Date.parse("2026-09-28T12:00:00Z");
  const asOf = Date.parse("2026-10-01T00:00:00Z");
  await bulkLoadHistory(db, ACME, from, to, asOf, 7, 0.3);
  await bulkLoadHistory(db, NORTHWIND, from, to, asOf, 7, 0.3);
  t = await testApp(db);
});
afterAll(async () => {
  await t.close();
  await db.end();
});

const get = async <T>(url: string) => {
  const res = await t.app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
};

describe("read API", () => {
  it("lists the demo accounts", async () => {
    const { body } = await get<Array<{ name: string }>>("/api/v1/accounts");
    expect(body.map((a) => a.name)).toEqual([
      "Acme Home Insurance",
      "Bright Smile Dental",
      "Northwind Auto Group",
    ]);
  });

  it("returns problem+json for unknown accounts, bad ids and oversized ranges", async () => {
    const missing = await t.app.inject(
      `/api/v1/accounts/00000000-0000-4000-8000-000000000000/metrics/summary`,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/application\/problem\+json/);

    const bad = await get<{ errors: Array<{ path: string }> }>("/api/v1/accounts/not-a-uuid/metrics/summary");
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0]!.path).toBe("params.accountId");

    const big = await get<{ title: string }>(
      `${A}/metrics/volume?granularity=hour&from=2026-07-01&to=2026-09-27`,
    );
    expect(big.status).toBe(400);
    expect(big.body.title).toBe("Range too large");

    const backwards = await get<{ title: string }>(`${A}/metrics/summary?from=2026-09-27&to=2026-09-21`);
    expect(backwards.status).toBe(400);
  });

  it("hourly volume is zero-filled, local daily volume adds up to the same total, and both match the KPI", async () => {
    const hourly = await get<VolumeResponse>(`${A}/metrics/volume?${WEEK}&granularity=hour`);
    const daily = await get<VolumeResponse>(`${A}/metrics/volume?${WEEK}&granularity=day`);
    const summary = await get<SummaryResponse>(`${A}/metrics/summary?${WEEK}`);
    expect(hourly.body.series).toHaveLength(7 * 24);
    expect(daily.body.series.map((p) => p.bucket)).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
    const sum = (r: VolumeResponse) => r.series.reduce((a, p) => a + p.total, 0);
    expect(sum(hourly.body)).toBe(sum(daily.body));
    expect(sum(hourly.body)).toBe(summary.body.totalCalls.value);
    expect(summary.body.totalCalls.value ?? 0).toBeGreaterThan(1000);
    expect(hourly.headers["cache-control"]).toBe("private, max-age=5");
  });

  it("filters by outcome and campaign", async () => {
    const missedOnly = await get<VolumeResponse>(
      `${A}/metrics/volume?${WEEK}&granularity=day&outcomes=missed`,
    );
    expect(
      missedOnly.body.series.every((p) => p.connected === 0 && p.converted === 0 && p.total === p.missed),
    ).toBe(true);

    const all = await get<SummaryResponse>(`${A}/metrics/summary?${WEEK}`);
    const one = await get<SummaryResponse>(
      `${A}/metrics/summary?${WEEK}&campaignIds=${ACME.campaigns[0]!.id}`,
    );
    expect(one.body.totalCalls.value ?? 0).toBeGreaterThan(0);
    expect(one.body.totalCalls.value).toBeLessThan(all.body.totalCalls.value ?? 0);

    const kpiIgnoresOutcome = await get<SummaryResponse>(`${A}/metrics/summary?${WEEK}&outcomes=missed`);
    expect(kpiIgnoresOutcome.body.ignoredFilters).toEqual(["outcomes"]);
    expect(kpiIgnoresOutcome.body.totalCalls.value).toBe(all.body.totalCalls.value);
  });

  it("compares with the previous period of the same length", async () => {
    const { body } = await get<SummaryResponse>(`${A}/metrics/summary?${WEEK}`);
    expect(body.previousRange).toMatchObject({ from: "2026-09-14", to: "2026-09-20" });
    expect(body.totalCalls.previous ?? 0).toBeGreaterThan(0);
    expect(body.conversionRate.value ?? 0).toBeGreaterThan(0);
    expect(body.conversionRate.value ?? 1).toBeLessThan(1);
  });

  it("conversion by source and by campaign cover the same calls", async () => {
    const bySource = await get<ConversionResponse>(`${A}/metrics/conversion?${WEEK}&groupBy=source`);
    const byCampaign = await get<ConversionResponse>(`${A}/metrics/conversion?${WEEK}&groupBy=campaign`);
    const resolved = (r: ConversionResponse) => r.groups.reduce((a, g) => a + g.resolved, 0);
    expect(resolved(bySource.body)).toBe(resolved(byCampaign.body));
    expect(byCampaign.body.groups).toHaveLength(ACME.campaigns.length);
    for (const g of bySource.body.groups) {
      expect(g.conversionRate).toBeCloseTo(g.converted / g.resolved, 10);
    }
  });

  it("paginates calls with a stable keyset cursor", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let last = Number.POSITIVE_INFINITY;
    for (let page = 0; page < 3; page++) {
      const url: string = `${A}/calls?from=2026-09-27&to=2026-09-27&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const { body }: { body: { items: FeedItem[]; nextCursor: string | null } } = await get(url);
      expect(body.items).toHaveLength(100);
      for (const item of body.items) {
        expect(seen.has(item.callId)).toBe(false);
        seen.add(item.callId);
        expect(Date.parse(item.startedAt)).toBeLessThanOrEqual(last);
        last = Date.parse(item.startedAt);
        expect(item.callerMasked).toMatch(/\*/); // never the raw number
      }
      cursor = body.nextCursor;
    }
    const bad = await get<{ title: string }>(`${A}/calls?cursor=garbage`);
    expect(bad.status).toBe(400);
  });

  it("never leaks another tenant's data, even when asked for its campaigns", async () => {
    const foreign = NORTHWIND.campaigns[0]!.id;
    const calls = await get<{ items: FeedItem[] }>(`${A}/calls?${WEEK}&campaignIds=${foreign}`);
    expect(calls.body.items).toEqual([]);
    const kpi = await get<SummaryResponse>(`${A}/metrics/summary?${WEEK}&campaignIds=${foreign}`);
    expect(kpi.body.totalCalls.value).toBe(0);
    const own = await get<{ items: FeedItem[] }>(`${A}/calls?${WEEK}&limit=100`);
    const acmeCampaigns = new Set(ACME.campaigns.map((c) => c.id));
    expect(own.body.items.every((i) => acmeCampaigns.has(i.campaign.id))).toBe(true);
  });
});

describe("ingest API", () => {
  it("accepts a batch, reports each outcome, and is idempotent on retry", async () => {
    const call = newCall({ startedAt: "2026-10-01T16:00:00.000Z" });
    const events = [
      ev(call, "call.started", "2026-10-01T16:00:00Z"),
      ev(call, "call.missed", "2026-10-01T16:00:30Z"),
    ];
    const post = () => t.app.inject({ method: "POST", url: "/api/v1/call-events", payload: { events } });
    const first = await post();
    expect(first.statusCode).toBe(200);
    expect(first.json().counts).toEqual({ applied: 2 });
    expect((await post()).json().counts).toEqual({ duplicate: 2 });
  });

  it("rejects malformed payloads with field paths", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/call-events",
      payload: { events: [{ eventId: "x", type: "call.teleported" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.length).toBeGreaterThan(0);
  });
});

describe("insights API", () => {
  it("returns grounded insights with their facts, caches them, and records feedback", async () => {
    const first = await get<InsightsResponse>(`${A}/insights?${WEEK}`);
    expect(first.status).toBe(200);
    expect(first.body.generator).toMatchObject({ kind: "template", promptVersion: "insights.v1" });
    expect(first.body.insights.length).toBeGreaterThan(0);
    expect(first.body.insights.length).toBeLessThanOrEqual(3);
    const ids = new Set(first.body.facts.map((f) => f.id));
    for (const i of first.body.insights) for (const id of i.factIds) expect(ids.has(id)).toBe(true);

    const again = await get<InsightsResponse>(`${A}/insights?${WEEK}`);
    expect(again.body.generatedAt).toBe(first.body.generatedAt); // served from cache

    const insight = first.body.insights[0]!;
    const fb = await t.app.inject({
      method: "POST",
      url: `${A}/insights/feedback`,
      payload: { cacheKey: first.body.cacheKey, insightId: insight.id, rating: -1, comment: "not useful" },
    });
    expect(fb.statusCode).toBe(204);
    const row = (await db.query("SELECT rating, prompt_version, insight FROM insight_feedback")).rows[0];
    expect(row).toMatchObject({ rating: -1, prompt_version: "insights.v1", insight: { id: insight.id } });

    const unknown = await t.app.inject({
      method: "POST",
      url: `${A}/insights/feedback`,
      payload: { cacheKey: "0123456789abcdef", insightId: "i1", rating: 1 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("ops", () => {
  it("exposes health and Prometheus metrics", async () => {
    expect((await t.app.inject("/readyz")).statusCode).toBe(200);
    const m = await t.app.inject("/metrics");
    expect(m.body).toContain("ingest_events_total");
    expect(m.body).toContain("insights_generations_total");
  });

  it("serves the OpenAPI document", async () => {
    const res = await t.app.inject("/api/docs/json");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain("/api/v1/accounts/{accountId}/metrics/volume");
  });
});
