import type { CallEventInput } from "@calls/shared";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/pool";
import { rollupDrift } from "../../src/db/rollups";
import { CampaignDirectory } from "../../src/ingest/campaignDirectory";
import { IngestService } from "../../src/ingest/ingestService";
import { freshDb } from "../helpers/db";
import { ACME, ev, newCall } from "../helpers/events";

let db: Db;
let ingest: IngestService;

beforeAll(async () => {
  db = await freshDb();
  const campaigns = new CampaignDirectory(db);
  await campaigns.load();
  ingest = new IngestService(db, campaigns);
});
afterAll(() => db.end());

type Outcome = "missed" | "connected" | "converted";

/** A valid lifecycle for one call. The final status does not depend on delivery order (rank-monotonic machine). */
function lifecycle(
  outcome: Outcome,
  campaignIdx: number,
  startMinute: number,
): { events: CallEventInput[]; expected: Outcome } {
  const start = new Date(Date.UTC(2026, 8, 20, 0, 0) + startMinute * 60_000);
  const at = (s: number) => new Date(start.getTime() + s * 1000).toISOString();
  const call = newCall({ campaignId: ACME.campaigns[campaignIdx]!.id, startedAt: start.toISOString() });
  const events = [ev(call, "call.started", at(0))];
  if (outcome === "missed") events.push(ev(call, "call.missed", at(25)));
  else {
    events.push(ev(call, "call.answered", at(8)), ev(call, "call.ended", at(200), 192));
    if (outcome === "converted") events.push(ev(call, "call.converted", at(3600 * 30)));
  }
  return { events, expected: outcome };
}

describe("rollup reconciliation (property)", () => {
  it("rollup always equals a fresh recount, whatever the order and duplication of events", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            outcome: fc.constantFrom<Outcome>("missed", "connected", "converted"),
            campaign: fc.integer({ min: 0, max: ACME.campaigns.length - 1 }),
            minute: fc.integer({ min: 0, max: 60 * 48 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }), // shuffle seed
        fc.double({ min: 0, max: 0.4, noNaN: true }), // duplicate rate
        async (calls, seed, dupRate) => {
          await db.query("TRUNCATE calls, call_events, call_stats_hourly");
          const lifecycles = calls.map((c) => lifecycle(c.outcome, c.campaign, c.minute));
          let rnd = seed || 1;
          const next = () => {
            rnd = (rnd * 1103515245 + 12345) % 2 ** 31;
            return rnd / 2 ** 31;
          };
          const all = lifecycles.flatMap((l) => l.events);
          const withDupes = all.flatMap((e) => (next() < dupRate ? [e, e] : [e]));
          for (let i = withDupes.length - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            [withDupes[i], withDupes[j]] = [withDupes[j]!, withDupes[i]!];
          }
          // Deliver in a few concurrent streams to exercise the per-call lock.
          const streams = [0, 1, 2].map((k) => withDupes.filter((_, i) => i % 3 === k));
          await Promise.all(streams.map((s) => ingest.ingestBatch(s)));

          expect(await rollupDrift(db, new Date("2026-09-01T00:00:00Z"))).toBe(0);
          for (const l of lifecycles) {
            const row = (await db.query("SELECT status FROM calls WHERE id = $1", [l.events[0]!.call.id]))
              .rows[0];
            expect(row.status).toBe(l.expected);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
