import { Pool } from "pg";

// pg reads PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD from the environment.
export const pool = new Pool({
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

export async function checkDatabaseConnection(): Promise<void> {
  await pool.query("SELECT 1");
}
