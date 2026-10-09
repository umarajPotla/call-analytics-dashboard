import { describe, expect, it } from "vitest";
import { AccountRateLimiter, countByAccount } from "./rateLimiter";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const batch = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("per-account ingest rate limiter", () => {
  it("allows a burst, then asks the sender to wait until the bucket refills", () => {
    const c = clock();
    const limiter = new AccountRateLimiter(100, 1000, c.now);
    expect(limiter.take(batch({ a: 500 }))).toBe(0);
    expect(limiter.take(batch({ a: 500 }))).toBe(0);
    expect(limiter.take(batch({ a: 250 }))).toBe(3); // 250 events at 100/s
    c.advance(2_500);
    expect(limiter.take(batch({ a: 250 }))).toBe(0);
  });

  it("limits each account on its own: one account's flood doesn't block another", () => {
    const limiter = new AccountRateLimiter(10, 500, clock().now);
    expect(limiter.take(batch({ noisy: 500 }))).toBe(0);
    expect(limiter.take(batch({ noisy: 1 }))).toBeGreaterThan(0);
    expect(limiter.take(batch({ quiet: 500 }))).toBe(0);
  });

  it("is all or nothing across the accounts in a batch", () => {
    const limiter = new AccountRateLimiter(10, 500, clock().now);
    limiter.take(batch({ b: 500 }));
    expect(limiter.take(batch({ a: 100, b: 100 }))).toBeGreaterThan(0);
    // Nothing was taken from a, so a full burst for a still fits.
    expect(limiter.take(batch({ a: 500 }))).toBe(0);
  });

  it("always admits a full 500-event batch from an idle account, whatever the configured burst", () => {
    const limiter = new AccountRateLimiter(1, 10, clock().now);
    expect(limiter.take(batch({ a: 500 }))).toBe(0);
  });

  it("does nothing when the rate is 0", () => {
    const limiter = new AccountRateLimiter(0, 0, clock().now);
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 10; i++) expect(limiter.take(batch({ a: 500 }))).toBe(0);
  });

  it("counts events per account", () => {
    const events = [{ call: { accountId: "a" } }, { call: { accountId: "b" } }, { call: { accountId: "a" } }];
    expect(countByAccount(events)).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
    );
  });
});
