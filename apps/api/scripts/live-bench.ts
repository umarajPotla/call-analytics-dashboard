/**
 * Live-feed load test: how long from POSTing a call event to every open SSE stream receiving it, as the number of
 * open streams grows. Also measures the polling fallback. Runs against any running API:
 *
 *   BASE=http://127.0.0.1:8080 SERVER_PID=<api pid, optional: adds CPU and memory> pnpm --filter @calls/api bench:live
 *
 * Start the API with SIM_ENABLED=false for clean numbers. Each phase opens N streams on one account, sends events
 * at a fixed rate, and times delivery on a sample of streams spread evenly across the hub's write order (parsing
 * every stream would make the load generator, not the server, the bottleneck). 5,000+ streams need `ulimit -n`
 * above the stream count in both shells. The load generator shares the machine, so results are conservative.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const SERVER_PID = Number(process.env.SERVER_PID ?? Number.NaN);
const SAMPLE = Number(process.env.SAMPLE ?? 100);
const PHASES: [streams: number, eventsPerSec: number, events: number][] = JSON.parse(
  process.env.PHASES ?? "[[1,10,100],[100,10,100],[1000,10,100],[5000,10,100]]",
);

const streamAgent = new http.Agent({ keepAlive: false, maxSockets: Number.POSITIVE_INFINITY });
const postAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const pollAgent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pending = { t0: number; post: number | null; receipts: number[] };
const pending = new Map<string, Pending>();

function serverStats(): { cpuSeconds: number; rssMb: number } | null {
  if (!Number.isFinite(SERVER_PID)) return null;
  const f = readFileSync(`/proc/${SERVER_PID}/stat`, "utf8").split(") ")[1]!.split(" ");
  const rss = readFileSync(`/proc/${SERVER_PID}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
  return { cpuSeconds: (Number(f[11]) + Number(f[12])) / 100, rssMb: Math.round(Number(rss?.[1]) / 1024) };
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(1);
}
const summary = (v: number[]) => ({ n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) });

function request(method: string, path: string, body?: unknown, agent = pollAgent) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${BASE}${path}`,
      {
        method,
        agent,
        headers: data
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function openStream(accountId: string, parse: boolean) {
  return new Promise<http.ClientRequest>((resolve, reject) => {
    const req = http.get(
      `${BASE}/api/v1/accounts/${accountId}/calls/stream`,
      { agent: streamAgent, headers: { accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`stream status ${res.statusCode}`));
        res.on("error", () => {});
        if (!parse) {
          res.resume();
          return resolve(req);
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          const now = performance.now();
          buf += chunk;
          let i = buf.indexOf("\n\n");
          while (i >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            i = buf.indexOf("\n\n");
            const id = frame.startsWith("id:") ? frame.match(/"callId":"([0-9a-f-]{36})"/)?.[1] : undefined;
            const p = id ? pending.get(id) : undefined;
            if (p) p.receipts.push(now - p.t0);
          }
        });
        resolve(req);
      },
    );
    req.on("error", reject);
  });
}

async function streamPhase(
  accountId: string,
  campaignId: string,
  streams: number,
  rate: number,
  count: number,
) {
  pending.clear();
  const stride = Math.max(1, Math.floor(streams / Math.min(streams, SAMPLE)));
  const reqs: http.ClientRequest[] = [];
  for (let i = 0; i < streams; i += 250) {
    const batch = Array.from({ length: Math.min(250, streams - i) }, (_, k) =>
      openStream(accountId, (i + k) % stride === 0),
    );
    reqs.push(...(await Promise.all(batch)));
  }
  const sampled = Math.ceil(streams / stride);
  await sleep(1500);
  const before = serverStats();
  const w0 = performance.now();
  const posts: Promise<void>[] = [];
  for (let k = 0; k < count; k++) {
    const wait = w0 + (k * 1000) / rate - performance.now();
    if (wait > 0) await sleep(wait);
    const callId = randomUUID();
    const now = new Date().toISOString();
    const p: Pending = { t0: performance.now(), post: null, receipts: [] };
    pending.set(callId, p);
    const events = [
      {
        eventId: randomUUID(),
        type: "call.started",
        occurredAt: now,
        call: { id: callId, accountId, campaignId, startedAt: now, callerRegion: "Load test" },
      },
    ];
    posts.push(
      request("POST", "/api/v1/call-events", { events }, postAgent).then((r) => {
        if (r.status !== 200) throw new Error(`ingest ${r.status}: ${r.text}`);
        p.post = performance.now() - p.t0;
      }),
    );
  }
  await Promise.all(posts);
  const sendSeconds = (performance.now() - w0) / 1000;
  await sleep(3000);
  const after = serverStats();
  const delivery: number[] = [];
  const lastViewer: number[] = [];
  let missing = 0;
  for (const p of pending.values()) {
    delivery.push(...p.receipts);
    missing += sampled - p.receipts.length;
    if (p.receipts.length === sampled) lastViewer.push(Math.max(...p.receipts));
  }
  for (const r of reqs) r.destroy();
  await sleep(1500);
  return {
    streams,
    eventsPerSec: rate,
    framesPerSec: Math.round((streams * count) / sendSeconds),
    ingestMs: summary([...pending.values()].map((p) => p.post ?? Number.NaN)),
    deliveryMs: summary(delivery),
    lastViewerMs: summary(lastViewer),
    missing,
    serverCpuCores:
      before && after
        ? +((after.cpuSeconds - before.cpuSeconds) / ((performance.now() - w0) / 1000)).toFixed(2)
        : null,
    serverRssMb: after?.rssMb ?? null,
  };
}

async function pollFleet(accountId: string, clients: number, intervalMs: number, seconds: number) {
  const latest = JSON.parse(
    (await request("GET", `/api/v1/accounts/${accountId}/calls/changes?afterSeq=1`)).text,
  ).latestSeq as number;
  const latencies: number[] = [];
  const before = serverStats();
  const w0 = performance.now();
  const end = w0 + seconds * 1000;
  await Promise.all(
    Array.from({ length: clients }, async () => {
      await sleep(Math.random() * intervalMs); // jitter: spread clients across the interval
      while (performance.now() < end) {
        const t0 = performance.now();
        await request("GET", `/api/v1/accounts/${accountId}/calls/changes?afterSeq=${latest}`);
        latencies.push(performance.now() - t0);
        await sleep(Math.max(0, intervalMs - (performance.now() - t0)));
      }
    }),
  );
  const elapsed = (performance.now() - w0) / 1000;
  const after = serverStats();
  return {
    clients,
    intervalMs,
    requestsPerSec: Math.round(latencies.length / elapsed),
    latencyMs: summary(latencies),
    serverCpuCores: before && after ? +((after.cpuSeconds - before.cpuSeconds) / elapsed).toFixed(2) : null,
  };
}

const accounts = JSON.parse((await request("GET", "/api/v1/accounts")).text) as { id: string }[];
const accountId = accounts[0]!.id;
const campaigns = JSON.parse((await request("GET", `/api/v1/accounts/${accountId}/campaigns`)).text) as {
  id: string;
}[];
const campaignId = campaigns[0]!.id;

const results = { at: new Date().toISOString(), base: BASE, stream: [] as unknown[], poll: [] as unknown[] };
for (const [streams, rate, count] of PHASES) {
  const r = await streamPhase(accountId, campaignId, streams, rate, count);
  console.log(JSON.stringify(r));
  results.stream.push(r);
}
const fleet = await pollFleet(accountId, 1000, 1000, 15);
console.log(JSON.stringify(fleet));
results.poll.push(fleet);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
process.exit(0);
