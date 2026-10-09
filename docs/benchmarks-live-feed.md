# Benchmark: live-feed latency and fan-out

Measured with `apps/api/scripts/live-bench.ts` on 2026-10-08, against one API process (`SIM_ENABLED=false`) and a local PostgreSQL 16.
Machine: 2 vCPU, 8 GB RAM. **The load generator ran on the same 2 vCPUs**, so these numbers are conservative.

```bash
BASE=http://127.0.0.1:8080 SERVER_PID=<api pid> pnpm --filter @calls/api bench:live
```

**Method.** Each phase opens N Server-Sent Events streams on one account, then POSTs `call.started` events to the public ingest API at a fixed rate. *Delivery* is the time from sending the POST to a stream receiving that call's frame, measured on 100 streams spread evenly across the hub's write order. *Last viewer* is when the slowest sampled stream got it. API CPU is read from `/proc` for the API process only.

## Delivery latency by number of open streams (10 events/s)

| Open streams | Frames/s | Ingest p50 | Delivery p50 / p95 / p99 | Last viewer p50 | API CPU |
|---|---|---|---|---|---|
| 1 | 10 | 5.2 ms | 5.2 / 9.1 / 16.8 ms | 5.2 ms | 0.02 cores |
| 100 | 1,010 | 4.9 ms | 6.0 / 9.3 / 21.8 ms | 7.0 ms | 0.04 cores |
| 1,000 | 10,094 | 4.9 ms | 14.7 / 27.3 / 32.7 ms | 23.1 ms | 0.12 cores |
| 5,000 | 50,488 | 7.8 ms | 61.9 / 133.5 / 158.7 ms | 97.1 ms | 0.53 cores |

An earlier run of the same method measured 43 / 83 / 102 ms at 5,000 streams; with the load generator sharing the CPUs, expect that much run-to-run variation at the top end.

## Past the knee (exploratory run, same method)

| Open streams | Events/s | Frames/s achieved (of 100k asked) | Delivery p50 | API CPU |
|---|---|---|---|---|
| 1,000 | 100 | ~72,000 | 1,237 ms | 0.58 cores |
| 5,000 | 20 | ~88,000 | 650 ms | 0.73 cores |
| 10,000 | 10 | ~82,000 | 1,380 ms | 0.78 cores |

Here the machine is saturated (API, load generator and PostgreSQL share 2 vCPUs) and ingest queues behind fan-out on the API's single event loop.

## Polling fallback, for comparison

1,000 clients polling `GET /calls/changes?afterSeq=…` every second, with jitter: 938 requests/s, p50 3.4 ms, 0.30 API cores. Each update still arrives ~500 ms late on average (half the interval). The same 1,000 viewers on SSE cost 0.12 cores and got updates in ~15 ms.

## What this says

- **Delivery = commit + fan-out.** With few streams, delivery tracks the ingest transaction (~5 ms). The hub adds about **10 µs per frame** on one core (0.53 cores for ~50k frames/s), written one socket after another, so the last viewer of an event waits roughly viewers × 10 µs.
- **One Node process handles ~50k frames/s** before latency climbs steeply; past ~70k frames/s on this machine it collapses to seconds. Plan ~40k frames/s per core with headroom.
- **Memory** grew from 90 MB idle to 325 MB with 10,000 streams open: under ~25 KB per stream, an upper bound.
- **At the 500-customer design point the feed is not the bottleneck** (DESIGN §11): ~10 viewers per account × ~1.5k events/s is ~15k frames/s, about 0.15 cores. A single account with thousands of viewers on one instance is what this hub design handles worst; the realtime gateway (§11, step 4) spreads that fan-out across nodes.
- **Cheap improvements, in order:** index clients by account (today `publish` scans every client on the instance), coalesce writes per client at high event rates, and send smaller frames.
