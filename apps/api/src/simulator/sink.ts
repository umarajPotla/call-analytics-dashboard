import type { CallEventInput } from "@calls/shared";

export interface EventSink {
  send(events: CallEventInput[]): Promise<void>;
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
      if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    }
  }
}
