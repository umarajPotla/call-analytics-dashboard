import type { FeedItem } from "@calls/shared";
import { describe, expect, it } from "vitest";
import { mergeFeed } from "./feed";

const item = (
  callId: string,
  status: FeedItem["status"],
  seq: number,
  startedAt = "2026-10-07T10:00:00Z",
): FeedItem => ({
  seq,
  callId,
  status,
  campaign: { id: "c", name: "Brand", source: "google_ads" },
  startedAt,
  answeredAt: null,
  endedAt: null,
  convertedAt: null,
  durationSec: null,
  callerMasked: "(415) ***-**42",
  callerRegion: null,
});

describe("mergeFeed", () => {
  it("updates a call in place instead of adding a second row", () => {
    const list = [item("a", "ringing", 1, "2026-10-07T10:01:00Z"), item("b", "ringing", 2)];
    const next = mergeFeed(list, item("b", "connected", 3), []);
    expect(next.map((i) => [i.callId, i.status])).toEqual([
      ["a", "ringing"],
      ["b", "connected"],
    ]);
  });

  it("ignores updates that would move a call backwards (late or replayed)", () => {
    const list = [item("a", "converted", 9)];
    expect(mergeFeed(list, item("a", "connected", 5), [])).toBe(list);
    expect(mergeFeed(list, item("a", "ringing", 12), [])).toBe(list);
  });

  it("inserts new calls by start time and stays bounded", () => {
    const list = [
      item("new", "ringing", 3, "2026-10-07T10:05:00Z"),
      item("old", "ringing", 1, "2026-10-07T10:00:00Z"),
    ];
    const next = mergeFeed(list, item("mid", "ringing", 4, "2026-10-07T10:02:00Z"), [], 2);
    expect(next.map((i) => i.callId)).toEqual(["new", "mid"]);
  });

  it("respects the outcome filter, including calls that stop matching", () => {
    const list = [item("a", "connected", 1)];
    expect(mergeFeed(list, item("b", "ringing", 2), ["connected"])).toBe(list);
    expect(mergeFeed(list, item("a", "converted", 3), ["connected"])).toEqual([]);
    expect(mergeFeed([], item("c", "converted", 4), ["converted"])).toHaveLength(1);
  });

  it("applies updates that don't change the status, such as a call ending", () => {
    const list = [item("a", "connected", 4)];
    const ended = { ...item("a", "connected", 7), endedAt: "2026-10-07T10:04:00Z", durationSec: 240 };
    expect(mergeFeed(list, ended, [])[0]).toMatchObject({ durationSec: 240, seq: 7 });
    expect(mergeFeed([ended], item("a", "connected", 4), [])).toEqual([ended]); // and ignores the older one
  });
});
