import type { FeedItem } from "@calls/shared";

/** Status only moves forward; the same order the server's state machine enforces. */
const RANK: Record<FeedItem["status"], number> = { ringing: 0, connected: 1, missed: 1, converted: 2 };

/**
 * Applies one live update to the feed. Pure, so the tricky cases are unit-tested:
 *  - the same call arrives twice (replay overlap, reconnects): keep one row, update it IN PLACE
 *  - an older update arrives after a newer one: ignore it (rank and sequence only move forward)
 *  - a call stops matching the outcome filter (connected -> converted while filtering on connected): drop it
 *  - new calls go in by start time, newest first, and the list stays bounded
 */
export function mergeFeed(items: FeedItem[], incoming: FeedItem, outcomes: string[], max = 50): FeedItem[] {
  const idx = items.findIndex((i) => i.callId === incoming.callId);
  const current = idx >= 0 ? items[idx]! : null;
  if (current) {
    const older = RANK[incoming.status] < RANK[current.status];
    const staleSeq = current.seq !== null && incoming.seq !== null && incoming.seq < current.seq;
    if (older || (staleSeq && RANK[incoming.status] === RANK[current.status])) return items;
  }
  const matches = outcomes.length === 0 || outcomes.includes(incoming.status);
  if (!matches) return current ? items.filter((_, i) => i !== idx) : items;
  if (current) {
    const next = items.slice();
    next[idx] = incoming;
    return next;
  }
  const at = items.findIndex((i) => i.startedAt < incoming.startedAt);
  const next = items.slice();
  next.splice(at === -1 ? next.length : at, 0, incoming);
  return next.slice(0, max);
}

export const maxSeq = (items: FeedItem[]) => items.reduce((m, i) => Math.max(m, i.seq ?? 0), 0);
