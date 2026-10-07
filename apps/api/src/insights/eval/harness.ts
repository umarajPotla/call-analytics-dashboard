import type { ChatMessage, Completion, LlmProvider } from "../gateway";
import type { Generation } from "../generator";
import { checkOutput, parseModelText } from "../guardrails";
import { PROBES } from "./adversarial";
import { CASES, type EvalCase } from "./cases";

export type CaseScore = {
  case: string;
  outcome: Generation["outcome"];
  kind: "llm" | "template";
  cited: string[];
  /** Share of required findings covered (1 when nothing is required). */
  coverage: number;
  forbiddenCited: string[];
  /** Insights that say "up" about a fact that went down, or the reverse. */
  directionErrors: number;
  /** The no-signal expectation was met (or did not apply). */
  noSignalOk: boolean;
  insights: number;
  latencyMs: number;
  tokens: { input: number; output: number };
  guardrailErrors: string[];
};

const UP = /\b(up|rose|risen|increase[sd]?|grew|higher|improved|gain(?:ed)?)\b/i;
const DOWN = /\b(down|fell|fallen|drop(?:ped)?|decrease[sd]?|declined?|lower|worse(?:ned)?)\b/i;

/** Beyond the guardrails: did the answer find what matters, avoid noise, and keep directions right? */
export function scoreCase(c: EvalCase, gen: Generation): CaseScore {
  const cited = [...new Set(gen.insights.flatMap((i) => i.factIds))];
  const required = c.expect.mustCover ?? [];
  const covered = required.filter((anyOf) => anyOf.some((id) => cited.includes(id))).length;
  const byId = new Map(c.facts.map((f) => [f.id, f]));
  let directionErrors = 0;
  for (const ins of gen.insights) {
    if (ins.factIds.length !== 1) continue;
    const f = byId.get(ins.factIds[0]!);
    if (!f || f.changePct === null || f.metric === "missed_peak_window") continue;
    const text = `${ins.title} ${ins.body}`;
    if (
      (f.changePct < 0 && UP.test(text) && !DOWN.test(text)) ||
      (f.changePct > 0 && DOWN.test(text) && !UP.test(text))
    ) {
      directionErrors++;
    }
  }
  return {
    case: c.name,
    outcome: gen.outcome,
    kind: gen.generator.kind,
    cited,
    coverage: required.length ? covered / required.length : 1,
    forbiddenCited: cited.filter((id) => c.expect.mustNotCite?.includes(id)),
    directionErrors,
    noSignalOk: !c.expect.noSignal || gen.outcome === "no_signal",
    insights: gen.insights.length,
    latencyMs: gen.latencyMs,
    tokens: gen.tokens,
    guardrailErrors: gen.guardrailErrors.map((e) => `${e.check}: ${e.message}`),
  };
}

export type ProbeResult = { name: string; expect: string; got: string; pass: boolean };

/** Runs every guardrail probe. All must pass in CI: this is the deterministic part of the eval suite. */
export function runProbes(): ProbeResult[] {
  return PROBES.map((p) => {
    const c = CASES.find((x) => x.name === p.caseName);
    if (!c) throw new Error(`probe ${p.name}: unknown case ${p.caseName}`);
    const parsed = parseModelText(p.output(c.facts));
    const result = parsed.ok
      ? checkOutput(parsed.value, c.facts)
      : { ok: false as const, errors: [parsed.error] };
    const got = result.ok ? "accept" : [...new Set(result.errors.map((e) => e.check))].join(",");
    const pass =
      p.expect === "accept" ? result.ok : !result.ok && result.errors.some((e) => e.check === p.expect);
    return { name: p.name, expect: p.expect, got, pass };
  });
}

/** Records every raw model answer per case, so a live run can be replayed offline (and in CI) later. */
export class RecordingProvider implements LlmProvider {
  readonly recordings: Record<string, string[]> = {};
  current = "";

  constructor(private readonly inner: LlmProvider) {}

  get model() {
    return this.inner.model;
  }

  async complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<Completion> {
    const c = await this.inner.complete(messages, opts);
    const list = this.recordings[this.current] ?? [];
    list.push(c.text);
    this.recordings[this.current] = list;
    return c;
  }
}

/** Plays recorded answers back in order. Lets CI re-check real model outputs against today's guardrails. */
export class ReplayProvider implements LlmProvider {
  current = "";
  private cursor = new Map<string, number>();

  constructor(
    readonly model: string,
    private readonly recordings: Record<string, string[]>,
  ) {}

  async complete(): Promise<Completion> {
    const list = this.recordings[this.current] ?? [];
    const i = this.cursor.get(this.current) ?? 0;
    this.cursor.set(this.current, i + 1);
    const text = list[i] ?? list[list.length - 1] ?? "";
    return { text, model: this.model, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }
}

export type Summary = {
  cases: number;
  /** Cases where the model was asked at all (not quiet periods). */
  modelCalls: number;
  llmAnswered: number;
  firstTryValid: number;
  repaired: number;
  fallbacks: number;
  coverage: number;
  forbiddenCitations: number;
  directionErrors: number;
  noSignalFailures: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  tokensPerCase: number;
};

export function summarize(scores: CaseScore[]): Summary {
  const lat = scores
    .filter((s) => s.latencyMs > 0)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
  const n = scores.length || 1;
  return {
    cases: scores.length,
    modelCalls: scores.filter((s) => !["no_signal", "no_llm", "rate_limited"].includes(s.outcome)).length,
    llmAnswered: scores.filter((s) => s.kind === "llm").length,
    firstTryValid: scores.filter((s) => s.outcome === "ok").length,
    repaired: scores.filter((s) => s.outcome === "repaired").length,
    fallbacks: scores.filter((s) => ["invalid", "timeout", "error", "circuit_open"].includes(s.outcome))
      .length,
    coverage: scores.reduce((a, s) => a + s.coverage, 0) / n,
    forbiddenCitations: scores.reduce((a, s) => a + s.forbiddenCited.length, 0),
    directionErrors: scores.reduce((a, s) => a + s.directionErrors, 0),
    noSignalFailures: scores.filter((s) => !s.noSignalOk).length,
    latencyP50Ms: Math.round(pct(0.5)),
    latencyP95Ms: Math.round(pct(0.95)),
    tokensPerCase: Math.round(scores.reduce((a, s) => a + s.tokens.input + s.tokens.output, 0) / n),
  };
}
