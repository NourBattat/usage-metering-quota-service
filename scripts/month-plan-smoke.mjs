import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("UTC/plan integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({
  max: 16,
  connectionTimeoutMillis: 5_000,
  application_name: "phase3c-month-plan-tests",
});
const clockValues = [];
let clockCalls = 0;
const app = buildApp({
  database: pool,
  provisioningToken,
  logger: false,
  consumptionTimestamp: async () => {
    clockCalls += 1;
    const value = clockValues.shift();
    if (!value) throw new Error("No test timestamp queued for consumption");
    return value;
  },
});
const accountIds = [];
let appClosed = false;
let assertions = 0;
let originalTimezone;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

function queueTimestamp(value) {
  clockValues.push(value);
}

function withTimeout(promise, label, milliseconds = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForAccountLockWaiter() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database()
        AND application_name='phase3c-month-plan-tests'
        AND wait_event_type='Lock'
        AND query='SELECT id FROM accounts WHERE id = $1 FOR UPDATE'
    `);
    if (waiting.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Consumption did not become observably blocked on the account row lock");
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`Account setup failed (HTTP ${response.statusCode})`);
  const value = response.json();
  accountIds.push(value.account.id);
  return value;
}

async function createUser(apiKey, name) {
  const response = await app.inject({
    method: "POST", url: "/v1/users", headers: { "x-api-key": apiKey }, payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`User setup failed (HTTP ${response.statusCode})`);
  return response.json();
}

async function createPlan(apiKey, scope, name, allowance, maxPerRequest) {
  const response = await app.inject({
    method: "POST", url: `/v1/plans/${scope}`, headers: { "x-api-key": apiKey },
    payload: { name, monthly_allowance: allowance, max_units_per_request: maxPerRequest },
  });
  if (response.statusCode !== 201) throw new Error(`Plan setup failed (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignPlan(apiKey, scope, planId, userId) {
  return app.inject({
    method: "PATCH",
    url: scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey }, payload: { plan_id: planId },
  });
}

async function updatePlan(apiKey, scope, planId, patch) {
  return app.inject({
    method: "PATCH", url: `/v1/plans/${scope}/${planId}`,
    headers: { "x-api-key": apiKey }, payload: patch,
  });
}

async function consume(apiKey, userId, units, requestId) {
  return app.inject({
    method: "POST", url: "/v1/consumptions", headers: { "x-api-key": apiKey },
    payload: { user_id: userId, units, request_id: requestId },
  });
}

async function readUsage(accountId, userIds, month) {
  const account = await pool.query(
    "SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month=$2::date",
    [accountId, month],
  );
  const users = await pool.query(
    "SELECT user_id,used_units FROM user_monthly_usage WHERE account_id=$1 AND month=$2::date ORDER BY user_id",
    [accountId, month],
  );
  const history = await pool.query(
    "SELECT COALESCE(sum(units),0)::text AS units FROM consumption_requests WHERE account_id=$1 AND status='accepted' AND response_body->>'usage_month'=$2",
    [accountId, month],
  );
  const userSum = users.rows.reduce((total, row) => total + BigInt(row.used_units), 0n);
  const accountUsed = BigInt(account.rows[0]?.used_units ?? "0");
  assert(accountUsed === userSum, `UTC ${month}: account counter equals sum of all user counters`);
  assert(accountUsed === BigInt(history.rows[0].units), `UTC ${month}: account counter equals accepted history units`);
  for (const userId of userIds) {
    const userUsage = users.rows.find((row) => row.user_id === userId);
    const userHistory = await pool.query(
      "SELECT COALESCE(sum(units),0)::text AS units FROM consumption_requests WHERE account_id=$1 AND user_id=$2 AND status='accepted' AND response_body->>'usage_month'=$3",
      [accountId, userId, month],
    );
    assert(BigInt(userUsage?.used_units ?? "0") === BigInt(userHistory.rows[0].units), `UTC ${month}: user counter equals that user's accepted history`);
  }
  return { account: accountUsed.toString(), users: users.rows.map((row) => row.used_units) };
}

async function verifyAllMonthsAgainstHistory(accountId, userIds) {
  const months = await pool.query(
    "SELECT month::text AS month,used_units::text AS used_units FROM account_monthly_usage WHERE account_id=$1 ORDER BY month",
    [accountId],
  );
  for (const month of months.rows) {
    const userTotal = await pool.query(
      "SELECT COALESCE(sum(used_units),0)::text AS units FROM user_monthly_usage WHERE account_id=$1 AND month=$2::date",
      [accountId, month.month],
    );
    const acceptedTotal = await pool.query(
      "SELECT COALESCE(sum(units),0)::text AS units FROM consumption_requests WHERE account_id=$1 AND status='accepted' AND response_body->>'usage_month'=$2",
      [accountId, month.month],
    );
    assert(BigInt(month.used_units) === BigInt(userTotal.rows[0].units), `UTC ${month.month}: account counter equals sum of user counters`);
    assert(BigInt(month.used_units) === BigInt(acceptedTotal.rows[0].units), `UTC ${month.month}: account counter equals accepted request history`);

    for (const userId of userIds) {
      const userUsage = await pool.query(
        "SELECT COALESCE(max(used_units),0)::text AS units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month=$3::date",
        [accountId, userId, month.month],
      );
      const userAccepted = await pool.query(
        "SELECT COALESCE(sum(units),0)::text AS units FROM consumption_requests WHERE account_id=$1 AND user_id=$2 AND status='accepted' AND response_body->>'usage_month'=$3",
        [accountId, userId, month.month],
      );
      assert(BigInt(userUsage.rows[0].units) === BigInt(userAccepted.rows[0].units), `UTC ${month.month}: user counter equals that user's accepted history`);
    }
  }
}

try {
  await app.ready();
  originalTimezone = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";

  const account = await provisionAccount("Phase 3C UTC and Plan Account");
  const userA = await createUser(account.api_key, "UTC Plan User A");
  const userB = await createUser(account.api_key, "UTC Plan User B");
  const userIds = [userA.id, userB.id];
  const dec31BeforeMidnight = "2025-12-31T23:59:59.999Z";
  const jan1AfterMidnight = "2026-01-01T00:00:00.001Z";

  // The application process timezone is deliberately not UTC; consumption must still use the supplied instant's UTC month.
  queueTimestamp(dec31BeforeMidnight);
  const decemberRequest = await consume(account.api_key, userA.id, 10, "phase3c-december-accepted");
  assert(decemberRequest.statusCode === 200 && decemberRequest.json().usage_month === "2025-12-01", "one millisecond before UTC midnight belongs to December");
  queueTimestamp(jan1AfterMidnight);
  const januaryRequest = await consume(account.api_key, userA.id, 5, "phase3c-january-accepted");
  assert(januaryRequest.statusCode === 200 && januaryRequest.json().usage_month === "2026-01-01", "one millisecond after UTC midnight belongs to January in the new year");
  await readUsage(account.account.id, userIds, "2025-12-01");
  await readUsage(account.account.id, userIds, "2026-01-01");
  const historicDecember = await pool.query(
    "SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2025-12-01'",
    [account.account.id],
  );
  assert(historicDecember.rows[0]?.used_units === "10", "December historical usage remains after January consumption");

  // Retry must return the saved December response without consulting the injected clock or charging January.
  const callsBeforeReplay = clockCalls;
  const januaryBeforeReplay = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2026-01-01'", [account.account.id]);
  const decemberReplay = await consume(account.api_key, userA.id, 10, "phase3c-december-accepted");
  assert(decemberReplay.statusCode === 200 && decemberReplay.headers["idempotency-replayed"] === "true", "December request replay works after the month transition");
  assert(decemberReplay.body === decemberRequest.body && decemberReplay.json().usage_month === "2025-12-01", "December replay preserves the original byte body and month");
  assert(clockCalls === callsBeforeReplay, "idempotent replay does not recalculate a processing timestamp");
  const januaryAfterReplay = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2026-01-01'", [account.account.id]);
  assert(januaryAfterReplay.rows[0].used_units === januaryBeforeReplay.rows[0].used_units, "old-month replay does not charge the new month");

  // Equivalent instants with an explicit non-UTC offset are interpreted in UTC, not the Node process timezone.
  queueTimestamp("2026-01-31T16:00:00-08:00");
  const offsetInstant = await consume(account.api_key, userB.id, 2, "phase3c-offset-utc-month");
  assert(offsetInstant.statusCode === 200 && offsetInstant.json().usage_month === "2026-02-01", "UTC month selection ignores machine timezone and honors the timestamp instant");

  // Lock wait across the simulated year boundary: request is visibly waiting before its clock callback is called.
  const lockClient = await pool.connect();
  let accountLockHeld = false;
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [account.account.id]);
    accountLockHeld = true;
    queueTimestamp("2026-01-01T00:00:00.001Z");
    const callsBeforeWait = clockCalls;
    const waitingRequest = consume(account.api_key, userB.id, 1, "phase3c-lock-crosses-midnight");
    await waitForAccountLockWaiter();
    assert(clockCalls === callsBeforeWait, "timestamp is not requested while transaction waits for the account lock");
    await lockClient.query("COMMIT");
    accountLockHeld = false;
    const afterLock = await withTimeout(waitingRequest, "midnight-crossing request after account lock release");
    assert(afterLock.statusCode === 200 && afterLock.json().usage_month === "2026-01-01", "lock-waited request is charged to UTC month determined after locks release");
  } finally {
    if (accountLockHeld) await lockClient.query("ROLLBACK");
    lockClient.release();
  }
  await readUsage(account.account.id, userIds, "2026-01-01");
  await readUsage(account.account.id, userIds, "2026-02-01");

  const starter = await pool.query("SELECT id FROM account_plans WHERE name='Starter' AND owner_account_id IS NULL AND is_predefined=true");
  const pro = await pool.query("SELECT id FROM account_plans WHERE name='Pro' AND owner_account_id IS NULL AND is_predefined=true");
  const basic = await pool.query("SELECT id FROM user_plans WHERE name='Basic' AND owner_account_id IS NULL AND is_predefined=true");
  const premium = await pool.query("SELECT id FROM user_plans WHERE name='Premium' AND owner_account_id IS NULL AND is_predefined=true");

  // Plan upgrades/downgrades preserve usage, affect future decisions, and do not delete previous months.
  const accountUsageBeforePlans = await pool.query("SELECT month,used_units FROM account_monthly_usage WHERE account_id=$1 ORDER BY month", [account.account.id]);
  assert((await assignPlan(account.api_key, "account", pro.rows[0].id)).statusCode === 200, "account upgrade Starter to Pro succeeds");
  assert((await assignPlan(account.api_key, "user", premium.rows[0].id, userA.id)).statusCode === 200, "user upgrade Basic to Premium succeeds");
  const accountUsageAfterUpgrade = await pool.query("SELECT month,used_units FROM account_monthly_usage WHERE account_id=$1 ORDER BY month", [account.account.id]);
  assert(JSON.stringify(accountUsageAfterUpgrade.rows) === JSON.stringify(accountUsageBeforePlans.rows), "account upgrade preserves all current and historical usage rows");
  const userUsageBeforeChanges = await pool.query("SELECT month,used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 ORDER BY month", [account.account.id, userA.id]);
  assert((await assignPlan(account.api_key, "user", basic.rows[0].id, userA.id)).statusCode === 200, "user downgrade Premium to Basic succeeds");
  const userUsageAfterChanges = await pool.query("SELECT month,used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 ORDER BY month", [account.account.id, userA.id]);
  assert(JSON.stringify(userUsageAfterChanges.rows) === JSON.stringify(userUsageBeforeChanges.rows), "user plan change preserves all monthly usage rows");
  assert((await assignPlan(account.api_key, "account", starter.rows[0].id)).statusCode === 200, "account downgrade Pro to Starter succeeds");
  const lowerAccountPlan = await createPlan(account.api_key, "account", "Phase 3C Below Existing Usage", 1, 100);
  assert((await assignPlan(account.api_key, "account", lowerAccountPlan.id)).statusCode === 200, "account plan can be lowered below already used units");
  queueTimestamp("2026-02-01T12:00:00Z");
  const belowAccountBalance = await consume(account.api_key, userB.id, 1, "phase3c-account-limit-below-usage");
  assert(belowAccountBalance.statusCode === 429 && belowAccountBalance.json().account.remaining_units === "0", "allowance below account usage has zero remaining and rejects more consumption");
  assert((await assignPlan(account.api_key, "account", pro.rows[0].id)).statusCode === 200, "increasing account allowance permits later consumption without resetting counters");

  queueTimestamp("2026-02-01T12:30:00Z");
  const userUsageBeforeDowngrade = await consume(account.api_key, userA.id, 5, "phase3c-user-build-usage-before-downgrade");
  assert(userUsageBeforeDowngrade.statusCode === 200, "user accumulates usage before a lower allowance is applied");

  const lowerUserPlan = await createPlan(account.api_key, "user", "Phase 3C User Lower Than Usage", 4, 100);
  assert((await assignPlan(account.api_key, "user", lowerUserPlan.id, userA.id)).statusCode === 200, "user allowance can be lowered below that user's usage");
  queueTimestamp("2026-02-01T13:00:00Z");
  const belowUserBalance = await consume(account.api_key, userA.id, 1, "phase3c-user-limit-below-usage");
  assert(belowUserBalance.statusCode === 429 && belowUserBalance.json().user.remaining_units === "0", "allowance below user usage has zero remaining and rejects more consumption");
  assert((await assignPlan(account.api_key, "user", premium.rows[0].id, userA.id)).statusCode === 200, "increasing user allowance permits later consumption without resetting counters");

  const clockBeforePlanReplay = clockCalls;
  const acceptedReplayAfterPlanChanges = await consume(account.api_key, userA.id, 10, "phase3c-december-accepted");
  assert(acceptedReplayAfterPlanChanges.statusCode === 200 && acceptedReplayAfterPlanChanges.headers["idempotency-replayed"] === "true", "accepted old-month retry replays after account and user plan changes");
  assert(acceptedReplayAfterPlanChanges.body === decemberRequest.body, "accepted retry after plan changes returns the original raw body");
  assert(clockCalls === clockBeforePlanReplay, "accepted replay after plan changes does not evaluate a new processing month");

  const sharedAccount = await provisionAccount("Phase 3C Shared Plan Account");
  const sharedUserA = await createUser(sharedAccount.api_key, "Shared Plan User A");
  const sharedUserB = await createUser(sharedAccount.api_key, "Shared Plan User B");
  const userACustom = await createPlan(sharedAccount.api_key, "user", "Phase 3C Shared User Plan", 100, 100);
  await assignPlan(sharedAccount.api_key, "user", userACustom.id, sharedUserA.id);
  await assignPlan(sharedAccount.api_key, "user", userACustom.id, sharedUserB.id);
  queueTimestamp("2026-02-02T00:00:00Z");
  const sharedA = await consume(sharedAccount.api_key, sharedUserA.id, 4, "phase3c-shared-custom-a");
  queueTimestamp("2026-02-02T00:00:01Z");
  const sharedB = await consume(sharedAccount.api_key, sharedUserB.id, 5, "phase3c-shared-custom-b");
  assert(sharedA.statusCode === 200 && sharedB.statusCode === 200, "both users can consume independently under a shared custom plan");
  const sharedUsageBeforeEdit = await pool.query("SELECT user_id,used_units FROM user_monthly_usage WHERE account_id=$1 AND month='2026-02-01' ORDER BY user_id", [sharedAccount.account.id]);
  assert(sharedUsageBeforeEdit.rows.length === 2 && sharedUsageBeforeEdit.rows.find((row) => row.user_id === sharedUserA.id)?.used_units === "4" && sharedUsageBeforeEdit.rows.find((row) => row.user_id === sharedUserB.id)?.used_units === "5", "shared plan users retain independent usage counters");
  assert((await updatePlan(sharedAccount.api_key, "user", userACustom.id, { monthly_allowance: 6, max_units_per_request: 3 })).statusCode === 200, "shared custom plan update commits new allowance and request maximum");
  queueTimestamp("2026-02-02T00:00:02Z");
  const afterSharedEditB = await consume(sharedAccount.api_key, sharedUserB.id, 2, "phase3c-shared-update-b-reject");
  assert(afterSharedEditB.statusCode === 429 && afterSharedEditB.json().failed_rules.some((rule) => rule.rule === "monthly_allowance"), "new lower shared allowance affects a user's next decision");
  queueTimestamp("2026-02-02T00:00:03Z");
  const afterSharedEditA = await consume(sharedAccount.api_key, sharedUserA.id, 2, "phase3c-shared-update-a-accept");
  assert(afterSharedEditA.statusCode === 200, "new custom plan allowance permits the other user within its independent balance");
  queueTimestamp("2026-02-02T00:00:04Z");
  const requestMax = await consume(sharedAccount.api_key, sharedUserA.id, 4, "phase3c-shared-update-max-reject");
  assert(requestMax.statusCode === 429 && requestMax.json().failed_rules.some((rule) => rule.rule === "max_units_per_request"), "new shared max-per-request limit affects subsequent requests");
  const originalSnapshot = await pool.query("SELECT user_monthly_allowance,user_max_units_per_request FROM consumption_requests WHERE account_id=$1 AND request_id='phase3c-shared-custom-a'", [sharedAccount.account.id]);
  const newerSnapshot = await pool.query("SELECT user_monthly_allowance,user_max_units_per_request FROM consumption_requests WHERE account_id=$1 AND request_id='phase3c-shared-update-a-accept'", [sharedAccount.account.id]);
  assert(originalSnapshot.rows[0].user_monthly_allowance === "100" && originalSnapshot.rows[0].user_max_units_per_request === "100", "historical request keeps the original custom-plan snapshots");
  assert(newerSnapshot.rows[0].user_monthly_allowance === "6" && newerSnapshot.rows[0].user_max_units_per_request === "3", "later request records the updated custom-plan snapshots");
  const userBPlanAfter = await pool.query("SELECT user_plan_id FROM users WHERE id=$1", [sharedUserB.id]);
  const userAUsageAfter = await pool.query("SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month='2026-02-01'", [sharedAccount.account.id, sharedUserA.id]);
  const userBUsageAfter = await pool.query("SELECT used_units FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2 AND month='2026-02-01'", [sharedAccount.account.id, sharedUserB.id]);
  assert(userBPlanAfter.rows[0].user_plan_id === userACustom.id, "both users remain assigned to the shared plan");
  assert(userAUsageAfter.rows[0].used_units === "6" && userBUsageAfter.rows[0].used_units === "5", "custom plan update preserves independent counters and rejected use consumes zero");

  const oldCustomRequestBody = sharedA.body;
  const accountMonthBeforeAcceptedReplay = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2026-02-01'", [sharedAccount.account.id]);
  const clockBeforeCustomRetry = clockCalls;
  const acceptedRetryAfterCustomUpdate = await consume(sharedAccount.api_key, sharedUserA.id, 4, "phase3c-shared-custom-a");
  assert(acceptedRetryAfterCustomUpdate.statusCode === 200 && acceptedRetryAfterCustomUpdate.headers["idempotency-replayed"] === "true", "accepted request replays after shared custom plan limit changes");
  assert(acceptedRetryAfterCustomUpdate.body === oldCustomRequestBody, "custom-plan replay preserves byte-identical response and original limit snapshot");
  const accountMonthAfterAcceptedReplay = await pool.query("SELECT used_units FROM account_monthly_usage WHERE account_id=$1 AND month='2026-02-01'", [sharedAccount.account.id]);
  assert(accountMonthAfterAcceptedReplay.rows[0].used_units === accountMonthBeforeAcceptedReplay.rows[0].used_units, "custom-plan idempotent retry does not add usage");
  assert(clockCalls === clockBeforeCustomRetry, "custom-plan idempotent retry does not evaluate the current month");

  // Rejected decisions also replay their original response after a plan change.
  await assignPlan(account.api_key, "user", basic.rows[0].id, userB.id);
  queueTimestamp("2026-03-01T00:00:00Z");
  const initiallyRejected = await consume(account.api_key, userB.id, 21, "phase3c-rejected-replay");
  assert(initiallyRejected.statusCode === 429, "a per-request quota rejection is recorded before plan change");
  const rejectedBody = initiallyRejected.body;
  await assignPlan(account.api_key, "user", premium.rows[0].id, userB.id);
  const rejectedReplay = await consume(account.api_key, userB.id, 21, "phase3c-rejected-replay");
  assert(rejectedReplay.statusCode === 429 && rejectedReplay.headers["idempotency-replayed"] === "true", "rejected decision is replayed after a user plan change and UTC month transition");
  assert(rejectedReplay.body === rejectedBody, "rejected replay preserves exact original response body across changes");

  await verifyAllMonthsAgainstHistory(account.account.id, userIds);
  await verifyAllMonthsAgainstHistory(sharedAccount.account.id, [sharedUserA.id, sharedUserB.id]);

  // Restore timezone in the test process; this never changes OS or database server timezone.
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;

  console.log(`UTC and plan integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("UTC and plan integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close UTC/plan integration app:", error);
    }
  }
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      assert(remaining.rows[0].count === 0, "UTC/plan tests cleaned only their scoped accounts");
    }
  } catch (error) {
    console.error("Could not clean up UTC/plan test data:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
