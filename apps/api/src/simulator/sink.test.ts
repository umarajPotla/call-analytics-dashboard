import type { CallEventInput } from "@calls/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSink, SendError } from "./sink";

const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ eventId: String(i) }) as unknown as CallEventInput);
const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe("simulator HTTP sink (a reference ingest client)", () => {
  it("sends in batches of 200", async () => {
    const fetch = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", fetch);
    await new HttpSink("http://api").send(events(450));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("on 429 reports how many events were accepted and honours Retry-After", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(200))
      .mockResolvedValueOnce(reply(429, { "retry-after": "3" }));
    vi.stubGlobal("fetch", fetch);
    const err = await new HttpSink("http://api").send(events(450)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err).toMatchObject({ sent: 200, retryAfterMs: 3_000 });
  });

  it("backs off 5 s on an error without Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(503)),
    );
    await expect(new HttpSink("http://api").send(events(10))).rejects.toMatchObject({
      sent: 0,
      retryAfterMs: 5_000,
    });
  });
});
