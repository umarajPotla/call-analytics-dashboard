import { randomUUID } from "node:crypto";
import type { CallEventInput, EventType } from "@calls/shared";
import { CATALOG } from "../../src/catalog";

export const ACME = CATALOG[0]!;
export const NORTHWIND = CATALOG[1]!;

export function newCall(overrides: Partial<CallEventInput["call"]> = {}): CallEventInput["call"] {
  return {
    id: randomUUID(),
    accountId: ACME.id,
    campaignId: ACME.campaigns[0]!.id,
    startedAt: "2026-10-05T17:15:00.000Z",
    callerNumber: "+14155550142",
    callerRegion: "San Francisco, CA",
    ...overrides,
  };
}

export function ev(
  call: CallEventInput["call"],
  type: EventType,
  occurredAt: string,
  durationSec?: number,
): CallEventInput {
  return {
    eventId: randomUUID(),
    type,
    occurredAt,
    call,
    ...(durationSec === undefined ? {} : { data: { durationSec } }),
  };
}
