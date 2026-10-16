import { runner } from "node-pg-migrate";
import { Pool } from "pg";

const pool = new Pool({
  max: 1,
  connectionTimeoutMillis: 5_000,
});

let client;

try {
  client = await pool.connect();
  await client.query("SELECT 1");
  const migrations = await runner({
    dbClient: client,
    dir: "migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    migrationsSchema: "public",
    schema: "public",
    singleTransaction: true,
    advisoryLockMode: "wait",
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    },
  });
  if (migrations.length === 0) {
    console.log("Database schema is up to date; no migrations were applied.");
  }
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
