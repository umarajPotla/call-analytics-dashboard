import type { FeedItem } from "@calls/shared";
import { useEffect, useState } from "react";
import { fmtAgo, fmtDuration, fmtTime } from "../format";
import type { LiveStatus } from "../useLiveFeed";
import { Empty, ErrorState, Loading, StatusChip } from "./common";

const SOURCE_SHORT: Record<string, string> = {
  google_ads: "Google Ads",
  meta: "Meta",
  tv: "TV",
  organic: "Organic",
  direct_mail: "Direct mail",
  affiliate: "Affiliate",
};

export function LiveBadge({ status }: { status: LiveStatus }) {
  const text = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    polling: "Live (polling)",
  }[status];
  const cls = status === "live" ? "on" : status === "polling" ? "degraded" : "";
  return (
    <span className={`live ${cls}`} role="status" aria-live="polite">
      <span className="dot" />
      {text}
    </span>
  );
}

function useNow(ms = 5_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type Props = {
  items: FeedItem[];
  updatedAt: Map<string, number>;
  tz: string;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  filtered: boolean;
};

export function LiveFeed({ items, updatedAt, tz, isLoading, error, onRetry, filtered }: Props) {
  const now = useNow();
  if (isLoading) return <Loading height={380} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (items.length === 0) {
    return (
      <Empty title={filtered ? "No calls match these filters yet" : "No calls yet"}>
        New calls appear here the moment they start.
      </Empty>
    );
  }
  return (
    <div className="feed-scroll">
      <table className="feed">
        <thead>
          <tr>
            <th>Started</th>
            <th className="hide-sm">Caller</th>
            <th>Campaign</th>
            <th>Status</th>
            <th className="hide-sm">Duration</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.callId} className={updatedAt.has(c.callId) ? "flash" : undefined}>
              <td>
                <div className="num">{fmtTime(c.startedAt, tz, true)}</div>
                <div className="faint">{fmtAgo(c.startedAt, now)}</div>
              </td>
              <td className="hide-sm">
                <div className="num">{c.callerMasked ?? "Unknown"}</div>
                <div className="faint">{c.callerRegion ?? ""}</div>
              </td>
              <td className="wrap">
                <div>{c.campaign.name}</div>
                <div className="faint">{SOURCE_SHORT[c.campaign.source] ?? c.campaign.source}</div>
              </td>
              <td>
                <StatusChip status={c.status} />
              </td>
              <td className="num muted hide-sm">
                {c.status === "connected" && !c.endedAt ? (
                  <span className="faint">On call</span>
                ) : (
                  fmtDuration(c.durationSec)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
