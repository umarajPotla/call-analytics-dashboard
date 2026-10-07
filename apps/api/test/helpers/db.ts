import { migrate } from "../../src/db/migrate";
import { createPool, type Db } from "../../src/db/pool";
import { seedReferenceData } from "../../src/db/seed";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/calls_test";

/** Fresh schema per test file: drop everything, migrate, seed the demo tenants. */
export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DATABASE_URL, 8);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  await seedReferenceData(db);
  return db;
}
