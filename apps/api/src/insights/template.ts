import type { Fact, Insight } from "@calls/shared";

/**
 * Deterministic insights rendered straight from facts. Used when no LLM is configured, when the model is down
 * (circuit open, timeout) or when its output fails the guardrails. Grounded by construction.
 */
export function renderTemplate(facts: Fact[], max = 3): Insight[] {
  const top = facts
    .filter((f) => f.notable)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, max);
  if (top.length === 0) {
    return [
      {
        id: "i1",
        title: "No significant changes this period",
        body: "Call volume, missed calls and conversion rates are within normal variation compared with the previous period.",
        action: null,
        factIds: [],
      },
    ];
  }
  return top.map((f, i) => ({ id: `i${i + 1}`, ...render(f), factIds: [f.id] }));
}

function render(f: Fact): Pick<Insight, "title" | "body" | "action"> {
  const name = f.label.split(" · ")[1] ?? f.label;
  const dir = (f.changePct ?? 0) >= 0 ? "up" : "down";
  const unit =
    f.dimension === "campaign"
      ? "this campaign"
      : f.dimension === "source"
        ? "this channel"
        : "your campaigns";
  switch (f.metric) {
    case "calls":
      return {
        title: `Calls from ${name} ${dir} ${f.display[2]}`,
        body: `${f.display[0]} calls this period vs ${f.display[1]} in the previous period.`,
        action:
          dir === "up"
            ? "Check that staffing keeps up with the extra volume."
            : `Check whether spend or targeting changed for ${unit}.`,
      };
    case "missed":
      return {
        title: `Missed calls from ${name} ${dir} ${f.display[2]}`,
        body: `${f.display[0]} missed calls this period vs ${f.display[1]} in the previous period.`,
        action: dir === "up" ? "Review staffing and overflow routing for these calls." : null,
      };
    case "conversion_rate":
      return {
        title: `Conversion rate for ${name} ${dir} ${f.display[2]}`,
        body: `${f.display[0]} of resolved calls converted vs ${f.display[1]} in the previous period (${f.display[3]} resolved calls).`,
        action:
          dir === "down"
            ? `Look for recent changes to the offer, landing page or call handling for ${unit}.`
            : `Consider shifting budget toward ${unit}.`,
      };
    case "missed_peak_window":
      return {
        title: `Missed calls cluster ${f.display[0]}`,
        body: `${f.display[1]} of calls in that window were missed vs ${f.display[2]} across all hours (${f.display[3]} missed).`,
        action: "Add coverage or overflow routing for that window.",
      };
  }
}
