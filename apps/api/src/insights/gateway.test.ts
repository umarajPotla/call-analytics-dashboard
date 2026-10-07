import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  estimateCostUsd,
  LlmError,
  LlmGateway,
  type LlmProvider,
  OpenAICompatibleProvider,
} from "./gateway";

const okBody = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

describe("OpenAICompatibleProvider", () => {
  it("posts a JSON-mode chat completion and reads text and usage", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      okBody('{"insights":[]}'),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: "http://llm/v1/",
      model: "m",
      apiKey: "k",
      timeoutMs: 1000,
      fetch,
    });
    const c = await p.complete([{ role: "user", content: "hi" }]);
    expect(c).toMatchObject({ text: '{"insights":[]}', inputTokens: 120, outputTokens: 40, model: "m" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://llm/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: "m",
      response_format: { type: "json_object" },
    });
  });

  it("maps failures to error kinds without leaking the response body", async () => {
    const mk = (res: () => Promise<Response>) =>
      new OpenAICompatibleProvider({
        baseUrl: "http://llm",
        model: "m",
        timeoutMs: 5,
        fetch: res as typeof fetch,
      });
    await expect(
      mk(async () => new Response("secret prompt echo", { status: 429 })).complete([]),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    const http = mk(async () => new Response("secret prompt echo", { status: 503 })).complete([]);
    await expect(http).rejects.toMatchObject({ kind: "http", status: 503 });
    await expect(http).rejects.not.toThrow(/secret/);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(mk(async () => Promise.reject(timeout)).complete([])).rejects.toMatchObject({
      kind: "timeout",
    });
    await expect(mk(async () => new Response("{}", { status: 200 })).complete([])).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});

describe("CircuitBreaker", () => {
  it("opens after N failures in the window, half-opens after the cooldown, and closes on success", () => {
    let t = 0;
    const b = new CircuitBreaker(3, 60_000, 30_000, () => t);
    b.failure();
    b.failure();
    expect(b.state).toBe("closed");
    b.failure();
    expect(b.state).toBe("open");
    expect(b.tryAcquire()).toBe(false);
    t += 30_000;
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // only one trial request
    b.success();
    expect(b.state).toBe("closed");
  });

  it("forgets failures outside the window and re-opens if the trial fails", () => {
    let t = 0;
    const b = new CircuitBreaker(2, 60_000, 30_000, () => t);
    b.failure();
    t += 61_000;
    b.failure();
    expect(b.state).toBe("closed");
    b.failure();
    expect(b.state).toBe("open");
    t += 30_000;
    expect(b.tryAcquire()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
  });
});

describe("LlmGateway", () => {
  const scripted = (...steps: Array<string | LlmError>): LlmProvider & { calls: number } => ({
    model: "m",
    calls: 0,
    async complete() {
      const s = steps[Math.min(this.calls++, steps.length - 1)]!;
      if (s instanceof LlmError) throw s;
      return { text: s, model: "m", inputTokens: 10, outputTokens: 5, latencyMs: 3 };
    },
  });
  const noSleep = async () => {};

  it("retries a transient error once", async () => {
    const p = scripted(new LlmError("http", "boom", 502), "ok");
    const g = new LlmGateway(p, new CircuitBreaker(), undefined, noSleep);
    await expect(g.complete([])).resolves.toMatchObject({ text: "ok" });
    expect(p.calls).toBe(2);
  });

  it("does not retry a timeout (the user already waited) and counts it toward the breaker", async () => {
    const p = scripted(new LlmError("timeout", "slow"));
    const breaker = new CircuitBreaker(1);
    const calls: string[] = [];
    const g = new LlmGateway(p, breaker, { call: (_m, outcome) => calls.push(outcome) }, noSleep);
    await expect(g.complete([])).rejects.toMatchObject({ kind: "timeout" });
    expect(p.calls).toBe(1);
    await expect(g.complete([])).rejects.toMatchObject({ kind: "circuit_open" });
    expect(p.calls).toBe(1);
    expect(calls).toEqual(["timeout", "circuit_open"]);
  });

  it("meters cost from a price table", () => {
    expect(
      estimateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 500_000 },
        { inputPerMTok: 0.1, outputPerMTok: 0.4 },
      ),
    ).toBeCloseTo(0.3);
  });
});
