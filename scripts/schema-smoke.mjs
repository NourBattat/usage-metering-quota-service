import pg from "pg";

const pool = new pg.Pool({
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const client = await pool.connect();

const accountA = "50000000-0000-4000-8000-000000000001";
const accountB = "50000000-0000-4000-8000-000000000002";
const accountPlanA = "51000000-0000-4000-8000-000000000001";
const accountPlanB = "51000000-0000-4000-8000-000000000002";
const userPlanA = "52000000-0000-4000-8000-000000000001";
const userPlanB = "52000000-0000-4000-8000-000000000002";
const userA = "53000000-0000-4000-8000-000000000001";
const userB = "53000000-0000-4000-8000-000000000002";
const now = new Date();
const utcMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  .toISOString()
  .slice(0, 10);

let assertions = 0;

async function expectConstraintFailure(label, operation, expectedCode) {
  await client.query("SAVEPOINT expected_constraint_failure");
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_constraint_failure");
  await client.query("RELEASE SAVEPOINT expected_constraint_failure");
  if (!caught || (expectedCode && caught.code !== expectedCode)) {
    throw new Error(
      `${label}: expected PostgreSQL error ${expectedCode ?? "constraint violation"}, got ${caught?.code ?? "no error"}`,
    );
  }
  assertions += 1;
  console.log(`PASS ${label} (${caught.code})`);
}

try {
  const ping = await client.query("SELECT 1 AS result");
  if (ping.rows[0]?.result !== 1) throw new Error("SELECT 1 failed");

  await client.query("BEGIN");
  try {
    await client.query(`
      INSERT INTO accounts (id, name, api_key_hash, account_plan_id)
      VALUES
        ($1, 'Schema Test Account A', repeat('a', 64), (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL)),
        ($2, 'Schema Test Account B', repeat('b', 64), (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL))
    `, [accountA, accountB]);

    await client.query(`
      INSERT INTO account_plans
        (id, owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES
        ($1, $3, 'Custom A', 100, 10),
        ($2, $4, 'Custom B', 200, 20)
    `, [accountPlanA, accountPlanB, accountA, accountB]);

    await client.query(`
      INSERT INTO user_plans
        (id, owner_account_id, name, monthly_allowance, max_units_per_request)
      VALUES
        ($1, $3, 'Custom User A', 50, 5),
        ($2, $4, 'Custom User B', 75, 7)
    `, [userPlanA, userPlanB, accountA, accountB]);

    await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [accountPlanA, accountA]);
    await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [accountPlanB, accountB]);
    await client.query(`
      INSERT INTO users (
        id, account_id, name, user_plan_id, user_plan_owner_account_id
      ) VALUES ($1, $3, 'User A', $5, $3), ($2, $4, 'User B', $6, $4)
    `, [userA, userB, accountA, accountB, userPlanA, userPlanB]);

    await client.query(`
      INSERT INTO account_monthly_usage (account_id, month, used_units)
      VALUES ($1, $3::date, 3), ($2, $3::date, 0)
    `, [accountA, accountB, utcMonth]);
    await client.query(`
      INSERT INTO user_monthly_usage (account_id, user_id, month, used_units)
      VALUES ($1, $2, $4::date, 2), ($3, $5, $4::date, 0)
    `, [accountA, userA, accountB, utcMonth, userB]);

    const userCounters = await client.query(
      "SELECT count(*)::int AS count FROM user_monthly_usage WHERE month = $1::date",
      [utcMonth],
    );
    if (userCounters.rows[0]?.count !== 2) throw new Error("User counters are not independent");
    assertions += 1;
    console.log("PASS independent per-user monthly usage counters");

    await client.query(`
      INSERT INTO consumption_requests (
        account_id, request_id, user_id, units, status,
        account_plan_id, account_plan_name, account_monthly_allowance,
        account_max_units_per_request, user_plan_id, user_plan_name,
        user_monthly_allowance, user_max_units_per_request,
        response_status, response_body
      ) VALUES (
        $1, 'schema-smoke-accepted', $2, 2, 'accepted',
        $3, 'Custom A', 100, 10, $4, 'Custom User A', 50, 5,
        200, '{"status":"accepted"}'::jsonb
      )
    `, [accountA, userA, accountPlanA, userPlanA]);

    await client.query(`
      INSERT INTO consumption_requests (
        account_id, request_id, user_id, units, status,
        rejection_reasons, failed_rule_levels,
        account_plan_id, account_plan_name, account_monthly_allowance,
        account_max_units_per_request, user_plan_id, user_plan_name,
        user_monthly_allowance, user_max_units_per_request,
        response_status, response_body
      ) VALUES (
        $1, 'schema-smoke-rejected', $2, 6, 'rejected',
        '[{"code":"user_quota_exceeded"}]'::jsonb, ARRAY['user']::text[],
        $3, 'Custom A', 100, 10, $4, 'Custom User A', 50, 5,
        429, '{"status":"rejected"}'::jsonb
      )
    `, [accountA, userA, accountPlanA, userPlanA]);

    await expectConstraintFailure("rejected request requires rejection details", async () => {
      await client.query(`
        INSERT INTO consumption_requests (
          account_id, request_id, user_id, units, status,
          account_plan_id, account_plan_name, account_monthly_allowance,
          account_max_units_per_request, user_plan_id, user_plan_name,
          user_monthly_allowance, user_max_units_per_request,
          response_status, response_body
        ) VALUES (
          $1, 'schema-smoke-rejected-without-reason', $2, 1, 'rejected',
          $3, 'Custom A', 100, 10, $4, 'Custom User A', 50, 5,
          429, '{"status":"rejected"}'::jsonb
        )
      `, [accountA, userA, accountPlanA, userPlanA]);
    }, "23514");

    const rejectedHistory = await client.query(
      "SELECT status, rejection_reasons, failed_rule_levels, response_status FROM consumption_requests WHERE account_id = $1 AND request_id = 'schema-smoke-rejected'",
      [accountA],
    );
    if (
      rejectedHistory.rows[0]?.status !== "rejected"
      || rejectedHistory.rows[0]?.failed_rule_levels?.[0] !== "user"
      || rejectedHistory.rows[0]?.response_status !== 429
    ) {
      throw new Error("Rejected request details were not persisted");
    }
    assertions += 1;
    console.log("PASS rejected request reasons, failed rule, and response snapshot");

    await expectConstraintFailure("duplicate (account_id, request_id)", async () => {
      await client.query(`
        INSERT INTO consumption_requests (
          account_id, request_id, user_id, units, status,
          account_plan_id, account_plan_name, account_monthly_allowance,
          account_max_units_per_request, user_plan_id, user_plan_name,
          user_monthly_allowance, user_max_units_per_request,
          response_status, response_body
        ) VALUES (
          $1, 'schema-smoke-accepted', $2, 2, 'accepted',
          $3, 'Custom A', 100, 10, $4, 'Custom User A', 50, 5,
          200, '{"status":"accepted"}'::jsonb
        )
      `, [accountA, userA, accountPlanA, userPlanA]);
    }, "23505");

    await expectConstraintFailure("cross-account user assigned to account usage", async () => {
      await client.query(
        "INSERT INTO user_monthly_usage (account_id, user_id, month) VALUES ($1, $2, $3::date)",
        [accountA, userB, utcMonth],
      );
    }, "23503");

    await expectConstraintFailure("account usage references unknown account", async () => {
      await client.query(
        "INSERT INTO account_monthly_usage (account_id, month) VALUES ('54000000-0000-4000-8000-000000000001', $1::date)",
        [utcMonth],
      );
    }, "23503");

    await expectConstraintFailure("cross-account user recorded in request history", async () => {
      await client.query(`
        INSERT INTO consumption_requests (
          account_id, request_id, user_id, units, status,
          account_plan_id, account_plan_name, account_monthly_allowance,
          account_max_units_per_request, user_plan_id, user_plan_name,
          user_monthly_allowance, user_max_units_per_request,
          response_status, response_body
        ) VALUES (
          $1, 'schema-smoke-cross-account-user', $2, 1, 'accepted',
          $3, 'Custom A', 100, 10, $4, 'Custom User A', 50, 5,
          200, '{"status":"accepted"}'::jsonb
        )
      `, [accountA, userB, accountPlanA, userPlanA]);
    }, "23503");

    await expectConstraintFailure("cross-account custom account plan assignment", async () => {
      await client.query("UPDATE accounts SET account_plan_id = $1 WHERE id = $2", [accountPlanB, accountA]);
    }, "23514");

    await expectConstraintFailure("cross-account custom user plan assignment", async () => {
      await client.query("UPDATE users SET user_plan_id = $1 WHERE id = $2", [userPlanB, userA]);
    }, "23514");

    await expectConstraintFailure("negative monthly allowance", async () => {
      await client.query(`
        INSERT INTO user_plans (owner_account_id, name, monthly_allowance, max_units_per_request)
        VALUES ($1, 'Invalid Negative Allowance', -1, 1)
      `, [accountA]);
    }, "23514");

    await expectConstraintFailure("non-month-start usage period", async () => {
      await client.query(
        "INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, '2026-10-02')",
        [accountA],
      );
    }, "23514");

    await expectConstraintFailure("plaintext API key rejected by hash check", async () => {
      await client.query(
        "INSERT INTO accounts (name, api_key_hash, account_plan_id) VALUES ('Invalid Key Account', 'plaintext-secret', (SELECT id FROM account_plans WHERE name = 'Starter' AND owner_account_id IS NULL))",
      );
    }, "23514");

    const history = await client.query(
      "SELECT status, response_body, account_monthly_allowance, user_monthly_allowance FROM consumption_requests WHERE account_id = $1 AND request_id = 'schema-smoke-accepted'",
      [accountA],
    );
    if (history.rows[0]?.status !== "accepted" || history.rows[0]?.response_body?.status !== "accepted") {
      throw new Error("Request response snapshot was not persisted");
    }
    assertions += 1;
    console.log("PASS request history and response/plan snapshots");
  } finally {
    await client.query("ROLLBACK");
  }

  console.log(`Schema integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Schema integration tests failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
