import { createHash } from "node:crypto";
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
      `SELECT payload FROM insight_cache
       WHERE account_id = $1 AND scope_key = $2 AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
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

    const same = await this.db.query<{ payload: InsightsResponse }>(
      "SELECT payload FROM insight_cache WHERE account_id = $1 AND cache_key = $2 AND expires_at > now()",
      [accountId, cacheKey],
    );
    if (same.rows[0]) {
      this.opts.metrics?.insightCache.inc({ result: "content" });
      await this.store(accountId, cacheKey, scope, same.rows[0].payload, TTL_MS);
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
      cacheKey,
      generatedAt: new Date(this.now()).toISOString(),
    };
    await this.store(
      accountId,
      cacheKey,
      scope,
      response,
      DEGRADED.includes(gen.outcome) ? DEGRADED_TTL_MS : TTL_MS,
    );
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

  private async store(
    accountId: string,
    cacheKey: string,
    scope: string,
    payload: InsightsResponse,
    ttlMs: number,
  ) {
    await this.db.query(
      `INSERT INTO insight_cache (account_id, cache_key, scope_key, payload, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5))
       ON CONFLICT (account_id, cache_key) DO UPDATE
         SET scope_key = EXCLUDED.scope_key, payload = EXCLUDED.payload,
             created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [accountId, cacheKey, scope, JSON.stringify(payload), ttlMs / 1000],
    );
  }

  /**
   * Thumbs up/down. Stores the insight and the facts it cited exactly as the user saw them, with the prompt
   * version and model, so a thumbs-down can be turned into an eval case.
   */
  async feedback(
    accountId: string,
    input: { cacheKey: string; insightId: string; rating: 1 | -1; comment?: string },
  ) {
    const { rows } = await this.db.query<{ payload: InsightsResponse }>(
      "SELECT payload FROM insight_cache WHERE account_id = $1 AND cache_key = $2",
      [accountId, input.cacheKey],
    );
    const payload = rows[0]?.payload;
    const insight: Insight | undefined = payload?.insights.find((i) => i.id === input.insightId);
    if (!payload || !insight) throw notFound("Insight");
    const cited = payload.facts.filter((f) => insight.factIds.includes(f.id));
    await this.db.query(
      `INSERT INTO insight_feedback (account_id, cache_key, insight_id, rating, prompt_version, model, insight, facts, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        accountId,
        input.cacheKey,
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
