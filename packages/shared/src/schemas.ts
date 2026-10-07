import { z } from "zod";

/** Wire contract for the API. The server validates with these; the web app types its client with them. */

export const CALL_STATUSES = ["ringing", "connected", "missed", "converted"] as const;
export const CallStatus = z.enum(CALL_STATUSES);
export type CallStatus = z.infer<typeof CallStatus>;

/** Outcomes a user can filter by. "ringing" is shown as "In progress". */
export const Outcome = CallStatus;

export const EVENT_TYPES = [
  "call.started",
  "call.answered",
  "call.missed",
  "call.ended",
  "call.converted",
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const SOURCES = ["google_ads", "meta", "tv", "organic", "direct_mail", "affiliate"] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const SOURCE_LABELS: Record<Source, string> = {
  google_ads: "Google Ads",
  meta: "Meta",
  tv: "TV",
  organic: "Organic search",
  direct_mail: "Direct mail",
  affiliate: "Affiliate",
};

/** One call lifecycle event, as sent by a telephony integration (or the simulator). Self-describing on purpose:
 * every event carries the call's identity so events can be applied in any order. */
export const CallEventInput = z.object({
  eventId: z.uuid(),
  type: EventType,
  occurredAt: z.iso.datetime({ offset: true }),
  call: z.object({
    id: z.uuid(),
    accountId: z.uuid(),
    campaignId: z.uuid(),
    startedAt: z.iso.datetime({ offset: true }),
    callerNumber: z.string().max(32).optional(),
    callerRegion: z.string().max(64).optional(),
  }),
  data: z
    .object({
      durationSec: z.number().int().min(0).max(86_400).optional(),
    })
    .optional(),
});
export type CallEventInput = z.infer<typeof CallEventInput>;

export const IngestBatch = z.object({ events: z.array(CallEventInput).min(1).max(500) });
export type IngestBatch = z.infer<typeof IngestBatch>;

export const IngestOutcome = z.enum(["applied", "noop", "duplicate", "rejected"]);
export type IngestOutcome = z.infer<typeof IngestOutcome>;

export const CampaignRef = z.object({ id: z.uuid(), name: z.string(), source: Source });
export type CampaignRef = z.infer<typeof CampaignRef>;

/** A row in the live feed. Sent over SSE and by GET /calls. */
export const FeedItem = z.object({
  seq: z.number().int().nullable(),
  callId: z.uuid(),
  status: CallStatus,
  campaign: CampaignRef,
  startedAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  convertedAt: z.string().nullable(),
  durationSec: z.number().int().nullable(),
  callerMasked: z.string().nullable(),
  callerRegion: z.string().nullable(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const Account = z.object({ id: z.uuid(), name: z.string(), timezone: z.string() });
export type Account = z.infer<typeof Account>;

export const Granularity = z.enum(["hour", "day"]);
export type Granularity = z.infer<typeof Granularity>;

export const VolumePoint = z.object({
  bucket: z.string(),
  ringing: z.number(),
  connected: z.number(),
  missed: z.number(),
  converted: z.number(),
  total: z.number(),
});
export type VolumePoint = z.infer<typeof VolumePoint>;

export const VolumeResponse = z.object({
  accountId: z.uuid(),
  timezone: z.string(),
  granularity: Granularity,
  from: z.string(),
  to: z.string(),
  series: z.array(VolumePoint),
  generatedAt: z.string(),
});
export type VolumeResponse = z.infer<typeof VolumeResponse>;

export const ConversionGroup = z.object({
  key: z.string(),
  label: z.string(),
  source: Source,
  resolved: z.number(),
  answered: z.number(),
  converted: z.number(),
  missed: z.number(),
  conversionRate: z.number().nullable(),
  conversionRateOfAnswered: z.number().nullable(),
  lowVolume: z.boolean(),
});
export type ConversionGroup = z.infer<typeof ConversionGroup>;

export const ConversionResponse = z.object({
  groupBy: z.enum(["source", "campaign"]),
  groups: z.array(ConversionGroup),
  ignoredFilters: z.array(z.string()),
  maturity: z.object({ mayStillUpdateFrom: z.string() }),
});
export type ConversionResponse = z.infer<typeof ConversionResponse>;

export const Kpi = z.object({ value: z.number().nullable(), previous: z.number().nullable() });
export type Kpi = z.infer<typeof Kpi>;

export const SummaryResponse = z.object({
  totalCalls: Kpi,
  answerRate: Kpi,
  conversionRate: Kpi,
  missedCalls: Kpi,
  inProgress: z.number(),
  /** The comparison period. `asOf` is where it was cut: the same local time as now if the range includes today. */
  previousRange: z.object({ from: z.string(), to: z.string(), asOf: z.string() }),
  ignoredFilters: z.array(z.string()),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;

export const CallsPage = z.object({ items: z.array(FeedItem), nextCursor: z.string().nullable() });
export type CallsPage = z.infer<typeof CallsPage>;

export const Insight = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  action: z.string().nullable(),
  factIds: z.array(z.string()),
});
export type Insight = z.infer<typeof Insight>;

export const Fact = z.object({
  id: z.string(),
  metric: z.enum(["calls", "missed", "conversion_rate", "missed_peak_window"]),
  dimension: z.enum(["account", "source", "campaign"]),
  label: z.string(),
  current: z.number(),
  previous: z.number().nullable(),
  changePct: z.number().nullable(),
  volume: z.number(),
  notable: z.boolean(),
  impact: z.number(),
  /** Pre-formatted numbers the generator may quote, e.g. ["38%", "212", "154"]. */
  display: z.array(z.string()),
  detail: z.string().nullable(),
});
export type Fact = z.infer<typeof Fact>;

export const InsightsResponse = z.object({
  insights: z.array(Insight),
  facts: z.array(Fact),
  generator: z.object({
    kind: z.enum(["llm", "template"]),
    model: z.string().nullable(),
    promptVersion: z.string(),
    fallbackReason: z.string().nullable(),
  }),
  cacheKey: z.string(),
  generatedAt: z.string(),
});
export type InsightsResponse = z.infer<typeof InsightsResponse>;
