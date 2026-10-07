import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Filters } from "./api";
import { ConversionChart } from "./components/ConversionChart";
import { ErrorState, Loading, Panel, Segmented, STATUS } from "./components/common";
import { FilterBar } from "./components/FilterBar";
import { InsightsBadge, InsightsPanel } from "./components/InsightsPanel";
import { KpiTiles } from "./components/KpiTiles";
import { LiveBadge, LiveFeed } from "./components/LiveFeed";
import { Legend, VolumeChart } from "./components/VolumeChart";
import { fmtShortDate, localDate, tzShort } from "./format";
import { useLiveFeed } from "./useLiveFeed";
import { resolveDates, useViewState } from "./viewState";

const METRICS = ["summary", "volume", "conversion"];

/** Runs `fn` at most once per `ms`, trailing call included, so a burst of live events causes one refetch. */
function useThrottle(fn: () => void, ms: number) {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      fn();
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        last.current = Date.now();
        fn();
      }, wait);
    }
  }, [fn, ms]);
}

export function App() {
  const [view, setView] = useViewState();
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Number.POSITIVE_INFINITY });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const account = accounts.data?.find((a) => a.id === view.accountId) ?? accounts.data?.[0];

  useEffect(() => {
    if (account && account.id !== view.accountId) setView({ accountId: account.id });
  }, [account, view.accountId, setView]);

  if (accounts.error) return <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />;
  if (!account) {
    return (
      <main>
        <div className="span-12">
          <Loading height={420} />
        </div>
      </main>
    );
  }

  const tz = account.timezone;
  const dates = resolveDates(view, tz);
  const filters: Filters = {
    accountId: account.id,
    from: dates.from,
    to: dates.to,
    campaignIds: view.campaignIds,
    outcomes: view.outcomes,
  };
  return (
    <Dashboard
      key={account.id}
      filters={filters}
      days={dates.days}
      today={localDate(tz)}
      tz={tz}
      view={view}
      setView={setView}
      accounts={accounts.data ?? []}
      devTools={meta.data?.devTools ?? false}
      grafanaUrl={meta.data?.grafanaUrl ?? null}
      invalidateMetrics={() =>
        qc.invalidateQueries({ predicate: (q) => METRICS.includes(String(q.queryKey[0])) })
      }
      resetAll={() => qc.invalidateQueries()}
    />
  );
}

type DashboardProps = {
  filters: Filters;
  days: number;
  today: string;
  tz: string;
  view: ReturnType<typeof useViewState>[0];
  setView: ReturnType<typeof useViewState>[1];
  accounts: Array<{ id: string; name: string; timezone: string }>;
  devTools: boolean;
  grafanaUrl: string | null;
  invalidateMetrics: () => void;
  resetAll: () => void;
};

function Dashboard({
  filters,
  days,
  today,
  tz,
  view,
  setView,
  accounts,
  devTools,
  grafanaUrl,
  invalidateMetrics,
  resetAll,
}: DashboardProps) {
  const granularity = days > 31 ? "day" : view.granularity;
  const key = [
    filters.accountId,
    filters.from,
    filters.to,
    filters.campaignIds.join(","),
    filters.outcomes.join(","),
  ];
  const common = { placeholderData: keepPreviousData, staleTime: 5_000, refetchInterval: 60_000 } as const;

  const campaigns = useQuery({
    queryKey: ["campaigns", filters.accountId],
    queryFn: () => api.campaigns(filters.accountId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const summary = useQuery({ queryKey: ["summary", ...key], queryFn: () => api.summary(filters), ...common });
  const volume = useQuery({
    queryKey: ["volume", ...key, granularity],
    queryFn: () => api.volume(filters, granularity),
    ...common,
  });
  const conversion = useQuery({
    queryKey: ["conversion", ...key.slice(0, 4), view.groupBy],
    queryFn: () => api.conversion(filters, view.groupBy),
    ...common,
  });
  // Insights are cached server-side for 15 minutes and never refetched per live event.
  const insights = useQuery({
    queryKey: ["insights", filters.accountId, filters.from, filters.to],
    queryFn: () => api.insights(filters),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });

  const onChange = useThrottle(invalidateMetrics, 5_000);
  const live = useLiveFeed({
    accountId: filters.accountId,
    campaignIds: filters.campaignIds,
    outcomes: filters.outcomes,
    onChange,
    onReset: resetAll,
  });

  const [notice, setNotice] = useState<string | null>(null);
  const spike = useMutation({
    mutationFn: () => api.spike(filters.accountId),
    onSuccess: () => setNotice("Traffic spike started: 6× calls for the next 10 minutes."),
    onError: (e) => setNotice(`Couldn’t start a spike: ${(e as Error).message}`),
  });
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [notice]);

  const isPartial = filters.to === today;
  const filteredOutcomes = filters.outcomes
    .map((o) => STATUS[o as keyof typeof STATUS]?.label ?? o)
    .join(", ");

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <span>Call Analytics</span>
        </div>
        <select
          className="account-select"
          aria-label="Account"
          value={filters.accountId}
          onChange={(e) => setView({ accountId: e.target.value, campaignIds: [] })}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="tz" title={`All times and days are in the account's time zone: ${tz}`}>
          Times in {tzShort(tz)} · {tz.replace("_", " ")}
        </span>
        <span className="spacer" />
        <nav className="toplinks">
          {devTools && (
            <button
              type="button"
              className="btn"
              onClick={() => spike.mutate()}
              disabled={spike.isPending}
              title="Demo control: multiply this account's traffic for 10 minutes"
            >
              ⚡ <span className="hide-sm">Simulate </span>spike
            </button>
          )}
          <a href="/api/docs" target="_blank" rel="noreferrer" className="hide-sm">
            API
          </a>
          {grafanaUrl && (
            <a href={grafanaUrl} target="_blank" rel="noreferrer" className="hide-sm">
              Grafana
            </a>
          )}
        </nav>
      </header>

      <FilterBar
        view={view}
        dates={filters}
        today={today}
        campaigns={campaigns.data ?? []}
        onChange={(patch) => setView(patch)}
      />

      {notice && (
        <div role="status" className="panel" style={{ margin: "12px 24px 0", padding: "10px 14px" }}>
          {notice}
        </div>
      )}

      <main>
        {summary.error ? (
          <div className="span-12 panel">
            <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
          </div>
        ) : (
          <KpiTiles data={summary.data} isPartial={isPartial} />
        )}

        <Panel
          className="span-8"
          title="Call volume"
          sub={`${fmtShortDate(filters.from)} – ${fmtShortDate(filters.to)}`}
          actions={
            <>
              <Legend outcomes={filters.outcomes} />
              <Segmented
                label="Granularity"
                value={granularity}
                onChange={(g) => setView({ granularity: g })}
                options={[
                  {
                    value: "hour",
                    label: "Hourly",
                    disabled: days > 31,
                    title: days > 31 ? "Up to 31 days" : undefined,
                  },
                  { value: "day", label: "Daily" },
                ]}
              />
            </>
          }
        >
          {volume.error ? (
            <ErrorState error={volume.error} onRetry={() => volume.refetch()} />
          ) : volume.data ? (
            <VolumeChart data={volume.data} outcomes={filters.outcomes} />
          ) : (
            <Loading height={300} />
          )}
          {filteredOutcomes && <p className="footnote">Showing only: {filteredOutcomes}.</p>}
        </Panel>

        <Panel
          className="span-4"
          title="What changed"
          sub="vs previous period"
          actions={<InsightsBadge data={insights.data} />}
        >
          <InsightsPanel
            accountId={filters.accountId}
            data={insights.data}
            isLoading={insights.isLoading}
            error={insights.error}
            onRetry={() => insights.refetch()}
          />
        </Panel>

        <Panel
          className="span-5"
          title="Conversion rate"
          sub="by campaign source"
          actions={
            <Segmented
              label="Group by"
              value={view.groupBy}
              onChange={(groupBy) => setView({ groupBy })}
              options={[
                { value: "source", label: "Source" },
                { value: "campaign", label: "Campaign" },
              ]}
            />
          }
        >
          {conversion.error ? (
            <ErrorState error={conversion.error} onRetry={() => conversion.refetch()} />
          ) : conversion.data ? (
            <ConversionChart data={conversion.data} />
          ) : (
            <Loading height={240} />
          )}
          <p className="footnote">
            Converted ÷ resolved calls (connected + missed + converted).
            {conversion.data && conversion.data.maturity.mayStillUpdateFrom <= filters.to && (
              <>
                {" "}
                Calls since {fmtShortDate(conversion.data.maturity.mayStillUpdateFrom)} may still convert (up
                to 72 h).
              </>
            )}
            {filters.outcomes.length > 0 && <> The outcome filter doesn’t apply to rates.</>}
          </p>
        </Panel>

        <Panel
          className="span-7"
          title="Live calls"
          sub="newest first"
          actions={<LiveBadge status={live.status} />}
        >
          <LiveFeed
            items={live.items}
            updatedAt={live.updatedAt}
            tz={tz}
            isLoading={live.isLoading}
            error={live.error}
            onRetry={() => live.refetch()}
            filtered={filters.campaignIds.length > 0 || filters.outcomes.length > 0}
          />
        </Panel>
      </main>
    </>
  );
}
