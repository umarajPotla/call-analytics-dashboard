import type { Fact } from "@calls/shared";
import type { GuardrailCheck } from "../guardrails";

/**
 * Model outputs the guardrails MUST reject (hallucinations and format failures we have seen or expect), and
 * outputs they MUST accept (so the checks don't become so strict that good answers fall back to the template).
 * Built from a case's real facts, so they stay valid when fact formatting changes.
 */
export type GuardrailProbe = {
  name: string;
  caseName: string;
  output: (facts: Fact[]) => string;
  /** The check that must fire, or "accept". */
  expect: GuardrailCheck | "accept";
};

const fact = (facts: Fact[], id: string) => {
  const f = facts.find((x) => x.id === id);
  if (!f) throw new Error(`probe fixture: no fact ${id}`);
  return f;
};
const BRAND = "campaign:c-brand:conversion_rate";
const json = (insights: unknown[]) => JSON.stringify({ insights });

const good = (facts: Fact[]) => {
  const f = fact(facts, BRAND);
  return {
    title: `Brand search conversion down ${f.display[2]}`,
    body: `${f.display[0]} of resolved calls converted vs ${f.display[1]} last period, across ${f.display[3]} calls.`,
    action: "Check recent changes to the brand landing page and call handling.",
    factIds: [BRAND],
  };
};

export const PROBES: GuardrailProbe[] = [
  // ---- must reject ----
  {
    name: "invented-number",
    caseName: "conversion-drop",
    expect: "ungrounded_number",
    output: (facts) => json([{ ...good(facts), title: "Brand search conversion down 12.5 pts" }]),
  },
  {
    name: "number-from-a-fact-it-does-not-cite",
    caseName: "conversion-drop",
    expect: "ungrounded_number",
    output: (facts) => {
      const other = fact(facts, "source:meta:conversion_rate");
      return json([{ ...good(facts), body: `Converted ${other.display[0]} of calls.` }]);
    },
  },
  {
    name: "unknown-fact-id",
    caseName: "conversion-drop",
    expect: "unknown_fact",
    output: (facts) => json([{ ...good(facts), factIds: ["campaign:c-ghost:conversion_rate"] }]),
  },
  {
    name: "cites-noise",
    caseName: "low-volume-noise",
    expect: "non_notable_fact",
    output: (facts) => {
      const f = fact(facts, "campaign:c-aff1:conversion_rate");
      return json([
        {
          title: "Partner A conversion is surging",
          body: `${f.display[0]} converted vs ${f.display[1]} before.`,
          action: null,
          factIds: [f.id],
        },
      ]);
    },
  },
  {
    name: "too-many-insights",
    caseName: "conversion-drop",
    expect: "schema",
    output: (facts) => json([good(facts), good(facts), good(facts), good(facts)]),
  },
  {
    name: "title-too-long",
    caseName: "conversion-drop",
    expect: "schema",
    output: (facts) => json([{ ...good(facts), title: `${good(facts).title} ${"and more ".repeat(10)}` }]),
  },
  {
    name: "no-citations",
    caseName: "conversion-drop",
    expect: "schema",
    output: (facts) => json([{ ...good(facts), factIds: [] }]),
  },
  {
    name: "prose-instead-of-json",
    caseName: "conversion-drop",
    expect: "json",
    output: () => "Brand search conversion dropped this week. You should look into it!",
  },
  // Found by the live eval of llama3.2:3b on prompt v1: every number right, the story wrong.
  {
    name: "right-numbers-wrong-direction",
    caseName: "conversion-drop",
    expect: "wrong_direction",
    output: (facts) => {
      const f = fact(facts, BRAND);
      return json([{ ...good(facts), title: `Brand search conversion up ${f.display[2]}` }]);
    },
  },
  {
    name: "mixed-directions-lumped-together",
    caseName: "mixed-directions",
    expect: "wrong_direction",
    output: (facts) => {
      const brand = fact(facts, BRAND);
      const meta = fact(facts, "source:meta:conversion_rate");
      return json([
        {
          title: "Conversion rates decreased",
          body: `Brand search fell to ${brand.display[0]} and Meta to ${meta.display[0]}.`,
          action: null,
          factIds: [brand.id, meta.id],
        },
      ]);
    },
  },
  {
    name: "names-a-channel-it-does-not-cite",
    caseName: "mixed-directions",
    expect: "uncited_mention",
    output: (facts) => json([{ ...good(facts), body: `${good(facts).body} Meta looks different.` }]),
  },
  // ---- must accept ----
  {
    name: "well-formed",
    caseName: "conversion-drop",
    expect: "accept",
    output: (facts) => json([good(facts)]),
  },
  {
    name: "fenced-json",
    caseName: "conversion-drop",
    expect: "accept",
    output: (facts) => `\`\`\`json\n${json([good(facts)])}\n\`\`\``,
  },
  {
    name: "mixed-directions-told-apart",
    caseName: "mixed-directions",
    expect: "accept",
    output: (facts) => {
      const brand = fact(facts, BRAND);
      const meta = fact(facts, "source:meta:conversion_rate");
      return json([
        {
          title: "Brand search down, Meta up",
          body: `Brand search conversion fell to ${brand.display[0]} while Meta rose to ${meta.display[0]}.`,
          action: null,
          factIds: [brand.id, meta.id],
        },
      ]);
    },
  },
  {
    name: "action-may-be-null",
    caseName: "conversion-drop",
    expect: "accept",
    output: (facts) => json([{ ...good(facts), action: null }]),
  },
];
