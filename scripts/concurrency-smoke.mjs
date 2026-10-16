import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Concurrency integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({
  max: 32,
  connectionTimeoutMillis: 5_000,
  application_name: "phase3b-concurrency-tests",
});
const app = buildApp({ database: pool, provisioningToken, logger: false });
const ownedAccountIds = [];
const results = [];
let appClosed = false;
let assertions = 0;
let rollbackTriggerInstalled = false;
let rollbackTriggerAccountId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

function withTimeout(promise, label, milliseconds = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

const pollInterval = () => new Promise((resolve) => setTimeout(resolve, 20));

async function waitForAccountLockWaiters(expectedCount, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'phase3b-concurrency-tests'
        AND wait_event_type = 'Lock'
        AND query = 'SELECT id FROM accounts WHERE id = $1 FOR UPDATE'
    `);
    if (result.rows[0].count >= expectedCount) return;
    await pollInterval();
  }
  throw new Error(`Timed out waiting for ${description}; expected ${expectedCount} blocked account lock request(s)`);
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Could not provision test account (HTTP ${response.statusCode})`);
  const account = response.json();
  ownedAccountIds.push(account.account.id);
  return account;
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

async function createPlan(apiKey, scope, name, allowance, requestMaximum) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/plans/${scope}`,
    headers: { "x-api-key": apiKey },
    payload: {
      name: `${name} ${randomUUID()}`,
      monthly_allowance: allowance,
      max_units_per_request: requestMaximum,
    },
  });
  if (response.statusCode !== 201) throw new Error(`Could not create custom ${scope} test plan (HTTP ${response.statusCode})`);
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

async function makeFixture(label, { accountAllowance = 10_000, accountRequestMax = 1_000, userAllowance = 10_000, userRequestMax = 1_000, users = 1 } = {}) {
  const account = await provisionAccount(`Phase 3B ${label}`);
  const createdUsers = [];
  for (let index = 1; index <= users; index += 1) {
    createdUsers.push(await createUser(account.api_key, `${label} User ${index}`));
  }
  const accountPlan = await createPlan(account.api_key, "account", `${label} Account Plan`, accountAllowance, accountRequestMax);
  const userPlan = await createPlan(account.api_key, "user", `${label} User Plan`, userAllowance, userRequestMax);
  const accountAssigned = await assignPlan(account.api_key, "account", accountPlan.id);
  assert(accountAssigned.statusCode === 200, `${label} account plan configured`);
  for (const user of createdUsers) {
    const userAssigned = await assignPlan(account.api_key, "user", userPlan.id, user.id);
    assert(userAssigned.statusCode === 200, `${label} user plan configured`);
  }
  return { account, users: createdUsers, accountPlan, userPlan };
}

async function consume(apiKey, userId, units, requestId) {
  return app.inject({
    method: "POST",
    url: "/v1/consumptions",
    headers: { "x-api-key": apiKey },
    payload: { user_id: userId, units, request_id: requestId },
  });
}

async function monthUtc() {
  const result = await pool.query(
    "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
  );
  return result.rows[0].month;
}

async function usageFor(accountId, userId, month) {
  const [account, user] = await Promise.all([
    pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date", [accountId, month]),
    pool.query("SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date", [accountId, userId, month]),
  ]);
  return {
    account: account.rows[0]?.used_units ?? "0",
    user: user.rows[0]?.used_units ?? "0",
  };
}

async function recordScenario(name, fixture, requestIds, responseList, month) {
  const accountUsage = await pool.query(
    "SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date",
    [fixture.account.account.id, month],
  );
  const userUsage = await Promise.all(fixture.users.map((user) => pool.query(
    "SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date",
    [fixture.account.account.id, user.id, month],
  )));
  const history = await pool.query(
    "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id = ANY($2::text[])",
    [fixture.account.account.id, requestIds],
  );
  const sumUsers = await pool.query(
    "SELECT COALESCE(sum(used_units),0)::text AS used_units FROM user_monthly_usage WHERE account_id=$1 AND month=$2::date",
    [fixture.account.account.id, month],
  );
  assert(
    (accountUsage.rows[0]?.used_units ?? "0") === sumUsers.rows[0].used_units,
    `${name}: account counter equals sum of all user counters for the UTC month`,
  );
  const replayCount = responseList.filter((response) => response.headers["idempotency-replayed"] === "true").length;
  const acceptedCount = responseList.filter((response) => response.statusCode === 200 && response.headers["idempotency-replayed"] !== "true").length;
  const rejectedCount = responseList.filter((response) => response.statusCode === 429 && response.headers["idempotency-replayed"] !== "true").length;
  const conflictCount = responseList.filter((response) => response.statusCode === 409).length;
  const accountUnits = accountUsage.rows[0]?.used_units ?? "0";
  const userUnits = userUsage.map((result) => result.rows[0]?.used_units ?? "0").join("/");
  results.push({
    scenario: name,
    concurrent: responseList.length,
    accepted: acceptedCount,
    rejected: rejectedCount,
    replays: replayCount,
    conflicts: conflictCount,
    accountUsage: accountUnits,
    userUsage: userUnits,
    history: history.rows[0].count,
  });
  return { acceptedCount, rejectedCount, conflictCount, accountUnits, userUnits, historyCount: history.rows[0].count };
}

async function runLockedMutationRace(label, fixture, mutation, consumption, expectedPlanName, expectedMonthlyAllowance) {
  const month = await monthUtc();
  const holder = await pool.connect();
  let holding = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [fixture.account.account.id]);
    holding = true;

    const mutationPromise = mutation();
    await waitForAccountLockWaiters(1, `${label} mutation to block on account row`);
    const consumePromise = consume(
      fixture.account.api_key,
      consumption.userId,
      consumption.units,
      consumption.requestId,
    );
    await waitForAccountLockWaiters(2, `${label} consumption to queue behind mutation`);

    await holder.query("COMMIT");
    holding = false;
    const [mutationResponse, consumptionResponse] = await withTimeout(
      Promise.all([mutationPromise, consumePromise]),
      `${label} queued operations`,
    );
    assert(mutationResponse.statusCode === 200, `${label} plan mutation committed first`);
    assert(consumptionResponse.statusCode === consumption.expectedStatus, `${label} consumption made a decision using the committed plan`);

    const snapshot = await pool.query(
      "SELECT account_plan_name,account_monthly_allowance,user_plan_name,user_monthly_allowance FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
      [fixture.account.account.id, consumption.requestId],
    );
    assert(snapshot.rows.length === 1, `${label} consumption history persisted`);
    assert(snapshot.rows[0][consumption.expectedSnapshotColumn] === expectedPlanName, `${label} history names the committed plan`);
    assert(snapshot.rows[0][consumption.expectedAllowanceColumn] === String(expectedMonthlyAllowance), `${label} history stores the committed allowance snapshot`);

    const usage = await usageFor(fixture.account.account.id, consumption.userId, month);
    const requestHistory = await pool.query(
      "SELECT status,units FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
      [fixture.account.account.id, consumption.requestId],
    );
    results.push({
      scenario: label,
      concurrent: 2,
      accepted: requestHistory.rows[0].status === "accepted" ? 1 : 0,
      rejected: requestHistory.rows[0].status === "rejected" ? 1 : 0,
      replays: 0,
      conflicts: 0,
      accountUsage: usage.account,
      userUsage: usage.user,
      history: requestHistory.rows.length,
    });
  } finally {
    if (holding) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function runRollbackFaultInjection(fixture, userId) {
  const testMonth = await monthUtc();
  const requestId = "phase3b-rollback-injected";
  const triggerName = "phase3b_rollback_fail_user_usage_trigger";
  const functionName = "phase3b_rollback_fail_user_usage";
  try {
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.account_id = '${fixture.account.account.id}'::uuid THEN
          RAISE EXCEPTION 'Phase 3B scoped rollback fault injection'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON user_monthly_usage
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);
    rollbackTriggerInstalled = true;
    rollbackTriggerAccountId = fixture.account.account.id;

    const response = await consume(fixture.account.api_key, userId, 5, requestId);
    assert(response.statusCode === 500, "injected user-counter failure returns server error");
    const usage = await usageFor(fixture.account.account.id, userId, testMonth);
    assert(usage.account === "0" && usage.user === "0", "failure after account update rolls both counters back");
    const history = await pool.query(
      "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
      [fixture.account.account.id, requestId],
    );
    assert(history.rows[0].count === 0, "unexpected transaction failure leaves no accepted/rejected history");

    await pool.query(`DROP TRIGGER ${triggerName} ON user_monthly_usage`);
    await pool.query(`DROP FUNCTION ${functionName}()`);
    rollbackTriggerInstalled = false;

    const retry = await consume(fixture.account.api_key, userId, 5, requestId);
    assert(retry.statusCode === 200 && retry.json().status === "accepted", "same request can be retried successfully after rollback");
    const retryHistory = await pool.query(
      "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id=$2",
      [fixture.account.account.id, requestId],
    );
    assert(retryHistory.rows[0].count === 1, "successful retry creates exactly one history record");
    results.push({ scenario: "Mid-transaction failure / retry", concurrent: 1, accepted: 1, rejected: 0, conflicts: 0, accountUsage: "5", userUsage: "5", history: 1 });
  } finally {
    if (rollbackTriggerInstalled && rollbackTriggerAccountId === fixture.account.account.id) {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON user_monthly_usage`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      rollbackTriggerInstalled = false;
    }
  }
}

async function runBoundaryCases(accountApiKey, accountId, user, accountPlan, userPlan) {
  const month = await monthUtc();
  const acceptedRequests = [];
  const consumeAndRecord = async (units, requestId) => {
    const response = await consume(accountApiKey, user.id, units, requestId);
    if (response.statusCode === 200) acceptedRequests.push({ requestId, units });
    return response;
  };
  const verifyInvariants = async (description, acceptedRequestIds) => {
    const usage = await pool.query(`
      SELECT
        a.used_units::text AS account_used,
        COALESCE(sum(u.used_units), 0)::text AS user_used
      FROM account_monthly_usage a
      LEFT JOIN user_monthly_usage u
        ON u.account_id = a.account_id AND u.month = a.month
      WHERE a.account_id = $1 AND a.month = $2::date
      GROUP BY a.account_id, a.month, a.used_units
    `, [accountId, month]);
    const history = await pool.query(
      "SELECT COALESCE(sum(units),0)::text AS accepted_units FROM consumption_requests WHERE account_id=$1 AND request_id=ANY($2::text[]) AND status='accepted'",
      [accountId, acceptedRequestIds],
    );
    assert(
      usage.rows[0]?.account_used === usage.rows[0]?.user_used,
      `${description}: account monthly usage equals the sum of its users for the month`,
    );
    assert(
      usage.rows[0]?.account_used === history.rows[0]?.accepted_units,
      `${description}: counters equal accepted request history, without synthetic usage`,
    );
  };

  // Reach the exact monthly boundary using accepted API requests (never direct counter edits).
  const seven = await consumeAndRecord(7, "phase3b-boundary-seed-7");
  assert(seven.statusCode === 200, "first accepted request builds usage toward the exact boundary");
  const exact = await consumeAndRecord(3, "phase3b-boundary-exact");
  assert(exact.statusCode === 200 && exact.json().account.used_units === "10" && exact.json().user.used_units === "10", "request exactly at both remaining allowances is accepted");
  const beyond = await consumeAndRecord(1, "phase3b-boundary-beyond");
  assert(beyond.statusCode === 429 && beyond.json().failed_rules.length === 2, "one unit beyond both exhausted quotas is rejected at both levels");
  await verifyInvariants("exact and beyond-boundary checks", acceptedRequests.map((request) => request.requestId));

  // Distinct fixtures make only one scope exhausted while all usage originates in accepted requests.
  const accountFirst = await makeFixture("Account Exhausts First", {
    accountAllowance: 10, accountRequestMax: 10,
    userAllowance: 20, userRequestMax: 10,
  });
  for (let index = 0; index < 10; index += 1) {
    const response = await consume(accountFirst.account.api_key, accountFirst.users[0].id, 1, `phase3b-account-first-${index}`);
    assert(response.statusCode === 200, "account-first fixture fills quota using accepted request history");
  }
  const accountMonth = await monthUtc();
  const accountOnlyFailure = await consume(accountFirst.account.api_key, accountFirst.users[0].id, 1, "phase3b-account-first-reject");
  assert(accountOnlyFailure.statusCode === 429 && accountOnlyFailure.json().failed_rules.length === 1 && accountOnlyFailure.json().failed_rules[0].level === "account", "account-exhausted-before-user reports only the account failure");
  const accountFixtureCounts = await usageFor(accountFirst.account.account.id, accountFirst.users[0].id, accountMonth);
  assert(accountFixtureCounts.account === "10" && accountFixtureCounts.user === "10", "account-first fixture maintains account equals user sum");
  const accountFixtureHistory = await pool.query("SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND status='accepted'", [accountFirst.account.account.id]);
  assert(accountFixtureHistory.rows[0].count === 10, "account-first counters correspond exactly to accepted history");
  results.push({ scenario: "Account quota exhausted first", concurrent: 11, accepted: 10, rejected: 1, conflicts: 0, accountUsage: "10", userUsage: "10", history: 11 });

  const userFirst = await makeFixture("User Exhausts First", {
    accountAllowance: 20, accountRequestMax: 10,
    userAllowance: 10, userRequestMax: 10,
  });
  for (let index = 0; index < 10; index += 1) {
    const response = await consume(userFirst.account.api_key, userFirst.users[0].id, 1, `phase3b-user-first-${index}`);
    assert(response.statusCode === 200, "user-first fixture fills quota using accepted request history");
  }
  const userMonth = await monthUtc();
  const userOnlyFailure = await consume(userFirst.account.api_key, userFirst.users[0].id, 1, "phase3b-user-first-reject");
  assert(userOnlyFailure.statusCode === 429 && userOnlyFailure.json().failed_rules.length === 1 && userOnlyFailure.json().failed_rules[0].level === "user", "user-exhausted-before-account reports only the user failure");
  const userFixtureCounts = await usageFor(userFirst.account.account.id, userFirst.users[0].id, userMonth);
  assert(userFixtureCounts.account === "10" && userFixtureCounts.user === "10", "user-first fixture maintains account equals user sum");
  const userFixtureHistory = await pool.query("SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND status='accepted'", [userFirst.account.account.id]);
  assert(userFixtureHistory.rows[0].count === 10, "user-first counters correspond exactly to accepted history");
  results.push({ scenario: "User quota exhausted first", concurrent: 11, accepted: 10, rejected: 1, conflicts: 0, accountUsage: "10", userUsage: "10", history: 11 });

  const tooLarge = await consumeAndRecord(11, "phase3b-boundary-per-request");
  assert(tooLarge.statusCode === 429 && tooLarge.json().failed_rules.some((rule) => rule.rule === "max_units_per_request"), "per-request maximum is enforced at quota evaluation");
  const rows = await pool.query(
    "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id LIKE 'phase3b-boundary-%'",
    [accountId],
  );
  assert(rows.rows[0].count === 4, "all valid boundary decisions have corresponding request history");
  await verifyInvariants("per-request boundary checks", acceptedRequests.map((request) => request.requestId));
  const counts = await usageFor(accountId, user.id, month);
  const boundaryHistory = await pool.query(
    "SELECT request_id FROM consumption_requests WHERE account_id=$1 AND request_id LIKE 'phase3b-boundary-%' AND status='accepted'",
    [accountId],
  );
  await verifyInvariants("all boundary checks", boundaryHistory.rows.map((row) => row.request_id));
  results.push({ scenario: "Exact boundary and per-request maximum", concurrent: 1, accepted: 2, rejected: 2, conflicts: 0, accountUsage: counts.account, userUsage: counts.user, history: rows.rows[0].count });
}

try {
  await app.ready();

  // Group 1: 50 distinct simultaneous requests on an account with no monthly usage rows.
  const sameUser = await makeFixture("Same User 50-Way", {
    accountAllowance: 23,
    accountRequestMax: 1,
    userAllowance: 29,
    userRequestMax: 1,
  });
  const firstMonth = await monthUtc();
  const firstTimeRows = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date", [sameUser.account.account.id, firstMonth]),
    pool.query("SELECT count(*)::int AS count FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date", [sameUser.account.account.id, sameUser.users[0].id, firstMonth]),
  ]);
  assert(firstTimeRows[0].rows[0].count === 0 && firstTimeRows[1].rows[0].count === 0, "same-user race starts with no monthly rows");
  const sameUserIds = Array.from({ length: 50 }, (_, index) => `phase3b-same-user-${index}`);
  const sameUserResponses = await withTimeout(Promise.all(sameUserIds.map((id) =>
    consume(sameUser.account.api_key, sameUser.users[0].id, 1, id))), "50-way same-user concurrency");
  const sameUserSummary = await recordScenario("Same user, 50 requests", sameUser, sameUserIds, sameUserResponses, firstMonth);
  assert(sameUserSummary.acceptedCount === 23 && sameUserSummary.rejectedCount === 27, "same-user race accepts exactly the account quota");
  assert(sameUserSummary.accountUnits === "23" && sameUserSummary.userUnits === "23", "same-user race counters equal accepted units");
  assert(sameUserSummary.historyCount === 50, "each of 50 valid attempts has exactly one history row");
  const exactFirstRows = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date) AS accounts,
      (SELECT count(*)::int FROM user_monthly_usage WHERE account_id=$1 AND user_id=$3 AND month=$2::date) AS users
  `, [sameUser.account.account.id, firstMonth, sameUser.users[0].id]);
  assert(exactFirstRows.rows[0].accounts === 1 && exactFirstRows.rows[0].users === 1, "simultaneous first use creates exactly one monthly row at each level");

  // Group 2: Independent user allowances and a shared account allowance.
  const multi = await makeFixture("Two Users Same Account", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 10,
    userRequestMax: 10,
    users: 2,
  });
  const multiMonth = await monthUtc();
  const multiRequests = multi.users.flatMap((user, userIndex) =>
    Array.from({ length: 15 }, (_, index) => ({
      user,
      requestId: `phase3b-multi-${userIndex}-${index}`,
    })),
  );
  const multiResponses = await withTimeout(Promise.all(multiRequests.map(({ user, requestId }) =>
    consume(multi.account.api_key, user.id, 1, requestId))), "two-user shared-account concurrency");
  const multiSummary = await recordScenario("Two users, shared account", multi, multiRequests.map((item) => item.requestId), multiResponses, multiMonth);
  const perUser = await Promise.all(multi.users.map((user) => usageFor(multi.account.account.id, user.id, multiMonth)));
  assert(multiSummary.accountUnits === "20", "shared account usage is the sum of both users' accepted units");
  assert(perUser.every((usage) => usage.user === "10"), "each user independently reaches its own allowance");
  assert(multiSummary.acceptedCount === 20 && multiSummary.rejectedCount === 10, "per-user quotas reject only each user's excess requests");
  assert(multiSummary.historyCount === 30, "every multi-user request has one history row");

  // Group 3a: Many simultaneous identical requests charge only once.
  const duplicates = await makeFixture("Duplicate Request Race", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
  });
  const duplicateMonth = await monthUtc();
  const duplicateIds = Array.from({ length: 20 }, () => "phase3b-same-id");
  const duplicateResponses = await withTimeout(Promise.all(duplicateIds.map(() =>
    consume(duplicates.account.api_key, duplicates.users[0].id, 3, "phase3b-same-id"))), "identical request-id race");
  const duplicateBodies = duplicateResponses.map((response) => response.body);
  const replayCount = duplicateResponses.filter((response) => response.headers["idempotency-replayed"] === "true").length;
  assert(duplicateResponses.every((response) => response.statusCode === 200), "all identical concurrent retries return the original success");
  assert(new Set(duplicateBodies).size === 1, "all identical concurrent retries return byte-identical bodies");
  assert(replayCount === 19, "all requests except the original carry the replay header");
  const duplicateSummary = await recordScenario("20 identical request IDs", duplicates, duplicateIds, duplicateResponses, duplicateMonth);
  assert(duplicateSummary.accountUnits === "3" && duplicateSummary.userUnits === "3", "identical request IDs charge usage once");
  assert(duplicateSummary.historyCount === 1, "identical request IDs create one history row");

  // Group 3b: Conflicting payloads race for the request ID; one wins, the other gets 409.
  const conflicting = await makeFixture("Conflicting Request ID Race", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
    users: 2,
  });
  const conflictMonth = await monthUtc();
  const conflictId = "phase3b-conflicting-id";
  const conflictResponses = await withTimeout(Promise.all([
    consume(conflicting.account.api_key, conflicting.users[0].id, 4, conflictId),
    consume(conflicting.account.api_key, conflicting.users[1].id, 5, conflictId),
  ]), "conflicting request-id race");
  assert(conflictResponses.filter((response) => response.statusCode === 409).length === 1, "conflicting concurrent payload loses with HTTP 409");
  assert(conflictResponses.filter((response) => response.statusCode === 200 || response.statusCode === 429).length === 1, "exactly one conflicting request establishes the original result");
  const conflictSummary = await recordScenario("Conflicting request ID", conflicting, [conflictId], conflictResponses, conflictMonth);
  assert(conflictSummary.historyCount === 1, "conflicting payload race leaves one history record");
  assert(BigInt(conflictSummary.accountUnits) === BigInt(conflictSummary.userUnits.split("/").reduce((sum, value) => sum + BigInt(value), 0n).toString()), "conflicting request race charges one consistent user and account total");

  // Group 4a: Account plan assignment is queued before consumption under the account lock.
  const accountPlanRace = await makeFixture("Account Plan Race", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
  });
  const accountOldPlan = await createPlan(accountPlanRace.account.api_key, "account", "Phase 3B account old plan", 1, 100);
  const accountNewPlan = await createPlan(accountPlanRace.account.api_key, "account", "Phase 3B account new plan", 5, 100);
  await assignPlan(accountPlanRace.account.api_key, "account", accountOldPlan.id);
  const accountPlanRaceId = "phase3b-account-plan-race";
  const accountPlanRaceMonth = await monthUtc();
  await runLockedMutationRace(
    "Account plan assignment race",
    accountPlanRace,
    () => assignPlan(accountPlanRace.account.api_key, "account", accountNewPlan.id),
    { userId: accountPlanRace.users[0].id, units: 7, requestId: accountPlanRaceId, expectedStatus: 429, expectedSnapshotColumn: "account_plan_name", expectedAllowanceColumn: "account_monthly_allowance" },
    accountNewPlan.name,
    5,
  );
  const accountRaceUsage = await usageFor(accountPlanRace.account.account.id, accountPlanRace.users[0].id, accountPlanRaceMonth);
  assert(accountRaceUsage.account === "0" && accountRaceUsage.user === "0", "rejected account-plan race preserves usage");

  // Group 4b: User plan assignment is queued before consumption under the account lock.
  const userPlanRace = await makeFixture("User Plan Race", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
  });
  const userNewPlan = await createPlan(userPlanRace.account.api_key, "user", "Phase 3B user new plan", 5, 100);
  const userPlanRaceId = "phase3b-user-plan-race";
  await runLockedMutationRace(
    "User plan assignment race",
    userPlanRace,
    () => assignPlan(userPlanRace.account.api_key, "user", userNewPlan.id, userPlanRace.users[0].id),
    { userId: userPlanRace.users[0].id, units: 7, requestId: userPlanRaceId, expectedStatus: 429, expectedSnapshotColumn: "user_plan_name", expectedAllowanceColumn: "user_monthly_allowance" },
    userNewPlan.name,
    5,
  );

  // Group 4c: Custom plan definition update is queued before consumption under the same account lock.
  const customUpdateRace = await makeFixture("Custom Limit Update Race", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
  });
  const mutablePlan = await createPlan(customUpdateRace.account.api_key, "account", "Phase 3B mutable account plan", 1, 100);
  await assignPlan(customUpdateRace.account.api_key, "account", mutablePlan.id);
  const customRaceId = "phase3b-custom-plan-race";
  await runLockedMutationRace(
    "Custom plan limit update race",
    customUpdateRace,
    () => app.inject({
      method: "PATCH",
      url: `/v1/plans/account/${mutablePlan.id}`,
      headers: { "x-api-key": customUpdateRace.account.api_key },
      payload: { monthly_allowance: 5 },
    }),
    { userId: customUpdateRace.users[0].id, units: 7, requestId: customRaceId, expectedStatus: 429, expectedSnapshotColumn: "account_plan_name", expectedAllowanceColumn: "account_monthly_allowance" },
    mutablePlan.name,
    5,
  );

  // Group 6: A scoped database trigger fails after account usage is updated but before user usage.
  const rollback = await makeFixture("Rollback Failure Injection", {
    accountAllowance: 100,
    accountRequestMax: 100,
    userAllowance: 100,
    userRequestMax: 100,
  });
  await runRollbackFaultInjection(rollback, rollback.users[0].id);

  // Group 7: Verify exact boundary, one over, and each exhaustion ordering.
  const boundary = await makeFixture("Quota Boundaries", {
    accountAllowance: 10,
    accountRequestMax: 10,
    userAllowance: 10,
    userRequestMax: 10,
  });
  await runBoundaryCases(boundary.account.api_key, boundary.account.account.id, boundary.users[0], boundary.accountPlan, boundary.userPlan);

  console.log("\nConcurrency results:");
  console.log("Scenario | Concurrent requests/operations | Accepted decisions | Rejected decisions | Replays | Conflicts | Final account usage | Final user usage | History rows | Result");
  for (const result of results) {
    console.log(`${result.scenario} | ${result.concurrent} | ${result.accepted} | ${result.rejected} | ${result.replays ?? 0} | ${result.conflicts} | ${result.accountUsage} | ${result.userUsage} | ${result.history} | PASS`);
  }
  console.log(`Concurrency integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Concurrency integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close concurrency integration app:", error);
    }
  }
  if (rollbackTriggerInstalled && rollbackTriggerAccountId) {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS phase3b_rollback_fail_user_usage_trigger ON user_monthly_usage`);
      await pool.query(`DROP FUNCTION IF EXISTS phase3b_rollback_fail_user_usage()`);
    } catch (error) {
      console.error("Could not remove scoped rollback test trigger:", error);
      process.exitCode = 1;
    }
  }
  try {
    if (ownedAccountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [ownedAccountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])", [ownedAccountIds]);
      assert(remaining.rows[0].count === 0, "concurrency tests cleaned only their scoped accounts");
    }
  } catch (error) {
    console.error("Could not clean up concurrency test data:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
