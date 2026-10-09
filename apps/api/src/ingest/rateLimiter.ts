/**
 * Per-account token bucket for ingest, counted in events (not requests). One account's flood (a misconfigured
 * integration, a retry storm) can't starve the others. A limited request changes nothing, so the sender simply
 * retries after `Retry-After`: events are idempotent, which is what makes rejecting the whole batch safe.
 *
 * In-memory, so the limit applies per API instance; with several instances behind a load balancer the effective
 * limit is the per-instance rate times the instance count (or move the buckets to Redis).
 */
export class AccountRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly burst: number;

  /**
   * @param ratePerSec events per second each account may sustain; 0 disables the limiter
   * @param burst events an idle account may send at once (at least one full 500-event batch)
   */
  constructor(
    private readonly ratePerSec: number,
    burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.burst = Math.max(burst, 500);
  }

  get enabled(): boolean {
    return this.ratePerSec > 0;
  }

  /**
   * Takes `count` tokens from each account's bucket, all or nothing.
   * @returns 0 when allowed; otherwise the whole seconds to wait before retrying (nothing was taken)
   */
  take(counts: ReadonlyMap<string, number>): number {
    if (!this.enabled) return 0;
    const t = this.now();
    let waitSec = 0;
    for (const [account, n] of counts) {
      const bucket = this.refill(account, t);
      if (bucket.tokens < n) waitSec = Math.max(waitSec, (n - bucket.tokens) / this.ratePerSec);
    }
    if (waitSec > 0) return Math.max(1, Math.ceil(waitSec));
    for (const [account, n] of counts) this.buckets.get(account)!.tokens -= n;
    return 0;
  }

  private refill(account: string, t: number) {
    let bucket = this.buckets.get(account);
    if (!bucket) {
      bucket = { tokens: this.burst, at: t };
      this.buckets.set(account, bucket);
    } else {
      bucket.tokens = Math.min(this.burst, bucket.tokens + ((t - bucket.at) / 1000) * this.ratePerSec);
      bucket.at = t;
    }
    return bucket;
  }
}

/** Events per account in one batch. */
export function countByAccount(events: ReadonlyArray<{ call: { accountId: string } }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.call.accountId, (counts.get(e.call.accountId) ?? 0) + 1);
  return counts;
}
