import type { Fact, Insight } from "@calls/shared";
import { z } from "zod";

/** What the model must return. Anything else is rejected. */
export const ModelOutput = z.object({
  insights: z
    .array(
      z.object({
        title: z.string().min(3).max(80),
        body: z.string().min(3).max(240),
        action: z.string().max(140).nullable().optional(),
        factIds: z.array(z.string()).min(1).max(4),
      }),
    )
    .max(3),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

export type GuardrailCheck = "json" | "schema" | "unknown_fact" | "non_notable_fact" | "ungrounded_number";
export type GuardrailError = { check: GuardrailCheck; message: string };
export type GuardrailResult = { ok: true; insights: Insight[] } | { ok: false; errors: GuardrailError[] };

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (s: string) => (s.match(NUMBER) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

/** Models sometimes wrap JSON in a Markdown fence even when asked not to. Accept that, nothing looser. */
export function parseModelText(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: GuardrailError } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: { check: "json", message: "output is not valid JSON" } };
  }
}

/**
 * The safety net between the model and the user:
 *  1. output matches the schema (shape, lengths, at most 3 insights)
 *  2. every cited fact id exists and is notable (low-volume or insignificant facts may not be cited)
 *  3. GROUNDING: every number in the text appears in the cited facts' display values or labels
 * Deterministic, so it runs in CI against adversarial outputs and in production on every generation.
 */
export function checkOutput(raw: unknown, facts: Fact[]): GuardrailResult {
  const parsed = ModelOutput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        check: "schema",
        message: `${i.path.join(".") || "output"}: ${i.message}`,
      })),
    };
  }

  const byId = new Map(facts.map((f) => [f.id, f]));
  const errors: GuardrailError[] = [];
  const insights: Insight[] = parsed.data.insights.map((ins, idx) => {
    const n = idx + 1;
    const cited: Fact[] = [];
    for (const id of ins.factIds) {
      const f = byId.get(id);
      if (!f) errors.push({ check: "unknown_fact", message: `insight ${n} cites unknown fact id "${id}"` });
      else if (!f.notable)
        errors.push({
          check: "non_notable_fact",
          message: `insight ${n} cites "${id}", which is not notable`,
        });
      else cited.push(f);
    }
    const allowed = new Set(cited.flatMap((f) => [...f.display.flatMap(numbersIn), ...numbersIn(f.label)]));
    for (const text of [ins.title, ins.body, ins.action ?? ""]) {
      for (const num of numbersIn(text)) {
        if (!allowed.has(num)) {
          errors.push({
            check: "ungrounded_number",
            message: `insight ${n} uses the number ${num}, which is not in the facts it cites`,
          });
        }
      }
    }
    return {
      id: `i${n}`,
      title: ins.title,
      body: ins.body,
      action: ins.action ?? null,
      factIds: ins.factIds,
    };
  });
  return errors.length ? { ok: false, errors } : { ok: true, insights };
}
