import type { CallStatus, EventType } from "@calls/shared";
import { describe, expect, it } from "vitest";
import { fieldsFor, transition } from "./callStateMachine";

describe("call state machine", () => {
  const cases: Array<[CallStatus | null, EventType, ReturnType<typeof transition>]> = [
    // Normal lifecycle
    [null, "call.started", { kind: "apply", next: "ringing" }],
    ["ringing", "call.answered", { kind: "apply", next: "connected" }],
    ["ringing", "call.missed", { kind: "apply", next: "missed" }],
    ["connected", "call.converted", { kind: "apply", next: "converted" }],
    // Out of order: later events arrive first and still land in the right state
    [null, "call.answered", { kind: "apply", next: "connected" }],
    [null, "call.converted", { kind: "apply", next: "converted" }],
    [null, "call.ended", { kind: "apply", next: "ringing" }],
    ["ringing", "call.converted", { kind: "apply", next: "converted" }],
    // Stale events never move a call backwards
    ["connected", "call.started", { kind: "noop" }],
    ["converted", "call.answered", { kind: "noop" }],
    ["converted", "call.ended", { kind: "noop" }],
    ["missed", "call.missed", { kind: "noop" }],
    ["converted", "call.converted", { kind: "noop" }],
    // Contradictions are rejected (kept in the log, not applied)
    ["missed", "call.converted", { kind: "reject", reason: "converted_after_missed" }],
    ["missed", "call.answered", { kind: "reject", reason: "answered_after_missed" }],
    ["connected", "call.missed", { kind: "reject", reason: "missed_after_answered" }],
    ["converted", "call.missed", { kind: "reject", reason: "missed_after_answered" }],
  ];

  it.each(cases)("%s + %s", (current, event, expected) => {
    expect(transition(current, event)).toEqual(expected);
  });

  it("extracts only the fields an event is responsible for", () => {
    expect(fieldsFor("call.answered", "T1")).toEqual({ answeredAt: "T1" });
    expect(fieldsFor("call.ended", "T2", 95)).toEqual({ endedAt: "T2", durationSec: 95 });
    expect(fieldsFor("call.converted", "T3")).toEqual({ convertedAt: "T3" });
    expect(fieldsFor("call.started", "T0")).toEqual({});
  });
});
