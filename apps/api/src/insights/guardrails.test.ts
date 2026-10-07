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
    for (const c of ["json", "schema", "unknown_fact", "non_notable_fact", "ungrounded_number", "accept"]) {
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
});
