import pg from "pg";

const pool = new pg.Pool({
  max: 1,
  connectionTimeoutMillis: 5_000,
});

try {
  const result = await pool.query("SELECT 1 AS result");

  if (result.rows[0]?.result !== 1) {
    throw new Error("Database smoke test returned an unexpected result");
  }

  console.log("Database smoke test passed: SELECT 1 returned 1");
} catch (error) {
  console.error("Database smoke test failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
