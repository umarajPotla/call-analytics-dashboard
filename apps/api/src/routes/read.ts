import {
  Account,
  answerRate,
  CallsPage,
  CampaignRef,
  ConversionResponse,
  conversionRate,
  Granularity,
  LATE_CONVERSION_HOURS,
  SummaryResponse,
  totalCalls,
  VolumeResponse,
} from "@calls/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/pool";
import type { AccountDirectory } from "../http/accounts";
import { AccountParams, OutcomeFilter, RangeQuery } from "../http/params";
import type { CampaignDirectory } from "../ingest/campaignDirectory";
import type { CallsRepo } from "../read/callsRepo";
import type { MetricsRepo } from "../read/metricsRepo";
import { lateConversionHorizon, previousRange, resolveRange } from "../read/range";

type Deps = {
  db: Db;
  accounts: AccountDirectory;
  campaigns: CampaignDirectory;
  metrics: MetricsRepo;
  calls: CallsRepo;
};

const CACHE = "private, max-age=5";

export const readRoutes: FastifyPluginAsyncZod<Deps> = async (
  app,
  { db, accounts, campaigns, metrics, calls },
) => {
  app.get(
    "/accounts",
    {
      schema: {
        tags: ["accounts"],
        summary: "Accounts the caller can see",
        response: { 200: z.array(Account) },
      },
    },
    async () => accounts.list(),
  );

  app.get(
    "/accounts/:accountId/campaigns",
    { schema: { tags: ["accounts"], params: AccountParams, response: { 200: z.array(CampaignRef) } } },
    async (req) => {
      accounts.require(req.params.accountId);
      return campaigns.forAccount(req.params.accountId).map(({ id, name, source }) => ({ id, name, source }));
    },
  );

  app.get(
    "/accounts/:accountId/metrics/volume",
    {
      schema: {
        tags: ["metrics"],
        summary: "Call volume over time, stacked by status",
        description:
          "Hourly buckets are UTC instants; daily buckets are local calendar days in the account's time zone.",
        params: AccountParams,
        querystring: RangeQuery.extend(OutcomeFilter.shape).extend({
          granularity: Granularity.default("hour"),
        }),
        response: { 200: VolumeResponse },
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      const q = req.query;
      const range = await resolveRange(
        db,
        account.timezone,
        q.from,
        q.to,
        q.granularity === "hour" ? 31 : 366,
      );
      const series =
        q.granularity === "hour"
          ? await metrics.hourly(account.id, range, q.campaignIds)
          : await metrics.daily(account.id, range, q.campaignIds);
      const keep = q.outcomes ? new Set(q.outcomes) : null;
      const filtered = keep
        ? series.map((p) => {
            const f = {
              ringing: keep.has("ringing") ? p.ringing : 0,
              connected: keep.has("connected") ? p.connected : 0,
              missed: keep.has("missed") ? p.missed : 0,
              converted: keep.has("converted") ? p.converted : 0,
            };
            return { bucket: p.bucket, ...f, total: totalCalls(f) };
          })
        : series;
      reply.header("cache-control", CACHE);
      return {
        accountId: account.id,
        timezone: account.timezone,
        granularity: q.granularity,
        from: range.from,
        to: range.to,
        series: filtered,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/accounts/:accountId/metrics/conversion",
    {
      schema: {
        tags: ["metrics"],
        summary: "Conversion rate by campaign source (or campaign)",
        description: "Conversion rate = converted / resolved calls. The outcome filter does not apply here.",
        params: AccountParams,
        querystring: RangeQuery.extend(OutcomeFilter.shape).extend({
          groupBy: z.enum(["source", "campaign"]).default("source"),
        }),
        response: { 200: ConversionResponse },
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      const range = await resolveRange(db, account.timezone, req.query.from, req.query.to, 366);
      const groups = await metrics.conversion(account.id, range, req.query.groupBy, req.query.campaignIds);
      const horizon = await lateConversionHorizon(db, account.timezone, LATE_CONVERSION_HOURS);
      reply.header("cache-control", CACHE);
      return {
        groupBy: req.query.groupBy,
        groups,
        ignoredFilters: req.query.outcomes ? ["outcomes"] : [],
        maturity: { mayStillUpdateFrom: horizon },
      };
    },
  );

  app.get(
    "/accounts/:accountId/metrics/summary",
    {
      schema: {
        tags: ["metrics"],
        summary: "KPI tiles with the previous period for comparison",
        description:
          "If the range includes today, the previous period is cut at the same local time (this week so far vs last week up to now).",
        params: AccountParams,
        querystring: RangeQuery.extend(OutcomeFilter.shape),
        response: { 200: SummaryResponse },
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      const range = await resolveRange(db, account.timezone, req.query.from, req.query.to, 366);
      const prev = await previousRange(db, range);
      const [cur, before] = await Promise.all([
        metrics.totals(account.id, range, req.query.campaignIds),
        metrics.totalsAsOf(account.id, prev, req.query.campaignIds),
      ]);
      reply.header("cache-control", CACHE);
      return {
        totalCalls: { value: totalCalls(cur), previous: totalCalls(before) },
        answerRate: { value: answerRate(cur), previous: answerRate(before) },
        conversionRate: { value: conversionRate(cur), previous: conversionRate(before) },
        missedCalls: { value: cur.missed, previous: before.missed },
        inProgress: cur.ringing,
        previousRange: { from: prev.from, to: prev.to, asOf: prev.asOfUtc.toISOString() },
        ignoredFilters: req.query.outcomes ? ["outcomes"] : [],
      };
    },
  );

  app.get(
    "/accounts/:accountId/calls",
    {
      schema: {
        tags: ["calls"],
        summary: "Recent calls, newest first (keyset pagination)",
        params: AccountParams,
        querystring: RangeQuery.extend(OutcomeFilter.shape).extend({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
        }),
        response: { 200: CallsPage },
      },
    },
    async (req) => {
      const account = accounts.require(req.params.accountId);
      const range = await resolveRange(db, account.timezone, req.query.from, req.query.to, 366);
      return calls.page(
        account.id,
        range,
        { campaignIds: req.query.campaignIds, outcomes: req.query.outcomes },
        req.query.limit,
        req.query.cursor,
      );
    },
  );

  app.get(
    "/accounts/:accountId/calls/changes",
    {
      schema: {
        tags: ["calls"],
        summary: "Polling fallback for the live feed: calls changed after a sequence number",
        params: AccountParams,
        querystring: z.object({ afterSeq: z.coerce.number().int().min(0).default(0) }),
        response: {
          200: z.object({ items: CallsPage.shape.items, latestSeq: z.number(), truncated: z.boolean() }),
        },
      },
    },
    async (req) => {
      const account = accounts.require(req.params.accountId);
      const latestSeq = await calls.latestSeq(account.id);
      const afterSeq = req.query.afterSeq || Math.max(0, latestSeq - 50);
      const { items, truncated } = await calls.changesSince(account.id, afterSeq, 200);
      return { items, latestSeq, truncated };
    },
  );
};
