import type { FeedItem } from "@calls/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, streamUrl } from "./api";
import { mergeFeed } from "./feed";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "polling";

type Args = {
  accountId: string;
  campaignIds: string[];
  outcomes: string[];
  onChange: () => void;
  onReset: () => void;
};

/**
 * The live feed: an initial page from the REST API, then Server-Sent Events. The browser's EventSource
 * reconnects by itself and sends Last-Event-ID, so the server replays what we missed. If the stream stays down
 * (a proxy that blocks SSE, say), we fall back to polling the same changes endpoint every 5 s.
 */
export function useLiveFeed({ accountId, campaignIds, outcomes, onChange, onReset }: Args) {
  const filterKey = `${campaignIds.join(",")}|${outcomes.join(",")}`;
  const initial = useQuery({
    queryKey: ["recent", accountId, filterKey],
    queryFn: () => api.recentCalls({ accountId, campaignIds, outcomes }),
    staleTime: Number.POSITIVE_INFINITY, // the stream keeps it fresh
  });
  const [items, setItems] = useState<FeedItem[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const callbacks = useRef({ onChange, onReset });
  callbacks.current = { onChange, onReset };

  useEffect(() => {
    if (initial.data) setItems(initial.data.items);
  }, [initial.data]);

  // Highest event sequence this client has seen. Replays and polling resume from here.
  const cursor = useRef(0);
  useEffect(() => {
    if (initial.data) cursor.current = Math.max(cursor.current, initial.data.asOfSeq ?? 0);
  }, [initial.data]);

  const apply = (incoming: FeedItem[]) => {
    if (incoming.length === 0) return;
    // Every update is merged (a call that ends keeps its status but gains a duration); mergeFeed drops stale ones.
    // Only new calls and status changes flash and trigger a chart refetch.
    const known = new Map(itemsRef.current.map((i) => [i.callId, i.status]));
    const changed = incoming.filter((i) => known.get(i.callId) !== i.status);
    setItems((prev) => incoming.reduce((list, i) => mergeFeed(list, i, outcomes), prev));
    if (changed.length === 0) return;
    setUpdatedAt((prev) => {
      const next = new Map(prev);
      const t = Date.now();
      for (const i of changed) next.set(i.callId, t);
      for (const [k, v] of next) if (t - v > 3_000) next.delete(k);
      return next;
    });
    callbacks.current.onChange();
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect only when the account or filters change
  useEffect(() => {
    setStatus("connecting");
    const es = new EventSource(streamUrl({ accountId, campaignIds }));
    let downSince: number | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };
    const wanted = (i: FeedItem) => campaignIds.length === 0 || campaignIds.includes(i.campaign.id);
    /** Fetch changes after the cursor and advance it, even when none of them match our filters. */
    const catchUp = async () => {
      const res = await api.changes(accountId, cursor.current);
      cursor.current = res.truncated
        ? Math.max(cursor.current, ...res.items.map((i) => i.seq ?? 0))
        : res.latestSeq;
      applyRef.current(res.items.filter(wanted));
    };

    es.onopen = () => {
      downSince = null;
      stopPolling();
      setStatus("live");
      // Close the gap between the initial page and the moment the stream opened.
      catchUp().catch(() => {});
    };
    es.onerror = () => {
      downSince ??= Date.now();
      setStatus(poll ? "polling" : "reconnecting");
    };
    es.addEventListener("call.updated", (e) => {
      const msg = e as MessageEvent;
      const seq = Number(msg.lastEventId);
      if (Number.isFinite(seq)) cursor.current = Math.max(cursor.current, seq);
      applyRef.current([JSON.parse(msg.data) as FeedItem]);
    });
    es.addEventListener("reset", () => callbacks.current.onReset());

    const watchdog = setInterval(() => {
      if (downSince === null || poll || Date.now() - downSince < 10_000) return;
      setStatus("polling");
      poll = setInterval(() => {
        catchUp().catch(() => {
          /* keep trying; the status badge already says we're degraded */
        });
      }, 5_000);
    }, 2_000);

    return () => {
      es.close();
      clearInterval(watchdog);
      stopPolling();
    };
  }, [accountId, filterKey]);

  return {
    items,
    updatedAt,
    status,
    isLoading: initial.isLoading,
    error: initial.error,
    refetch: initial.refetch,
  };
}
