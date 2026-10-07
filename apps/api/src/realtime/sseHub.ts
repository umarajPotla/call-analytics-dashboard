import type { ServerResponse } from "node:http";
import type { FeedUpdate } from "./pgListener";

const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED_WRITES = 500;

type Client = {
  id: number;
  accountId: string;
  res: ServerResponse;
  pending: number;
  campaignIds: Set<string> | null;
};

export interface HubObserver {
  clients(n: number): void;
  dropped(reason: "slow" | "closed" | "shutdown"): void;
}

/**
 * Fans live updates out to browsers over Server-Sent Events, per account. One slow tab must never slow the
 * others: each client has a bounded number of unflushed writes; past that it is disconnected and its
 * EventSource reconnects and resyncs with Last-Event-ID.
 */
export class SseHub {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout;

  constructor(private readonly observer?: HubObserver) {
    this.heartbeat = setInterval(() => this.broadcastRaw(": heartbeat\n\n"), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Takes over the response: SSE headers, then events until the client goes away. */
  attach(accountId: string, res: ServerResponse, campaignIds: string[] | null): number {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // stop proxies (nginx, Render) from buffering the stream
    });
    res.write("retry: 3000\n\n");
    const client: Client = {
      id: this.nextId++,
      accountId,
      res,
      pending: 0,
      campaignIds: campaignIds ? new Set(campaignIds) : null,
    };
    this.clients.set(client.id, client);
    this.observer?.clients(this.clients.size);
    res.on("close", () => this.remove(client.id, "closed"));
    return client.id;
  }

  /** Send to one client only (used for replay right after it connects). */
  sendTo(clientId: number, frame: string): void {
    const c = this.clients.get(clientId);
    if (c) this.write(c, frame);
  }

  publish(update: FeedUpdate): void {
    const frame = formatUpdate(update.seq, update.item);
    for (const c of this.clients.values()) {
      if (c.accountId !== update.accountId) continue;
      if (c.campaignIds && !c.campaignIds.has(update.item.campaign.id)) continue;
      this.write(c, frame);
    }
  }

  /** After the database listener reconnects we may have missed updates: ask every client to refetch. */
  resyncAll(): void {
    this.broadcastRaw("event: reset\ndata: {}\n\n");
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients.values()) {
      c.res.end("retry: 2000\n\n"); // reconnect quickly to a healthy instance after a deploy
      this.remove(c.id, "shutdown");
    }
  }

  private broadcastRaw(frame: string): void {
    for (const c of this.clients.values()) this.write(c, frame);
  }

  private write(c: Client, frame: string): void {
    if (c.pending >= MAX_BUFFERED_WRITES) {
      c.res.destroy();
      this.remove(c.id, "slow");
      return;
    }
    c.pending++;
    c.res.write(frame, () => {
      c.pending--;
    });
  }

  private remove(id: number, reason: "slow" | "closed" | "shutdown"): void {
    if (!this.clients.delete(id)) return;
    this.observer?.dropped(reason);
    this.observer?.clients(this.clients.size);
  }
}

export function formatUpdate(seq: number, item: unknown): string {
  return `id: ${seq}\nevent: call.updated\ndata: ${JSON.stringify(item)}\n\n`;
}
