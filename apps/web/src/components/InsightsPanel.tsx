import type { Fact, InsightsResponse } from "@calls/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { fmtAgo } from "../format";
import { Empty, ErrorState, Skeleton } from "./common";

type Props = {
  accountId: string;
  data: InsightsResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
};

export function InsightsPanel({ accountId, data, isLoading, error, onRetry }: Props) {
  if (isLoading) {
    return (
      <div aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="insight">
            <Skeleton height={14} width="70%" />
            <div style={{ height: 8 }} />
            <Skeleton height={12} />
            <div style={{ height: 4 }} />
            <Skeleton height={12} width="85%" />
          </div>
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!data || data.insights.length === 0) return <Empty title="Nothing to report" />;

  const facts = new Map(data.facts.map((f) => [f.id, f]));
  return (
    <div>
      {data.insights.map((ins) => (
        <article key={`${data.generationId}-${ins.id}`} className="insight">
          <h3>{ins.title}</h3>
          <p>{ins.body}</p>
          {ins.action && <div className="action">{ins.action}</div>}
          {ins.factIds.length > 0 && (
            <details className="sources">
              <summary>Sources</summary>
              <ul>
                {ins.factIds.map((id) => {
                  const f = facts.get(id);
                  return f ? <li key={id}>{describeFact(f)}</li> : null;
                })}
              </ul>
            </details>
          )}
          {ins.factIds.length > 0 && (
            <Feedback accountId={accountId} generationId={data.generationId} insightId={ins.id} />
          )}
        </article>
      ))}
      <p className="footnote">
        {data.generator.kind === "llm" ? (
          <>
            Written by <strong>{data.generator.model}</strong> from the figures in “Sources”. Every number is
            checked against them before it is shown.
          </>
        ) : (
          <>
            Rules-based summary
            {data.generator.fallbackReason ? ` (${data.generator.fallbackReason})` : ""}. Compared with the
            previous period of the same length.
          </>
        )}{" "}
        Updated {fmtAgo(data.generatedAt)}.
      </p>
    </div>
  );
}

function describeFact(f: Fact): string {
  switch (f.metric) {
    case "conversion_rate":
      return `${f.label}: ${f.display[0]} vs ${f.display[1]} (${f.display[3]} resolved calls)`;
    case "missed_peak_window":
      return `${f.label}: ${f.display[1]} missed vs ${f.display[2]} overall (${f.display[3]} missed calls)`;
    default:
      return `${f.label}: ${f.display[0]} vs ${f.display[1]}`;
  }
}

function Feedback({
  accountId,
  generationId,
  insightId,
}: {
  accountId: string;
  generationId: string;
  insightId: string;
}) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const send = useMutation({
    mutationFn: (r: 1 | -1) => api.feedback(accountId, { generationId, insightId, rating: r }),
    onSuccess: (_, r) => setRating(r),
  });
  return (
    <div className="insight-foot">
      <span className="faint">{rating ? "Thanks for the feedback" : "Useful?"}</span>
      <button
        type="button"
        aria-label="Useful"
        aria-pressed={rating === 1}
        disabled={send.isPending || rating !== null}
        onClick={() => send.mutate(1)}
      >
        👍
      </button>
      <button
        type="button"
        aria-label="Not useful"
        aria-pressed={rating === -1}
        disabled={send.isPending || rating !== null}
        onClick={() => send.mutate(-1)}
      >
        👎
      </button>
    </div>
  );
}

export function InsightsBadge({ data }: { data: InsightsResponse | undefined }) {
  if (!data) return null;
  return data.generator.kind === "llm" ? (
    <span className="badge ai" title={`Prompt ${data.generator.promptVersion}`}>
      ✦ AI
    </span>
  ) : (
    <span className="badge" title={data.generator.fallbackReason ?? undefined}>
      Rules-based
    </span>
  );
}
