import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import type { Db } from "../../src/db/pool";
import { CampaignDirectory } from "../../src/ingest/campaignDirectory";
import { IngestService } from "../../src/ingest/ingestService";
import type { AccountRateLimiter } from "../../src/ingest/rateLimiter";
import { InsightGenerator } from "../../src/insights/generator";
import { InsightsService } from "../../src/insights/service";
import { Metrics } from "../../src/observability/metrics";
import { SseHub } from "../../src/realtime/sseHub";

export type TestApp = {
  app: FastifyInstance;
  hub: SseHub;
  ingest: IngestService;
  metrics: Metrics;
  close: () => Promise<void>;
};

/** The real app (same buildApp as production) over a test database. Insights use the template (no model). */
export async function testApp(db: Db, opts: { ingestLimiter?: AccountRateLimiter } = {}): Promise<TestApp> {
  const campaigns = new CampaignDirectory(db);
  await campaigns.load();
  const metrics = new Metrics();
  const hub = new SseHub(metrics.hubObserver);
  const ingest = new IngestService(db, campaigns, metrics.ingestObserver);
  const insights = new InsightsService(db, new InsightGenerator(null, "test"), { metrics });
  const app = await buildApp({
    config: { LOG_LEVEL: "silent", DEV_TOOLS: false, WEB_DIST: undefined },
    db,
    campaigns,
    ingest,
    ingestLimiter: opts.ingestLimiter,
    hub,
    metrics,
    insights,
  });
  await app.ready();
  return {
    app,
    hub,
    ingest,
    metrics,
    close: async () => {
      hub.close();
      await app.close();
    },
  };
}
