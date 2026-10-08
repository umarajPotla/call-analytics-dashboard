import type { Fact } from "@calls/shared";
import { describe, expect, it } from "vitest";
import { PROBES } from "./eval/adversarial";
import { CASES } from "./eval/cases";
import { type ChatMessage, CircuitBreaker, LlmError, LlmGateway, type LlmProvider } from "./gateway";
import { InsightGenerator } from "./generator";

const drop = CASES.find((c) => c.name === "conversion-drop")!;
const quiet = CASES.find((c) => c.name === "quiet-week")!;
const probe = (name: string) => PROBES.find((p) => p.name === name)!.output(drop.facts);

function scripted(...answers: Array<string | LlmError>) {
  const seen: ChatMessage[][] = [];
  const provider: LlmProvider = {
    model: "test-model",
    async complete(messages) {
      seen.push(structuredClone(messages));
      const a = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      if (a instanceof LlmError) throw a;
      return { text: a, model: "test-model", inputTokens: 100, outputTokens: 50, latencyMs: 5 };
    },
  };
  const gen = new InsightGenerator(
    new LlmGateway(provider, new CircuitBreaker(), undefined, async () => {}),
    "SYSTEM",
  );
  return { gen, seen };
}
const notable = (facts: Fact[]) => facts.filter((f) => f.notable);

describe("InsightGenerator", () => {
  it("uses a grounded model answer as is", async () => {
    const { gen, seen } = scripted(probe("well-formed"));
    const g = await gen.generate(notable(drop.facts));
    expect(g.outcome).toBe("ok");
    expect(g.generator).toMatchObject({ kind: "llm", model: "test-model", fallbackReason: null });
    expect(g.tokens).toEqual({ input: 100, output: 50 });
    // The model only ever sees notable facts, and only the fields it needs.
    const sent = JSON.parse(seen[0]![1]!.content) as { facts: Array<Record<string, unknown>> };
    expect(
      sent.facts.every((f) => Object.keys(f).sort().join() === "detail,direction,display,id,label,metric"),
    ).toBe(true);
  });

  it("feeds guardrail errors back once, and accepts a repaired answer", async () => {
    const { gen, seen } = scripted(probe("invented-number"), probe("well-formed"));
    const g = await gen.generate(notable(drop.facts));
    expect(g.outcome).toBe("repaired");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.at(-1)!.content).toMatch(/12\.5.*not in the facts/);
  });

  it("falls back to the template when both answers fail, and says why", async () => {
    const { gen, seen } = scripted(probe("invented-number"));
    const g = await gen.generate(notable(drop.facts));
    expect(seen).toHaveLength(2);
    expect(g.outcome).toBe("invalid");
    expect(g.generator).toMatchObject({ kind: "template", fallbackReason: "model output failed guardrails" });
    expect(g.guardrailErrors[0]!.check).toBe("ungrounded_number");
    expect(g.insights.length).toBeGreaterThan(0);
  });

  it("falls back to the template when the model is down", async () => {
    const { gen } = scripted(new LlmError("timeout", "slow"));
    const g = await gen.generate(notable(drop.facts));
    expect(g.outcome).toBe("timeout");
    expect(g.generator.kind).toBe("template");
  });

  it("does not call the model when nothing is notable, or when the budget is spent", async () => {
    const { gen, seen } = scripted(probe("well-formed"));
    expect((await gen.generate(quiet.facts)).outcome).toBe("no_signal");
    expect((await gen.generate(notable(drop.facts), { allowLlm: false })).outcome).toBe("rate_limited");
    expect(seen).toHaveLength(0);
  });
});
