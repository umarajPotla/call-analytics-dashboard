import { describe, expect, it } from "vitest";
import { CATALOG } from "../catalog";
import { callsPerMinute, foldAsOf, generateMinute, localHourAndWeekday } from "./model";

const acme = CATALOG[0]!;
// Tuesday 2026-10-06 18:30 UTC = 11:30 in Los Angeles (business hours)
const busyMinute = Date.UTC(2026, 9, 6, 18, 30);

describe("simulator model", () => {
  it("is deterministic: the same minute always produces the same calls and event ids", () => {
    expect(generateMinute(acme, busyMinute, 42)).toEqual(generateMinute(acme, busyMinute, 42));
    expect(generateMinute(acme, busyMinute, 42)).not.toEqual(generateMinute(acme, busyMinute, 43));
  });

  it("follows the local business-hours curve", () => {
    const night = Date.UTC(2026, 9, 6, 10, 30); // 03:30 in LA
    expect(callsPerMinute(acme, busyMinute, 1)).toBeGreaterThan(callsPerMinute(acme, night, 1) * 10);
    expect(localHourAndWeekday("America/Los_Angeles", busyMinute)).toEqual({ hour: 11, weekday: 2 });
  });

  it("generates valid lifecycles whose folded state respects time", () => {
    const calls = Array.from({ length: 60 }, (_, i) =>
      generateMinute(acme, busyMinute + i * 60_000, 7),
    ).flat();
    expect(calls.length).toBeGreaterThan(100);
    for (const c of calls) {
      expect(c.events[0]!.type).toBe("call.started");
      expect(foldAsOf(c, c.startedAt - 1)).toBeNull();
      expect(foldAsOf(c, c.startedAt)?.status).toBe("ringing");
      const final = foldAsOf(c, Number.MAX_SAFE_INTEGER)!;
      const types = c.events.map((e) => e.type);
      const expected = types.includes("call.converted")
        ? "converted"
        : types.includes("call.missed")
          ? "missed"
          : "connected";
      expect(final.status).toBe(expected);
    }
  });

  it("produces realistic rates in business hours", () => {
    const calls = Array.from({ length: 240 }, (_, i) =>
      generateMinute(acme, busyMinute + i * 60_000, 3),
    ).flat();
    const finals = calls.map((c) => foldAsOf(c, Number.MAX_SAFE_INTEGER)!.status);
    const answered = finals.filter((s) => s !== "missed").length / finals.length;
    const converted = finals.filter((s) => s === "converted").length / finals.length;
    expect(answered).toBeGreaterThan(0.75);
    expect(converted).toBeGreaterThan(0.1);
    expect(converted).toBeLessThan(0.35);
  });
});
