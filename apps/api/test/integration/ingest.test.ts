import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/pool";
import { rollupDrift } from "../../src/db/rollups";
import { CampaignDirectory } from "../../src/ingest/campaignDirectory";
import { IngestService, NOTIFY_CHANNEL } from "../../src/ingest/ingestService";
import { freshDb, TEST_DATABASE_URL } from "../helpers/db";
import { ACME, ev, NORTHWIND, newCall } from "../helpers/events";

let db: Db;
let ingest: IngestService;

beforeAll(async () => {
  db = await freshDb();
  const campaigns = new CampaignDirectory(db);
  await campaigns.load();
  ingest = new IngestService(db, campaigns);
});
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("TRUNCATE calls, call_events, call_stats_hourly");
});

const callRow = async (id: string) => (await db.query("SELECT * FROM calls WHERE id = $1", [id])).rows[0];
const bucket = async (campaignId: string) =>
  (
    await db.query(
      "SELECT ringing, connected, missed, converted FROM call_stats_hourly WHERE campaign_id = $1",
      [campaignId],
    )
  ).rows;

describe("ingest", () => {
  it("applies a full lifecycle and keeps one count per call in the start-hour bucket", async () => {
    const call = newCall();
    const results = await ingest.ingestBatch([
      ev(call, "call.started", "2026-10-05T17:15:00Z"),
      ev(call, "call.answered", "2026-10-05T17:15:12Z"),
      ev(call, "call.ended", "2026-10-05T17:19:12Z", 240),
      ev(call, "call.converted", "2026-10-05T17:19:40Z"),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["applied", "applied", "applied", "applied"]);
    const row = await callRow(call.id);
    expect(row.status).toBe("converted");
    expect(row.duration_sec).toBe(240);
    expect(await bucket(call.campaignId)).toEqual([{ ringing: 0, connected: 0, missed: 0, converted: 1 }]);
  });

  it("counts a duplicate delivery exactly once", async () => {
    const call = newCall();
    const started = ev(call, "call.started", "2026-10-05T17:15:00Z");
    const answered = ev(call, "call.answered", "2026-10-05T17:15:10Z");
    const results = await ingest.ingestBatch([started, answered, answered, started]);
    expect(results.map((r) => r.outcome)).toEqual(["applied", "applied", "duplicate", "duplicate"]);
    expect(await bucket(call.campaignId)).toEqual([{ ringing: 0, connected: 1, missed: 0, converted: 0 }]);
  });

  it("lands in the right state when events arrive out of order", async () => {
    const call = newCall();
    const results = await ingest.ingestBatch([
      ev(call, "call.converted", "2026-10-05T17:20:00Z"),
      ev(call, "call.started", "2026-10-05T17:15:00Z"),
      ev(call, "call.answered", "2026-10-05T17:15:10Z"),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["applied", "noop", "applied"]); // answered still records answered_at
    const row = await callRow(call.id);
    expect(row.status).toBe("converted");
    expect(row.answered_at).not.toBeNull();
    expect(await bucket(call.campaignId)).toEqual([{ ringing: 0, connected: 0, missed: 0, converted: 1 }]);
  });

  it("credits a late (offline) conversion to the hour the call started, not the hour it converted", async () => {
    const call = newCall({ startedAt: "2026-10-03T09:05:00Z" });
    await ingest.ingestBatch([
      ev(call, "call.started", "2026-10-03T09:05:00Z"),
      ev(call, "call.answered", "2026-10-03T09:05:20Z"),
      ev(call, "call.ended", "2026-10-03T09:09:00Z", 220),
    ]);
    await ingest.ingest(ev(call, "call.converted", "2026-10-05T14:00:00Z"));
    const rows = (
      await db.query(
        "SELECT bucket_start, connected, converted FROM call_stats_hourly WHERE campaign_id = $1",
        [call.campaignId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket_start.toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(rows[0]).toMatchObject({ connected: 0, converted: 1 });
  });

  it("rejects a conversion for a missed call and keeps it in the log", async () => {
    const call = newCall();
    await ingest.ingestBatch([
      ev(call, "call.started", "2026-10-05T17:15:00Z"),
      ev(call, "call.missed", "2026-10-05T17:15:30Z"),
    ]);
    const result = await ingest.ingest(ev(call, "call.converted", "2026-10-05T18:00:00Z"));
    expect(result).toMatchObject({ outcome: "rejected", reason: "converted_after_missed" });
    const logged = (
      await db.query("SELECT applied, reject_reason FROM call_events WHERE seq = $1", [result.seq])
    ).rows[0];
    expect(logged).toEqual({ applied: false, reject_reason: "converted_after_missed" });
    expect((await callRow(call.id)).status).toBe("missed");
  });

  it("rejects events for a campaign that belongs to another account, without storing them", async () => {
    const call = newCall({ accountId: NORTHWIND.id, campaignId: ACME.campaigns[0]!.id });
    const result = await ingest.ingest(ev(call, "call.started", "2026-10-05T17:15:00Z"));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unknown_campaign", seq: null });
    expect((await db.query("SELECT count(*)::int AS n FROM call_events")).rows[0].n).toBe(0);
  });

  it("rejects events from the future (clock skew beyond 5 minutes)", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await ingest.ingest(ev(newCall({ startedAt: future }), "call.started", future));
    expect(result).toMatchObject({ outcome: "rejected", reason: "occurred_in_future" });
  });

  it("stores only a masked caller number, never the raw one", async () => {
    const call = newCall({ callerNumber: "+14155550142" });
    await ingest.ingest(ev(call, "call.started", "2026-10-05T17:15:00Z"));
    expect((await callRow(call.id)).caller_masked).toBe("(415) ***-**42");
    const payload = JSON.stringify((await db.query("SELECT payload FROM call_events")).rows[0].payload);
    expect(payload).not.toContain("5550142");
  });

  it("serialises concurrent events for the same new call", async () => {
    const call = newCall();
    await Promise.all([
      ingest.ingest(ev(call, "call.started", "2026-10-05T17:15:00Z")),
      ingest.ingest(ev(call, "call.answered", "2026-10-05T17:15:10Z")),
      ingest.ingest(ev(call, "call.ended", "2026-10-05T17:18:00Z", 170)),
      ingest.ingest(ev(call, "call.converted", "2026-10-05T17:18:30Z")),
    ]);
    expect((await callRow(call.id)).status).toBe("converted");
    expect(await bucket(call.campaignId)).toEqual([{ ringing: 0, connected: 0, missed: 0, converted: 1 }]);
    expect(await rollupDrift(db, new Date("2026-10-01T00:00:00Z"))).toBe(0);
  });

  it("notifies the live feed only after commit", async () => {
    const listener = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await listener.connect();
    await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
    const received = new Promise<{ a: string; s: number; i: { callId: string; status: string } }>((resolve) =>
      listener.on("notification", (msg) => resolve(JSON.parse(msg.payload ?? "{}"))),
    );
    const call = newCall();
    const result = await ingest.ingest(ev(call, "call.started", "2026-10-05T17:15:00Z"));
    const msg = await received;
    expect(msg).toMatchObject({ a: ACME.id, s: result.seq, i: { callId: call.id, status: "ringing" } });
    await listener.end();
  });

  it("treats a replayed event id as a duplicate even with different content", async () => {
    const call = newCall();
    const first = ev(call, "call.started", "2026-10-05T17:15:00Z");
    await ingest.ingest(first);
    const replay = { ...first, type: "call.missed" as const, eventId: first.eventId };
    expect((await ingest.ingest(replay)).outcome).toBe("duplicate");
    expect((await callRow(call.id)).status).toBe("ringing");
    expect(randomUUID()).not.toBe(first.eventId);
  });
});
