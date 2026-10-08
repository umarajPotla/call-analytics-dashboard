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

export type GuardrailCheck =
  | "json"
  | "schema"
  | "unknown_fact"
  | "non_notable_fact"
  | "ungrounded_number"
  | "wrong_direction"
  | "uncited_mention";
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

const UP =
  /\b(up|rose|risen|rising|increas(?:e|ed|es|ing)|grew|grown|growing|higher|improv(?:e|ed|es|ing)|gain(?:ed|s)?|jump(?:ed|s)?|surg(?:e|ed|es|ing)|climb(?:ed|s|ing)?)\b/i;
const DOWN =
  /\b(down|fell|fallen|falling|drop(?:ped|s|ping)?|decreas(?:e|ed|es|ing)|declin(?:e|ed|es|ing)|lower|worse(?:ned)?|dipped|slipped|shrank|shrunk)\b/i;

type Direction = "up" | "down";
/** Which way a fact moved, or null when "direction" doesn't apply (the missed-call peak window, no change). */
export function directionOf(f: Fact): Direction | null {
  if (f.metric === "missed_peak_window" || f.changePct === null || f.changePct === 0) return null;
  return f.changePct > 0 ? "up" : "down";
}
/** The campaign or source a fact is about ("Calls · Meta" -> "Meta"); null for account-wide facts. */
const subjectOf = (f: Fact) => (f.dimension === "account" ? null : (f.label.split(" · ")[1] ?? null));
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Number grounding isn't enough: a live eval of a small local model produced answers where every number was
 * right and the direction was wrong ("Meta calls up 34%" for a 34% drop), or that named a channel it didn't
 * cite. These two checks close that gap without understanding language: they compare direction words with the
 * directions of the cited facts, and named campaigns/sources with the cited ones.
 */
function directionErrors(n: number, text: string, cited: Fact[]): GuardrailError[] {
  const dirs = new Set(cited.map(directionOf).filter((d): d is Direction => d !== null));
  const saysUp = UP.test(text);
  const saysDown = DOWN.test(text);
  if (dirs.size === 0 || (!saysUp && !saysDown)) return []; // no direction claimed, or none to check
  const errors: GuardrailError[] = [];
  const err = (message: string) =>
    errors.push({ check: "wrong_direction", message: `insight ${n} ${message}` });
  const name = (d: Direction) =>
    cited
      .filter((f) => directionOf(f) === d)
      .map((f) => f.label)
      .join(", ");
  if (saysUp && !dirs.has("up")) err(`says something went up, but every fact it cites went down`);
  if (saysDown && !dirs.has("down")) err(`says something went down, but every fact it cites went up`);
  if (dirs.has("up") && dirs.has("down")) {
    if (!saysUp) err(`only describes decreases, but ${name("up")} went up`);
    if (!saysDown) err(`only describes increases, but ${name("down")} went down`);
  }
  // Locally: a fact's change figure ("34%", "7.0 pts") must not sit next to the opposite direction word.
  const words = text.split(/\s+/);
  for (const f of cited) {
    const d = directionOf(f);
    const change =
      f.metric === "calls" || f.metric === "missed" || f.metric === "conversion_rate" ? f.display[2] : null;
    if (!d || !change) continue;
    const num = numbersIn(change)[0];
    // Skip if another cited fact shows the same figure in the other direction: we can't tell which is meant.
    if (
      !num ||
      cited.some((o) => o !== f && directionOf(o) !== d && o.display[2] && numbersIn(o.display[2])[0] === num)
    )
      continue;
    words.forEach((w, i) => {
      if (!numbersIn(w).includes(num)) return;
      const near = words.slice(Math.max(0, i - 4), i + 3).join(" ");
      const same = d === "up" ? UP : DOWN;
      const other = d === "up" ? DOWN : UP;
      if (other.test(near) && !same.test(near))
        err(`puts ${change} next to the wrong direction for ${f.label}`);
    });
  }
  return errors;
}

function mentionErrors(n: number, text: string, cited: Fact[], all: Fact[]): GuardrailError[] {
  const citedNames = new Set(
    cited
      .map(subjectOf)
      .filter(Boolean)
      .map((s) => s!.toLowerCase()),
  );
  const names = [...new Set(all.map(subjectOf).filter((s): s is string => !!s))].sort(
    (a, b) => b.length - a.length,
  );
  let rest = text;
  const errors: GuardrailError[] = [];
  for (const name of names) {
    const re = new RegExp(`(^|[^\\w-])${escapeRegex(name)}(?![\\w-])`, "gi");
    if (!re.test(rest)) continue;
    rest = rest.replace(re, "$1 "); // longest names first, so "Brand search" isn't found inside "Non-brand search"
    if (!citedNames.has(name.toLowerCase())) {
      errors.push({
        check: "uncited_mention",
        message: `insight ${n} mentions ${name} but cites no fact about it`,
      });
    }
  }
  return errors;
}

/**
 * The safety net between the model and the user:
 *  1. output matches the schema (shape, lengths, at most 3 insights)
 *  2. every cited fact id exists and is notable (low-volume or insignificant facts may not be cited)
 *  3. GROUNDING: every number in the text appears in the cited facts' display values or labels
 *  4. DIRECTION: "up"/"down" words agree with the cited facts' directions
 *  5. MENTIONS: every campaign or source named in the text is one the insight cites
 * Deterministic, so it runs in CI against adversarial outputs and recorded model answers, and in production on
 * every generation.
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
    errors.push(...directionErrors(n, `${ins.title}. ${ins.body}`, cited));
    errors.push(...mentionErrors(n, `${ins.title}. ${ins.body}. ${ins.action ?? ""}`, cited, facts));
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
