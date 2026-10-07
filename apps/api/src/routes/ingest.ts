import { IngestBatch, IngestOutcome } from "@calls/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { IngestService } from "../ingest/ingestService";

const Result = z.object({
  eventId: z.string(),
  outcome: IngestOutcome,
  seq: z.number().nullable(),
  reason: z.string().optional(),
});

export const ingestRoutes: FastifyPluginAsyncZod<{ ingest: IngestService }> = async (app, { ingest }) => {
  app.post(
    "/call-events",
    {
      bodyLimit: 1_048_576,
      schema: {
        tags: ["ingest"],
        summary: "Ingest call lifecycle events (idempotent, at-least-once safe)",
        description:
          "Send 1-500 events. Re-sending an event with the same eventId is a no-op ('duplicate'). Events may arrive in any order. Each event gets its own outcome.",
        body: IngestBatch,
        response: { 200: z.object({ results: z.array(Result), counts: z.record(z.string(), z.number()) }) },
      },
    },
    async (req) => {
      const results = await ingest.ingestBatch(req.body.events);
      const counts: Record<string, number> = {};
      for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      return { results, counts };
    },
  );
};
