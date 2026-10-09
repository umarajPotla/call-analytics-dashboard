# Runbook

What each alert means, how to confirm it, and what to do. Alerts are defined in
[`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml); the dashboards are in Grafana under **Call Analytics**.

Commands assume Docker Compose (`docker compose exec api …`). Without Docker, use the `pnpm --filter @calls/api …` equivalents.

## api-down

**Means:** Prometheus can't scrape `/metrics`. The dashboard is down or unreachable.

1. `docker compose ps`: is `api` restarting? `docker compose logs --tail 100 api`.
2. A configuration error is printed as `Invalid configuration:` followed by the variable at fault.
3. `curl localhost:8080/readyz`: `503` means the API is up but can't reach Postgres. Check `db` health and `DATABASE_URL`.
4. On the hosted demo, the free instance sleeps after 15 minutes idle. The first request wakes it in about 30 s, and the simulator then catches up on the minutes it missed. That is expected, not an incident.

## ingest-lag

**Means:** the p95 time from a call event happening to it being stored is above 10 s. The live feed and charts are behind.

1. **Service health** dashboard: are requests slow overall (database), or is only ingest slow?
2. Just after a wake-up from sleep, the simulator replays events that happened while the host was asleep. Their lag is real but harmless, and the alert's 5-minute `for` window usually absorbs it.
3. If Postgres is slow: look for lock waits (`SELECT * FROM pg_stat_activity WHERE wait_event_type = 'Lock'`). Ingest takes a per-call advisory lock; contention means one call is receiving a burst of events.

## ingest-rejects

**Means:** more than 1% of incoming events are rejected for 10 minutes. Rejected events are not lost: invalid ones are kept in `call_events` with `applied = false` and a `reject_reason`, and events for unknown campaigns are refused before storage. The usual cause is an integration sending bad data.

1. **Data correctness** → *Rejections by reason*: which reason?
2. `unknown_campaign`: a campaign was created in the telephony platform but not here, or an account sends another account's campaign ids. The campaign directory reloads at most every 30 s, so a brand-new campaign settles by itself; a steady rate does not. The sender can resend those events once the campaign exists; they were never stored, so they apply normally.
3. `identity_mismatch` or an invalid transition (a conversion for a missed call): look at the stored events, `SELECT reject_reason, payload FROM call_events WHERE NOT applied ORDER BY seq DESC LIMIT 20`, and take it to the integration's owner.
4. `occurred_in_future`: the sender's clock is more than 5 minutes ahead.

## ingest-rate-limited

**Means:** an account has been over its ingest limit (`INGEST_RATE_PER_ACCOUNT` events/s, burst `INGEST_BURST_PER_ACCOUNT`) for 15 minutes. Those requests got `429` with `Retry-After`, and nothing in them was applied. Events are idempotent, so a well-behaved sender resends and loses nothing, but the live feed for that account falls behind.

1. **Service health** → *Ingested events by outcome* shows the refused rate. Find the account in the API logs: each refusal is logged as `ingest: rate limited` with the account ids.
2. A retry storm (a sender ignoring `Retry-After`) is the sender's bug; tell its owner. A real volume increase (a TV campaign, a new large customer) means the limit is too low: raise it for everyone with the environment variables, and plan per-account limits if one customer needs much more than the rest.
3. The limiter is per API instance; with several instances the effective limit is the configured rate times the instance count.

## rollup-drift

**Means:** some hourly rollup buckets disagree with a recount of the `calls` table. **The dashboard is showing wrong numbers.** This should never happen: every ingest updates the call and the rollup in one transaction.

1. **Data correctness** dashboard: how many buckets, and since when?
2. Repair: `docker compose exec api node dist/rebuild-rollups.js --since <ISO time before the drift>`. It prints the drift before and after, which should be 0. Ingest keeps running; it waits a few seconds behind the rebuild's locks.
3. Then find the cause: a manual SQL change, a restored backup, or a code path that writes `calls` without going through `IngestService`. Add a test that reproduces it. The property test in `test/integration/rollup.property.test.ts` is the place.

## http-errors

**Means:** more than 2% of API requests fail with a 5xx. Users see "Couldn't load this" panels.

1. **Service health** dashboard → *Requests by route* and *Latency by route*: is it one route or all of them?
2. `docker compose logs --tail 200 api | grep '"level":50'`: unhandled errors are logged with their stack; responses never include it.
3. All routes failing usually means the database: check `/readyz` and the [api-down](#api-down) steps. One route failing after a deploy means a code regression: roll back.

## live-feed-drops

**Means:** more than 5% of live-feed disconnects are the server cutting off slow clients. Each client may have at most 500 unflushed writes; past that it is disconnected so it can't slow everyone else down. The browser reconnects by itself and replays what it missed, so users usually notice only a brief "Reconnecting…".

1. **Service health** → *Live-feed connections*: a burst right after a traffic spike is expected; a steady rate is not.
2. A steady rate means clients can't keep up: a slow network path, or a proxy buffering the stream. Check that proxies honour `X-Accel-Buffering: no`.
3. If it persists at real scale, that's the signal for the dedicated realtime gateway (DESIGN §11, step 4).

## insights-fallback

**Means:** more than 20% of AI insight generations fell back to the rules-based template. Users still see insights, but not the model's.

1. **AI insights** dashboard → *Generations by outcome*:
   - `timeout` or `error`: the provider is slow or failing. Check its status page and `llm_requests_total` by outcome. The circuit breaker opens after 5 failures in 60 s and retries after 30 s.
   - `circuit_open`: same as above. The breaker is protecting latency.
   - `invalid`: the model answers, but its output fails the guardrails. See *Guardrail rejections by check*. A spike in `ungrounded_number` after a model or prompt change is a regression: roll back the prompt version or model, then reproduce with `pnpm eval --live`.
2. `rate_limited` is our own per-account budget (`INSIGHTS_LLM_BUDGET_PER_HOUR`), not the provider's. It doesn't count toward this alert.

## Useful commands

| Task | Command |
|---|---|
| Apply migrations | `docker compose exec api node dist/migrate.js` |
| Recheck and repair rollups | `docker compose exec api node dist/rebuild-rollups.js --since 2026-10-01T00:00:00Z` |
| Offline evals (CI gate) | `pnpm eval` |
| Live evals against the configured model | `pnpm eval --live --runs 3 --record` |
| Trigger a traffic spike (demo) | `curl -XPOST localhost:8080/api/v1/dev/spike -H 'content-type: application/json' -d '{"accountId":"<id>"}'` |
