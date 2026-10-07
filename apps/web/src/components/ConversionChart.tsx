import type { ConversionResponse } from "@calls/shared";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtInt, fmtPct } from "../format";
import { Empty } from "./common";

type Group = ConversionResponse["groups"][number];

export function ConversionChart({ data }: { data: ConversionResponse }) {
  const groups = [...data.groups].sort((a, b) => (b.conversionRate ?? -1) - (a.conversionRate ?? -1));
  if (groups.length === 0 || groups.every((g) => g.resolved === 0)) {
    return <Empty title="No resolved calls in this range">Try a wider date range or fewer filters.</Empty>;
  }
  const height = Math.max(180, groups.length * 38 + 20);
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <BarChart
          data={groups}
          layout="vertical"
          margin={{ top: 0, right: 120, bottom: 0, left: 0 }}
          barSize={18}
        >
          <XAxis type="number" hide domain={[0, (max: number) => Math.max(0.05, max * 1.05)]} />
          <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ConversionTooltip />} />
          <Bar dataKey={(g: Group) => g.conversionRate ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {groups.map((g) => (
              <Cell key={g.key} fill={g.lowVolume ? "var(--border)" : "var(--converted)"} />
            ))}
            <LabelList
              position="right"
              content={(p) => {
                const g = groups[Number(p.index)];
                if (!g) return null;
                const x = Number(p.x) + Number(p.width) + 8;
                const y = Number(p.y) + Number(p.height) / 2 + 4;
                return (
                  <text x={x} y={y} fontSize={12} fill="var(--text)">
                    <tspan fontWeight={650}>{fmtPct(g.conversionRate)}</tspan>
                    <tspan fill="var(--faint)" dx={6}>
                      {g.lowVolume ? "low volume" : `${fmtInt(g.resolved)} calls`}
                    </tspan>
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ConversionTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Group }> }) {
  const g = payload?.[0]?.payload;
  if (!active || !g) return null;
  return (
    <div className="tooltip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{g.label}</div>
      <div className="row">
        <span>Conversion rate</span>
        <strong className="num">{fmtPct(g.conversionRate)}</strong>
      </div>
      <div className="row">
        <span>Of answered calls</span>
        <span className="num">{fmtPct(g.conversionRateOfAnswered)}</span>
      </div>
      <div className="row">
        <span>Converted / resolved</span>
        <span className="num">
          {fmtInt(g.converted)} / {fmtInt(g.resolved)}
        </span>
      </div>
      <div className="row">
        <span>Missed</span>
        <span className="num">{fmtInt(g.missed)}</span>
      </div>
      {g.lowVolume && <div className="faint">Fewer than 30 resolved calls: treat with caution.</div>}
    </div>
  );
}
