# Real-time call analytics

A real-time call analytics dashboard for a marketing manager. Calls come in from tracking numbers on each campaign. The dashboard shows them **live as they happen**, call volume **by hour and by day**, **conversion rate by campaign source**, and a short **"what changed"** summary written by an AI model. Every number and every up/down in that summary is checked against SQL facts before it is shown.

In Invoca's terms: a *conversion* is a signal (a sale, booking or quote) tied to the campaign and channel that drove the call, and the "what changed" panel is close in spirit to Smart Alerts for missed calls and conversion drops. It says what to check rather than claiming why something happened.

[![CI](https://github.com/umarajPotla/call-analytics-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/umarajPotla/call-analytics-dashboard/actions/workflows/ci.yml)

![Dashboard](docs/images/dashboard.png)

**Docs:**
- [Design and decisions](docs/DESIGN.md): assumptions, metric definitions, the decision records, the scaling path and the change log
- [Architecture diagrams](docs/diagrams/architecture-diagrams.pdf)
- [Runbook](docs/RUNBOOK.md)
- [Benchmark](docs/benchmarks.md): 9.7M calls across 500 accounts
- API reference at `/api/docs` once the app is running

## Run it

You need Docker. Nothing else.

```bash
git clone https://github.com/umarajPotla/call-analytics-dashboard.git
cd call-analytics-dashboard
docker compose up --build
```

Open **http://localhost:8080**. On first start the simulator loads 14 days of history for three demo brands (about 100k calls, a few seconds). Then it streams live calls. **⚡ Simulate spike** multiplies one brand's traffic 6× for 10 minutes so you can watch the charts move.

| Also try | Command |
|---|---|
| Prometheus and Grafana: dashboards and alerts at http://localhost:3000 | `GRAFANA_URL=http://localhost:3000 docker compose --profile observability up --build` |
| AI insights with a local model ([Ollama](https://ollama.com) running on your machine) | `ollama pull llama3.2:3b`, then `LLM_BASE_URL=http://host.docker.internal:11434/v1 LLM_MODEL=llama3.2:3b docker compose up --build` |
| AI insights with Gemini's free tier | `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai LLM_MODEL=gemini-3.5-flash LLM_API_KEY=… docker compose up --build` |
| Without Docker (Node 24, pnpm 10, a local Postgres) | `cp .env.example .env`, set `DATABASE_URL`, then `pnpm install && pnpm dev` (API on :8080, dashboard on :5173) |

**Without an AI model the dashboard still works.** The insights panel falls back to a rules-based summary built from the same facts.

## What it does

| Requirement | Where it is |
|---|---|
| Call volume, last 7 days, hourly and daily | *Call volume* chart, Hourly/Daily toggle. Bars are stacked by status. Days and hours are in the account's own time zone, including DST days with 23 or 25 hours |
| Conversion rate by campaign source | *Conversion rate* chart, with a Source/Campaign toggle. Low-volume groups are flagged. Recent days are marked "may still convert" because conversions can arrive up to 72 h late |
| Live feed with status | *Live calls*: Server-Sent Events. Rows update in place as a call rings, connects or is missed, then converts. It reconnects and replays missed updates by itself, and falls back to polling if the stream is blocked |
| Filters: date range, campaign, outcome | Filter bar. Every filter lives in the URL, so a view can be bookmarked or shared |
| API access | Versioned REST under `/api/v1`, with OpenAPI docs at `/api/docs`. The live feed is also an API: `GET …/calls/stream` |
| Beyond the brief | KPI tiles compared like for like with the previous period · AI "what changed" panel with sources and feedback · Grafana dashboards and alerts as code · CI that runs the whole stack |

## Decision summary

*Also pasted into the submission form. Detail and the full reasoning are in [DESIGN.md](docs/DESIGN.md).*

**The problem as I framed it.** A marketing manager at one brand (A1) wants to know four things: are calls coming in now, which channels produce calls that convert, how volume trends this week, and how many calls are missed. There was no kickoff call, so I wrote the open questions down as explicit assumptions (DESIGN §3). The main ones:
- **Converted** means the brand's business outcome (sale, booking, quote). It is reported at call end or up to 72 h later, and credited to the call's start time and campaign.
- **Conversion rate** = converted ÷ resolved calls. Resolved = connected + missed + converted, so calls still ringing don't drag the rate down.
- **Last 7 days** means 7 calendar days in the account's time zone.

Each assumption says what changes if it's wrong, and most are a one-function change.

**Key decisions and trade-offs**
1. **One PostgreSQL database holds three forms of the data:**
   - an append-only event log
   - the current state of each call
   - hourly rollups, updated in the same transaction as each event

   Charts read a few hundred rollup rows instead of scanning calls. The cost is a second copy that could drift. A property-based test, a continuous drift check with an alert, and a repair tool cover that. I chose no Kafka, no Redis and no OLAP store: at this scale each would add a moving part without a measured need. DESIGN §11 lists what breaks first at 500 customers and the order I'd fix it in.
2. **Ingest is safe to retry and tolerates any arrival order.** Every event has an id, so a duplicate is a no-op. A rank-based state machine only moves a call forward, so out-of-order events are no-ops too. The simulator deliberately sends duplicates and reordered events to prove this live.
3. **Live updates use Server-Sent Events fed by Postgres `LISTEN/NOTIFY`, not WebSockets.** Updates only flow one way (server to browser), and SSE gives automatic reconnect and replay over plain HTTP. Charts refetch at most once every 5 s rather than recomputing metrics in the browser, so there is one source of truth.
4. **Comparisons are like for like,** in both the KPI tiles and the AI insights. "This week so far" is compared with last week up to the same local time, and last week's conversions are counted as they were known at that point. Running the first version showed why this matters: every week looked worse than the last, because today is partial and recent calls haven't collected their late conversions yet.
5. **The AI feature is grounded and measurable.** SQL computes every number. The model only chooses and phrases the notable facts. Guardrails reject any number that isn't in the facts an insight cites, any up/down that contradicts them, and any channel named without being cited. A rules-based template takes over if the model fails or is unavailable.
   - **Evidence, not hope:** a live eval of a small local model (llama3.2:3b) found answers with every number right and the direction wrong ("Meta calls up 34%" for a 34% drop). That is why the direction and mention checks exist. The recorded answers are replayed in CI, where the guardrails reject every one of them.
   - **Noise control:** "notable" requires z ≥ 3, not 2. About 50 facts are tested per view, and at z ≥ 2 the first version reported pure noise.
   - **Platform pieces:** a provider-agnostic gateway (timeouts, retry, circuit breaker, cost meter), versioned prompts, caching, a per-account budget, and an eval suite that runs in CI.
6. **Operable from day one.** Prometheus metrics, four Grafana dashboards and six alert rules are provisioned from the repo, each alert with a runbook entry.
7. **TypeScript end to end.** One language and shared Zod schemas from the database to the browser, with the OpenAPI spec generated from the same schemas. Inside Invoca's codebase I'd follow its conventions (Rails); for a greenfield build in two days I chose the stack I can explain line by line.
8. **$0 to run.** Docker Compose locally. Render's free tier plus Neon's free Postgres for the hosted demo.

**What I'd do next:**
- real authentication with Postgres row-level security
- a server-side aggregate cache and pushed "stats changed" events (the first scaling bottleneck)
- tracing
- rate limits on ingest
- batching rollup deltas in projection workers once ingest nears its measured limit ([benchmark](docs/benchmarks.md))

## API

```bash
A=dc85fdbe-de05-46c9-965d-e29d3553663d   # Acme Home Insurance (demo)
curl localhost:8080/api/v1/accounts
curl "localhost:8080/api/v1/accounts/$A/metrics/summary"                         # KPIs vs previous period
curl "localhost:8080/api/v1/accounts/$A/metrics/volume?granularity=day&from=2026-10-01&to=2026-10-07"
curl "localhost:8080/api/v1/accounts/$A/metrics/conversion?groupBy=source&outcomes=missed"   # ignoredFilters: ["outcomes"]
curl "localhost:8080/api/v1/accounts/$A/calls?limit=20"                          # keyset pagination: nextCursor
curl -N "localhost:8080/api/v1/accounts/$A/calls/stream"                         # live feed (SSE)
curl "localhost:8080/api/v1/accounts/$A/insights"
```

- **Errors** are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`, with the path of each invalid field.
- **Ingest** is `POST /api/v1/call-events` with 1–500 events. Each event gets its own outcome: `applied`, `duplicate`, `noop` (older than the call's current state) or `rejected`.

## How it fits together

![Architecture](docs/diagrams/01-architecture.png)

```
apps/api         Fastify API, ingest, SSE hub, simulator, AI insights, jobs
  src/domain       call state machine, caller masking (pure)
  src/ingest       idempotent, order-tolerant ingest (one transaction per event)
  src/read         range resolution (time zones, like-for-like), metrics and calls repositories
  src/realtime     LISTEN/NOTIFY listener, SSE hub with replay and backpressure
  src/insights     facts, LLM gateway, guardrails, generator, cache/service, prompts, eval suite
  migrations       plain SQL
apps/web         React dashboard (TanStack Query, Recharts), Playwright smoke test
packages/shared  Zod schemas and metric definitions shared by API and web
ops/             Prometheus config and alert rules, Grafana provisioning and dashboard generator
docs/            design, diagrams, runbook
```

## Testing and quality

```bash
pnpm test        # 107 tests: unit, property-based, integration against real Postgres, SSE over real HTTP
                 # (integration tests use TEST_DATABASE_URL, default postgres://postgres@127.0.0.1:5432/calls_test,
                 #  and drop that database's schema)
pnpm eval        # AI evals: guardrail probes, template answers, replay of recorded model answers
pnpm e2e         # Playwright against a running stack
pnpm bench       # 9.7M-call benchmark (needs BENCH_DATABASE_URL; drops that database's schema)
pnpm lint && pnpm typecheck
```

The tests cover:
- **Ingest and rollups:** the rollup always equals a fresh recount, whatever the order, duplication and concurrency of events (property-based).
- **Tenancy and the API:** tenant isolation, even when one account asks for another's campaign ids; keyset pagination; totals that agree across endpoints.
- **Time:** US and UK DST weeks; like-for-like comparisons with late conversions. Integration-test sessions run in UTC+13:45 to prove no query depends on the server's time zone.
- **Live feed:** push after commit, replay on reconnect, filtering.
- **AI insights:** the guardrails against hallucinated numbers, unknown or noisy citations and format failures; the gateway's retry and circuit breaker; the fallback paths.

**CI** ([workflow](.github/workflows/ci.yml)) runs on every push to `main` and every pull request:
1. lint, typecheck, unit tests and evals
2. integration tests against a Postgres service
3. builds the Docker image and starts the stack with `docker compose up`, exactly as a reviewer would, then runs the Playwright test against it
4. starts Prometheus and Grafana and checks that the six alert rules load, the API is scraped, and all four dashboards are provisioned

## AI insights, in short

```
SQL facts (like-for-like, notable only if big enough AND z ≥ 3)
  → top 8 by impact, measured in estimated conversions
  → cache (15-min window per range + content hash of the facts) · single-flight · per-account budget
  → LLM via an OpenAI-compatible gateway (timeout, retry, circuit breaker, token and cost metering)
  → guardrails: schema · cited facts exist and are notable · every number appears in the cited facts
                · up/down agrees with the cited facts · every channel named is cited
  → one repair round with the errors fed back → otherwise the rules-based template
```

- **Feedback:** 👍/👎 is stored with the prompt version, the model and a snapshot of what the user saw, ready to become an eval case.
- **Live evals:** `pnpm eval --live --runs 3 --record` runs the cases against the configured model, writes results to `apps/api/evals/results/`, and records the raw answers so CI can replay them. With Docker only: `docker compose exec api node dist/eval.js --live --runs 3 --record`.
- Details: DESIGN §7 and [diagram 2](docs/diagrams/02-ai-insights.png).

## How I used AI to build this

I built this with an AI coding assistant as a pair programmer, the way I'd want a team to use one.
- **Design first:** the assumptions, metric definitions, state machine and decisions were written down before any code ([DESIGN.md](docs/DESIGN.md)).
- **Small, reviewed slices:** code was generated module by module, reviewed, and committed in small described commits.
- **Tests as the contract:** every risky behaviour is pinned by tests, and CI runs the full stack.
- **Run it and question it:** the most important corrections came from running the system and asking whether the numbers were honest, not from the generated code: like-for-like comparisons, the stricter notability threshold, ranking insights in a common unit, and the direction guardrail found by a live eval on a local model.
- **Fresh-eyes review:** before submitting, a separate AI agent that hadn't seen the work reviewed the code against these docs. It found real bugs (a live-feed regression, KPI tiles that weren't like for like, feedback that could point at regenerated text) and claims the code didn't back up. All are fixed and listed in the [change log](docs/DESIGN.md#15-change-log).

Where I'd look hardest in a review:
- The SSE hub under real load. Backpressure is implemented and tested functionally, but not load-tested.
- The simulator's catch-up after a long sleep on the free host.
- The quality of a small local model's phrasing. The evals measure it, and the guardrails make it safe rather than good.

## Known limitations

- Authentication is stubbed: every request acts as a demo user. Tenant scoping is real.
- Rollups are hourly, so for time zones with half-hour offsets (India, for example) day boundaries are approximate to the hour (assumption A9).
- The hosted demo runs on free tiers: the first request after 15 minutes idle takes about 30 s while the host wakes up and the simulator catches up.
