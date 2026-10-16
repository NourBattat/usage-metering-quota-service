import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Usage API integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 16, connectionTimeoutMillis: 5_000 });
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
    method: "POST", url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create test account (HTTP ${response.statusCode})`);
  const body = response.json();
  accountIds.push(body.account.id);
  return body;
}

async function createUser(apiKey, name) {
  const response = await app.inject({
    method: "POST", url: "/v1/users", headers: { "x-api-key": apiKey }, payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create test user (HTTP ${response.statusCode})`);
  return response.json();
}

async function createPlan(apiKey, scope, name, allowance, maxPerRequest) {
  const response = await app.inject({
    method: "POST", url: `/v1/plans/${scope}`, headers: { "x-api-key": apiKey },
    payload: { name: `${name} ${crypto.randomUUID()}`, monthly_allowance: allowance, max_units_per_request: maxPerRequest },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create test plan (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignPlan(apiKey, scope, planId, userId) {
  return app.inject({
    method: "PATCH", url: scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey }, payload: { plan_id: planId },
  });
}

async function consume(apiKey, userId, units, requestId) {
  return app.inject({
    method: "POST", url: "/v1/consumptions", headers: { "x-api-key": apiKey },
    payload: { user_id: userId, units, request_id: requestId },
  });
}

async function getUsage(apiKey, userId) {
  const [account, user] = await Promise.all([
    app.inject({ method: "GET", url: "/v1/usage/account", headers: { "x-api-key": apiKey } }),
    app.inject({ method: "GET", url: `/v1/users/${userId}/usage`, headers: { "x-api-key": apiKey } }),
  ]);
  return { account, user };
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 4A Usage Account A");
  const accountB = await provisionAccount("Phase 4A Usage Account B");
  const userA = await createUser(accountA.api_key, "Usage User A");
  const userA2 = await createUser(accountA.api_key, "Usage User A2");
  const userB = await createUser(accountB.api_key, "Usage User B");

  const currentMonthResult = await pool.query(
    "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
  );
  const currentMonth = currentMonthResult.rows[0].month;
  const countsBefore = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM account_monthly_usage WHERE account_id=ANY($1::uuid[]) AND month=$2::date) AS accounts,
      (SELECT count(*)::int FROM user_monthly_usage WHERE account_id=ANY($1::uuid[]) AND month=$2::date) AS users
  `, [accountIds, currentMonth]);
  const rowsBefore = countsBefore.rows[0];

  const emptyReports = await getUsage(accountA.api_key, userA.id);
  assert(emptyReports.account.statusCode === 200 && emptyReports.user.statusCode === 200, "zero-usage account and user reports return HTTP 200");
  for (const [kind, response] of Object.entries(emptyReports)) {
    const body = response.json();
    assert(body.month === currentMonth, `${kind} report returns the current UTC month`);
    assert(body.used_units === "0" && body.remaining_units === body.plan.monthly_allowance, `${kind} missing usage row is reported as zero without a negative balance`);
  }
  const countsAfterReport = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM account_monthly_usage WHERE account_id=ANY($1::uuid[]) AND month=$2::date) AS accounts,
      (SELECT count(*)::int FROM user_monthly_usage WHERE account_id=ANY($1::uuid[]) AND month=$2::date) AS users
  `, [accountIds, currentMonth]);
  assert(countsAfterReport.rows[0].accounts === rowsBefore.accounts && countsAfterReport.rows[0].users === rowsBefore.users, "reporting a missing month creates no usage rows");

  const accepted = await consume(accountA.api_key, userA.id, 12, "phase4a-accepted");
  assert(accepted.statusCode === 200, "accepted consumption succeeds before reports");
  const rejected = await consume(accountA.api_key, userA.id, 101, "phase4a-rejected");
  assert(rejected.statusCode === 429, "rejected consumption does not count toward reports");

  const afterConsumption = await getUsage(accountA.api_key, userA.id);
  assert(afterConsumption.account.json().used_units === "12", "account report reflects accepted consumption");
  assert(afterConsumption.user.json().used_units === "12", "user report reflects accepted consumption");
  const secondUserReport = await app.inject({
    method: "GET", url: `/v1/users/${userA2.id}/usage`, headers: { "x-api-key": accountA.api_key },
  });
  assert(secondUserReport.json().used_units === "0", "another user's usage remains independent");

  const assignmentPlans = await pool.query(`
    SELECT ap.id AS pro_id,up.id AS premium_id
    FROM account_plans ap CROSS JOIN user_plans up
    WHERE ap.name='Pro' AND ap.owner_account_id IS NULL AND ap.is_predefined
      AND up.name='Premium' AND up.owner_account_id IS NULL AND up.is_predefined
  `);
  const pro = assignmentPlans.rows[0].pro_id;
  const premium = assignmentPlans.rows[0].premium_id;
  assert((await assignPlan(accountA.api_key, "account", pro)).statusCode === 200, "account upgrade to Pro succeeds");
  assert((await assignPlan(accountA.api_key, "user", premium, userA.id)).statusCode === 200, "user upgrade to Premium succeeds");
  const afterUpgrade = await getUsage(accountA.api_key, userA.id);
  assert(afterUpgrade.account.json().used_units === "12" && afterUpgrade.user.json().used_units === "12", "upgrades preserve current usage");
  assert(BigInt(afterUpgrade.account.json().remaining_units) > BigInt(afterConsumption.account.json().remaining_units), "Pro upgrade increases account remaining allowance");
  assert(BigInt(afterUpgrade.user.json().remaining_units) > BigInt(afterConsumption.user.json().remaining_units), "Premium upgrade increases user remaining allowance");

  const accountCustom = await createPlan(accountA.api_key, "account", "Phase 4A Custom Account", 50, 10);
  const userCustom = await createPlan(accountA.api_key, "user", "Phase 4A Custom User", 20, 5);
  await assignPlan(accountA.api_key, "account", accountCustom.id);
  await assignPlan(accountA.api_key, "user", userCustom.id, userA.id);
  const afterCustomAssign = await getUsage(accountA.api_key, userA.id);
  assert(afterCustomAssign.account.json().used_units === "12" && afterCustomAssign.user.json().used_units === "12", "custom plan assignment does not reset usage");

  await pool.query(
    "INSERT INTO account_monthly_usage(account_id,month,used_units) VALUES($1,$2::date,123) ON CONFLICT(account_id,month) DO UPDATE SET used_units=EXCLUDED.used_units",
    [accountA.account.id, "2025-08-01"],
  );
  await pool.query(
    "INSERT INTO user_monthly_usage(account_id,user_id,month,used_units) VALUES($1,$2,$3::date,77) ON CONFLICT(account_id,user_id,month) DO UPDATE SET used_units=EXCLUDED.used_units",
    [accountA.account.id, userA.id, "2025-08-01"],
  );
  const historicalBefore = await pool.query(`
    SELECT
      (SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2025-08-01') AS account_used,
      (SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month='2025-08-01') AS user_used
  `, [accountA.account.id, userA.id]);

  const largePlan = await createPlan(accountA.api_key, "user", "Phase 4A Large BigInt", 9_000_000_000_000_000, 1_000_000);
  await assignPlan(accountA.api_key, "user", largePlan.id, userA.id);
  const largeReport = await app.inject({
    method: "GET", url: `/v1/users/${userA.id}/usage`, headers: { "x-api-key": accountA.api_key },
  });
  assert(largeReport.json().plan.monthly_allowance === "9000000000000000", "BIGINT allowance is serialized without JavaScript precision loss");

  const lowAccountPlan = await createPlan(accountA.api_key, "account", "Phase 4A Low Account", 5, 100);
  const lowUserPlan = await createPlan(accountA.api_key, "user", "Phase 4A Low User", 5, 100);
  await assignPlan(accountA.api_key, "account", lowAccountPlan.id);
  await assignPlan(accountA.api_key, "user", lowUserPlan.id, userA.id);
  await assignPlan(accountA.api_key, "user", lowUserPlan.id, userA2.id);
  const downgraded = await getUsage(accountA.api_key, userA.id);
  assert(downgraded.account.json().used_units === "12" && downgraded.account.json().remaining_units === "0", "account downgrade below usage reports zero remaining");
  assert(downgraded.user.json().used_units === "12" && downgraded.user.json().remaining_units === "0", "user downgrade below usage reports zero remaining");
  const lowReportNoRow = await app.inject({ method: "GET", url: `/v1/users/${userA2.id}/usage`, headers: { "x-api-key": accountA.api_key } });
  assert(lowReportNoRow.json().used_units === "0" && lowReportNoRow.json().remaining_units === "5", "missing row under current low plan reports full allowance");

  const missingKey = await app.inject({ method: "GET", url: "/v1/usage/account" });
  assert(missingKey.statusCode === 401, "account usage rejects missing API key");
  const invalidKey = await app.inject({ method: "GET", url: "/v1/usage/account", headers: { "x-api-key": "invalid-key" } });
  assert(invalidKey.statusCode === 401, "account usage rejects invalid API key");
  const foreignUser = await app.inject({ method: "GET", url: `/v1/users/${userB.id}/usage`, headers: { "x-api-key": accountA.api_key } });
  assert(foreignUser.statusCode === 404, "foreign user usage is concealed with HTTP 404");
  const invalidUserId = await app.inject({ method: "GET", url: "/v1/users/not-a-uuid/usage", headers: { "x-api-key": accountA.api_key } });
  assert(invalidUserId.statusCode === 400, "invalid user UUID returns HTTP 400");
  const unsupportedQuery = await app.inject({ method: "GET", url: "/v1/users/" + userA.id + "/usage?account_id=" + accountB.account.id, headers: { "x-api-key": accountA.api_key } });
  assert(unsupportedQuery.statusCode === 400, "unsupported client account query is rejected");
  const accountOverride = await app.inject({ method: "GET", url: `/v1/usage/account?account_id=${accountB.account.id}`, headers: { "x-api-key": accountA.api_key } });
  assert(accountOverride.statusCode === 400, "client cannot override account selection in usage report");

  const historicalAfter = await pool.query(`
    SELECT
      (SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2025-08-01') AS account_used,
      (SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month='2025-08-01') AS user_used
  `, [accountA.account.id, userA.id]);
  assert(
    historicalAfter.rows[0].account_used === historicalBefore.rows[0].account_used
      && historicalAfter.rows[0].user_used === historicalBefore.rows[0].user_used,
    "historical month rows are unchanged by reports and plan changes",
  );
  const countsBeforeRepeat = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM account_monthly_usage WHERE account_id=ANY($1::uuid[])) AS accounts,
      (SELECT count(*)::int FROM user_monthly_usage WHERE account_id=ANY($1::uuid[])) AS users
  `, [accountIds]);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await getUsage(accountA.api_key, userA.id);
  }
  const countsAfterRepeat = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM account_monthly_usage WHERE account_id=ANY($1::uuid[])) AS accounts,
      (SELECT count(*)::int FROM user_monthly_usage WHERE account_id=ANY($1::uuid[])) AS users
  `, [accountIds]);
  assert(
    countsAfterRepeat.rows[0].accounts === countsBeforeRepeat.rows[0].accounts
      && countsAfterRepeat.rows[0].users === countsBeforeRepeat.rows[0].users,
    "repeated reports do not modify counters or create rows",
  );

  console.log(`Usage API integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Usage API integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close usage integration app:", error);
    }
  }
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      assert(remaining.rows[0].count === 0, "usage tests cleaned only their scoped accounts and related data");
    }
  } catch (error) {
    console.error("Could not clean up usage test accounts:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
