import type { CallEventInput } from "@calls/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AccountProfile } from "../catalog";
import type { Db } from "../db/pool";
import { bulkLoadHistory } from "./backfill";
import { generateMinute, LATE_CONVERSION_MAX_MS, type SimCall, type SimEvent } from "./model";
import type { EventSink } from "./sink";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type SimulatorOptions = {
  seed: number;
  backfillDays: number;
  multiplier: number;
  duplicateRate: number;
  reorderRate: number;
};

type Pending = { at: number; event: CallEventInput };

/**
 * Drives realistic traffic:
 *  - cold start: bulk-load history (see backfill.ts), then schedule every event still in the future
 *  - resume after the host slept: bulk-load the missed minutes and replay late events through the API
 *  - live: each minute generate new calls; every second send due events through the ingest API
 * Chaos knobs deliberately duplicate and reorder some events to exercise idempotency in the demo.
 */
export class SimulatorRunner {
  private queue: Pending[] = [];
  private lastMinute = new Map<string, number>();
  private spikes = new Map<string, { until: number; multiplier: number }>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private rnd = Math.random;

  constructor(
    private readonly db: Db,
    private readonly sink: EventSink,
    private readonly accounts: AccountProfile[],
    private readonly opts: SimulatorOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    const now = Date.now();
    const current = Math.floor(now / MINUTE) * MINUTE;
    for (const account of this.accounts) {
      const saved = await this.db.query<{ last_generated_minute: Date }>(
        "SELECT last_generated_minute FROM simulator_state WHERE account_id = $1",
        [account.id],
      );
      const last = saved.rows[0]?.last_generated_minute.getTime();
      const windowStart = current - this.opts.backfillDays * DAY;

      if (last === undefined || last < windowStart) {
        const n = await bulkLoadHistory(
          this.db,
          account,
          windowStart,
          current,
          now,
          this.opts.seed,
          this.opts.multiplier,
        );
        this.log.info({ account: account.name, calls: n }, "simulator: history loaded");
      } else if (last + MINUTE < current) {
        const n = await bulkLoadHistory(
          this.db,
          account,
          last + MINUTE,
          current,
          now,
          this.opts.seed,
          this.opts.multiplier,
        );
        // Calls generated before we slept may have events (late conversions) that fell into the gap.
        const replay = this.eventsBetween(
          account,
          last - LATE_CONVERSION_MAX_MS,
          last + MINUTE,
          last + MINUTE,
          now,
        );
        this.enqueue(replay.map((e) => ({ at: now, event: e })));
        this.log.info(
          { account: account.name, calls: n, replayed: replay.length },
          "simulator: caught up after sleep",
        );
      }

      // Schedule everything still in the future for calls that already started.
      for (let m = current - LATE_CONVERSION_MAX_MS - MINUTE; m < current; m += MINUTE) {
        for (const call of generateMinute(account, m, this.opts.seed, this.opts.multiplier)) {
          this.enqueue(
            call.events.filter((e) => e.at > now).map((e) => ({ at: e.at, event: toInput(call, e) })),
          );
        }
      }
      this.lastMinute.set(account.id, current - MINUTE);
      await this.saveState(account.id, current - MINUTE);
    }
    this.timer = setInterval(() => void this.tick(), 1000);
    this.log.info({ scheduled: this.queue.length }, "simulator: live");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Demo control: multiply an account's traffic for a few minutes so the charts visibly move. */
  spike(accountId: string, multiplier = 6, minutes = 10): void {
    this.spikes.set(accountId, { until: Date.now() + minutes * MINUTE, multiplier });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const current = Math.floor(now / MINUTE) * MINUTE;
      for (const account of this.accounts) {
        let last = this.lastMinute.get(account.id) ?? current - MINUTE;
        while (last < current) {
          last += MINUTE;
          for (const call of this.callsFor(account, last, now)) {
            this.enqueue(call.events.map((e) => ({ at: e.at, event: toInput(call, e) })));
          }
        }
        if (last !== this.lastMinute.get(account.id)) {
          this.lastMinute.set(account.id, last);
          await this.saveState(account.id, last);
        }
      }
      await this.flushDue(now);
    } catch (err) {
      this.log.warn({ err }, "simulator: tick failed, will retry");
    } finally {
      this.ticking = false;
    }
  }

  private callsFor(account: AccountProfile, minute: number, now: number): SimCall[] {
    const calls = generateMinute(account, minute, this.opts.seed, this.opts.multiplier);
    const spike = this.spikes.get(account.id);
    if (spike && spike.until > now) {
      // Extra calls on top of the baseline; salted so their ids never collide with regular traffic.
      calls.push(
        ...generateMinute(
          account,
          minute,
          this.opts.seed,
          this.opts.multiplier * (spike.multiplier - 1),
          "spike",
        ),
      );
    }
    return calls;
  }

  private async flushDue(now: number): Promise<void> {
    const due: CallEventInput[] = [];
    const later: Pending[] = [];
    for (const p of this.queue) {
      if (p.at > now) later.push(p);
      else if (this.rnd() < this.opts.reorderRate)
        later.push({ at: now + 5_000 + this.rnd() * 25_000, event: p.event });
      else {
        due.push(p.event);
        if (this.rnd() < this.opts.duplicateRate) due.push(p.event);
      }
    }
    if (due.length === 0) return;
    this.queue = later;
    try {
      await this.sink.send(due);
    } catch (err) {
      // Events are idempotent, so retrying the whole batch later is safe.
      this.enqueue(due.map((event) => ({ at: now + 5_000, event })));
      throw err;
    }
  }

  private eventsBetween(
    account: AccountProfile,
    fromMinute: number,
    toMinute: number,
    afterMs: number,
    untilMs: number,
  ) {
    const out: CallEventInput[] = [];
    for (let m = fromMinute - (fromMinute % MINUTE); m < toMinute; m += MINUTE) {
      for (const call of generateMinute(account, m, this.opts.seed, this.opts.multiplier)) {
        for (const e of call.events) if (e.at >= afterMs && e.at <= untilMs) out.push(toInput(call, e));
      }
    }
    return out;
  }

  private enqueue(items: Pending[]): void {
    this.queue.push(...items);
  }

  private async saveState(accountId: string, minute: number): Promise<void> {
    await this.db.query(
      `INSERT INTO simulator_state (account_id, last_generated_minute) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET last_generated_minute = EXCLUDED.last_generated_minute`,
      [accountId, new Date(minute)],
    );
  }
}

function toInput(call: SimCall, e: SimEvent): CallEventInput {
  return {
    eventId: e.eventId,
    type: e.type,
    occurredAt: new Date(e.at).toISOString(),
    call: {
      id: call.id,
      accountId: call.accountId,
      campaignId: call.campaignId,
      startedAt: new Date(call.startedAt).toISOString(),
      callerNumber: call.callerNumber,
      callerRegion: call.callerRegion,
    },
    ...(e.durationSec === undefined ? {} : { data: { durationSec: e.durationSec } }),
  };
}
