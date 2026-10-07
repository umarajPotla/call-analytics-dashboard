import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fact, Insight, InsightsResponse } from "@calls/shared";
import { type ChatMessage, LlmError, type LlmGateway } from "./gateway";
import { checkOutput, type GuardrailError, parseModelText } from "./guardrails";
import { renderTemplate } from "./template";

export const PROMPT_VERSION = "insights.v1";

/** Prompts are versioned files, reviewed like code. The version is part of the cache key and of every metric. */
export function loadPrompt(version = PROMPT_VERSION): string {
  // src/insights/prompts in dev; dist/prompts when bundled (both are ./prompts next to this module's output)
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "prompts", `${version}.md`), "utf8");
}

export type GenerationOutcome =
  | "ok" // first answer passed every guardrail
  | "repaired" // second answer passed after the first was rejected
  | "invalid" // both answers failed the guardrails -> template
  | "timeout"
  | "error"
  | "circuit_open"
  | "rate_limited" // our per-tenant budget, not the provider's
  | "no_llm" // no model configured -> template
  | "no_signal"; // nothing notable: template says so, no model call needed

export type Generation = {
  insights: Insight[];
  generator: InsightsResponse["generator"];
  outcome: GenerationOutcome;
  guardrailErrors: GuardrailError[];
  tokens: { input: number; output: number };
  latencyMs: number;
};

/** Facts shown to the model: only what it needs, so the prompt stays small and the model can't cite other fields. */
export function factsForPrompt(facts: Fact[]) {
  return facts.map((f) => ({
    id: f.id,
    label: f.label,
    metric: f.metric,
    display: f.display,
    detail: f.detail,
  }));
}

/**
 * Facts in, insights out. No database and no cache here, so the eval harness runs exactly the production path.
 * The model only selects and phrases; guardrails decide whether its words reach the user.
 */
export class InsightGenerator {
  constructor(
    private readonly gateway: LlmGateway | null,
    private readonly systemPrompt: string,
    private readonly promptVersion = PROMPT_VERSION,
  ) {}

  get model(): string | null {
    return this.gateway?.model ?? null;
  }

  async generate(facts: Fact[], opts: { allowLlm?: boolean } = {}): Promise<Generation> {
    const notable = facts.filter((f) => f.notable);
    if (notable.length === 0) return this.template(facts, "no_signal", null);
    if (!this.gateway) return this.template(facts, "no_llm", "no model configured");
    if (opts.allowLlm === false)
      return this.template(facts, "rate_limited", "per-account AI budget reached; using template");

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: JSON.stringify({ facts: factsForPrompt(notable) }) },
    ];
    const tokens = { input: 0, output: 0 };
    let latencyMs = 0;
    let lastErrors: GuardrailError[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        const c = await this.gateway.complete(messages, { json: true });
        tokens.input += c.inputTokens;
        tokens.output += c.outputTokens;
        latencyMs += c.latencyMs;
        text = c.text;
      } catch (err) {
        const kind = err instanceof LlmError ? err.kind : "network";
        const outcome: GenerationOutcome =
          kind === "timeout" ? "timeout" : kind === "circuit_open" ? "circuit_open" : "error";
        return { ...this.template(facts, outcome, `model ${kind.replace("_", " ")}`), tokens, latencyMs };
      }

      const parsed = parseModelText(text);
      const result = parsed.ok
        ? checkOutput(parsed.value, notable)
        : { ok: false as const, errors: [parsed.error] };
      if (result.ok && result.insights.length > 0) {
        return {
          insights: result.insights,
          generator: {
            kind: "llm",
            model: this.gateway.model,
            promptVersion: this.promptVersion,
            fallbackReason: null,
          },
          outcome: attempt === 0 ? "ok" : "repaired",
          guardrailErrors: lastErrors,
          tokens,
          latencyMs,
        };
      }
      lastErrors = result.ok
        ? [{ check: "schema", message: "insights: expected at least 1 insight" }]
        : result.errors;
      // One repair attempt: show the model exactly what was wrong.
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `Your answer was rejected:\n${lastErrors.map((e) => `- ${e.message}`).join("\n")}\nReply again with JSON only, following every rule.`,
        },
      );
    }
    return {
      ...this.template(facts, "invalid", "model output failed guardrails"),
      guardrailErrors: lastErrors,
      tokens,
      latencyMs,
    };
  }

  private template(facts: Fact[], outcome: GenerationOutcome, fallbackReason: string | null): Generation {
    return {
      insights: renderTemplate(facts),
      generator: { kind: "template", model: null, promptVersion: this.promptVersion, fallbackReason },
      outcome,
      guardrailErrors: [],
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
    };
  }
}
