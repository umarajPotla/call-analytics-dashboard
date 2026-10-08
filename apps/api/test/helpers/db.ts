import { migrate } from "../../src/db/migrate";
import { createPool, type Db } from "../../src/db/pool";
import { seedReferenceData } from "../../src/db/seed";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/calls_test";

/**
 * Fresh schema per test file: drop everything, migrate, seed the demo tenants.
 * Sessions run in an awkward time zone (UTC+13:45) on purpose: if any query depended on the session's zone
 * instead of naming one, the integration tests would catch it.
 */
export async function freshDb(): Promise<Db> {
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set("options", "-c TimeZone=Pacific/Chatham");
  const db = createPool(url.toString(), 8);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  await seedReferenceData(db);
  return db;
}
