import type { IngestOutcome } from "@calls/shared";
import client from "prom-client";
import type { IngestObserver } from "../ingest/ingestService";
import { estimateCostUsd, type GatewayObserver, type Pricing } from "../insights/gateway";
import type { HubObserver } from "../realtime/sseHub";

/** Prometheus metrics. Grafana dashboards in ops/grafana read exactly these names. */
export class Metrics {
  readonly registry = new client.Registry();

  readonly httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly ingestEvents = new client.Counter({
    name: "ingest_events_total",
    help: "Call events by ingest outcome",
    labelNames: ["outcome", "reason"] as const,
    registers: [this.registry],
  });
  readonly ingestLag = new client.Histogram({
    name: "ingest_lag_seconds",
    help: "Time from an event occurring to it being ingested",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 3600],
    registers: [this.registry],
  });
  readonly sseClients = new client.Gauge({
    name: "sse_connected_clients",
    help: "Open live-feed connections",
    registers: [this.registry],
  });
  readonly sseDisconnects = new client.Counter({
    name: "sse_disconnects_total",
    help: "Live-feed disconnects by reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly rollupDrift = new client.Gauge({
    name: "rollup_drift_buckets",
    help: "Hourly rollup buckets that disagree with a recount of calls (should be 0)",
    registers: [this.registry],
  });
  readonly insightGenerations = new client.Counter({
    name: "insights_generations_total",
    help: "AI insight generations by outcome",
    labelNames: ["outcome", "model"] as const,
    registers: [this.registry],
  });
  readonly insightLatency = new client.Histogram({
    name: "insights_llm_latency_seconds",
    help: "LLM call latency for insights",
    labelNames: ["model"] as const,
    buckets: [0.25, 0.5, 1, 2, 4, 8, 16],
    registers: [this.registry],
  });
  readonly insightTokens = new client.Counter({
    name: "insights_llm_tokens_total",
    help: "LLM tokens used for insights",
    labelNames: ["direction", "model"] as const,
    registers: [this.registry],
  });
  readonly insightCost = new client.Counter({
    name: "insights_llm_cost_usd_total",
    help: "Estimated LLM spend for insights (0 on free tiers, but the meter exists)",
    labelNames: ["model"] as const,
    registers: [this.registry],
  });
  readonly insightCache = new client.Counter({
    name: "insights_cache_total",
    help: "Insight cache lookups (fresh = same range within TTL, content = identical facts, miss)",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  readonly insightGuardrailFailures = new client.Counter({
    name: "insights_guardrail_failures_total",
    help: "Model outputs rejected by a guardrail check",
    labelNames: ["check"] as const,
    registers: [this.registry],
  });
  readonly llmRequests = new client.Counter({
    name: "llm_requests_total",
    help: "Calls to the LLM provider by outcome (after the gateway's own retry)",
    labelNames: ["model", "outcome"] as const,
    registers: [this.registry],
  });
  readonly insightFeedback = new client.Counter({
    name: "insights_feedback_total",
    help: "Thumbs up/down on insights",
    labelNames: ["rating", "generator"] as const,
    registers: [this.registry],
  });

  constructor() {
    client.collectDefaultMetrics({ register: this.registry });
  }

  readonly ingestObserver: IngestObserver = {
    onResult: (outcome: IngestOutcome, lagSeconds: number, reason?: string) => {
      this.ingestEvents.inc({ outcome, reason: reason ?? "" });
      if (outcome === "applied" && lagSeconds >= 0) this.ingestLag.observe(lagSeconds);
    },
  };

  /** Meters every LLM call: latency, tokens and estimated spend from a price table ($0 on free tiers). */
  gatewayObserver(pricing: Pricing): GatewayObserver {
    return {
      call: (model, outcome, c) => {
        this.llmRequests.inc({ model, outcome });
        if (!c) return;
        this.insightLatency.observe({ model }, c.latencyMs / 1000);
        this.insightTokens.inc({ model, direction: "input" }, c.inputTokens);
        this.insightTokens.inc({ model, direction: "output" }, c.outputTokens);
        this.insightCost.inc({ model }, estimateCostUsd(c, pricing));
      },
    };
  }

  readonly hubObserver: HubObserver = {
    clients: (n) => this.sseClients.set(n),
    dropped: (reason) => this.sseDisconnects.inc({ reason }),
  };
}
