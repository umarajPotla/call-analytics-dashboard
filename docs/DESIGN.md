# Real-Time Call Analytics — Design & Decisions

**Author:** <Your Name> · **Date:** October 7, 2026 · **Status:** v1.0. Decisions are final unless an assumption marked *Confirm* is contradicted at kickoff; any change goes in the [change log](#15-change-log).
**Repo:** `<github link>` · **Live demo:** `<render link>` · **Diagrams:** [`docs/diagrams/`](diagrams/)

---

## 1. Summary

A real-time call analytics dashboard for a **marketing manager**. It answers four questions on one screen:

1. Are calls coming in right now, and is anything going wrong?
2. Which campaign sources produce calls that **convert**?
3. How did call volume trend this week, hour by hour and day by day?
4. How many calls are we **missing**?

**What's built:**
- **Ingest:** an idempotent ingest API writes call events to PostgreSQL in three forms: an append-only event log, a current-state table, and hourly rollups.
- **Serving:** a REST API serves the charts, and Server-Sent Events (SSE) push live updates to a React dashboard.
- **Test data:** a deterministic simulator produces realistic traffic, including duplicates, out-of-order events and late conversions.
- **AI insights:** one optional, grounded AI feature summarizes what changed. It runs behind a provider-agnostic LLM gateway, with evals, guardrails and telemetry.
- **Monitoring:** operational health is visible in Grafana dashboards provisioned as code.

Everything runs with one command (`docker compose up`) and costs $0.

## 2. Goals and non-goals

| Goals | Non-goals (intentionally left out) |
|---|---|
| Hourly and daily call volume for the last 7 days | Authentication/SSO. Tenant scoping is enforced, identity is stubbed |
| Conversion rate by campaign source, with a toggle to campaign | Call recordings, transcripts, speech analytics |
| Live feed of calls with status updating in place | Ad spend, cost per call, ROI (needs ad-platform data) |
| Filters by date range, campaign and outcome, shareable through the URL | Multi-touch attribution |
| Correct under real-world mess: duplicates, out-of-order events, late conversions, DST | Kafka, Kubernetes, microservices. Not needed at this scale; see the [scaling path](#11-scaling-path) |
| One grounded AI feature, built the way I'd build AI features on a shared platform | Text-to-SQL or free-form chat over data |
| Operable: health checks, metrics, dashboards, alerts | Mobile-specific layout (responsive basics only) |

## 3. Assumptions

*Confirm* = I'll raise it at the kickoff call. Each row says what changes if the assumption is wrong.

| ID | Assumption | If wrong |
|---|---|---|
| A1 | The user is a marketing manager at **one enterprise brand**. Agencies managing many brands are out of scope. *Confirm* | Add an account switcher and cross-account views. The data model is already multi-tenant |
| A2 | A conversion is either detected at call end or **arrives later** (offline/CRM import), up to **72 h** after the call. It is credited to the call's **start time and campaign**. *Confirm* | Widen the late-arrival window and extend the "rates may still rise" marker |
| A3 | **Conversion rate = converted ÷ resolved calls** (connected + missed + converted). Rate among answered calls is shown as a secondary number. *Confirm* | Swap the denominator. It's one function, `metrics.ts`, with tests |
| A4 | **Missed** = not answered by a person (no answer, voicemail, abandoned in the phone menu). A conversion reported for a missed call is **rejected and logged**. *Confirm* | Add a `voicemail` status, or accept the conversion. Both are local changes to the state machine |
| A5 | **Campaign source** = channel (Google Ads, Meta, TV, organic, direct mail, affiliate). Each campaign belongs to exactly one source | Add a source↔campaign mapping table |
| A6 | **"Last 7 days"** = 7 calendar days in the **account's time zone**, including today (partial). *Confirm* | Switch to a rolling 168 h window (one function) |
| A7 | Freshness targets: live feed **≤ 3 s p95** end to end; charts **≤ 10 s** | Tighter targets mean pushing aggregates instead of throttled refetch (see D7) |
| A8 | Each call has **one** campaign (single-touch, from the tracking number) | Multi-touch needs a call↔touchpoint table and weighting rules |
| A9 | Account time zones have **whole-hour UTC offsets** for accurate daily totals | Move rollups to 15-minute buckets (4× rows) |
| A10 | Demo scale: **3 accounts**, ~2–6k calls/day each, 14 days of history. Performance is benchmarked separately at **~10M calls / 500 accounts** | — |
| A11 | **Synthetic data only.** No real PII; caller numbers are masked at ingest | Real data needs encryption at rest, access controls, retention policies |
| A12 | Reviewers run it with **Docker only** (macOS/Linux). The hosted link is a convenience and may cold-start | Add a no-Docker path (`pnpm dev` + local Postgres) |
| A13 | Free LLM tiers are acceptable **for synthetic, aggregate data only** | Production needs enterprise / zero-retention terms or a self-hosted model |

## 4. Metric definitions

Each call has exactly one status at a time: `ringing` (in progress) → `connected` | `missed` → `converted`.

| Metric | Definition | Notes |
|---|---|---|
| Total calls | Calls whose **start time** falls in the range | Always bucketed by call start, never by conversion time |
| Resolved calls | connected + missed + converted | Excludes in-progress calls so live calls don't lower the rates |
| Answer rate | (connected + converted) ÷ resolved | |
| Conversion rate | converted ÷ resolved | "—" when resolved = 0, never 0% or NaN |
| Conversion rate (of answered) | converted ÷ (connected + converted) | Secondary, shown in the tooltip |
| Low-volume flag | resolved < 30 | Badge in the UI. The AI insights never treat these as notable |
| Conversion maturity | Last 3 days may still gain late conversions | Subtle "may still update" marker |

## 5. Architecture

![Architecture](diagrams/01-architecture.png)

Editable source: [`diagrams/01-architecture.excalidraw`](diagrams/01-architecture.excalidraw) (open at excalidraw.com).

| Component | Responsibility |
|---|---|
| **Web app** (React) | Filters ↔ URL, cached data fetching, charts, live feed, insights panel. No metric math in the browser |
| **REST API** (Fastify) | Tenant-scoped reads over rollups and calls; validation; OpenAPI; problem+json errors |
| **Ingest service** | Validate → dedupe → state machine → update projection + rollup **in one transaction** → notify |
| **SSE hub** | One `LISTEN` per instance; per-account fan-out; heartbeats; replay on reconnect; backpressure |
| **Insights service** | Deterministic facts (SQL) → LLM gateway → guardrails → cache; template fallback |
| **Simulator** | Seeded, realistic traffic sent **through the public ingest API** (no direct DB writes) |
| **PostgreSQL** | `call_events` (log), `calls` (current state), `call_stats_hourly` (rollup), `insight_*` (cache, feedback) |
| **Observability** | OpenTelemetry → Prometheus → Grafana (dashboards and alerts provisioned from the repo) |
| **External** | LLM provider (Ollama locally / Gemini free tier hosted). Future: telephony and CRM feeds |

**Main flows**

1. **Ingest:** `POST /api/v1/call-events` → one transaction: insert event (`ON CONFLICT DO NOTHING`), lock the call row, apply the state transition, upsert the call, apply ±1 deltas to the hourly rollup, `pg_notify` → `202`.
2. **Charts:** `GET …/metrics/*` reads `call_stats_hourly` (≈168 rows × campaigns per week) and returns zero-filled buckets.
3. **Live:** `NOTIFY` → hub → `event: call.updated` to that account's clients → the browser upserts the feed row and **throttles** a chart refetch (≤ once per 5 s).
4. **Reconnect:** the browser sends `Last-Event-ID` → the server replays events with a higher sequence number (bounded, with a small overlap) → the client dedupes.

## 6. Decisions

Format: **Decision** → why → trade-off I accept → when I'd revisit.

| ID | Decision (one line) |
|---|---|
| D1 | TypeScript end to end: Node.js 24 LTS + Fastify, React 19 + Vite + TanStack Query + Recharts, Zod schemas shared |
| D2 | pnpm monorepo: `apps/api`, `apps/web`, `packages/shared`; hexagonal-lite layering |
| D3 | PostgreSQL 17 as the only datastore |
| D4 | Event log → current-state projection → hourly rollup, maintained transactionally |
| D5 | At-least-once ingest made idempotent by `event_id`; rank-based state machine tolerates out-of-order events |
| D6 | Server-Sent Events for live updates, fanned out via Postgres `LISTEN/NOTIFY`; polling fallback |
| D7 | Charts refresh by throttled refetch on events; the server rollup is the single source of truth |
| D8 | Store UTC; bucket by UTC hour; group into days in the account's time zone |
| D9 | Multi-tenant from day one: `account_id` on every row and query |
| D10 | REST `/api/v1` + OpenAPI + RFC 9457 errors + keyset pagination |
| D11 | Deterministic simulator that uses the public ingest API |
| D12 | AI insights: deterministic facts + LLM phrasing + grounding checks + evals, behind a provider-agnostic gateway |
| D13 | OpenTelemetry metrics → Prometheus → Grafana, dashboards and alerts as code. Grafana is for operators, not customers |
| D14 | Docker Compose locally (with profiles); Render + Neon free tiers for the hosted demo |
| D15 | Test where the risk is: state machine, rollup math, time bucketing, tenancy, SSE, LLM guardrails |

**D1 — TypeScript end to end.** One language across client, server and shared contracts. Zod schemas generate both runtime validation and the OpenAPI spec, so the API contract can't drift. Node.js 24 is the supported LTS line (to April 2028); I'd move to Node 26 after it enters LTS in late October 2026.
*Trade-off:* Invoca's core backend is Rails. Inside an existing codebase I'd follow house conventions (Rails, GraphQL/Apollo). For a 3-day greenfield build I chose the stack I can explain line by line.

**D2 — Monorepo with hexagonal-lite layering.** The domain logic (`callStateMachine`, `metrics`, `timeBuckets`, insight `facts`) is pure and framework-free. Routes are thin adapters. SQL lives only in repositories. Another engineer can find and change one concern without reading the whole system.

**D3 — PostgreSQL only.** Transactions make ingest atomic. `LISTEN/NOTIFY` covers fan-out at this scale. Window functions and `generate_series` cover the analytics.
*Rejected:* a time-series extension (TimescaleDB's continuous aggregates aren't available on the managed host), a separate OLAP store, Redis. Each would add a moving part without a measured need.
*Revisit:* when dashboard reads compete with ingest writes (see §11).

**D4 — Event log → projection → rollup.**
- `call_events` keeps the audit trail and the replay cursor for SSE.
- `calls` holds the current state of each call.
- `call_stats_hourly` holds one row per account × campaign × UTC hour, so a 7-day chart reads hundreds of rows, not hundreds of thousands.
- A status change is −1 on the old status column and +1 on the new one, in the bucket of the call's **start hour**.

*Trade-off:* the rollup is a second representation that could drift. Mitigations: a property-based reconciliation test, a `rebuild-rollups` command, and a scheduled drift check exported as a metric and alerted on.

**D5 — Idempotent, order-tolerant ingest.**
- Delivery is at-least-once. The unique `event_id` makes processing effectively-once.
- Events carry the call's identity fields (account, campaign, start time), so a `converted` event can arrive before `answered`.
- Transitions only move forward by rank (ringing 0 → connected/missed 1 → converted 2). Stale events are no-ops. Invalid ones (a conversion on a missed call, per A4) are kept with `applied = false` and counted.

**D6 — SSE over WebSockets.** The need is one-way, server → browser. SSE is plain HTTP, the browser reconnects automatically with `Last-Event-ID`, it works through standard proxies, and you can test it with `curl`.
- Heartbeats every 20 s.
- A bounded per-client queue: a slow client is disconnected and resyncs, so it never affects others.
- Graceful drain on deploy.
- Fallback: polling with the same cursor (`since=<seq>`).

Known subtlety: sequence numbers are assigned at insert, not commit, so replay uses a small overlap window and the client dedupes.

**D7 — Throttled refetch instead of client-side aggregation.** Recomputing charts in the browser from individual events would duplicate the metric logic and drift. A refetch at most every 5 s per open dashboard is cheap at demo scale.
*Revisit:* at scale this is the first thing to break (read amplification); the fix is a server-side aggregate cache plus pushed "stats changed" events (§11).

**D8 — Time.** `timestamptz` in UTC; rollups are UTC hours; daily views group hours into **local days** in the account's IANA time zone, which is correct for 23- and 25-hour DST days. Ranges are half-open `[from, to)`. Buckets are zero-filled on the server. Fixed-clock tests cover the US (Nov 1, 2026) and UK (Oct 25, 2026) DST changes.
*Known limitation:* half-hour-offset zones (A9).

**D9 — Multi-tenancy.** Every table carries `account_id`. The tenant is in the URL path and checked by authorization middleware (stubbed identity, real scoping). Tests assert account A can never read account B. Postgres row-level security is the production defense in depth.

**D10 — API.** Versioned REST under `/api/v1`, OpenAPI at `/api/docs`, RFC 9457 problem+json errors, input validation on every route. Keyset pagination on `(started_at, id)` stays stable while new calls stream in. Hourly ranges are capped at 31 days. Metrics responses send `Cache-Control: private, max-age=5`.

**D11 — Simulator through the front door.**
- **Realistic traffic:** arrivals follow business-hour and weekday curves per account time zone; answer and conversion rates vary by source; call durations are log-normal; ~35% of conversions arrive late (up to 72 h).
- **Deterministic:** seeded per minute, so any window regenerates identically.
- **Self-healing on cold start:** it backfills on boot and catches up after sleeping.
- **Chaos knobs:** duplicates (~2%) and reordering (~1%) prove idempotency live.

Because the simulator uses the public ingest API, swapping in a real telephony feed is a configuration change.

**D12 — AI insights: grounded, measured, replaceable** (details in §7). The LLM **never computes numbers and never writes SQL**. SQL computes the facts; the model only selects and phrases them, and every number it outputs is checked against those facts.
*Trade-off:* less "magic" than free-form chat. In exchange, the output is verifiable, cheap, testable in CI and degrades gracefully to deterministic text.

**D13 — Observability as code.**
- **Instrumentation:** OpenTelemetry SDK. Metrics are exposed in Prometheus format and scraped locally. Traces export via OTLP when an endpoint is configured.
- **Grafana (self-hosted, free):** datasources, three dashboards and alert rules are provisioned from `ops/grafana/`, so `docker compose --profile observability up` gives a working ops view with zero clicks.
- **Hosted option:** Grafana Cloud's free tier (no card; 10k active metric series, 50 GB logs, 50 GB traces, 14-day retention, 3 users).

*Why not build the customer dashboard in Grafana:* the product view needs tenant-aware access, metric semantics (resolved vs answered, maturity markers), a live feed that updates in place, and UX made for a non-technical user. Grafana is the right tool for **operators**; the React app is for **Maya**. Grafana also gets an internal "business cross-check" panel that reads the rollups directly, and its numbers must match the product UI.

**D14 — Runs anywhere for $0.**
- **Local:** `docker compose up` (Postgres, API, simulator, web). Optional profiles: `observability` (Prometheus, Grafana) and `ai` (points at Ollama; on macOS run Ollama natively for Apple-silicon acceleration).
- **Hosted:** Render free web service serving the API and the built SPA from one origin, plus Neon free Postgres.
- *Rejected:* Render's free Postgres (expires after 30 days), Fly.io and Railway (trial only), serverless functions for SSE (duration caps).
- **Neon's limits:** no keep-alive pinger, so Neon's free compute hours aren't burned.

**D15 — Testing.** See §9.

## 7. AI insights — platform design

![AI insights pipeline](diagrams/02-ai-insights.png)

**User value.** A marketing manager shouldn't have to stare at charts to notice that something changed. The panel shows up to three short, sourced insights for the selected account and range, for example:

> **Missed calls from TV · Fall Spot up 38% vs last week (212 vs 154)**, concentrated on weekdays 12–2 pm. Consider overflow routing or extra staff in that window. *Sources: 3 metrics*

**Pipeline**

1. **Facts (deterministic SQL over rollups).** Period-over-period changes in volume, missed calls and conversion rate by source and campaign, plus hour-of-day concentration of misses. A fact is **notable** only if |Δ| ≥ 15% and volume ≥ 30, or, for rates, a two-proportion z-test with |z| ≥ 2. Each fact gets a stable id and pre-formatted numbers.
2. **Selection.** Rank by impact (|Δ| × volume) and keep the top 6, so the prompt is small and the token cost bounded.
3. **Generation.** A versioned prompt (`prompts/insights.v1.md`) asks for JSON matching a Zod schema: `{ insights: [{ title ≤ 80 chars, body ≤ 240 chars, factIds[], action? }] }`, at most 3 insights.
4. **Guardrails.**
   - The output must match the schema.
   - Every `factId` must exist.
   - **Every number in the text must appear in the cited facts** (normalized: `38%`, `212`, `154`).
   - Length limits apply, and only aggregates ever reach the prompt.
   - One retry with the validation error fed back, then **fallback** to a deterministic template rendered from the same facts.
5. **Caching and cost control.** Cache key = hash(prompt version, model, facts). TTL is 15 min, with single-flight request coalescing. Insights are **never regenerated per live event**.
6. **Feedback.** 👍/👎 on each insight is stored with the prompt version and model, and becomes new eval cases.

**LLM gateway.** One small interface, `generateStructured<T>(schema, messages, { timeoutMs, maxTokens })`, with a single **OpenAI-compatible adapter** configured by environment variables (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`):

| Environment | Provider | Why |
|---|---|---|
| Local | **Ollama** (`http://localhost:11434/v1`) | Free, offline, nothing leaves the laptop |
| Hosted demo | **Gemini API free tier** (OpenAI-compatible endpoint) | Free, fast; synthetic aggregate data only (free-tier content may be used to improve Google's products) |
| Alternative | Groq free tier | Same adapter, swap by config |
| CI | **Recorded provider** (fixtures) | Deterministic, free, no network |
| Disabled | **Template provider** | Feature still works with no LLM at all |

The gateway also owns **timeouts** (8 s), **one retry with backoff**, a **circuit breaker** (open after 5 failures in 60 s → template), **per-tenant rate limits**, and **telemetry**. Adding a second AI feature means reusing the gateway, the prompt files, the eval harness and the guardrail helpers. That's the platform point.

**Evals** (`evals/insights/`)

- **Cases:** 15–20 fact sets covering a spike, a drop, low-volume traps, no change, mixed signals, rate up while volume down, all zeros, a single campaign, and a DST week.
- **Checks** (all deterministic):

| Check | Gate |
|---|---|
| Schema valid | ≥ 98% |
| **Grounding: no ungrounded numbers** | **100% (hard gate)** |
| Valid fact ids | 100% |
| Highest-impact fact covered | ≥ 90% |
| Low-volume facts never cited as notable | 100% |
| Latency p95, tokens per insight | Reported, not gated |

- **CI** runs the suite against recorded responses on every PR (free and deterministic).
- **Live runs** compare models and prompt versions: `pnpm eval --provider=ollama|gemini`. Results are committed under `evals/results/`.

**Telemetry.**
- One OpenTelemetry span per generation, with GenAI semantic-convention attributes (model, input/output tokens).
- Metrics: latency, tokens, outcome (`ok | invalid | timeout | fallback`), cache hit rate, grounding failures, and estimated cost from a price table ($0 on free tiers, but the mechanism exists).
- These appear in the Grafana "AI insights" dashboard. Prompts and responses are logged only in development.

**Next (not built):** "Ask the dashboard" — natural language → a **validated filter object** through tool calling (never SQL), evaluated by exact match on a golden set of queries.

## 8. Observability

| Dashboard (provisioned) | Panels |
|---|---|
| **Service health** | Requests/s, errors, p95 latency by route; ingest events/s; **ingest lag** p95 (`received_at − occurred_at`); duplicates and rejected events; SSE connected clients and disconnects; DB pool usage |
| **AI insights** | Generations by outcome; p95 latency; tokens in/out; cache hit rate; grounding failures; fallback rate; estimated cost |
| **Data correctness** | Rollup drift rows (must be 0); events received vs applied; business cross-check (calls, conversion rate) read straight from the rollups |

**Alerts (provisioned):** ingest lag p95 > 10 s · rollup drift > 0 · SSE error rate > 5% · insight fallback rate > 20% · `/readyz` failing.
**Logs:** structured JSON (pino) with request id and account id; caller numbers never logged.
**Health:** `/healthz` (process up) and `/readyz` (database reachable).

## 9. Testing and quality

| Layer | Tooling | What it proves |
|---|---|---|
| Unit | Vitest | Every state-machine transition (including stale and rejected); metric math (zero denominators, low-volume); time bucketing (DST days, `[from, to)` boundaries) |
| Property-based | fast-check | Random lifecycles + shuffled order + duplicates ⇒ rollup equals a fresh recomputation |
| Integration | Testcontainers (real Postgres) | Idempotency; concurrent events on one call; late conversion moves counts; **tenant isolation**; pagination stability |
| API contract | Fastify `inject` | Validation, problem+json errors, defaults, foreign-campaign 404 |
| SSE | Integration | Account-scoped delivery, `Last-Event-ID` replay, heartbeat, slow-client disconnect |
| AI guardrails | Vitest + eval suite | Grounding checker, schema, fallback path, circuit breaker |
| E2E smoke | Playwright | Loads, filters update URL and data, a simulated call appears live |

**CI (GitHub Actions):** lint → typecheck → unit → integration (Postgres service) → evals (recorded) → build → E2E smoke.
**Benchmark:** at ~10M calls across 500 accounts, I compare rollup reads against raw aggregation (p50/p95 plus `EXPLAIN ANALYZE`), measured on my machine and published in `docs/benchmarks.md`.

## 10. Security and privacy

- Tenant scoping on every query, plus an isolation test suite. Row-level security is the production next step.
- Caller numbers are masked at ingest. Only aggregates are sent to LLMs. No raw PII in logs.
- Validation and body-size limits on every endpoint; rate limit on ingest; same-origin hosting, so no CORS surface.
- Secrets come only from environment variables (`.env.example` committed). Free LLM tiers are used for synthetic data only (A13).

## 11. Scaling path

**Assumptions for "500 enterprise customers":** ~20k calls/customer/day → ~10M calls/day (~115/s average, ~500/s peak, ~1.5k events/s); ~10 concurrent viewers per customer → ~5k open SSE connections.

![Scaling](diagrams/03-scaling.png)

**What breaks first, in order:**

1. **Read amplification on the primary database.** Every live event triggers throttled refetches from every open dashboard of that account; at ~5k viewers that's 1k+ aggregate queries/s competing with ingest writes.
   → Server-side aggregate cache keyed by (account, filters) with a ~5 s TTL and request coalescing; push a lightweight "stats changed" event; a read replica for dashboards.
2. **Hot rollup rows.** One busy campaign means many transactions updating the same hourly row.
   → Put a queue between ingest and projection; projection workers **micro-batch** rollup deltas (aggregate per second, write once).
3. **`LISTEN/NOTIFY` under heavy write concurrency.** Committing a transaction that issued `NOTIFY` takes a global lock to preserve commit order.
   → Move fan-out to a pub/sub layer or the event stream.
4. **Single-node SSE fan-out.**
   → A dedicated, horizontally scaled realtime gateway subscribed to per-account channels, with reconnect jitter.
5. **Noisy neighbors.**
   → Per-tenant rate limits and statement timeouts, then **cell-based** sharding (largest tenants get their own cell).
6. **Storage growth.**
   → Time-partitioned tables, archival, a columnar store for long-range reporting.
7. **LLM cost and rate limits** (12k+ generations/day if hourly per tenant).
   → Precompute on a schedule, cache by facts hash, smaller models for routine summaries, per-tenant quotas, multi-provider failover in the gateway.

**Evolution:** v0 (this build) → v1 (~50 customers: replicas, aggregate cache, pushed deltas) → v2 (~500: event stream, projection workers, realtime gateway, OLAP, per-tenant limits) → v3 (cells, regional data residency). Each step is triggered by a measured symptom, not added ahead of need.

## 12. Delivery plan

| When | Milestone |
|---|---|
| Day 0 | Kickoff; confirm A1–A7; repo, CI and Compose skeleton |
| Day 1 | Schema, state machine and ingest (with tests), simulator, metrics + calls endpoints → **numbers visible via `curl`** |
| Day 2 | SSE hub, dashboard (filters, volume, conversion, live feed, KPIs), property and E2E tests → **full flow works locally** |
| Day 3 AM | AI insights (time-boxed ~5 h): facts, gateway, guardrails, panel, evals |
| Day 3 PM | Grafana provisioning, deploy, benchmark, diagrams, README / decision summary |

**Cut order if time runs short:** hosted Grafana → live LLM on the hosted demo (the template fallback stays) → benchmark → E2E tests.
**Never cut:** the four core features, ingest correctness tests, the decision summary, the diagram, the one-command run.

## 13. How I use AI tools while building

- **Design first, by me:** this document, the metric definitions and the state machine come before any generated code.
- **Small, reviewable slices:** I generate code one module at a time and review it as I would a teammate's PR.
- **Tests as the contract:** I specify the high-risk tests myself.
- **AI as a reviewer:** I use AI to attack the design ("find edge cases in this transition table").
- **A running log:** the README records which parts were AI-assisted, what I changed, and where my confidence in extending them is lower.

## 14. Questions for the kickoff call

1. Who exactly is the user: one brand's marketing manager, or an agency? (A1)
2. When does a call count as converted, and how late can a conversion arrive? (A2)
3. Should conversion rate be out of all calls or answered calls? (A3)
4. Does a voicemail count as missed, and can a missed call later convert? (A4)
5. Is "last 7 days" calendar days in the account's time zone, or a rolling 168 hours? (A6)
6. How real-time is real-time for you: seconds for the feed, minutes for charts? (A7)
7. Anything you'd like to see more of: testing depth, infra, UX, or AI?

## 15. Change log

| Date | Change | Reason |
|---|---|---|
| 2026-10-07 | v1.0 | Initial decisions and assumptions |
| | *(post-kickoff updates go here)* | |
