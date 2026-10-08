import { InsightsResponse } from "@calls/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/pool";
import type { AccountDirectory } from "../http/accounts";
import { AccountParams } from "../http/params";
import type { InsightsService } from "../insights/service";
import { resolveRange } from "../read/range";

type Deps = { db: Db; accounts: AccountDirectory; insights: InsightsService };

export const insightsRoutes: FastifyPluginAsyncZod<Deps> = async (app, { db, accounts, insights }) => {
  app.get(
    "/accounts/:accountId/insights",
    {
      schema: {
        tags: ["insights"],
        summary: "Up to three grounded insights about what changed vs the previous period",
        description:
          "Facts are computed in SQL; a language model (if configured) only selects and phrases them, and every number is checked against the facts. Falls back to a deterministic template. Covers all campaigns. Cached for up to 15 minutes.",
        params: AccountParams,
        querystring: z.object({
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
        }),
        response: { 200: InsightsResponse },
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      const range = await resolveRange(db, account.timezone, req.query.from, req.query.to, 92);
      reply.header("cache-control", "private, max-age=60");
      return insights.get(account.id, range);
    },
  );

  app.post(
    "/accounts/:accountId/insights/feedback",
    {
      schema: {
        tags: ["insights"],
        summary: "Thumbs up/down on one insight (feeds the eval set)",
        params: AccountParams,
        body: z.object({
          generationId: z.uuid(),
          insightId: z.string().min(1).max(8),
          rating: z.union([z.literal(1), z.literal(-1)]),
          comment: z.string().max(500).optional(),
        }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      await insights.feedback(account.id, req.body);
      return reply.status(204).send(null);
    },
  );
};
