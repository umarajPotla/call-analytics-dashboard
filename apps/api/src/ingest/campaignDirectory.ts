import type { CampaignRef, Source } from "@calls/shared";
import type { Db } from "../db/pool";

export type CampaignInfo = CampaignRef & { accountId: string };

/**
 * In-memory lookup of campaigns (small, rarely changes). Reloads on a miss so new campaigns are picked up, but
 * at most once per 30 s: ingest is unauthenticated in the demo, and unknown ids must not cost a table scan each.
 */
export class CampaignDirectory {
  private byId = new Map<string, CampaignInfo>();
  private lastReload = 0;

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
    if (!this.byId.has(id) && Date.now() - this.lastReload > 30_000) {
      this.lastReload = Date.now();
      await this.load();
    }
    return this.byId.get(id);
  }

  forAccount(accountId: string): CampaignInfo[] {
    return [...this.byId.values()].filter((c) => c.accountId === accountId);
  }
}
