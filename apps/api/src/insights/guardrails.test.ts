import type { Fact } from "@calls/shared";
import { describe, expect, it } from "vitest";
import { PROBES } from "./eval/adversarial";
import { CASES } from "./eval/cases";
import { runProbes } from "./eval/harness";
import { checkOutput, parseModelText } from "./guardrails";
import { renderTemplate } from "./template";

describe("guardrails", () => {
  it.each(runProbes())("probe $name -> $expect", (r) => {
    expect(r.got, `got ${r.got}`).toBeDefined();
    expect(r.pass).toBe(true);
  });

  it("has a probe for every check", () => {
    const checks = new Set(PROBES.map((p) => p.expect));
    for (const c of [
      "json",
      "schema",
      "unknown_fact",
      "non_notable_fact",
      "ungrounded_number",
      "wrong_direction",
      "uncited_mention",
      "accept",
    ]) {
      expect(checks).toContain(c);
    }
  });

  it.each(CASES)(
    "the template answer for '$name' always passes the guardrails (grounded by construction)",
    (c) => {
      const insights = renderTemplate(c.facts).filter((i) => i.factIds.length > 0);
      const result = checkOutput({ insights: insights.map(({ id: _, ...rest }) => rest) }, c.facts);
      expect(result.ok ? [] : result.errors).toEqual([]);
    },
  );

  it("treats 1,234 and 1234, and 20.0% and 20%, as the same number", () => {
    const [c] = CASES;
    const f = c!.facts.find((x) => x.notable)!;
    const n = f.display[0]!.replace(/,/g, "");
    const text = JSON.stringify({ insights: [{ title: "Change", body: `Now ${n}.`, factIds: [f.id] }] });
    const parsed = parseModelText(text);
    expect(parsed.ok && checkOutput(parsed.value, c!.facts).ok).toBe(true);
  });

  it("matches campaign names whole: citing Non-brand search doesn't count as naming Brand search", () => {
    const fact = (id: string, name: string, change: number): Fact => ({
      id,
      metric: "conversion_rate",
      dimension: "campaign",
      label: `Conversion rate · ${name}`,
      current: 0.2,
      previous: 0.2 - change,
      changePct: change,
      volume: 1000,
      notable: true,
      impact: 10,
      display: ["20.0%", "15.0%", "5.0 pts", "1,000"],
      detail: null,
    });
    const facts = [fact("brand", "Brand search", -0.05), fact("nonbrand", "Non-brand search", 0.05)];
    const ok = checkOutput(
      {
        insights: [
          {
            title: "Non-brand search conversion up 5.0 pts",
            body: "Now 20.0% vs 15.0%.",
            factIds: ["nonbrand"],
          },
        ],
      },
      facts,
    );
    expect(ok.ok ? [] : ok.errors).toEqual([]);
    const bad = checkOutput(
      {
        insights: [
          { title: "Non-brand search down 5.0 pts", body: "Now 20.0% vs 15.0%.", factIds: ["nonbrand"] },
        ],
      },
      facts,
    );
    expect(bad.ok ? [] : bad.errors.map((e) => e.check)).toContain("wrong_direction");
  });
});
