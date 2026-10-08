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

## rollup-drift

**Means:** some hourly rollup buckets disagree with a recount of the `calls` table. **The dashboard is showing wrong numbers.** This should never happen: every ingest updates the call and the rollup in one transaction.

1. **Data correctness** dashboard: how many buckets, and since when?
2. Repair: `docker compose exec api node dist/rebuild-rollups.js --since <ISO time before the drift>`. It prints the drift before and after, which should be 0. Ingest keeps running; it waits a few seconds behind the rebuild's locks.
3. Then find the cause: a manual SQL change, a restored backup, or a code path that writes `calls` without going through `IngestService`. Add a test that reproduces it. The property test in `test/integration/rollup.property.test.ts` is the place.

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
