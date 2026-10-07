import type { Fact, Source, StatusCounts } from "@calls/shared";
import { type CampaignCounts, factsFromCounts, type HourCounts } from "../facts";

/**
 * Eval cases for insights. Each case is a realistic week of counts, turned into facts by the SAME rules that run
 * in production (factsFromCounts), plus what a good answer must and must not do.
 */
export type EvalCase = {
  name: string;
  description: string;
  facts: Fact[];
  expect: {
    /** Nothing notable: the generator must answer without calling the model. */
    noSignal?: boolean;
    /** Each inner list is one finding: at least one of its fact ids must be cited by some insight. */
    mustCover?: string[][];
    /** Fact ids that must never be cited (low volume or noise). */
    mustNotCite?: string[];
  };
};

/** Counts for `total` resolved calls with the given miss and conversion shares. */
export function counts(total: number, missShare: number, convShare: number): StatusCounts {
  const missed = Math.round(total * missShare);
  const converted = Math.round(total * convShare);
  return { ringing: 0, connected: total - missed - converted, missed, converted };
}

const campaign = (
  id: string,
  name: string,
  source: Source,
  cur: StatusCounts,
  prev: StatusCounts,
): CampaignCounts => ({
  id,
  name,
  source,
  cur,
  prev,
});

/** A business-hours day shape with misses concentrated where answer rates drop. */
function hours(scale: number, eveningMissShare = 0.45, dayMissShare = 0.12): HourCounts[] {
  const shape = [1, 1, 1, 1, 1, 2, 6, 14, 22, 26, 26, 25, 23, 24, 23, 22, 19, 15, 11, 8, 6, 4, 3, 2];
  return shape.map((v, h) => {
    const resolved = Math.round(v * scale);
    const share = h >= 8 && h < 17 ? dayMissShare : eveningMissShare;
    return { h, resolved, missed: Math.round(resolved * share) };
  });
}

// Stable steady-state campaigns reused across cases.
const steady = {
  nonBrand: campaign(
    "c-nonbrand",
    "Non-brand search",
    "google_ads",
    counts(2100, 0.2, 0.17),
    counts(2080, 0.2, 0.17),
  ),
  meta: campaign("c-meta", "Meta lookalikes", "meta", counts(1500, 0.24, 0.11), counts(1520, 0.24, 0.11)),
  tv: campaign("c-tv", "Regional TV", "tv", counts(900, 0.3, 0.12), counts(910, 0.3, 0.12)),
  organic: campaign(
    "c-organic",
    "Organic search",
    "organic",
    counts(1200, 0.2, 0.19),
    counts(1190, 0.2, 0.19),
  ),
};

export const CASES: EvalCase[] = [
  {
    name: "conversion-drop",
    description: "Brand search conversion fell sharply on similar volume; everything else steady.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.2), counts(2550, 0.18, 0.29)),
        steady.nonBrand,
        steady.meta,
        steady.tv,
        steady.organic,
      ],
      hours(10),
    ),
    expect: { mustCover: [["campaign:c-brand:conversion_rate", "source:google_ads:conversion_rate"]] },
  },
  {
    name: "tv-volume-spike",
    description: "A TV flight nearly doubled TV calls and its missed calls; staffing didn't keep up.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.27), counts(2580, 0.18, 0.27)),
        steady.nonBrand,
        steady.meta,
        campaign("c-tv", "Regional TV", "tv", counts(1750, 0.42, 0.1), counts(900, 0.3, 0.12)),
        steady.organic,
      ],
      hours(11),
    ),
    expect: { mustCover: [["source:tv:calls", "source:tv:missed"]] },
  },
  {
    name: "quiet-week",
    description: "Every change is within normal variation. The right answer is to say so.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.27), counts(2560, 0.18, 0.27)),
        steady.nonBrand,
        steady.meta,
        steady.tv,
        steady.organic,
      ],
      hours(10, 0.14, 0.12),
    ),
    expect: { noSignal: true },
  },
  {
    name: "low-volume-noise",
    description:
      "A tiny affiliate campaign swings wildly on a handful of calls; a real Meta drop sits next to it.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.27), counts(2560, 0.18, 0.27)),
        steady.nonBrand,
        campaign("c-meta", "Meta lookalikes", "meta", counts(1000, 0.24, 0.11), counts(1520, 0.24, 0.11)),
        steady.tv,
        campaign("c-aff1", "Partner A", "affiliate", counts(22, 0.2, 0.36), counts(25, 0.2, 0.08)),
        campaign("c-aff2", "Partner B", "affiliate", counts(18, 0.2, 0.05), counts(16, 0.2, 0.25)),
      ],
      hours(9, 0.14, 0.12),
    ),
    expect: {
      mustCover: [["source:meta:calls"]],
      mustNotCite: [
        "campaign:c-aff1:conversion_rate",
        "campaign:c-aff2:conversion_rate",
        "source:affiliate:conversion_rate",
      ],
    },
  },
  {
    name: "mixed-directions",
    description:
      "Meta conversion improved while Google Ads conversion dropped: directions must not be mixed up.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.21), counts(2580, 0.18, 0.28)),
        steady.nonBrand,
        campaign("c-meta", "Meta lookalikes", "meta", counts(1500, 0.24, 0.17), counts(1510, 0.24, 0.1)),
        steady.tv,
        steady.organic,
      ],
      hours(10, 0.14, 0.12),
    ),
    expect: {
      mustCover: [
        ["campaign:c-brand:conversion_rate", "source:google_ads:conversion_rate"],
        ["source:meta:conversion_rate"],
      ],
    },
  },
  {
    name: "evening-misses",
    description: "Volume and conversion are steady, but evening calls go unanswered.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.22, 0.26), counts(2580, 0.22, 0.26)),
        steady.nonBrand,
        steady.meta,
        steady.tv,
        steady.organic,
      ],
      hours(12, 0.6, 0.1),
    ),
    expect: { mustCover: [["account:all:missed_peak_window"]] },
  },
  {
    name: "many-signals",
    description:
      "A busy week with more notable changes than fit in three insights; the biggest must come first.",
    facts: factsFromCounts(
      [
        campaign("c-brand", "Brand search", "google_ads", counts(2600, 0.18, 0.19), counts(2580, 0.18, 0.28)),
        campaign(
          "c-nonbrand",
          "Non-brand search",
          "google_ads",
          counts(2600, 0.2, 0.17),
          counts(2080, 0.2, 0.17),
        ),
        campaign("c-meta", "Meta lookalikes", "meta", counts(1000, 0.24, 0.11), counts(1520, 0.24, 0.11)),
        campaign("c-tv", "Regional TV", "tv", counts(1500, 0.38, 0.1), counts(900, 0.3, 0.12)),
        campaign("c-organic", "Organic search", "organic", counts(1200, 0.2, 0.25), counts(1190, 0.2, 0.18)),
      ],
      hours(12, 0.5, 0.12),
    ),
    expect: { mustCover: [["campaign:c-brand:conversion_rate", "source:google_ads:conversion_rate"]] },
  },
];
