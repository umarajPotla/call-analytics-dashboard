import type { Account } from "@calls/shared";
import type { Db } from "../db/pool";
import { notFound } from "./errors";

/**
 * Tenant guard. Authentication is stubbed for the demo (every request acts as a demo user who may see the demo
 * accounts), but scoping is real: every read is filtered by the account id resolved here, and an unknown or
 * foreign account is a 404. In production this checks the caller's token claims.
 */
export class AccountDirectory {
  private accounts = new Map<string, Account>();

  constructor(private readonly db: Db) {}

  async load(): Promise<void> {
    const { rows } = await this.db.query<Account>("SELECT id, name, timezone FROM accounts ORDER BY name");
    this.accounts = new Map(rows.map((a) => [a.id, a]));
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  require(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw notFound("Account");
    return a;
  }
}
