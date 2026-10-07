import type { CallStatus, EventType } from "@calls/shared";

/**
 * The call lifecycle as a pure function: (current status, event) -> decision. No I/O, so every rule is
 * unit-testable and the ingest transaction stays a thin shell around it.
 *
 * Events can arrive late, twice, or out of order, so transitions only move FORWARD by rank:
 *   ringing (0)  ->  connected | missed (1)  ->  converted (2)
 * An event that would move backwards is stale and becomes a no-op. An event that contradicts an outcome is
 * rejected and kept in the log for inspection (a product decision, see DESIGN.md A4).
 */

export type Decision =
  | { kind: "apply"; next: CallStatus }
  | { kind: "noop" }
  | { kind: "reject"; reason: RejectReason };

export type RejectReason = "answered_after_missed" | "missed_after_answered" | "converted_after_missed";

export const STATUS_RANK: Record<CallStatus, number> = { ringing: 0, connected: 1, missed: 1, converted: 2 };

export function transition(current: CallStatus | null, event: EventType): Decision {
  switch (event) {
    case "call.started":
    case "call.ended":
      // Neither changes the outcome. They create the call if we have not seen it yet (out-of-order delivery).
      return current === null ? { kind: "apply", next: "ringing" } : { kind: "noop" };

    case "call.answered":
      if (current === null || current === "ringing") return { kind: "apply", next: "connected" };
      if (current === "missed") return { kind: "reject", reason: "answered_after_missed" };
      return { kind: "noop" }; // connected or converted: already past this point

    case "call.missed":
      if (current === null || current === "ringing") return { kind: "apply", next: "missed" };
      if (current === "missed") return { kind: "noop" };
      return { kind: "reject", reason: "missed_after_answered" };

    case "call.converted":
      if (current === "missed") return { kind: "reject", reason: "converted_after_missed" };
      if (current === "converted") return { kind: "noop" };
      return { kind: "apply", next: "converted" }; // from null, ringing or connected (late/offline conversions)
  }
}

/** Timestamps and attributes an event contributes. Applied with COALESCE so a late duplicate never erases data. */
export type CallFieldPatch = {
  answeredAt?: string;
  endedAt?: string;
  convertedAt?: string;
  durationSec?: number;
};

export function fieldsFor(event: EventType, occurredAt: string, durationSec?: number): CallFieldPatch {
  switch (event) {
    case "call.answered":
      return { answeredAt: occurredAt };
    case "call.ended":
      return durationSec === undefined ? { endedAt: occurredAt } : { endedAt: occurredAt, durationSec };
    case "call.converted":
      return { convertedAt: occurredAt };
    default:
      return {};
  }
}
