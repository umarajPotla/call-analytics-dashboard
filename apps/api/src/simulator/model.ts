import type { CallStatus, EventType } from "@calls/shared";
import type { AccountProfile } from "../catalog";
import { fieldsFor, transition } from "../domain/callStateMachine";
import {
  between,
  exponential,
  hashSeed,
  logNormal,
  mulberry32,
  pickWeighted,
  poisson,
  uuidFrom,
} from "./prng";

/**
 * Traffic model. Shapes that make the charts tell a story:
 * - business-hours curve in the account's own time zone, quieter weekends
 * - answer rate drops after hours (missed calls cluster in the evening)
 * - conversion varies by campaign and rises with call duration
 * - ~35% of conversions arrive hours later (offline/CRM), up to 72 h
 * - each campaign drifts slowly on its own multi-week cycle (volume and conversion), so week-over-week
 *   comparisons contain real changes for the insights to find, not only sampling noise
 */

// Relative call volume by local hour, 00..23.
const HOUR_CURVE = [
  0.05, 0.03, 0.02, 0.02, 0.03, 0.08, 0.25, 0.55, 0.85, 1.0, 1.0, 0.95, 0.9, 0.92, 0.9, 0.85, 0.75, 0.6, 0.42,
  0.3, 0.22, 0.15, 0.1, 0.07,
];
const HOUR_CURVE_SUM = HOUR_CURVE.reduce((a, b) => a + b, 0);
// Sunday..Saturday
const WEEKDAY_FACTOR = [0.4, 1.05, 1.0, 1.0, 1.0, 0.95, 0.55];

export const LATE_CONVERSION_MAX_MS = 72 * 3600_000;
const DAY_MS = 86_400_000;

/** Deterministic drift multipliers for one campaign at one instant. Pure in (campaign, time). */
export function campaignDrift(campaignId: string, ms: number): { volume: number; conversion: number } {
  const phase = (hashSeed(campaignId, "phase") / 2 ** 32) * 2 * Math.PI;
  const day = ms / DAY_MS;
  return {
    volume: 1 + 0.25 * Math.sin((2 * Math.PI * day) / 19 + phase),
    conversion: 1 + 0.25 * Math.sin((2 * Math.PI * day) / 29 + 1.7 * phase),
  };
}

const AREA_CODES: Record<string, Array<[string, string]>> = {
  "America/Los_Angeles": [
    ["415", "San Francisco, CA"],
    ["510", "Oakland, CA"],
    ["408", "San Jose, CA"],
    ["916", "Sacramento, CA"],
    ["213", "Los Angeles, CA"],
    ["619", "San Diego, CA"],
  ],
  "America/New_York": [
    ["212", "New York, NY"],
    ["718", "Brooklyn, NY"],
    ["516", "Long Island, NY"],
    ["201", "Jersey City, NJ"],
    ["914", "Yonkers, NY"],
  ],
  "Europe/London": [
    ["44-20", "London"],
    ["44-161", "Manchester"],
    ["44-121", "Birmingham"],
    ["44-117", "Bristol"],
  ],
};

export type SimEvent = { eventId: string; type: EventType; at: number; durationSec?: number };
export type SimCall = {
  id: string;
  accountId: string;
  campaignId: string;
  startedAt: number;
  callerNumber: string;
  callerRegion: string;
  events: SimEvent[];
};

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localHourAndWeekday(timezone: string, ms: number): { hour: number; weekday: number } {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    });
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export function callsPerMinute(account: AccountProfile, ms: number, multiplier: number): number {
  const { hour, weekday } = localHourAndWeekday(account.timezone, ms);
  return (
    ((account.callsPerDay * HOUR_CURVE[hour]!) / HOUR_CURVE_SUM / 60) * WEEKDAY_FACTOR[weekday]! * multiplier
  );
}

function answerProbability(hour: number, weekday: number): number {
  const weekend = weekday === 0 || weekday === 6;
  if (hour < 7 || hour >= 21) return 0.35;
  if (weekend) return 0.66;
  if (hour >= 8 && hour < 18) return 0.88;
  return 0.55;
}

/** All calls that start in one minute for one account, with their full future lifecycle. Pure and repeatable. */
export function generateMinute(
  account: AccountProfile,
  minuteStart: number,
  seed: number,
  multiplier = 1,
  salt = "",
): SimCall[] {
  const rng = mulberry32(hashSeed(seed, account.id, minuteStart, salt));
  const mix = account.campaigns.map((c) => {
    const d = campaignDrift(c.id, minuteStart);
    return { campaign: c, weight: c.weight * d.volume, conversion: c.conversion * d.conversion };
  });
  const volumeFactor =
    mix.reduce((s, m) => s + m.weight, 0) / account.campaigns.reduce((s, c) => s + c.weight, 0);
  const n = poisson(rng, callsPerMinute(account, minuteStart, multiplier) * volumeFactor);
  const areas = AREA_CODES[account.timezone] ?? AREA_CODES["America/Los_Angeles"]!;
  const calls: SimCall[] = [];
  for (let i = 0; i < n; i++) {
    const id = uuidFrom(rng);
    const t0 = minuteStart + Math.floor(rng() * 60_000);
    const { campaign, conversion } = pickWeighted(rng, mix);
    const [area, region] = areas[Math.floor(rng() * areas.length)]!;
    const callerNumber = area.startsWith("44-")
      ? `+${area.replace("-", " ")} ${String(Math.floor(between(rng, 1000, 9999)))} ${String(Math.floor(between(rng, 100, 999)))}`
      : `+1${area}555${String(Math.floor(between(rng, 100, 199))).padStart(4, "0")}`;
    const { hour, weekday } = localHourAndWeekday(account.timezone, t0);
    const events: SimEvent[] = [{ eventId: uuidFrom(rng), type: "call.started", at: t0 }];

    if (rng() >= answerProbability(hour, weekday)) {
      events.push({
        eventId: uuidFrom(rng),
        type: "call.missed",
        at: t0 + Math.round(between(rng, 20_000, 35_000)),
      });
    } else {
      const answeredAt = t0 + Math.round(between(rng, 4_000, 20_000));
      const durationSec = Math.round(Math.min(3600, Math.max(20, logNormal(rng, 170, 0.6))));
      const endedAt = answeredAt + durationSec * 1000;
      events.push(
        { eventId: uuidFrom(rng), type: "call.answered", at: answeredAt },
        { eventId: uuidFrom(rng), type: "call.ended", at: endedAt, durationSec },
      );
      const durationFactor = durationSec > 240 ? 1.25 : durationSec < 60 ? 0.4 : 1;
      if (rng() < Math.min(0.95, conversion * durationFactor)) {
        const delay =
          rng() < 0.65
            ? between(rng, 5_000, 90_000)
            : Math.min(exponential(rng, 6 * 3600_000), LATE_CONVERSION_MAX_MS);
        events.push({ eventId: uuidFrom(rng), type: "call.converted", at: endedAt + Math.round(delay) });
      }
    }
    calls.push({
      id,
      accountId: account.id,
      campaignId: campaign.id,
      startedAt: t0,
      callerNumber,
      callerRegion: region,
      events,
    });
  }
  return calls;
}

export type FoldedCall = {
  status: CallStatus;
  answeredAt: string | null;
  endedAt: string | null;
  convertedAt: string | null;
  durationSec: number | null;
};

/** The call's state as of `asOf`, computed with the same state machine the ingest path uses. */
export function foldAsOf(call: SimCall, asOf: number): FoldedCall | null {
  let status: CallStatus | null = null;
  const out: FoldedCall = {
    status: "ringing",
    answeredAt: null,
    endedAt: null,
    convertedAt: null,
    durationSec: null,
  };
  for (const e of [...call.events].sort((a, b) => a.at - b.at)) {
    if (e.at > asOf) break;
    const d = transition(status, e.type);
    if (d.kind === "reject") continue;
    if (d.kind === "apply") status = d.next;
    const p = fieldsFor(e.type, new Date(e.at).toISOString(), e.durationSec);
    out.answeredAt ??= p.answeredAt ?? null;
    out.endedAt ??= p.endedAt ?? null;
    out.convertedAt ??= p.convertedAt ?? null;
    out.durationSec ??= p.durationSec ?? null;
  }
  if (status === null) return null;
  out.status = status;
  return out;
}
