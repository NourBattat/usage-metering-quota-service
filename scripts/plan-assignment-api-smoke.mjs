import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Plan assignment integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 12, connectionTimeoutMillis: 5_000 });
const app = buildApp({ database: pool, provisioningToken, logger: false });
const accountIds = [];
let appClosed = false;
let assertions = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Could not create assignment-test account (HTTP ${response.statusCode})`);
  }
  const value = response.json();
  accountIds.push(value.account.id);
  return value;
}

async function createUser(apiKey, name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": apiKey },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create test user (HTTP ${response.statusCode})`);
  return response.json();
}

async function createPlan(apiKey, scope, name) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/plans/${scope}`,
    headers: { "x-api-key": apiKey },
    payload: { name, monthly_allowance: 4321, max_units_per_request: 42 },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create test ${scope} plan (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignAccount(apiKey, planId) {
  return app.inject({
    method: "PATCH",
    url: "/v1/accounts/me/plan",
    headers: { "x-api-key": apiKey },
    payload: planId === undefined ? {} : { plan_id: planId },
  });
}

async function assignUser(apiKey, userId, planId) {
  return app.inject({
    method: "PATCH",
    url: `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey },
    payload: planId === undefined ? {} : { plan_id: planId },
  });
}

async function expectSqlFailure(label, operation, code) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SAVEPOINT expected_assignment_failure");
    let error;
    try {
      await operation(client);
    } catch (caught) {
      error = caught;
    }
    await client.query("ROLLBACK TO SAVEPOINT expected_assignment_failure");
    await client.query("RELEASE SAVEPOINT expected_assignment_failure");
    assert(error?.code === code, `${label} (${error?.code ?? "no error"})`);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 2C.2 Assignment Account A");
  const accountB = await provisionAccount("Phase 2C.2 Assignment Account B");
  const userA = await createUser(accountA.api_key, "Ahmad Assignment Test");
  const userB = await createUser(accountB.api_key, "Foreign Assignment User");

  const accountPlans = await pool.query(
    "SELECT id,name FROM account_plans WHERE owner_account_id IS NULL AND is_predefined=true AND name IN ('Starter','Pro')",
  );
  const userPlans = await pool.query(
    "SELECT id,name FROM user_plans WHERE owner_account_id IS NULL AND is_predefined=true AND name IN ('Basic','Premium')",
  );
  const starter = accountPlans.rows.find((row) => row.name === "Starter");
  const pro = accountPlans.rows.find((row) => row.name === "Pro");
  const basic = userPlans.rows.find((row) => row.name === "Basic");
  const premium = userPlans.rows.find((row) => row.name === "Premium");
  assert(Boolean(starter && pro && basic && premium), "predefined assignment plans exist");

  const customAccountA = await createPlan(accountA.api_key, "account", "Assignment Account Custom A");
  const customAccountB = await createPlan(accountB.api_key, "account", "Assignment Account Custom B");
  const customUserA = await createPlan(accountA.api_key, "user", "Assignment User Custom A");
  const customUserB = await createPlan(accountB.api_key, "user", "Assignment User Custom B");

  const missingKey = await app.inject({ method: "PATCH", url: "/v1/accounts/me/plan", payload: { plan_id: pro.id } });
  assert(missingKey.statusCode === 401, "account plan assignment rejects a missing API key");
  const invalidKey = await app.inject({
    method: "PATCH", url: "/v1/accounts/me/plan",
    headers: { "x-api-key": "invalid-api-key" }, payload: { plan_id: pro.id },
  });
  assert(invalidKey.statusCode === 401, "account plan assignment rejects an invalid API key");
  const missingPlanId = await assignAccount(accountA.api_key);
  assert(missingPlanId.statusCode === 400, "missing account plan ID is rejected");
  const accountExtraField = await app.inject({
    method: "PATCH", url: "/v1/accounts/me/plan", headers: { "x-api-key": accountA.api_key },
    payload: { plan_id: pro.id, owner_account_id: accountB.account.id },
  });
  assert(accountExtraField.statusCode === 400, "account assignment rejects client-controlled ownership fields");
  const invalidPlanId = await assignAccount(accountA.api_key, "not-a-uuid");
  assert(invalidPlanId.statusCode === 400, "invalid account plan ID format is rejected");

  for (const [plan, name] of [[pro, "Pro"], [starter, "Starter"], [pro, "Pro again"]]) {
    const response = await assignAccount(accountA.api_key, plan.id);
    assert(response.statusCode === 200 && response.json().plan.name === plan.name, `account plan changes to ${name}`);
  }
  const accountBStarter = await assignAccount(accountB.api_key, starter.id);
  assert(accountBStarter.statusCode === 200, "second account can be assigned Starter independently");

  const foreignCustomAccount = await assignAccount(accountA.api_key, customAccountB.id);
  assert(foreignCustomAccount.statusCode === 404, "cross-account custom account plan is rejected");
  const nonexistentAccountPlan = await assignAccount(accountA.api_key, "71000000-0000-4000-8000-000000000001");
  assert(nonexistentAccountPlan.statusCode === 404, "nonexistent account plan is rejected");
  const wrongScopeAccount = await assignAccount(accountA.api_key, basic.id);
  assert(wrongScopeAccount.statusCode === 404, "user plan cannot be assigned as an account plan");

  const missingUserKey = await app.inject({ method: "PATCH", url: `/v1/users/${userA.id}/plan`, payload: { plan_id: premium.id } });
  assert(missingUserKey.statusCode === 401, "user plan assignment rejects a missing API key");
  const invalidUserKey = await app.inject({
    method: "PATCH", url: `/v1/users/${userA.id}/plan`,
    headers: { "x-api-key": "invalid-api-key" }, payload: { plan_id: premium.id },
  });
  assert(invalidUserKey.statusCode === 401, "user plan assignment rejects an invalid API key");
  const missingUserPlanId = await assignUser(accountA.api_key, userA.id);
  assert(missingUserPlanId.statusCode === 400, "missing user plan ID is rejected");
  const foreignUser = await assignUser(accountA.api_key, userB.id, premium.id);
  assert(foreignUser.statusCode === 404, "foreign user ID is rejected without disclosure");
  const unknownUser = await assignUser(accountA.api_key, "72000000-0000-4000-8000-000000000001", premium.id);
  assert(unknownUser.statusCode === 404, "nonexistent user ID returns 404");
  const userExtraField = await app.inject({
    method: "PATCH", url: `/v1/users/${userA.id}/plan`, headers: { "x-api-key": accountA.api_key },
    payload: { plan_id: premium.id, account_id: accountB.account.id },
  });
  assert(userExtraField.statusCode === 400, "user assignment rejects client-controlled account ownership");

  for (const [plan, name] of [[premium, "Premium"], [basic, "Basic"], [premium, "Premium again"]]) {
    const response = await assignUser(accountA.api_key, userA.id, plan.id);
    assert(response.statusCode === 200 && response.json().plan.name === plan.name, `user plan changes to ${name}`);
  }
  const foreignCustomUser = await assignUser(accountA.api_key, userA.id, customUserB.id);
  assert(foreignCustomUser.statusCode === 404, "cross-account custom user plan is rejected");
  const nonexistentUserPlan = await assignUser(accountA.api_key, userA.id, "73000000-0000-4000-8000-000000000001");
  assert(nonexistentUserPlan.statusCode === 404, "nonexistent user plan is rejected");
  const wrongScopeUser = await assignUser(accountA.api_key, userA.id, starter.id);
  assert(wrongScopeUser.statusCode === 404, "account plan cannot be assigned as a user plan");
  assert((await assignUser(accountA.api_key, userA.id, customUserA.id)).statusCode === 200, "owned custom user plan can be assigned");
  assert((await assignAccount(accountA.api_key, customAccountA.id)).statusCode === 200, "owned custom account plan can be assigned");

  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  await pool.query(
    "INSERT INTO account_monthly_usage(account_id,month,used_units) VALUES($1,$2::date,777) ON CONFLICT(account_id,month) DO UPDATE SET used_units=EXCLUDED.used_units",
    [accountA.account.id, month],
  );
  await pool.query(
    "INSERT INTO user_monthly_usage(account_id,user_id,month,used_units) VALUES($1,$2,$3::date,333) ON CONFLICT(account_id,user_id,month) DO UPDATE SET used_units=EXCLUDED.used_units",
    [accountA.account.id, userA.id, month],
  );
  const accountBefore = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date", [accountA.account.id, month]);
  const userBefore = await pool.query("SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date", [accountA.account.id, userA.id, month]);
  assert(accountBefore.rows[0]?.used_units === "777" && userBefore.rows[0]?.used_units === "333", "test usage counters were set before reassignment");

  const assignToPro = await assignAccount(accountA.api_key, pro.id);
  const assignToPremium = await assignUser(accountA.api_key, userA.id, premium.id);
  assert(assignToPro.statusCode === 200 && assignToPremium.statusCode === 200, "account and user plan reassignment commits");
  const accountAfter = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date", [accountA.account.id, month]);
  const userAfter = await pool.query("SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date", [accountA.account.id, userA.id, month]);
  assert(accountAfter.rows[0]?.used_units === "777" && userAfter.rows[0]?.used_units === "333", "plan changes do not reset monthly usage");

  const accountMe = await app.inject({ method: "GET", url: "/v1/accounts/me", headers: { "x-api-key": accountA.api_key } });
  const userMe = await app.inject({ method: "GET", url: `/v1/users/${userA.id}`, headers: { "x-api-key": accountA.api_key } });
  assert(accountMe.statusCode === 200 && accountMe.json().plan.name === "Pro", "account lookup reflects newly assigned Pro plan");
  assert(userMe.statusCode === 200 && userMe.json().plan.name === "Premium", "user lookup reflects newly assigned Premium plan");

  const planTypeConstraint = await expectSqlFailure("database rejects wrong-scope account assignment", (client) =>
    client.query("UPDATE accounts SET account_plan_id=$1 WHERE id=$2", [basic.id, accountA.account.id]), "23503");
  void planTypeConstraint;
  await expectSqlFailure("database rejects cross-account custom user assignment", (client) =>
    client.query("UPDATE users SET user_plan_id=$1 WHERE id=$2", [customUserB.id, userA.id]), "23514");
  await expectSqlFailure("database rejects null account plan assignment", (client) =>
    client.query("UPDATE accounts SET account_plan_id=NULL WHERE id=$1", [accountA.account.id]), "23502");
  await expectSqlFailure("database rejects null user plan assignment", (client) =>
    client.query("UPDATE users SET user_plan_id=NULL WHERE id=$1", [userA.id]), "23502");

  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountA.account.id]);
    lockHeld = true;
    let assignmentFinished = false;
    const pendingAssignment = assignAccount(accountA.api_key, starter.id).finally(() => {
      assignmentFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!assignmentFinished, "plan change waits while another transaction holds the account row lock");
    await lockClient.query("COMMIT");
    lockHeld = false;
    const serializedResult = await pendingAssignment;
    assert(serializedResult.statusCode === 200, "waiting plan change completes after the account lock is released");
  } finally {
    if (lockHeld) await lockClient.query("ROLLBACK");
    lockClient.release();
  }

  const accountsPlanNull = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[]) AND account_plan_id IS NULL", [accountIds]);
  const usersPlanNull = await pool.query("SELECT count(*)::int AS count FROM users WHERE account_id=ANY($1::uuid[]) AND user_plan_id IS NULL", [accountIds]);
  assert(accountsPlanNull.rows[0]?.count === 0 && usersPlanNull.rows[0]?.count === 0, "all test accounts and users retain valid assigned plans");
  console.log(`Plan assignment integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Plan assignment integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close plan assignment app:", error);
    }
  }
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      assert(remaining.rows[0]?.count === 0, "assignment integration cleanup removed only its test accounts");
    }
  } catch (error) {
    console.error("Could not clean up plan assignment test accounts:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
