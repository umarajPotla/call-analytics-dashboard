import { IngestBatch, IngestOutcome } from "@calls/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { HttpError } from "../http/errors";
import type { IngestService } from "../ingest/ingestService";
import { type AccountRateLimiter, countByAccount } from "../ingest/rateLimiter";

const Result = z.object({
  eventId: z.string(),
  outcome: IngestOutcome,
  seq: z.number().nullable(),
  reason: z.string().optional(),
});

type Deps = {
  ingest: IngestService;
  limiter?: AccountRateLimiter;
  onRateLimited?: (events: number) => void;
};

export const ingestRoutes: FastifyPluginAsyncZod<Deps> = async (app, { ingest, limiter, onRateLimited }) => {
  app.post(
    "/call-events",
    {
      bodyLimit: 1_048_576,
      schema: {
        tags: ["ingest"],
        summary: "Ingest call lifecycle events (idempotent, at-least-once safe)",
        description:
          "Send 1-500 events. Re-sending an event with the same eventId is a no-op ('duplicate'). Events may arrive in any order. Each event gets its own outcome.\n\n" +
          "Each account may send a sustained number of events per second, with a burst allowance. Over the limit the whole batch is refused with 429 and a `Retry-After` header, and nothing is applied: resend the same batch after that many seconds. " +
          "On a 5xx, resend the whole batch too: events that were already applied come back as 'duplicate'.",
        body: IngestBatch,
        response: { 200: z.object({ results: z.array(Result), counts: z.record(z.string(), z.number()) }) },
      },
    },
    async (req, reply) => {
      const perAccount = countByAccount(req.body.events);
      const waitSec = limiter?.take(perAccount) ?? 0;
      if (waitSec > 0) {
        onRateLimited?.(req.body.events.length);
        req.log.warn(
          { accounts: [...perAccount.keys()], events: req.body.events.length, retryAfterSec: waitSec },
          "ingest: rate limited",
        );
        reply.header("retry-after", String(waitSec));
        throw new HttpError(
          429,
          "Too many requests",
          `Ingest rate limit reached for an account in this batch. Nothing was applied; resend the batch in ${waitSec} s.`,
        );
      }
      const results = await ingest.ingestBatch(req.body.events);
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      return { results, counts };
    },
  );
};
