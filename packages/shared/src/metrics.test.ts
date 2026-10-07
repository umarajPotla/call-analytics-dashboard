import { describe, expect, it } from "vitest";
import {
  answerRate,
  conversionRate,
  conversionRateOfAnswered,
  emptyCounts,
  isLowVolume,
  resolvedCalls,
  totalCalls,
} from "./metrics";

describe("metric definitions", () => {
  const c = { ringing: 5, connected: 60, missed: 20, converted: 20 };

  it("excludes in-progress calls from the resolved denominator", () => {
    expect(totalCalls(c)).toBe(105);
    expect(resolvedCalls(c)).toBe(100);
  });

  it("computes conversion rate over resolved calls and over answered calls", () => {
    expect(conversionRate(c)).toBeCloseTo(0.2);
    expect(conversionRateOfAnswered(c)).toBeCloseTo(0.25);
    expect(answerRate(c)).toBeCloseTo(0.8);
  });

  it("returns null (not 0 or NaN) when there is nothing to divide by", () => {
    const empty = emptyCounts();
    expect(conversionRate(empty)).toBeNull();
    expect(answerRate({ ...empty, ringing: 3 })).toBeNull();
  });

  it("flags low volume below 30 resolved calls", () => {
    expect(isLowVolume({ ...emptyCounts(), converted: 1, missed: 1 })).toBe(true);
    expect(isLowVolume(c)).toBe(false);
  });
});
