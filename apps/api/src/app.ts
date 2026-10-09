import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config";
import type { Db } from "./db/pool";
import { AccountDirectory } from "./http/accounts";
import { registerProblemHandler } from "./http/problem";
import type { CampaignDirectory } from "./ingest/campaignDirectory";
import type { IngestService } from "./ingest/ingestService";
import type { AccountRateLimiter } from "./ingest/rateLimiter";
import type { InsightsService } from "./insights/service";
import { createLogger } from "./observability/logger";
import type { Metrics } from "./observability/metrics";
import { CallsRepo } from "./read/callsRepo";
import { MetricsRepo } from "./read/metricsRepo";
import type { SseHub } from "./realtime/sseHub";
import { ingestRoutes } from "./routes/ingest";
import { insightsRoutes } from "./routes/insights";
import { devRoutes, metaRoutes, opsRoutes } from "./routes/ops";
import { readRoutes } from "./routes/read";
import { streamRoutes } from "./routes/stream";

export type AppDeps = {
  config: Pick<Config, "LOG_LEVEL" | "DEV_TOOLS" | "WEB_DIST"> & Partial<Pick<Config, "GRAFANA_URL">>;
  db: Db;
  campaigns: CampaignDirectory;
  ingest: IngestService;
  /** Per-account ingest rate limit; omitted = unlimited (tests). */
  ingestLimiter?: AccountRateLimiter;
  hub: SseHub;
  metrics: Metrics;
  insights?: InsightsService;
  spike?: (accountId: string) => void;
  logger?: FastifyBaseLogger;
};

/** Builds the HTTP app from its dependencies. Tests call this with a test database; server.ts wires production. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger(deps.config.LOG_LEVEL),
    // Per-request logs only when debugging; latency and status go to Prometheus instead.
    logController: new LogController({ disableRequestLogging: deps.config.LOG_LEVEL !== "debug" }),
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemHandler(app);

  app.addHook("onResponse", async (req, reply) => {
    deps.metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Call Analytics API",
        version: "1.0.0",
        description: "Real-time call analytics: ingest call events, read metrics, follow the live feed.",
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/api/docs" });

  const accounts = new AccountDirectory(deps.db);
  await accounts.load();
  const metricsRepo = new MetricsRepo(deps.db);
  const callsRepo = new CallsRepo(deps.db, deps.campaigns);

  await app.register(opsRoutes, { db: deps.db, metrics: deps.metrics });
  await app.register(
    async (api) => {
      await api.register(readRoutes, {
        db: deps.db,
        accounts,
        campaigns: deps.campaigns,
        metrics: metricsRepo,
        calls: callsRepo,
      });
      await api.register(streamRoutes, { accounts, calls: callsRepo, hub: deps.hub });
      await api.register(ingestRoutes, {
        ingest: deps.ingest,
        limiter: deps.ingestLimiter,
        onRateLimited: (n) => deps.metrics.ingestRateLimited.inc(n),
      });
      await api.register(metaRoutes, {
        meta: {
          version: process.env.npm_package_version ?? "1.0.0",
          devTools: Boolean(deps.config.DEV_TOOLS && deps.spike),
          ai: { enabled: Boolean(deps.insights?.model), model: deps.insights?.model ?? null },
          grafanaUrl: deps.config.GRAFANA_URL ?? null,
        },
      });
      if (deps.insights)
        await api.register(insightsRoutes, { db: deps.db, accounts, insights: deps.insights });
      if (deps.config.DEV_TOOLS && deps.spike) await api.register(devRoutes, { spike: deps.spike });
    },
    { prefix: "/api/v1" },
  );

  // Serve the built SPA from the same origin: no CORS, and SSE stays on one host.
  const webDist = deps.config.WEB_DIST;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.get("/*", async (req, reply) => {
      // Only page routes get the SPA shell. A missing asset is a 404, not index.html served as JavaScript.
      if (req.url.startsWith("/api/") || /\.[a-z0-9]+(?:\?|$)/i.test(req.url)) return reply.callNotFound();
      return reply.sendFile("index.html");
    });
  }

  return app;
}
