import type { CampaignRef, Source } from "@calls/shared";
import type { Db } from "../db/pool";

export type CampaignInfo = CampaignRef & { accountId: string };

/** In-memory lookup of campaigns (small, rarely changes). Reloads on a miss so new campaigns are picked up. */
export class CampaignDirectory {
  private byId = new Map<string, CampaignInfo>();

  constructor(private readonly db: Db) {}

  async load(): Promise<void> {
    const { rows } = await this.db.query<{ id: string; account_id: string; name: string; source: Source }>(
      "SELECT id, account_id, name, source FROM campaigns",
    );
    this.byId = new Map(
      rows.map((r) => [r.id, { id: r.id, accountId: r.account_id, name: r.name, source: r.source }]),
    );
  }

  async get(id: string): Promise<CampaignInfo | undefined> {
    if (!this.byId.has(id)) await this.load();
    return this.byId.get(id);
  }

  /** Synchronous lookup for hot paths after load(). */
  peek(id: string): CampaignInfo | undefined {
    return this.byId.get(id);
  }

  forAccount(accountId: string): CampaignInfo[] {
    return [...this.byId.values()].filter((c) => c.accountId === accountId);
  }
}
