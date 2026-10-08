import pg from "pg";

// Return bigint/numeric aggregates (count, sum) as JS numbers. Our counts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/**
 * No session settings on purpose: every query names its time zone explicitly (date_trunc(..., 'UTC'),
 * `AT TIME ZONE tz`), so results never depend on the server's zone, and the pool works unchanged behind
 * transaction-mode poolers such as Neon's PgBouncer, which reject startup `options` and don't keep SETs.
 */
export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

/** Run fn inside a transaction; commits on success, rolls back and rethrows on error. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
