import type { FeedItem } from "@calls/shared";
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { NOTIFY_CHANNEL } from "../ingest/ingestService";

export type FeedUpdate = { accountId: string; seq: number; item: FeedItem };

/**
 * One dedicated LISTEN connection per API instance (not from the pool: LISTEN needs a session, and pooled
 * transaction-mode connections such as Neon's PgBouncer endpoint don't keep one). Reconnects with backoff.
 */
export class PgListener {
  private client: pg.Client | undefined;
  private stopped = false;
  private attempt = 0;

  constructor(
    private readonly connectionString: string,
    private readonly onUpdate: (u: FeedUpdate) => void,
    private readonly log: FastifyBaseLogger,
    private readonly onReconnect: () => void = () => {},
  ) {}

  private reconnecting = false;

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const { a, s, i } = JSON.parse(msg.payload) as { a: string; s: number; i: FeedItem };
        this.onUpdate({ accountId: a, seq: s, item: i });
      } catch (err) {
        this.log.warn({ err }, "listener: bad payload");
      }
    });
    client.on("error", (err) => {
      this.log.warn({ err }, "listener: connection error");
      void this.reconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    } catch (err) {
      await client.end().catch(() => {}); // don't leak a half-open connection
      throw err;
    }
    this.client = client;
    this.attempt = 0;
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) return; // one reconnect loop at a time, however many errors fire
    this.reconnecting = true;
    await this.client?.end().catch(() => {});
    this.client = undefined;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    setTimeout(() => {
      this.start()
        .then(() => {
          this.reconnecting = false;
          this.onReconnect(); // clients may have missed updates: tell them to resync
        })
        .catch(() => {
          this.reconnecting = false;
          void this.reconnect();
        });
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => {});
  }
}
