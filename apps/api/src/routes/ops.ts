import { AppMeta } from "@calls/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/pool";
import type { Metrics } from "../observability/metrics";

export const opsRoutes: FastifyPluginAsyncZod<{ db: Db; metrics: Metrics }> = async (
  app,
  { db, metrics },
) => {
  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));

  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });
};

export const devRoutes: FastifyPluginAsyncZod<{ spike: (accountId: string) => void }> = async (
  app,
  { spike },
) => {
  app.post(
    "/dev/spike",
    {
      schema: {
        tags: ["demo"],
        summary: "Demo control: 6x traffic for 10 minutes on one account (enabled only with DEV_TOOLS=true)",
        body: z.object({ accountId: z.uuid() }),
        response: { 202: z.object({ ok: z.boolean() }) },
      },
    },
    async (req, reply) => {
      spike(req.body.accountId);
      return reply.status(202).send({ ok: true });
    },
  );
};

export const metaRoutes: FastifyPluginAsyncZod<{ meta: AppMeta }> = async (app, { meta }) => {
  app.get(
    "/meta",
    {
      schema: {
        tags: ["accounts"],
        summary: "Deployment features the UI adapts to",
        response: { 200: AppMeta },
      },
    },
    async () => meta,
  );
};
