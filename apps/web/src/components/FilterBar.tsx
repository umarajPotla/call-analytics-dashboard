import type { CallStatus, CampaignRef } from "@calls/shared";
import { useEffect, useRef, useState } from "react";
import { PRESET_LABELS, type Preset, type ViewState } from "../viewState";
import { Segmented, STATUS } from "./common";

const SOURCE_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta: "Meta",
  tv: "TV",
  organic: "Organic",
  direct_mail: "Direct mail",
  affiliate: "Affiliate",
};

type Props = {
  view: ViewState;
  dates: { from: string; to: string };
  today: string;
  campaigns: CampaignRef[];
  onChange: (patch: Partial<ViewState>) => void;
};

export function FilterBar({ view, dates, today, campaigns, onChange }: Props) {
  const presets = (["today", "7d", "14d", "30d", "custom"] as Preset[]).map((p) => ({
    value: p,
    label: PRESET_LABELS[p],
  }));
  const filtered = view.campaignIds.length > 0 || view.outcomes.length > 0 || view.preset !== "7d";

  return (
    <div className="filters">
      <Segmented
        label="Date range"
        value={view.preset}
        options={presets}
        onChange={(preset) =>
          onChange(
            preset === "custom"
              ? { preset, from: dates.from, to: dates.to }
              : { preset, from: null, to: null },
          )
        }
      />
      {view.preset === "custom" && (
        <span className="dates">
          <input
            type="date"
            aria-label="From"
            value={dates.from}
            max={dates.to}
            onChange={(e) => e.target.value && onChange({ from: e.target.value })}
          />
          <span className="muted">to</span>
          <input
            type="date"
            aria-label="To"
            value={dates.to}
            min={dates.from}
            max={today}
            onChange={(e) => e.target.value && onChange({ to: e.target.value })}
          />
        </span>
      )}

      <CampaignPicker
        campaigns={campaigns}
        selected={view.campaignIds}
        onChange={(campaignIds) => onChange({ campaignIds })}
      />

      <fieldset className="chips">
        <legend className="filter-label">Outcome</legend>
        {(["connected", "missed", "converted", "ringing"] as CallStatus[]).map((s) => {
          const on = view.outcomes.includes(s);
          return (
            <button
              key={s}
              type="button"
              className="chip"
              aria-pressed={on}
              style={on ? { color: STATUS[s].color } : undefined}
              title={STATUS[s].hint}
              onClick={() =>
                onChange({ outcomes: on ? view.outcomes.filter((o) => o !== s) : [...view.outcomes, s] })
              }
            >
              <span className="dot" style={{ background: STATUS[s].color }} />
              {STATUS[s].label}
            </button>
          );
        })}
      </fieldset>

      {filtered && (
        <button
          type="button"
          className="link-btn"
          onClick={() => onChange({ preset: "7d", from: null, to: null, campaignIds: [], outcomes: [] })}
        >
          Reset filters
        </button>
      )}
    </div>
  );
}

function CampaignPicker({
  campaigns,
  selected,
  onChange,
}: {
  campaigns: CampaignRef[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const label =
    selected.length === 0
      ? "All campaigns"
      : selected.length === 1
        ? (campaigns.find((c) => c.id === selected[0])?.name ?? "1 campaign")
        : `${selected.length} campaigns`;

  return (
    <div className="picker" ref={ref}>
      <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="filter-label">Campaign</span> {label} ▾
      </button>
      {open && (
        <div className="picker-menu" role="menu">
          {campaigns.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
                }
              />
              {c.name}
              <small>{SOURCE_LABELS[c.source] ?? c.source}</small>
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" className="link-btn" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
