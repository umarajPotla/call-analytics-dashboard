// Grafana dashboards as code. Edit this file, run `node ops/grafana/generate.mjs`, commit both.
// Metric names match apps/api/src/observability/metrics.ts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "dashboards");
const PROM = { type: "prometheus", uid: "prom" };
const SQL = { type: "grafana-postgresql-datasource", uid: "callsdb" };

let id = 1;
const at = (x, y, w, h) => ({ x, y, w, h });
const target = (expr, legendFormat = "", refId = "A") => ({
  datasource: PROM,
  expr,
  legendFormat,
  refId,
  range: true,
});

function stat(
  title,
  expr,
  { unit = "short", gridPos, thresholds, decimals, description, colorMode = "value" } = {},
) {
  return {
    id: id++,
    type: "stat",
    title,
    description,
    datasource: PROM,
    gridPos,
    targets: [target(expr)],
    options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode, graphMode: "area", textMode: "value" },
    fieldConfig: {
      defaults: {
        unit,
        decimals,
        color: { mode: "thresholds" },
        thresholds: thresholds ?? { mode: "absolute", steps: [{ color: "green", value: null }] },
      },
      overrides: [],
    },
  };
}

function series(title, targets, { unit = "short", gridPos, stack = false, description, min } = {}) {
  return {
    id: id++,
    type: "timeseries",
    title,
    description,
    datasource: PROM,
    gridPos,
    targets: targets.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i) })),
    options: {
      legend: { displayMode: "list", placement: "bottom" },
      tooltip: { mode: "multi", sort: "desc" },
    },
    fieldConfig: {
      defaults: {
        unit,
        min,
        custom: {
          drawStyle: "line",
          lineWidth: 2,
          fillOpacity: stack ? 35 : 10,
          stacking: { mode: stack ? "normal" : "none" },
          showPoints: "never",
        },
      },
      overrides: [],
    },
  };
}

const row = (title, y) => ({
  id: id++,
  type: "row",
  title,
  collapsed: false,
  gridPos: at(0, y, 24, 1),
  panels: [],
});

function dashboard(uid, title, description, panels, extra = {}) {
  return {
    uid,
    title,
    description,
    tags: ["call-analytics"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    editable: false,
    refresh: "10s",
    time: { from: "now-1h", to: "now" },
    links: [
      { title: "Service health", type: "link", url: "/d/svc-health" },
      { title: "AI insights", type: "link", url: "/d/ai-insights" },
      { title: "Data correctness", type: "link", url: "/d/data-correctness" },
      { title: "Business overview", type: "link", url: "/d/business" },
    ],
    panels,
    ...extra,
  };
}

const red = (v) => ({
  mode: "absolute",
  steps: [
    { color: "green", value: null },
    { color: "red", value: v },
  ],
});
const amberRed = (a, r) => ({
  mode: "absolute",
  steps: [
    { color: "green", value: null },
    { color: "orange", value: a },
    { color: "red", value: r },
  ],
});
const NOT_STREAM = 'route!~".*/stream|/metrics"';

// ---------------------------------------------------------------- service health
id = 1;
const health = dashboard(
  "svc-health",
  "Call Analytics · Service health",
  "Is the API up, fast and delivering live updates? Golden signals plus the live feed.",
  [
    stat("API up", 'up{job="api"}', {
      gridPos: at(0, 0, 4, 4),
      thresholds: {
        mode: "absolute",
        steps: [
          { color: "red", value: null },
          { color: "green", value: 1 },
        ],
      },
    }),
    stat("Requests / s", `sum(rate(http_request_duration_seconds_count{${NOT_STREAM}}[1m]))`, {
      unit: "reqps",
      gridPos: at(4, 0, 4, 4),
      decimals: 1,
    }),
    stat(
      "p95 latency",
      `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${NOT_STREAM}}[5m])))`,
      { unit: "s", gridPos: at(8, 0, 4, 4), thresholds: amberRed(0.25, 1) },
    ),
    stat(
      "5xx rate",
      'sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / clamp_min(sum(rate(http_request_duration_seconds_count[5m])), 1e-9)',
      { unit: "percentunit", gridPos: at(12, 0, 4, 4), thresholds: amberRed(0.01, 0.02), decimals: 2 },
    ),
    stat("Live-feed clients", "sum(sse_connected_clients)", { gridPos: at(16, 0, 4, 4) }),
    stat("Ingest lag p95", "histogram_quantile(0.95, sum by (le) (rate(ingest_lag_seconds_bucket[5m])))", {
      unit: "s",
      gridPos: at(20, 0, 4, 4),
      thresholds: amberRed(5, 10),
      description: "Event occurred → stored. Target < 10 s.",
    }),
    row("Traffic and latency", 4),
    series(
      "Requests by route",
      [target(`sum by (route) (rate(http_request_duration_seconds_count{${NOT_STREAM}}[1m]))`, "{{route}}")],
      {
        unit: "reqps",
        gridPos: at(0, 5, 12, 8),
      },
    ),
    series(
      "Latency by route (p95)",
      [
        target(
          `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{${NOT_STREAM}}[5m])))`,
          "{{route}}",
        ),
      ],
      { unit: "s", gridPos: at(12, 5, 12, 8) },
    ),
    row("Live feed and ingest", 13),
    series(
      "Ingested events by outcome",
      [
        target("sum by (outcome) (rate(ingest_events_total[1m]))", "{{outcome}}"),
        target("sum(rate(ingest_rate_limited_events_total[1m]))", "rate limited (429)"),
      ],
      {
        unit: "ops",
        stack: true,
        gridPos: at(0, 14, 8, 8),
        description:
          "applied = changed a call · duplicate = same event id again · noop = older than current state · rejected = invalid · rate limited = refused with 429, the sender retries",
      },
    ),
    series(
      "Ingest lag",
      [
        target("histogram_quantile(0.5, sum by (le) (rate(ingest_lag_seconds_bucket[5m])))", "p50"),
        target("histogram_quantile(0.95, sum by (le) (rate(ingest_lag_seconds_bucket[5m])))", "p95"),
      ],
      { unit: "s", gridPos: at(8, 14, 8, 8) },
    ),
    series(
      "Live-feed connections",
      [
        target("sum(sse_connected_clients)", "connected"),
        target("sum by (reason) (increase(sse_disconnects_total[5m]))", "disconnects: {{reason}}"),
      ],
      { gridPos: at(16, 14, 8, 8) },
    ),
    row("Runtime", 22),
    series("Event-loop lag (p99)", [target("nodejs_eventloop_lag_p99_seconds", "p99")], {
      unit: "s",
      gridPos: at(0, 23, 8, 7),
    }),
    series(
      "Memory",
      [target("process_resident_memory_bytes", "rss"), target("nodejs_heap_size_used_bytes", "heap used")],
      {
        unit: "bytes",
        gridPos: at(8, 23, 8, 7),
      },
    ),
    series("CPU", [target("rate(process_cpu_seconds_total[1m])", "cpu")], {
      unit: "percentunit",
      gridPos: at(16, 23, 8, 7),
    }),
  ],
);

// ---------------------------------------------------------------- AI insights
id = 1;
const FALLBACK = 'outcome=~"invalid|timeout|error|circuit_open"';
const ASKED = 'outcome!~"no_signal|no_llm|rate_limited"';
const ai = dashboard(
  "ai-insights",
  "Call Analytics · AI insights",
  "Quality, latency and cost of the insights feature. The template fallback keeps the panel working when the model doesn't.",
  [
    stat("Generations (1h)", "sum(increase(insights_generations_total[1h]))", {
      gridPos: at(0, 0, 4, 4),
      decimals: 0,
    }),
    stat(
      "Fallback rate",
      `sum(rate(insights_generations_total{${FALLBACK}}[30m])) / clamp_min(sum(rate(insights_generations_total{${ASKED}}[30m])), 1e-9)`,
      {
        unit: "percentunit",
        gridPos: at(4, 0, 4, 4),
        thresholds: amberRed(0.1, 0.2),
        description: "Model asked, template shown (alert at 20%)",
      },
    ),
    stat(
      "Grounded first try",
      `sum(rate(insights_generations_total{outcome="ok"}[1h])) / clamp_min(sum(rate(insights_generations_total{${ASKED}}[1h])), 1e-9)`,
      {
        unit: "percentunit",
        gridPos: at(8, 0, 4, 4),
        description: "Passed every guardrail without a repair round",
      },
    ),
    stat(
      "LLM p95 latency",
      "histogram_quantile(0.95, sum by (le) (rate(insights_llm_latency_seconds_bucket[30m])))",
      {
        unit: "s",
        gridPos: at(12, 0, 4, 4),
        thresholds: amberRed(4, 8),
      },
    ),
    stat(
      "Cache hit rate",
      'sum(rate(insights_cache_total{result!="miss"}[1h])) / clamp_min(sum(rate(insights_cache_total[1h])), 1e-9)',
      { unit: "percentunit", gridPos: at(16, 0, 4, 4) },
    ),
    stat("Est. spend (24h)", "sum(increase(insights_llm_cost_usd_total[24h]))", {
      unit: "currencyUSD",
      gridPos: at(20, 0, 4, 4),
      decimals: 4,
      description: "From the price table in config ($0 on free tiers)",
    }),
    series(
      "Generations by outcome",
      [target("sum by (outcome) (increase(insights_generations_total[5m]))", "{{outcome}}")],
      {
        stack: true,
        gridPos: at(0, 4, 12, 8),
      },
    ),
    series(
      "Guardrail rejections by check",
      [target("sum by (check) (increase(insights_guardrail_failures_total[5m]))", "{{check}}")],
      {
        stack: true,
        gridPos: at(12, 4, 12, 8),
        description: "ungrounded_number = the model wrote a number that is not in the facts it cited",
      },
    ),
    series(
      "LLM latency",
      [
        target(
          "histogram_quantile(0.5, sum by (le) (rate(insights_llm_latency_seconds_bucket[15m])))",
          "p50",
        ),
        target(
          "histogram_quantile(0.95, sum by (le) (rate(insights_llm_latency_seconds_bucket[15m])))",
          "p95",
        ),
      ],
      { unit: "s", gridPos: at(0, 12, 8, 8) },
    ),
    series(
      "Tokens",
      [target("sum by (direction) (increase(insights_llm_tokens_total[5m]))", "{{direction}}")],
      {
        stack: true,
        gridPos: at(8, 12, 8, 8),
      },
    ),
    series(
      "LLM calls and feedback",
      [
        target("sum by (outcome) (increase(llm_requests_total[5m]))", "llm {{outcome}}"),
        target("sum by (rating) (increase(insights_feedback_total[1h]))", "feedback {{rating}}"),
      ],
      { gridPos: at(16, 12, 8, 8) },
    ),
  ],
);

// ---------------------------------------------------------------- data correctness
id = 1;
const correctness = dashboard(
  "data-correctness",
  "Call Analytics · Data correctness",
  "Are the numbers right? The rollup is continuously reconciled against a recount of calls.",
  [
    stat("Rollup drift (buckets)", "max(rollup_drift_buckets)", {
      gridPos: at(0, 0, 6, 5),
      thresholds: red(1),
      colorMode: "background",
      description: "Hourly buckets that disagree with a recount of calls over the last 2 days. Must be 0.",
    }),
    stat("Duplicates absorbed (1h)", 'sum(increase(ingest_events_total{outcome="duplicate"}[1h]))', {
      gridPos: at(6, 0, 6, 5),
      decimals: 0,
      description: "At-least-once delivery, made harmless by idempotency on event id",
    }),
    stat("Out-of-order no-ops (1h)", 'sum(increase(ingest_events_total{outcome="noop"}[1h]))', {
      gridPos: at(12, 0, 6, 5),
      decimals: 0,
      description: "Events older than the call's current state",
    }),
    stat("Rejected (1h)", 'sum(increase(ingest_events_total{outcome="rejected"}[1h]))', {
      gridPos: at(18, 0, 6, 5),
      decimals: 0,
      thresholds: amberRed(1, 50),
    }),
    series("Rollup drift", [target("max(rollup_drift_buckets)", "drift")], {
      gridPos: at(0, 5, 12, 8),
      min: 0,
    }),
    series(
      "Rejections by reason",
      [target('sum by (reason) (increase(ingest_events_total{outcome="rejected"}[5m]))', "{{reason}}")],
      {
        stack: true,
        gridPos: at(12, 5, 12, 8),
      },
    ),
  ],
);

// ---------------------------------------------------------------- business (SQL, read-only role)
id = 1;
const sql = (rawSql, format = "time_series") => ({
  datasource: SQL,
  refId: "A",
  rawQuery: true,
  editorMode: "code",
  format,
  rawSql,
});
function sqlPanel(type, title, rawSql, gridPos, fieldConfig = {}, options = {}, format = "time_series") {
  return {
    id: id++,
    type,
    title,
    datasource: SQL,
    gridPos,
    targets: [sql(rawSql, format)],
    fieldConfig: { defaults: fieldConfig, overrides: [] },
    options,
  };
}
const ACCT = "account_id = '$account'";
const business = dashboard(
  "business",
  "Call Analytics · Business overview (SQL)",
  "The same numbers as the React dashboard, straight from Postgres through a read-only role.",
  [
    sqlPanel(
      "stat",
      "Calls",
      `SELECT count(*) AS calls FROM calls WHERE ${ACCT} AND $__timeFilter(started_at)`,
      at(0, 0, 6, 4),
      { unit: "short" },
      { reduceOptions: { calcs: ["lastNotNull"] } },
      "table",
    ),
    sqlPanel(
      "stat",
      "Conversion rate",
      `SELECT count(*) FILTER (WHERE status = 'converted')::float / nullif(count(*) FILTER (WHERE status <> 'ringing'), 0) AS rate
       FROM calls WHERE ${ACCT} AND $__timeFilter(started_at)`,
      at(6, 0, 6, 4),
      { unit: "percentunit", decimals: 1 },
      { reduceOptions: { calcs: ["lastNotNull"] } },
      "table",
    ),
    sqlPanel(
      "stat",
      "Missed calls",
      `SELECT count(*) FILTER (WHERE status = 'missed') AS missed FROM calls WHERE ${ACCT} AND $__timeFilter(started_at)`,
      at(12, 0, 6, 4),
      { unit: "short" },
      { reduceOptions: { calcs: ["lastNotNull"] } },
      "table",
    ),
    sqlPanel(
      "stat",
      "Answer rate",
      `SELECT count(*) FILTER (WHERE status IN ('connected','converted'))::float / nullif(count(*) FILTER (WHERE status <> 'ringing'), 0) AS rate
       FROM calls WHERE ${ACCT} AND $__timeFilter(started_at)`,
      at(18, 0, 6, 4),
      { unit: "percentunit", decimals: 1 },
      { reduceOptions: { calcs: ["lastNotNull"] } },
      "table",
    ),
    sqlPanel(
      "timeseries",
      "Calls per hour by status",
      `SELECT bucket_start AS time, sum(converted) AS converted, sum(connected) AS connected, sum(missed) AS missed, sum(ringing) AS ringing
       FROM call_stats_hourly WHERE ${ACCT} AND $__timeFilter(bucket_start) GROUP BY 1 ORDER BY 1`,
      at(0, 4, 24, 9),
      { custom: { drawStyle: "bars", fillOpacity: 80, stacking: { mode: "normal" }, lineWidth: 0 } },
      { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
    ),
    sqlPanel(
      "barchart",
      "Conversion rate by source",
      `SELECT c.source, sum(s.converted)::float / nullif(sum(s.connected + s.missed + s.converted), 0) AS conversion_rate
       FROM call_stats_hourly s JOIN campaigns c ON c.id = s.campaign_id
       WHERE s.${ACCT} AND $__timeFilter(s.bucket_start) GROUP BY 1 ORDER BY 2 DESC`,
      at(0, 13, 12, 9),
      { unit: "percentunit", decimals: 1 },
      { orientation: "horizontal", showValue: "always", legend: { showLegend: false } },
      "table",
    ),
    sqlPanel(
      "table",
      "Latest calls",
      `SELECT k.started_at AS "Started", c.name AS "Campaign", k.status AS "Status", k.caller_masked AS "Caller", k.duration_sec AS "Duration (s)"
       FROM calls k JOIN campaigns c ON c.id = k.campaign_id WHERE k.${ACCT} ORDER BY k.started_at DESC LIMIT 25`,
      at(12, 13, 12, 9),
      {},
      {},
      "table",
    ),
  ],
  {
    time: { from: "now-7d", to: "now" },
    refresh: "30s",
    templating: {
      list: [
        {
          name: "account",
          label: "Account",
          type: "query",
          datasource: SQL,
          query: "SELECT name AS __text, id::text AS __value FROM accounts ORDER BY name",
          refresh: 1,
          current: {},
        },
      ],
    },
  },
);

for (const [file, d] of [
  ["service-health.json", health],
  ["ai-insights.json", ai],
  ["data-correctness.json", correctness],
  ["business.json", business],
]) {
  writeFileSync(join(OUT, file), `${JSON.stringify(d, null, 2)}\n`);
  console.log(`wrote ${file} (${d.panels.length} panels)`);
}
