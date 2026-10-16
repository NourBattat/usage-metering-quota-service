import { Pool } from "pg";
import { seedPredefinedPlans } from "../dist/db/seed.js";

const pool = new Pool({
  max: 1,
  connectionTimeoutMillis: 5_000,
});

let client;
let transactionStarted = false;

try {
  client = await pool.connect();
  await client.query("BEGIN");
  transactionStarted = true;

  const result = await seedPredefinedPlans(client);
  await client.query("COMMIT");
  transactionStarted = false;

  console.log(
    `Predefined plan seed completed: ${result.inserted} inserted, ${result.unchanged} already matched.`,
  );
} catch (error) {
  if (transactionStarted) {
    await client.query("ROLLBACK");
  }
  console.error("Predefined plan seed failed:", error);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
