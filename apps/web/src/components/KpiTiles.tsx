import type { SummaryResponse } from "@calls/shared";
import { fmtInt, fmtPct, fmtShortDate } from "../format";
import { Skeleton } from "./common";

type Kind = "count" | "rate";
type Tile = { key: keyof SummaryResponse; label: string; kind: Kind; upIsGood: boolean; hint: string };

const TILES: Tile[] = [
  {
    key: "totalCalls",
    label: "Total calls",
    kind: "count",
    upIsGood: true,
    hint: "Calls that started in the range",
  },
  {
    key: "answerRate",
    label: "Answer rate",
    kind: "rate",
    upIsGood: true,
    hint: "(Connected + converted) ÷ resolved calls. Resolved excludes calls still ringing.",
  },
  {
    key: "conversionRate",
    label: "Conversion rate",
    kind: "rate",
    upIsGood: true,
    hint: "Converted ÷ resolved calls. Late conversions (up to 72 h) are credited to the original call.",
  },
  {
    key: "missedCalls",
    label: "Missed calls",
    kind: "count",
    upIsGood: false,
    hint: "Not answered by a person",
  },
];

export function KpiTiles({ data, isPartial }: { data: SummaryResponse | undefined; isPartial: boolean }) {
  return (
    <div className="kpis span-12">
      {TILES.map((t) => {
        const kpi = data?.[t.key] as { value: number | null; previous: number | null } | undefined;
        return (
          <section key={t.key} className="panel kpi" aria-label={t.label}>
            <div className="label" title={t.hint}>
              {t.label}
              {t.key === "totalCalls" && data && data.inProgress > 0 && (
                <span className="badge">{data.inProgress} live</span>
              )}
            </div>
            {!data || !kpi ? (
              <>
                <Skeleton height={34} width="60%" />
                <div style={{ height: 6 }} />
                <Skeleton height={12} width="80%" />
              </>
            ) : (
              <>
                <div className="value">{t.kind === "rate" ? fmtPct(kpi.value) : fmtInt(kpi.value ?? 0)}</div>
                <Delta tile={t} value={kpi.value} previous={kpi.previous} />
                <div className="delta">
                  vs {fmtShortDate(data.previousRange.from)} – {fmtShortDate(data.previousRange.to)}
                  {isPartial ? ", up to the same time" : ""}
                </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Delta({ tile, value, previous }: { tile: Tile; value: number | null; previous: number | null }) {
  if (value === null || previous === null || (tile.kind === "count" && previous === 0)) {
    return <div className="delta">No comparison available</div>;
  }
  const diff = tile.kind === "rate" ? (value - previous) * 100 : ((value - previous) / previous) * 100;
  if (Math.abs(diff) < 0.05) return <div className="delta">No change</div>;
  const up = diff > 0;
  const good = up === tile.upIsGood;
  const text = tile.kind === "rate" ? `${Math.abs(diff).toFixed(1)} pts` : `${Math.abs(diff).toFixed(1)}%`;
  return (
    <div className="delta">
      <span className={good ? "good" : "bad"}>
        {up ? "▲" : "▼"} {text}
      </span>
    </div>
  );
}
