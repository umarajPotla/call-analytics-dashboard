import { describe, expect, it } from "vitest";
import { counts } from "./eval/cases";
import { type CampaignCounts, factsFromCounts, poissonZ, twoProportionZ } from "./facts";

const camp = (
  id: string,
  source: CampaignCounts["source"],
  cur: CampaignCounts["cur"],
  prev: CampaignCounts["prev"],
) => ({
  id,
  name: id,
  source,
  cur,
  prev,
});
const byId = (facts: ReturnType<typeof factsFromCounts>) => new Map(facts.map((f) => [f.id, f]));

describe("fact rules", () => {
  it("z statistics", () => {
    expect(twoProportionZ(50, 100, 50, 100)).toBe(0);
    expect(twoProportionZ(60, 100, 40, 100)).toBeCloseTo(2.83, 2);
    expect(poissonZ(130, 100)).toBeCloseTo(1.98, 2);
    expect(poissonZ(0, 0)).toBe(0);
  });

  it("a large change on small volume is not notable", () => {
    const f = byId(
      factsFromCounts(
        [
          camp("big", "google_ads", counts(3000, 0.2, 0.25), counts(3000, 0.2, 0.25)),
          camp("tiny", "affiliate", counts(20, 0.2, 0.5), counts(20, 0.2, 0.1)),
          camp("tiny2", "affiliate", counts(20, 0.2, 0.1), counts(20, 0.2, 0.1)),
        ],
        [],
      ),
    );
    expect(f.get("campaign:tiny:conversion_rate")!.notable).toBe(false);
    expect(f.get("source:affiliate:conversion_rate")!.notable).toBe(false);
  });

  it("a small but real rate change on big volume is notable only past both the z and the 2-point floor", () => {
    const mk = (cur: number) =>
      byId(factsFromCounts([camp("a", "meta", counts(20_000, 0.2, cur), counts(20_000, 0.2, 0.2))], [])).get(
        "source:meta:conversion_rate",
      )!;
    expect(mk(0.21).notable).toBe(false); // z ~ 2.5 and only 1 point
    expect(mk(0.225).notable).toBe(true); // z ~ 6, 2.5 points
  });

  it("does not repeat a single-campaign source at campaign level", () => {
    const facts = factsFromCounts(
      [
        camp("tv", "tv", counts(900, 0.3, 0.1), counts(500, 0.3, 0.1)),
        camp("b1", "google_ads", counts(900, 0.3, 0.1), counts(900, 0.3, 0.1)),
        camp("b2", "google_ads", counts(900, 0.3, 0.1), counts(900, 0.3, 0.1)),
      ],
      [],
    );
    expect(facts.some((f) => f.id.startsWith("campaign:tv:"))).toBe(false);
    expect(facts.some((f) => f.id.startsWith("campaign:b1:"))).toBe(true);
  });

  it("ranks every kind of change in estimated conversions", () => {
    // The account converts 18% of resolved calls now, so +500 calls ~ 90 conversions; -5 points on 1,000 calls = 50.
    const f = byId(
      factsFromCounts(
        [
          camp("a", "tv", counts(1500, 0.2, 0.2), counts(1000, 0.2, 0.2)),
          camp("b", "meta", counts(1000, 0.2, 0.15), counts(1000, 0.2, 0.2)),
        ],
        [],
      ),
    );
    expect(f.get("source:tv:calls")!.impact).toBeCloseTo(500 * (450 / 2500), 0);
    expect(f.get("source:meta:conversion_rate")!.impact).toBeCloseTo(50, 0);
  });

  it("picks the missed-call window with the most excess misses, not the highest rate on a handful of calls", () => {
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, resolved: 100, missed: 10 }));
    hours[3] = { h: 3, resolved: 20, missed: 18 }; // 90% of very few calls
    hours[18] = { h: 18, resolved: 300, missed: 150 }; // 50% of many
    hours[19] = { h: 19, resolved: 250, missed: 120 };
    const facts = factsFromCounts([camp("a", "tv", counts(2000, 0.15, 0.2), counts(2000, 0.15, 0.2))], hours);
    const peak = facts.find((x) => x.metric === "missed_peak_window")!;
    expect(peak.display[0]).toBe("6 pm–8 pm");
    expect(peak.notable).toBe(true);
  });
});
