import { createHash, randomUUID } from "node:crypto";
import type { Fact, Insight, InsightsResponse } from "@calls/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/pool";
import { notFound } from "../http/errors";
import type { Metrics } from "../observability/metrics";
import { previousRange, type ResolvedRange } from "../read/range";
import { computeFacts } from "./facts";
import type { GenerationOutcome, InsightGenerator } from "./generator";
import { PROMPT_VERSION } from "./generator";

const TTL_MS = 15 * 60_000;
/** A template answer given because the model was unavailable is kept briefly, so we try the model again soon. */
const DEGRADED_TTL_MS = 60_000;
/** The model sees at most this many facts: the notable ones with the most impact. Keeps prompts small and cheap. */
const MAX_FACTS = 8;
const HOUR = 3_600_000;

const DEGRADED: GenerationOutcome[] = ["timeout", "error", "circuit_open", "rate_limited"];

export type InsightsServiceOptions = {
  metrics?: Metrics;
  log?: FastifyBaseLogger;
  /** LLM generations allowed per account per rolling hour; past that the template answers. */
  budgetPerHour?: number;
  now?: () => number;
};

/**
 * Insights for an account and date range: facts from SQL -> cached generation -> response.
 * Insights are never regenerated per live event. Cost is bounded three ways: a 15-minute freshness window per
 * (account, range), content addressing on the exact facts, and a per-account hourly budget of model calls.
 */
export class InsightsService {
  private inflight = new Map<string, Promise<InsightsResponse>>();
  private budget = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly generator: InsightGenerator,
    private readonly opts: InsightsServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** The model behind the insights, or null when only the template is available. */
  get model(): string | null {
    return this.generator.model;
  }

  get(accountId: string, range: ResolvedRange): Promise<InsightsResponse> {
    const scope = [accountId, range.from, range.to, PROMPT_VERSION, this.generator.model ?? "template"].join(
      "|",
    );
    // Single flight: concurrent requests for the same scope share one generation.
    const running = this.inflight.get(scope);
    if (running) return running;
    const p = this.load(accountId, range, scope).finally(() => this.inflight.delete(scope));
    this.inflight.set(scope, p);
    return p;
  }

  private async load(accountId: string, range: ResolvedRange, scope: string): Promise<InsightsResponse> {
    const fresh = await this.db.query<{ payload: InsightsResponse }>(
      `SELECT g.payload FROM insight_scopes s JOIN insight_generations g ON g.id = s.generation_id
       WHERE s.account_id = $1 AND s.scope_key = $2 AND s.expires_at > now()`,
      [accountId, scope],
    );
    if (fresh.rows[0]) {
      this.opts.metrics?.insightCache.inc({ result: "fresh" });
      return fresh.rows[0].payload;
    }

    const previous = await previousRange(this.db, range);
    const all = await computeFacts(this.db, accountId, range, previous);
    const facts = all
      .filter((f) => f.notable)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, MAX_FACTS);
    const cacheKey = factsKey(facts, this.generator.model);

    const same = await this.db.query<{ id: string; payload: InsightsResponse; ttl: number }>(
      `SELECT id, payload, extract(epoch FROM expires_at - now()) AS ttl FROM insight_generations
       WHERE account_id = $1 AND cache_key = $2 AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [accountId, cacheKey],
    );
    if (same.rows[0]) {
      this.opts.metrics?.insightCache.inc({ result: "content" });
      await this.point(accountId, scope, same.rows[0].id, Math.min(TTL_MS, same.rows[0].ttl * 1000));
      return same.rows[0].payload;
    }
    this.opts.metrics?.insightCache.inc({ result: "miss" });

    const gen = await this.generator.generate(facts, { allowLlm: this.takeBudget(accountId, facts) });
    const m = this.opts.metrics;
    m?.insightGenerations.inc({ outcome: gen.outcome, model: this.generator.model ?? "template" });
    for (const e of gen.guardrailErrors) m?.insightGuardrailFailures.inc({ check: e.check });
    if (gen.guardrailErrors.length) {
      this.opts.log?.warn(
        { accountId, outcome: gen.outcome, errors: gen.guardrailErrors },
        "insights: guardrails rejected model output",
      );
    }

    const response: InsightsResponse = {
      insights: gen.insights,
      facts,
      generator: gen.generator,
      generationId: randomUUID(),
      cacheKey,
      generatedAt: new Date(this.now()).toISOString(),
    };
    const ttl = DEGRADED.includes(gen.outcome) ? DEGRADED_TTL_MS : TTL_MS;
    await this.db.query(
      `INSERT INTO insight_generations (id, account_id, cache_key, payload, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [response.generationId, accountId, cacheKey, JSON.stringify(response), ttl / 1000],
    );
    await this.point(accountId, scope, response.generationId, ttl);
    return response;
  }

  /** Spend one unit of the account's hourly LLM budget, if a model call would happen at all. */
  private takeBudget(accountId: string, facts: Fact[]): boolean {
    if (!this.generator.model || !facts.some((f) => f.notable)) return true;
    const limit = this.opts.budgetPerHour ?? 30;
    const t = this.now();
    const recent = (this.budget.get(accountId) ?? []).filter((x) => t - x < HOUR);
    const allowed = recent.length < limit;
    if (allowed) recent.push(t);
    this.budget.set(accountId, recent);
    return allowed;
  }

  /** Make `generationId` the answer for this (account, range) for the next `ttlMs`. */
  private async point(accountId: string, scope: string, generationId: string, ttlMs: number) {
    await this.db.query(
      `INSERT INTO insight_scopes (account_id, scope_key, generation_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (account_id, scope_key) DO UPDATE
         SET generation_id = EXCLUDED.generation_id, expires_at = EXCLUDED.expires_at`,
      [accountId, scope, generationId, Math.max(1, ttlMs / 1000)],
    );
  }

  /**
   * Thumbs up/down on one insight of one generation. Generations are immutable, so the stored snapshot (the
   * insight and the facts it cited, the prompt version and the model) is exactly what the user saw, ready to
   * become an eval case.
   */
  async feedback(
    accountId: string,
    input: { generationId: string; insightId: string; rating: 1 | -1; comment?: string },
  ) {
    const { rows } = await this.db.query<{ payload: InsightsResponse; cache_key: string }>(
      "SELECT payload, cache_key FROM insight_generations WHERE account_id = $1 AND id = $2",
      [accountId, input.generationId],
    );
    const payload = rows[0]?.payload;
    const insight: Insight | undefined = payload?.insights.find((i) => i.id === input.insightId);
    if (!payload || !insight) throw notFound("Insight");
    const cited = payload.facts.filter((f) => insight.factIds.includes(f.id));
    await this.db.query(
      `INSERT INTO insight_feedback
         (account_id, generation_id, cache_key, insight_id, rating, prompt_version, model, insight, facts, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        accountId,
        input.generationId,
        rows[0]!.cache_key,
        input.insightId,
        input.rating,
        payload.generator.promptVersion,
        payload.generator.model,
        JSON.stringify(insight),
        JSON.stringify(cited),
        input.comment ?? null,
      ],
    );
    this.opts.metrics?.insightFeedback.inc({
      rating: input.rating > 0 ? "up" : "down",
      generator: payload.generator.kind,
    });
  }
}

/** Content address of a generation: the prompt version, the model and the exact facts it would see. */
export function factsKey(facts: Fact[], model: string | null): string {
  const material = JSON.stringify([
    PROMPT_VERSION,
    model ?? "template",
    facts.map((f) => [f.id, f.display, f.notable]),
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
