import { CATALOG } from "../catalog";
import type { Db } from "./pool";

/** Idempotent: inserts the demo tenants and campaigns if they are missing. */
export async function seedReferenceData(db: Db): Promise<void> {
  for (const a of CATALOG) {
    await db.query(
      "INSERT INTO accounts (id, name, timezone) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone",
      [a.id, a.name, a.timezone],
    );
    for (const c of a.campaigns) {
      await db.query(
        "INSERT INTO campaigns (id, account_id, name, source) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
        [c.id, a.id, c.name, c.source],
      );
    }
  }
}
