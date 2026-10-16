import pg from "pg";
import { seedPredefinedPlans } from "../dist/db/seed.js";

const pool = new pg.Pool({
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const client = await pool.connect();
const testAccountId = "55000000-0000-4000-8000-000000000001";
const testPlanId = "56000000-0000-4000-8000-000000000001";
const tableNames = [
  "accounts",
  "users",
  "account_plans",
  "user_plans",
  "account_monthly_usage",
  "user_monthly_usage",
  "consumption_requests",
];
let assertions = 0;

async function counts() {
  const results = {};
  for (const table of tableNames) {
    const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    results[table] = result.rows[0].count;
  }
  return results;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

try {
  await client.query("SELECT 1");
  const baselineCounts = await counts();

  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO accounts (id, name, api_key_hash) VALUES ($1, 'Seed Smoke Account', repeat('c', 64))",
      [testAccountId],
    );
    await client.query(`
      INSERT INTO account_plans
        (id, owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES ($1, $2, 'Seed Smoke Custom', 777, 7)
    `, [testPlanId, testAccountId]);
    await client.query(`
      INSERT INTO user_plans
        (owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES ($1, 'Seed Smoke Custom', 888, 8)
    `, [testAccountId]);

    const existingAccountPredefined = await client.query(
      "SELECT count(*)::int AS count FROM account_plans WHERE owner_account_id IS NULL AND name IN ('Starter', 'Pro')",
    );
    const existingUserPredefined = await client.query(
      "SELECT count(*)::int AS count FROM user_plans WHERE owner_account_id IS NULL AND name IN ('Basic', 'Premium')",
    );

    const firstSeed = await seedPredefinedPlans(client);
    const expectedFirstInserts = 4
      - existingAccountPredefined.rows[0].count
      - existingUserPredefined.rows[0].count;
    assert(
      firstSeed.inserted === expectedFirstInserts,
      "first seed inserts only missing predefined plans",
    );
    assert(
      firstSeed.unchanged === 4 - expectedFirstInserts,
      "first seed reports matching predefined plans without changing them",
    );

    const expected = [
      ["account_plans", "Starter", "10000", "100"],
      ["account_plans", "Pro", "100000", "1000"],
      ["user_plans", "Basic", "1000", "20"],
      ["user_plans", "Premium", "5000", "100"],
    ];

    for (const [table, name, allowance, requestLimit] of expected) {
      const result = await client.query(
        `SELECT name, monthly_allowance, max_units_per_request, owner_account_id, is_predefined FROM ${table} WHERE name = $1 AND owner_account_id IS NULL`,
        [name],
      );
      const rows = result.rows;
      assert(rows.length === 1, `${table}.${name} exists exactly once`);
      assert(
        rows[0].monthly_allowance === allowance
          && rows[0].max_units_per_request === requestLimit,
        `${table}.${name} has documented default values`,
      );
      assert(
        rows[0].owner_account_id === null && rows[0].is_predefined === true,
        `${table}.${name} is predefined and has no owner account`,
      );
    }

    const accountNames = await client.query(
      "SELECT name FROM account_plans WHERE owner_account_id IS NULL ORDER BY name",
    );
    const userNames = await client.query(
      "SELECT name FROM user_plans WHERE owner_account_id IS NULL ORDER BY name",
    );
    assert(
      accountNames.rows.map((row) => row.name).join(",") === "Pro,Starter",
      "account plans are stored in their separate table",
    );
    assert(
      userNames.rows.map((row) => row.name).join(",") === "Basic,Premium",
      "user plans are stored in their separate table",
    );

    await client.query(
      "UPDATE accounts SET account_plan_id = (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL) WHERE id = $1",
      [testAccountId],
    );
    const assignableUserId = "57000000-0000-4000-8000-000000000001";
    await client.query(
      "INSERT INTO users (id, account_id, name, user_plan_id) VALUES ($1, $2, 'Seed Smoke User', (SELECT id FROM user_plans WHERE name = 'Basic' AND owner_account_id IS NULL))",
      [assignableUserId, testAccountId],
    );
    const assignments = await client.query(`
      SELECT accounts.account_plan_owner_account_id, user_plan_owner_account_id
      FROM accounts
      JOIN users ON users.account_id = accounts.id
      WHERE accounts.id = $1 AND users.id = $2
    `, [testAccountId, assignableUserId]);
    assert(
      assignments.rows.length === 1
        && assignments.rows[0].account_plan_owner_account_id === null
        && assignments.rows[0].user_plan_owner_account_id === null,
      "predefined account and user plans can be assigned across accounts",
    );

    const customBefore = await client.query(
      "SELECT owner_account_id, monthly_allowance, max_units_per_request, is_predefined FROM account_plans WHERE id = $1",
      [testPlanId],
    );
    const customUserBefore = await client.query(
      "SELECT owner_account_id, monthly_allowance, max_units_per_request, is_predefined FROM user_plans WHERE owner_account_id = $1 AND name = 'Seed Smoke Custom'",
      [testAccountId],
    );

    const secondSeed = await seedPredefinedPlans(client);
    assert(secondSeed.inserted === 0, "repeated seed inserts no duplicates");
    assert(secondSeed.unchanged === 4, "repeated seed preserves all matching definitions");

    const customAfter = await client.query(
      "SELECT owner_account_id, monthly_allowance, max_units_per_request, is_predefined FROM account_plans WHERE id = $1",
      [testPlanId],
    );
    const customUserAfter = await client.query(
      "SELECT owner_account_id, monthly_allowance, max_units_per_request, is_predefined FROM user_plans WHERE owner_account_id = $1 AND name = 'Seed Smoke Custom'",
      [testAccountId],
    );
    assert(
      JSON.stringify(customAfter.rows) === JSON.stringify(customBefore.rows),
      "custom account-owned plan remains unchanged",
    );
    assert(
      JSON.stringify(customUserAfter.rows) === JSON.stringify(customUserBefore.rows),
      "custom user-owned plan remains unchanged",
    );

    await client.query("SAVEPOINT predefined_drift_check");
    await client.query(
      "UPDATE account_plans SET monthly_allowance = 12345 WHERE owner_account_id IS NULL AND name = 'Starter'",
    );
    await client.query("SAVEPOINT seed_drift_attempt");
    let driftRejected = false;
    try {
      await seedPredefinedPlans(client);
    } catch (error) {
      driftRejected = String(error).includes('Starter')
        && String(error).includes("no existing definition was changed");
    }
      await client.query("ROLLBACK TO SAVEPOINT seed_drift_attempt");
      await client.query("RELEASE SAVEPOINT seed_drift_attempt");
    assert(driftRejected, "mismatched predefined values fail loudly instead of being overwritten");
    const driftedValue = await client.query(
      "SELECT monthly_allowance FROM account_plans WHERE owner_account_id IS NULL AND name = 'Starter'",
    );
    assert(
      driftedValue.rows[0]?.monthly_allowance === "12345",
      "seed leaves a conflicting existing definition untouched",
    );
    await client.query("ROLLBACK TO SAVEPOINT predefined_drift_check");
    await client.query("RELEASE SAVEPOINT predefined_drift_check");

    const duringCounts = await counts();
    assert(
      duringCounts.accounts === baselineCounts.accounts + 1
        && duringCounts.account_plans === baselineCounts.account_plans + 1
          + (2 - existingAccountPredefined.rows[0].count)
        && duringCounts.user_plans === baselineCounts.user_plans + 1
          + (2 - existingUserPredefined.rows[0].count)
        && duringCounts.users === baselineCounts.users + 1
        && duringCounts.account_monthly_usage === baselineCounts.account_monthly_usage
        && duringCounts.user_monthly_usage === baselineCounts.user_monthly_usage
        && duringCounts.consumption_requests === baselineCounts.consumption_requests,
      "existing application rows are preserved while seed adds only predefined and temporary custom plans",
    );
  } finally {
    await client.query("ROLLBACK");
  }

  const afterRollback = await counts();
  assert(
    JSON.stringify(afterRollback) === JSON.stringify(baselineCounts),
    "test transaction rollback leaves no seed or custom test rows behind",
  );
  console.log(`Seed integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Seed integration tests failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
