import type { CallEventInput } from "@calls/shared";

export interface EventSink {
  send(events: CallEventInput[]): Promise<void>;
}

/** A send that stopped part-way: the first `sent` events were accepted; retry the rest after `retryAfterMs`. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly sent: number,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** Posts events to the public ingest endpoint, exactly as a telephony integration would. */
export class HttpSink implements EventSink {
  constructor(private readonly baseUrl: string) {}

  async send(events: CallEventInput[]): Promise<void> {
    for (let i = 0; i < events.length; i += 200) {
      const res = await fetch(`${this.baseUrl}/api/v1/call-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: events.slice(i, i + 200) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // A well-behaved client: honour Retry-After (429, 503), otherwise back off a few seconds.
        const retryAfterSec = Number(res.headers.get("retry-after"));
        throw new SendError(
          `ingest responded ${res.status}`,
          i,
          Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 5_000,
        );
      }
    }
  }
}
