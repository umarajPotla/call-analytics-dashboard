import type { FeedItem } from "@calls/shared";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/pool";
import { PgListener } from "../../src/realtime/pgListener";
import { type TestApp, testApp } from "../helpers/app";
import { freshDb, TEST_DATABASE_URL } from "../helpers/db";
import { ACME, ev, newCall } from "../helpers/events";

let db: Db;
let t: TestApp;
let listener: PgListener;
let base: string;

beforeAll(async () => {
  db = await freshDb();
  t = await testApp(db);
  listener = new PgListener(TEST_DATABASE_URL, (u) => t.hub.publish(u), pino({ level: "silent" }));
  await listener.start();
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/v1/accounts/${ACME.id}`;
});
afterAll(async () => {
  await listener.stop();
  await t.close();
  await db.end();
});

type Frame = { id?: string; event?: string; data?: string };

/** Minimal SSE client: collects frames until `until` is satisfied or the timeout passes. */
async function collect(
  url: string,
  until: (frames: Frame[]) => boolean,
  headers: Record<string, string> = {},
  ms = 4000,
) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const frames: Frame[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const deadline = Date.now() + ms;
  const opened = new Promise<void>((resolve) => setTimeout(resolve, 150)); // let the server attach the client
  const loop = (async () => {
    while (Date.now() < deadline && !until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = {};
        for (const line of raw.split("\n")) {
          const [k, ...rest] = line.split(": ");
          if (k === "id" || k === "event" || k === "data") f[k] = rest.join(": ");
        }
        if (f.event || f.data) frames.push(f);
        i = buf.indexOf("\n\n");
      }
    }
  })();
  return {
    opened,
    done: Promise.race([loop, new Promise((r) => setTimeout(r, ms))]).then(() => {
      ac.abort();
      return frames;
    }),
  };
}

const now = (offsetMs = 0) => new Date(Date.now() - 5_000 + offsetMs).toISOString();
const itemsFor = (frames: Frame[], callId: string) =>
  frames
    .filter((f) => f.event === "call.updated")
    .map((f) => JSON.parse(f.data!) as FeedItem)
    .filter((i) => i.callId === callId);

describe("live feed (SSE)", () => {
  it("pushes a call's status changes to subscribers of its account, after commit", async () => {
    const call = newCall({ startedAt: now() });
    const sub = await collect(`${base}/calls/stream`, (f) =>
      itemsFor(f, call.id).some((i) => i.status === "connected"),
    );
    await sub.opened;
    await t.ingest.ingestBatch([ev(call, "call.started", now())]);
    await t.ingest.ingestBatch([ev(call, "call.answered", now(2_000))]);
    const statuses = itemsFor(await sub.done, call.id).map((i) => i.status);
    expect(statuses).toEqual(["ringing", "connected"]);
  });

  it("replays what a reconnecting client missed (Last-Event-ID)", async () => {
    const call = newCall({ startedAt: now() });
    const [started] = await t.ingest.ingestBatch([ev(call, "call.started", now())]);
    await t.ingest.ingestBatch([ev(call, "call.missed", now(3_000))]);
    const sub = await collect(`${base}/calls/stream`, (f) => itemsFor(f, call.id).length > 0, {
      "last-event-id": String(started!.seq! - 1),
    });
    const items = itemsFor(await sub.done, call.id);
    expect(items.at(-1)!.status).toBe("missed"); // current state, not a stale intermediate one
  });

  it("only sends the campaigns a client filtered on", async () => {
    const [mine, other] = ACME.campaigns;
    const a = newCall({ startedAt: now(), campaignId: mine!.id });
    const b = newCall({ startedAt: now(), campaignId: other!.id });
    const sub = await collect(
      `${base}/calls/stream?campaignIds=${mine!.id}`,
      (f) => itemsFor(f, a.id).length > 0,
    );
    await sub.opened;
    await t.ingest.ingestBatch([ev(b, "call.started", now()), ev(a, "call.started", now())]);
    const frames = await sub.done;
    expect(itemsFor(frames, a.id)).toHaveLength(1);
    expect(itemsFor(frames, b.id)).toHaveLength(0);
  });
});
