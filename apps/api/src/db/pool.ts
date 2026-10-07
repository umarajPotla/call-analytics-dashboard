import pg from "pg";

// Return bigint/numeric aggregates (count, sum) as JS numbers. Our counts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  // Every session runs in UTC so date_trunc/bucketing never depends on the server's zone.
  return new pg.Pool({ connectionString, max, options: "-c TimeZone=UTC" });
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
