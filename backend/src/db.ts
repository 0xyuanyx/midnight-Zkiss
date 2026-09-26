import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
export type Db = Pool | PoolClient;
export type Row = Record<string, any>;
export async function one(
  db: Db,
  sql: string,
  values: unknown[] = [],
): Promise<Row | undefined> {
  return (await db.query(sql, values)).rows[0];
}
export async function transaction<T>(
  pool: Pool,
  action: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool: Pool) {
  await transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':zkiss:migration'))",
    );
    await db.query(
      "CREATE TABLE IF NOT EXISTS migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const [version, filename] of [
      ["001", "001_initial.sql"],
      ["002", "002_publication.sql"],
      ["003", "003_ai_metadata.sql"],
      ["004", "004_stream_secret.sql"],
      ["005", "005_midnight_v2.sql"],
      ["006", "006_admission_nullifier.sql"],
      ["007", "007_browser_relay.sql"],
    ]) {
      if (
        !(await one(db, "SELECT version FROM migrations WHERE version=$1", [
          version,
        ]))
      ) {
        await db.query(
          await readFile(
            new URL("../migrations/" + filename, import.meta.url),
            "utf8",
          ),
        );
        await db.query("INSERT INTO migrations(version) VALUES($1)", [version]);
      }
    }
  });
}
