import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Consumption integration tests require PROVISIONING_TOKEN of at least 32 characters.");
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
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Test setup could not create account (HTTP ${response.statusCode})`);
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
  if (response.statusCode !== 201) throw new Error(`Test setup could not create user (HTTP ${response.statusCode})`);
  return response.json();
}

async function createCustomPlan(apiKey, scope, name, monthlyAllowance, maxPerRequest) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/plans/${scope}`,
    headers: { "x-api-key": apiKey },
    payload: {
      name,
      monthly_allowance: monthlyAllowance,
      max_units_per_request: maxPerRequest,
    },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create ${scope} test plan (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignPlan(apiKey, scope, planId, userId) {
  return app.inject({
    method: "PATCH",
    url: scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey },
    payload: { plan_id: planId },
  });
}

async function consume(apiKey, { userId, units, requestId, ...extra } = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/consumptions",
    headers: apiKey ? { "x-api-key": apiKey } : {},
    payload: { user_id: userId, units, request_id: requestId, ...extra },
  });
}

async function getCounts(accountId, userId, month) {
  const account = await pool.query(
    "SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date",
    [accountId, month],
  );
  const user = await pool.query(
    "SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date",
    [accountId, userId, month],
  );
  return {
    account: account.rows[0]?.used_units ?? "0",
    user: user.rows[0]?.used_units ?? "0",
  };
}

async function setUsage(accountId, userId, month, accountUnits, userUnits) {
  await pool.query(
    `INSERT INTO account_monthly_usage(account_id,month,used_units)
     VALUES($1,$2::date,$3) ON CONFLICT(account_id,month)
     DO UPDATE SET used_units=EXCLUDED.used_units,updated_at=clock_timestamp()`,
    [accountId, month, accountUnits],
  );
  await pool.query(
    `INSERT INTO user_monthly_usage(account_id,user_id,month,used_units)
     VALUES($1,$2,$3::date,$4) ON CONFLICT(account_id,user_id,month)
     DO UPDATE SET used_units=EXCLUDED.used_units,updated_at=clock_timestamp()`,
    [accountId, userId, month, userUnits],
  );
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 3A Consumption Account A");
  const accountB = await provisionAccount("Phase 3A Consumption Account B");
  const userA = await createUser(accountA.api_key, "Consumption User A");
  const userB = await createUser(accountB.api_key, "Consumption User B");
  const processingMonth = await pool.query(
    "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
  );
  const month = processingMonth.rows[0].month;
  const priorUsage = await getCounts(accountA.account.id, userA.id, month);
  assert(priorUsage.account === "0" && priorUsage.user === "0", "new accounts/users begin with no current-month usage rows");

  const accepted = await consume(accountA.api_key, {
    userId: userA.id,
    units: 12,
    requestId: "phase3a-accepted-001",
  });
  const acceptedRaw = accepted.body;
  assert(accepted.statusCode === 200 && accepted.json().status === "accepted", "valid consumption is accepted");
  assert(accepted.json().usage_month === month, "consumption response includes the UTC processing month");
  const acceptedCounts = await getCounts(accountA.account.id, userA.id, month);
  assert(acceptedCounts.account === "12" && acceptedCounts.user === "12", "accepted request increments both usage counters equally");

  const historyAccepted = await pool.query(
    "SELECT status,response_status,response_body,account_plan_name,user_plan_name FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
    [accountA.account.id, "phase3a-accepted-001"],
  );
  assert(historyAccepted.rows.length === 1 && historyAccepted.rows[0].status === "accepted", "accepted decision is stored exactly once");
  assert(historyAccepted.rows[0].response_status === 200 && historyAccepted.rows[0].response_body.status === "accepted", "accepted HTTP response is persisted for replay");
  assert(historyAccepted.rows[0].account_plan_name === "Starter" && historyAccepted.rows[0].user_plan_name === "Basic", "accepted request stores applied plan snapshots");

  const replayBeforeChange = historyAccepted.rows[0].response_body;
  const replay = await consume(accountA.api_key, {
    userId: userA.id,
    units: 12,
    requestId: "phase3a-accepted-001",
  });
  const replayRaw = replay.body;
  assert(replay.statusCode === 200 && replay.headers["idempotency-replayed"] === "true", "exact retry replays HTTP 200 with replay header");
  assert(replayRaw === acceptedRaw, "exact retry returns the original HTTP body byte-for-byte");
  assert(JSON.stringify(replay.json()) === JSON.stringify(replayBeforeChange), "exact retry preserves the original JSON response");
  assert((await getCounts(accountA.account.id, userA.id, month)).account === "12", "exact retry does not increment usage again");

  const secondUser = await createUser(accountA.api_key, "Consumption User A Second");
  const planAfterReplay = await pool.query(
    "SELECT id FROM account_plans WHERE name='Pro' AND owner_account_id IS NULL AND is_predefined=true",
  );
  await assignPlan(accountA.api_key, "account", planAfterReplay.rows[0].id);
  const changedMonth = await pool.query("SELECT date_trunc('month', (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 month')::date::text AS month");
  const replayAfterPlanChange = await consume(accountA.api_key, {
    userId: userA.id,
    units: 12,
    requestId: "phase3a-accepted-001",
  });
  assert(replayAfterPlanChange.headers["idempotency-replayed"] === "true", "retry remains a replay after a plan change");
  assert(JSON.stringify(replayAfterPlanChange.json()) === JSON.stringify(replayBeforeChange), "replay keeps its original decision and snapshots after a plan change");
  assert(replayAfterPlanChange.json().usage_month === month, "replay keeps its original UTC month after the plan change");

  const conflict = await consume(accountA.api_key, {
    userId: userA.id,
    units: 13,
    requestId: "phase3a-accepted-001",
  });
  assert(conflict.statusCode === 409, "same request ID with different parameters returns HTTP 409");
  const conflictUser = await consume(accountA.api_key, {
    userId: secondUser.id,
    units: 12,
    requestId: "phase3a-accepted-001",
  });
  assert(conflictUser.statusCode === 409, "same request ID with a different user returns HTTP 409");
  const replayHistoryCount = await pool.query(
    "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
    [accountA.account.id, "phase3a-accepted-001"],
  );
  assert(replayHistoryCount.rows[0]?.count === 1, "exact and conflicting retries create no duplicate history rows");
  assert((await getCounts(accountA.account.id, userA.id, month)).account === "12", "conflicting retry does not change usage");

  const accountPerRequestPlan = await createCustomPlan(accountA.api_key, "account", "Phase 3A Account Request Cap", 100, 5);
  const userHighPlan = await createCustomPlan(accountA.api_key, "user", "Phase 3A User Request High", 100, 10);
  await assignPlan(accountA.api_key, "account", accountPerRequestPlan.id);
  await assignPlan(accountA.api_key, "user", userHighPlan.id, userA.id);
  await setUsage(accountA.account.id, userA.id, month, 0, 0);
  const accountPerRequestReject = await consume(accountA.api_key, { userId: userA.id, units: 6, requestId: "phase3a-account-max" });
  assert(accountPerRequestReject.statusCode === 429, "account per-request maximum rejects an oversized request");
  assert(accountPerRequestReject.json().failed_rules.some((rule) => rule.level === "account" && rule.rule === "max_units_per_request"), "account max failure is identified at account level");
  assert((await getCounts(accountA.account.id, userA.id, month)).account === "0", "account per-request rejection increments neither counter");

  const accountHighPlan = await createCustomPlan(accountA.api_key, "account", "Phase 3A Account Request High", 100, 10);
  const userPerRequestPlan = await createCustomPlan(accountA.api_key, "user", "Phase 3A User Request Cap", 100, 5);
  await assignPlan(accountA.api_key, "account", accountHighPlan.id);
  await assignPlan(accountA.api_key, "user", userPerRequestPlan.id, userA.id);
  const userPerRequestReject = await consume(accountA.api_key, { userId: userA.id, units: 6, requestId: "phase3a-user-max" });
  assert(userPerRequestReject.statusCode === 429, "user per-request maximum rejects an oversized request");
  assert(userPerRequestReject.json().failed_rules.some((rule) => rule.level === "user" && rule.rule === "max_units_per_request"), "user max failure is identified at user level");

  const accountMonthlyPlan = await createCustomPlan(accountA.api_key, "account", "Phase 3A Account Monthly Cap", 10, 100);
  const userMonthlyHigh = await createCustomPlan(accountA.api_key, "user", "Phase 3A User Monthly High", 100, 100);
  await assignPlan(accountA.api_key, "account", accountMonthlyPlan.id);
  await assignPlan(accountA.api_key, "user", userMonthlyHigh.id, userA.id);
  await setUsage(accountA.account.id, userA.id, month, 8, 0);
  const accountMonthlyReject = await consume(accountA.api_key, { userId: userA.id, units: 3, requestId: "phase3a-account-month" });
  assert(accountMonthlyReject.statusCode === 429, "account monthly allowance rejects a request exceeding the remaining balance");
  assert(accountMonthlyReject.json().failed_rules.some((rule) => rule.level === "account" && rule.rule === "monthly_allowance"), "account monthly failure is identified at account level");
  assert((await getCounts(accountA.account.id, userA.id, month)).account === "8", "account monthly rejection preserves both counters");

  const accountMonthlyHigh = await createCustomPlan(accountA.api_key, "account", "Phase 3A Account Monthly High", 100, 100);
  const userMonthlyPlan = await createCustomPlan(accountA.api_key, "user", "Phase 3A User Monthly Cap", 2, 100);
  await assignPlan(accountA.api_key, "account", accountMonthlyHigh.id);
  await assignPlan(accountA.api_key, "user", userMonthlyPlan.id, userA.id);
  await setUsage(accountA.account.id, userA.id, month, 0, 0);
  const userMonthlyReject = await consume(accountA.api_key, { userId: userA.id, units: 3, requestId: "phase3a-user-month" });
  assert(userMonthlyReject.statusCode === 429, "user monthly allowance rejects a request exceeding the remaining balance");
  assert(userMonthlyReject.json().failed_rules.some((rule) => rule.level === "user" && rule.rule === "monthly_allowance"), "user monthly failure is identified at user level");

  const accountBothPlan = await createCustomPlan(accountA.api_key, "account", "Phase 3A Account Both Cap", 10, 100);
  const userBothPlan = await createCustomPlan(accountA.api_key, "user", "Phase 3A User Both Cap", 5, 100);
  await assignPlan(accountA.api_key, "account", accountBothPlan.id);
  await assignPlan(accountA.api_key, "user", userBothPlan.id, userA.id);
  await setUsage(accountA.account.id, userA.id, month, 9, 4);
  const bothReject = await consume(accountA.api_key, { userId: userA.id, units: 2, requestId: "phase3a-both-month" });
  assert(bothReject.statusCode === 429 && bothReject.json().failed_rules.length === 2, "simultaneous account and user monthly failures are both reported");
  assert((await getCounts(accountA.account.id, userA.id, month)).account === "9", "simultaneous rejection leaves usage unchanged");
  const rejectedHistory = await pool.query(
    "SELECT status,response_status,failed_rule_levels,response_body FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
    [accountA.account.id, "phase3a-both-month"],
  );
  assert(rejectedHistory.rows.length === 1 && rejectedHistory.rows[0].status === "rejected" && rejectedHistory.rows[0].response_status === 429, "rejected decision and HTTP response are stored");
  assert(rejectedHistory.rows[0].failed_rule_levels.includes("account") && rejectedHistory.rows[0].failed_rule_levels.includes("user"), "rejected history stores both failed rule levels");

  const missingKey = await app.inject({ method: "POST", url: "/v1/consumptions", payload: { user_id: userA.id, units: 1, request_id: "missing-key" } });
  assert(missingKey.statusCode === 401, "consumption rejects missing API key");
  const invalidKey = await app.inject({ method: "POST", url: "/v1/consumptions", headers: { "x-api-key": "invalid-api-key" }, payload: { user_id: userA.id, units: 1, request_id: "invalid-key" } });
  assert(invalidKey.statusCode === 401, "consumption rejects invalid API key");
  const foreignUser = await consume(accountA.api_key, { userId: userB.id, units: 1, requestId: "foreign-user" });
  assert(foreignUser.statusCode === 404, "cross-account user is rejected without disclosure");
  const unknownUser = await consume(accountA.api_key, { userId: "74000000-0000-4000-8000-000000000001", units: 1, requestId: "unknown-user" });
  assert(unknownUser.statusCode === 404, "unknown user is rejected");

  const invalidInputs = [
    [{ user_id: userA.id, units: 0, request_id: "zero" }, "zero units"],
    [{ user_id: userA.id, units: -1, request_id: "negative" }, "negative units"],
    [{ user_id: userA.id, units: 1.5, request_id: "decimal" }, "decimal units"],
    [{ user_id: userA.id, units: "1", request_id: "string" }, "string units"],
    [{ user_id: userA.id, units: 1_000_001, request_id: "too-many" }, "units beyond supported limit"],
    [{ user_id: userA.id, units: 1, request_id: "   " }, "blank request ID"],
    [{ user_id: "not-a-uuid", units: 1, request_id: "bad-user" }, "invalid user UUID"],
    [{ user_id: userA.id, units: 1, request_id: "extra", account_id: accountB.account.id }, "client account ownership"],
  ];
  for (const [payload, label] of invalidInputs) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/consumptions",
      headers: { "x-api-key": accountA.api_key },
      payload,
    });
    assert(response.statusCode === 400, `${label} is rejected`);
  }

  const concurrencyAccount = await provisionAccount("Phase 3A Concurrent Consumption Account");
  const concurrencyUser = await createUser(concurrencyAccount.api_key, "Concurrent User");
  const concurrentAccountPlan = await createCustomPlan(concurrencyAccount.api_key, "account", "Phase 3A Concurrent Account Limit", 10, 100);
  const concurrentUserPlan = await createCustomPlan(concurrencyAccount.api_key, "user", "Phase 3A Concurrent User Limit", 10, 100);
  await assignPlan(concurrencyAccount.api_key, "account", concurrentAccountPlan.id);
  await assignPlan(concurrencyAccount.api_key, "user", concurrentUserPlan.id, concurrencyUser.id);
  const concurrent = await Promise.all([
    consume(concurrencyAccount.api_key, { userId: concurrencyUser.id, units: 7, requestId: "phase3a-concurrent-a" }),
    consume(concurrencyAccount.api_key, { userId: concurrencyUser.id, units: 7, requestId: "phase3a-concurrent-b" }),
  ]);
  assert(concurrent.filter((response) => response.statusCode === 200).length === 1, "concurrent requests allow only one request within the shared quota");
  assert(concurrent.filter((response) => response.statusCode === 429).length === 1, "concurrent excess request is rejected");
  const concurrentCounts = await getCounts(concurrencyAccount.account.id, concurrencyUser.id, month);
  assert(concurrentCounts.account === "7" && concurrentCounts.user === "7", "concurrent requests cannot overspend either counter");

  console.log(`Consumption integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Consumption integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close consumption integration app:", error);
    }
  }
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
      assert(remaining.rows[0]?.count === 0, "consumption integration cleanup removed only its scoped accounts");
    }
  } catch (error) {
    console.error("Could not clean up consumption test accounts:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
