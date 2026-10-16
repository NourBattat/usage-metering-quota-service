import pg from "pg";
import { seedPredefinedPlans } from "../dist/db/seed.js";

const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 5_000 });
const client = await pool.connect();
const accountA = "58000000-0000-4000-8000-000000000001";
const accountB = "58000000-0000-4000-8000-000000000002";
const userA = "59000000-0000-4000-8000-000000000001";
const userB = "59000000-0000-4000-8000-000000000002";
const customAccountPlanA = "5a000000-0000-4000-8000-000000000001";
const customAccountPlanB = "5a000000-0000-4000-8000-000000000002";
const customUserPlanA = "5b000000-0000-4000-8000-000000000001";
const customUserPlanB = "5b000000-0000-4000-8000-000000000002";
let assertions = 0;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
}

async function expectFailure(label, operation, expectedCode) {
  await client.query("SAVEPOINT assignment_failure");
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  await client.query("ROLLBACK TO SAVEPOINT assignment_failure");
  await client.query("RELEASE SAVEPOINT assignment_failure");
  assert(error?.code === expectedCode, `${label} (${error?.code ?? "no error"})`);
}

async function predefinedPlan(table, name) {
  const result = await client.query(
    `SELECT id FROM ${table} WHERE name = $1 AND owner_account_id IS NULL AND is_predefined = true`,
    [name],
  );
  if (result.rows.length !== 1) throw new Error(`Expected one predefined ${table} plan named ${name}`);
  return result.rows[0].id;
}

try {
  await client.query("SELECT 1");
  const baseline = await client.query(`
    SELECT
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM account_plans) AS account_plans,
      (SELECT count(*)::int FROM user_plans) AS user_plans
  `);
  const before = baseline.rows[0];

  await client.query("BEGIN");
  try {
    await seedPredefinedPlans(client);
    await client.query(`
      INSERT INTO accounts (id, name, api_key_hash, account_plan_id)
      VALUES
        ($1, 'Assignment Test Account A', repeat('d', 64), (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL)),
        ($2, 'Assignment Test Account B', repeat('e', 64), (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL))
    `, [accountA, accountB]);
    await client.query(`
      INSERT INTO users (id, account_id, name, user_plan_id)
      VALUES
        ($1, $3, 'Assignment Test User A', (SELECT id FROM user_plans WHERE name = 'Basic' AND owner_account_id IS NULL)),
        ($2, $4, 'Assignment Test User B', (SELECT id FROM user_plans WHERE name = 'Basic' AND owner_account_id IS NULL))
    `, [userA, userB, accountA, accountB]);
    await client.query(`
      INSERT INTO account_plans
        (id, owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES
        ($1, $3, 'Assignment Custom Account A', 100, 10),
        ($2, $4, 'Assignment Custom Account B', 200, 20)
    `, [customAccountPlanA, customAccountPlanB, accountA, accountB]);
    await client.query(`
      INSERT INTO user_plans
        (id, owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES
        ($1, $3, 'Assignment Custom User A', 50, 5),
        ($2, $4, 'Assignment Custom User B', 75, 7)
    `, [customUserPlanA, customUserPlanB, accountA, accountB]);

    const starter = await predefinedPlan("account_plans", "Starter");
    const pro = await predefinedPlan("account_plans", "Pro");
    const basic = await predefinedPlan("user_plans", "Basic");
    const premium = await predefinedPlan("user_plans", "Premium");

    await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [starter, accountA]);
    await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [pro, accountB]);
    await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [basic, userA]);
    await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [premium, userB]);
    assert(true, "Starter and Pro can be assigned to different accounts");
    assert(true, "Basic and Premium can be assigned to different users");

    await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [customAccountPlanA, accountA]);
    await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [customUserPlanA, userA]);
    const validCustom = await client.query(`
      SELECT accounts.account_plan_owner_account_id AS account_owner,
             users.user_plan_owner_account_id AS user_owner
      FROM accounts JOIN users ON users.account_id = accounts.id
      WHERE accounts.id = $1 AND users.id = $2
    `, [accountA, userA]);
    assert(
      validCustom.rows[0]?.account_owner === accountA
        && validCustom.rows[0]?.user_owner === accountA,
      "account-owned custom plans can be assigned within their owning account",
    );

    await expectFailure("cross-account custom account plan is rejected", async () => {
      await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [customAccountPlanB, accountA]);
    }, "23514");
    await expectFailure("cross-account custom user plan is rejected", async () => {
      await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [customUserPlanB, userA]);
    }, "23514");

    await expectFailure("nonexistent account plan is rejected by direct SQL", async () => {
      await client.query(
        "UPDATE accounts SET account_plan_id = '5c000000-0000-4000-8000-000000000001' WHERE id = $1",
        [accountA],
      );
    }, "23503");
    await expectFailure("nonexistent user plan is rejected by direct SQL", async () => {
      await client.query(
        "UPDATE users SET user_plan_id = '5c000000-0000-4000-8000-000000000002' WHERE id = $1",
        [userA],
      );
    }, "23503");

    await expectFailure("user plan ID cannot be assigned as an account plan", async () => {
      await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [basic, accountA]);
    }, "23503");
    await expectFailure("account plan ID cannot be assigned as a user plan", async () => {
      await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [starter, userA]);
    }, "23503");

    await expectFailure("owner ID without account plan ID is rejected", async () => {
      await client.query(
        "UPDATE accounts SET account_plan_id = NULL, account_plan_owner_account_id = $1 WHERE id = $2",
        [accountA, accountA],
      );
    }, "23514");
    await expectFailure("owner ID without user plan ID is rejected", async () => {
      await client.query(
        "UPDATE users SET user_plan_id = NULL, user_plan_owner_account_id = $1 WHERE id = $2",
        [accountA, userA],
      );
    }, "23514");

    await expectFailure("inconsistent predefined account owner is rejected", async () => {
      await client.query(
        "UPDATE accounts SET account_plan_id = $1, account_plan_owner_account_id = $2 WHERE id = $3",
        [starter, accountA, accountA],
      );
    }, "23514");
    await expectFailure("inconsistent predefined user owner is rejected", async () => {
      await client.query(
        "UPDATE users SET user_plan_id = $1, user_plan_owner_account_id = $2 WHERE id = $3",
        [basic, accountA, userA],
      );
    }, "23514");

    await expectFailure("predefined plan ownership cannot be changed after assignment", async () => {
      await client.query(
        "UPDATE account_plans SET owner_account_id = $1, is_predefined = false WHERE id = $2",
        [accountA, starter],
      );
    }, "23514");
    await expectFailure("custom plan ownership cannot be transferred to another account", async () => {
      await client.query(
        "UPDATE user_plans SET owner_account_id = $1 WHERE id = $2",
        [accountB, customUserPlanA],
      );
    }, "23514");

    await expectFailure("account cannot be left without an assigned plan", async () => {
      await client.query(
        "UPDATE accounts SET account_plan_id = NULL, account_plan_owner_account_id = NULL WHERE id = $1",
        [accountA],
      );
    }, "23502");
    await expectFailure("user cannot be left without an assigned plan", async () => {
      await client.query(
        "UPDATE users SET user_plan_id = NULL, user_plan_owner_account_id = NULL WHERE id = $1",
        [userA],
      );
    }, "23502");
  } finally {
    await client.query("ROLLBACK");
  }

  const after = await client.query(`
    SELECT
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM account_plans) AS account_plans,
      (SELECT count(*)::int FROM user_plans) AS user_plans
  `);
  assert(
    JSON.stringify(after.rows[0]) === JSON.stringify(before),
    "assignment integration transaction leaves no test data behind",
  );
  console.log(`Plan assignment regression tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Plan assignment regression tests failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
