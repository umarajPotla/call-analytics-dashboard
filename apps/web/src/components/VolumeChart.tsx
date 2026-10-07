import type { CallStatus, VolumePoint, VolumeResponse } from "@calls/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtDay, fmtHourLabel, fmtInt } from "../format";
import { STATUS } from "./common";

const ORDER: CallStatus[] = ["converted", "connected", "missed", "ringing"];

type Row = VolumePoint & { label: string; tooltip: string };

export function VolumeChart({ data, outcomes }: { data: VolumeResponse; outcomes: string[] }) {
  const tz = data.timezone;
  const hourly = data.granularity === "hour";
  const rows: Row[] = data.series.map((p) => {
    if (!hourly) return { ...p, label: fmtDay(p.bucket), tooltip: fmtDay(p.bucket) };
    const { day, hour } = fmtHourLabel(p.bucket, tz);
    return { ...p, label: hour === "12 AM" ? day : hour, tooltip: `${day}, ${hour}` };
  });
  const shown = ORDER.filter((s) => outcomes.length === 0 || outcomes.includes(s));
  // Hourly: a tick at each local midnight. Daily: every bar.
  const ticks = hourly
    ? rows.filter((r) => fmtHourLabel(r.bucket, tz).hour === "12 AM").map((r) => r.bucket)
    : undefined;

  return (
    <div className="fill" style={{ width: "100%" }}>
      <ResponsiveContainer>
        <BarChart
          data={rows}
          margin={{ top: 4, right: 4, bottom: 0, left: -12 }}
          barCategoryGap={hourly ? 1 : "18%"}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucket"
            ticks={ticks}
            tickFormatter={(b: string) => (hourly ? fmtHourLabel(b, tz).day : fmtDay(b))}
            tickLine={false}
            axisLine={false}
            minTickGap={12}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => fmtInt(v)}
          />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<VolumeTooltip shown={shown} />} />
          {shown.map((s, i) => (
            <Bar
              key={s}
              dataKey={s}
              stackId="v"
              fill={STATUS[s].color}
              name={STATUS[s].label}
              radius={i === shown.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function VolumeTooltip({
  active,
  payload,
  shown,
}: {
  active?: boolean;
  payload?: Array<{ payload: Row }>;
  shown: CallStatus[];
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const total = shown.reduce((a, s) => a + row[s], 0);
  return (
    <div className="tooltip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{row.tooltip}</div>
      {[...shown].reverse().map((s) => (
        <div className="row" key={s}>
          <span>
            <span className="dot" style={{ background: STATUS[s].color }} /> {STATUS[s].label}
          </span>
          <span className="num">{fmtInt(row[s])}</span>
        </div>
      ))}
      <div className="row" style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4 }}>
        <strong>Total</strong>
        <strong className="num">{fmtInt(total)}</strong>
      </div>
    </div>
  );
}

export function Legend({ outcomes }: { outcomes: string[] }) {
  return (
    <span className="chips" aria-hidden>
      {ORDER.filter((s) => outcomes.length === 0 || outcomes.includes(s)).map((s) => (
        <span key={s} className="faint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className="dot" style={{ background: STATUS[s].color }} />
          {STATUS[s].label}
        </span>
      ))}
    </span>
  );
}
