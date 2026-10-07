import { useCallback, useEffect, useState } from "react";
import { addDays, daysBetween, localDate } from "./format";

/**
 * Every filter lives in the URL, so a view can be bookmarked or pasted into Slack and opens exactly the same.
 * Presets stay relative ("last 7 days" means last 7 days whenever the link is opened); custom ranges are fixed.
 */
export type Preset = "today" | "7d" | "14d" | "30d" | "custom";
export type ViewState = {
  accountId: string | null;
  preset: Preset;
  from: string | null;
  to: string | null;
  campaignIds: string[];
  outcomes: string[];
  granularity: "hour" | "day";
  groupBy: "source" | "campaign";
};

const PRESETS: Preset[] = ["today", "7d", "14d", "30d", "custom"];
const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

function read(): ViewState {
  const p = new URLSearchParams(window.location.search);
  const preset = PRESETS.includes(p.get("range") as Preset) ? (p.get("range") as Preset) : "7d";
  return {
    accountId: p.get("account"),
    preset,
    from: p.get("from"),
    to: p.get("to"),
    campaignIds: csv(p.get("campaigns")),
    outcomes: csv(p.get("outcomes")),
    granularity: p.get("view") === "day" ? "day" : "hour",
    groupBy: p.get("by") === "campaign" ? "campaign" : "source",
  };
}

function write(s: ViewState): string {
  const p = new URLSearchParams();
  if (s.accountId) p.set("account", s.accountId);
  if (s.preset !== "7d") p.set("range", s.preset);
  if (s.preset === "custom" && s.from && s.to) {
    p.set("from", s.from);
    p.set("to", s.to);
  }
  if (s.campaignIds.length) p.set("campaigns", s.campaignIds.join(","));
  if (s.outcomes.length) p.set("outcomes", s.outcomes.join(","));
  if (s.granularity === "day") p.set("view", "day");
  if (s.groupBy === "campaign") p.set("by", "campaign");
  const q = p.toString();
  return q ? `?${q}` : window.location.pathname;
}

export function useViewState(): [ViewState, (patch: Partial<ViewState>) => void] {
  const [state, setState] = useState(read);
  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = useCallback((patch: Partial<ViewState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      window.history.pushState(null, "", write(next));
      return next;
    });
  }, []);
  return [state, update];
}

/** Turns the view's range into concrete local dates for the account's time zone. */
export function resolveDates(s: ViewState, tz: string): { from: string; to: string; days: number } {
  const today = localDate(tz);
  let from = addDays(today, -6);
  let to = today;
  if (s.preset === "today") from = today;
  if (s.preset === "14d") from = addDays(today, -13);
  if (s.preset === "30d") from = addDays(today, -29);
  if (s.preset === "custom" && s.from && s.to) {
    from = s.from;
    to = s.to;
  }
  return { from, to, days: daysBetween(from, to) };
}

export const PRESET_LABELS: Record<Preset, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  custom: "Custom",
};
