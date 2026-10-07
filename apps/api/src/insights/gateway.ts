/**
 * Provider-agnostic LLM gateway. Every AI feature goes through here, so timeouts, retries, the circuit breaker,
 * token/cost metering and telemetry are written once. Providers speak the OpenAI-compatible chat API, which
 * covers Ollama (local), Gemini (hosted free tier) and Groq without an SDK per vendor.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Completion = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type LlmErrorKind = "timeout" | "rate_limited" | "http" | "network" | "bad_response" | "circuit_open";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }

  /** Worth one more try: the provider may succeed a moment later. */
  get transient(): boolean {
    return (
      this.kind === "network" ||
      this.kind === "rate_limited" ||
      (this.kind === "http" && (this.status ?? 0) >= 500)
    );
  }
}

export interface LlmProvider {
  readonly model: string;
  complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<Completion>;
}

type FetchLike = typeof fetch;

export type OpenAICompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  temperature?: number;
  fetch?: FetchLike;
};

export class OpenAICompatibleProvider implements LlmProvider {
  readonly model: string;
  private readonly url: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.fetch = opts.fetch ?? fetch;
  }

  async complete(messages: ChatMessage[], { json = true }: { json?: boolean } = {}): Promise<Completion> {
    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.opts.temperature ?? 0.2,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new LlmError("timeout", `no response within ${this.opts.timeoutMs} ms`);
      throw new LlmError("network", (err as Error).message);
    }
    if (res.status === 429) throw new LlmError("rate_limited", "provider rate limit", 429);
    if (!res.ok) {
      // Never echo the body into logs verbatim: some providers include the request (and so our prompt) in errors.
      throw new LlmError("http", `provider responded ${res.status}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    } | null;
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new LlmError("bad_response", "response had no message content");
    return {
      text,
      model: this.model,
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
      latencyMs: performance.now() - started,
    };
  }
}

/**
 * Classic three-state breaker. Opens after `threshold` failures inside `windowMs`; while open every call fails
 * fast (the caller falls back to the template instantly instead of making users wait for timeouts). After
 * `cooldownMs` one trial request is let through: success closes it, failure re-opens it.
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 60_000,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** Returns true if a request may proceed. In half-open state only one trial request is admitted. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "half_open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = [];
    this.openedAt = null;
    this.trialInFlight = false;
  }

  failure(): void {
    const t = this.now();
    if (this.state === "half_open") {
      this.openedAt = t;
      this.trialInFlight = false;
      return;
    }
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.threshold) this.openedAt = t;
  }
}

export interface GatewayObserver {
  call(model: string, outcome: "ok" | LlmErrorKind, c?: Completion): void;
}

export type Pricing = { inputPerMTok: number; outputPerMTok: number };

/** Wraps a provider with the breaker, one retry on transient errors, and metering. */
export class LlmGateway {
  constructor(
    private readonly provider: LlmProvider,
    private readonly breaker = new CircuitBreaker(),
    private readonly observer?: GatewayObserver,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get breakerState() {
    return this.breaker.state;
  }

  async complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<Completion> {
    if (!this.breaker.tryAcquire()) {
      this.observer?.call(this.model, "circuit_open");
      throw new LlmError("circuit_open", "LLM circuit is open");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.provider.complete(messages, opts);
        this.breaker.success();
        this.observer?.call(this.model, "ok", c);
        return c;
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError("network", (err as Error).message);
        if (attempt === 0 && e.transient) {
          await this.sleep(400 + Math.random() * 400);
          continue;
        }
        this.breaker.failure();
        this.observer?.call(this.model, e.kind);
        throw e;
      }
    }
  }
}

export function estimateCostUsd(c: Pick<Completion, "inputTokens" | "outputTokens">, p: Pricing): number {
  return (c.inputTokens * p.inputPerMTok + c.outputTokens * p.outputPerMTok) / 1_000_000;
}
