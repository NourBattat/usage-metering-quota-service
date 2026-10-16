import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Monthly history integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 12, connectionTimeoutMillis: 5_000 });
const clockValues = [];
let clockCalls = 0;
const app = buildApp({
  database: pool,
  provisioningToken,
  logger: false,
  consumptionTimestamp: async () => {
    clockCalls += 1;
    const timestamp = clockValues.shift();
    if (!timestamp) throw new Error("No controlled timestamp queued for historical consumption");
    return timestamp;
  },
});
const accountIds = [];
let appClosed = false;
let assertions = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

function queueMonth(month, day = "15") {
  clockValues.push(`${month}-${day}T12:00:00.000Z`);
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST", url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`History setup account failed (HTTP ${response.statusCode})`);
  const account = response.json();
  accountIds.push(account.account.id);
  return account;
}

async function createUser(apiKey, name) {
  const response = await app.inject({
    method: "POST", url: "/v1/users", headers: { "x-api-key": apiKey }, payload: { name },
  });
  if (response.statusCode !== 201) throw new Error(`History setup user failed (HTTP ${response.statusCode})`);
  return response.json();
}

async function consume(apiKey, userId, units, requestId, month) {
  queueMonth(month);
  return app.inject({
    method: "POST", url: "/v1/consumptions", headers: { "x-api-key": apiKey },
    payload: { user_id: userId, units, request_id: requestId },
  });
}

async function history(url, apiKey) {
  return app.inject({
    method: "GET",
    url,
    headers: apiKey === undefined ? {} : { "x-api-key": apiKey },
  });
}

async function createPlan(apiKey, scope, name, allowance, maximum) {
  const response = await app.inject({
    method: "POST", url: `/v1/plans/${scope}`, headers: { "x-api-key": apiKey },
    payload: { name: `${name} ${randomUUID()}`, monthly_allowance: allowance, max_units_per_request: maximum },
  });
  if (response.statusCode !== 201) throw new Error(`History plan setup failed (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignPlan(apiKey, scope, planId, userId) {
  return app.inject({
    method: "PATCH", url: scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey }, payload: { plan_id: planId },
  });
}

function monthsRange(startYear, startMonth, count) {
  return Array.from({ length: count }, (_, offset) => {
    const month = startMonth - 1 + offset;
    const year = startYear + Math.floor(month / 12);
    const monthNumber = (month % 12) + 1;
    return `${year}-${String(monthNumber).padStart(2, "0")}`;
  });
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 4B History Account A");
  const accountB = await provisionAccount("Phase 4B History Account B");
  const emptyAccount = await provisionAccount("Phase 4B Empty History Account");
  const userA1 = await createUser(accountA.api_key, "History User A1");
  const userA2 = await createUser(accountA.api_key, "History User A2");
  const userB = await createUser(accountB.api_key, "History User B");
  const months = monthsRange(2024, 1, 23);

  // Generate 23 stored account/user months with the injected clock; user A2 deliberately has gaps.
  for (let index = 0; index < months.length; index += 1) {
    const month = months[index];
    const first = await consume(accountA.api_key, userA1.id, 1, `phase4b-a1-${month}`, month);
    assert(first.statusCode === 200, `user A1 consumption recorded for ${month}`);
    if (index % 3 === 0) {
      const second = await consume(accountA.api_key, userA2.id, 2, `phase4b-a2-${month}`, month);
      assert(second.statusCode === 200, `user A2 consumption recorded for ${month}`);
    }
  }
  for (const month of ["2024-03", "2024-07", "2025-01", "2025-11"]) {
    const response = await consume(accountB.api_key, userB.id, 4, `phase4b-b-${month}`, month);
    assert(response.statusCode === 200, `account B isolated usage recorded for ${month}`);
  }

  const zeroUser = await createUser(accountA.api_key, "History User With No Usage");
  const empty = await history(`/v1/users/${zeroUser.id}/usage/history`, accountA.api_key);
  assert(empty.statusCode === 200 && empty.json().history.length === 0, "user with no history receives an empty list");
  assert(empty.json().pagination.next_cursor === null, "empty history has no next cursor");
  const emptyAccountHistory = await history("/v1/usage/account/history", emptyAccount.api_key);
  assert(emptyAccountHistory.statusCode === 200 && emptyAccountHistory.json().history.length === 0, "account with no usage receives an empty history list");

  const accountResponse = await history("/v1/usage/account/history", accountA.api_key);
  const accountHistory = accountResponse.json();
  assert(accountResponse.statusCode === 200 && accountHistory.account_id === accountA.account.id, "account history returns the authenticated account identifier");
  assert(accountHistory.history.length === 20, "default account history limit is 20");
  assert(accountHistory.history[0].month === "2025-11" && accountHistory.history[19].month === "2024-04", "account history is ordered newest to oldest");
  assert(accountHistory.history.every((item) => typeof item.used_units === "string"), "account usage values are serialized as strings");
  assert(accountHistory.history.every((item) => Object.keys(item).sort().join(",") === "month,used_units"), "history exposes usage only and does not invent historical plan allowances");
  assert(accountHistory.pagination.limit === 20 && typeof accountHistory.pagination.next_cursor === "string", "account history returns a next cursor when more rows exist");

  const secondAccountPage = await history(
    `/v1/usage/account/history?cursor=${encodeURIComponent(accountHistory.pagination.next_cursor)}`,
    accountA.api_key,
  );
  assert(secondAccountPage.statusCode === 200 && secondAccountPage.json().history.length === 3, "account cursor retrieves the remaining page");
  assert(secondAccountPage.json().pagination.next_cursor === null, "last account page has no next cursor");
  const allAccountMonths = [...accountHistory.history, ...secondAccountPage.json().history].map((item) => item.month);
  assert(allAccountMonths.length === 23 && new Set(allAccountMonths).size === 23, "account pages contain every month once without duplicates or gaps");
  assert(allAccountMonths.join(",") === [...allAccountMonths].sort().reverse().join(","), "account cursor pages keep stable newest-first order");

  const filtered = await history("/v1/usage/account/history?from_month=2024-03&to_month=2024-06&limit=2", accountA.api_key);
  assert(filtered.statusCode === 200, "valid inclusive month filters are accepted");
  assert(filtered.json().history.map((item) => item.month).join(",") === "2024-06,2024-05", "date filters are inclusive and sorted newest first");
  const filteredNext = await history(
    `/v1/usage/account/history?from_month=2024-03&to_month=2024-06&limit=2&cursor=${encodeURIComponent(filtered.json().pagination.next_cursor)}`,
    accountA.api_key,
  );
  assert(filteredNext.json().history.map((item) => item.month).join(",") === "2024-04,2024-03", "cursor pagination remains compatible with inclusive filters");
  assert(filteredNext.json().pagination.next_cursor === null, "filtered final page has null cursor");
  const fromOnly = await history("/v1/usage/account/history?from_month=2025-10", accountA.api_key);
  assert(fromOnly.json().history.map((item) => item.month).join(",") === "2025-11,2025-10", "from_month-only filter is inclusive");
  const toOnly = await history("/v1/usage/account/history?to_month=2024-02", accountA.api_key);
  assert(toOnly.json().history.map((item) => item.month).join(",") === "2024-02,2024-01", "to_month-only filter is inclusive");

  const customLimit = await history("/v1/usage/account/history?limit=5", accountA.api_key);
  assert(customLimit.statusCode === 200 && customLimit.json().history.length === 5 && customLimit.json().pagination.limit === 5, "custom page size is honored");
  const tooLargeLimit = await history("/v1/usage/account/history?limit=101", accountA.api_key);
  assert(tooLargeLimit.statusCode === 400, "page size above 100 is rejected");
  const zeroLimit = await history("/v1/usage/account/history?limit=0", accountA.api_key);
  assert(zeroLimit.statusCode === 400, "zero page size is rejected");

  const invalidQueries = [
    ["from_month=2024-1", "malformed from_month"],
    ["to_month=2024-13", "invalid calendar month"],
    ["from_month=0000-01", "year zero"],
    ["from_month=2024-07&to_month=2024-06", "reversed date range"],
    ["cursor=not-a-valid-cursor", "invalid cursor"],
    ["page=2", "unsupported query parameter"],
  ];
  for (const [query, label] of invalidQueries) {
    const response = await history(`/v1/usage/account/history?${query}`, accountA.api_key);
    assert(response.statusCode === 400, `${label} returns HTTP 400`);
  }

  const userHistory = await history(`/v1/users/${userA1.id}/usage/history?limit=100`, accountA.api_key);
  assert(userHistory.statusCode === 200 && userHistory.json().user_id === userA1.id, "user history returns the requested owned user identifier");
  assert(userHistory.json().history.length === 23, "user A1 history includes every month consumed");
  assert(userHistory.json().history.every((item) => item.used_units === "1"), "user A1 monthly counters are independent");
  const defaultUserPage = await history(`/v1/users/${userA1.id}/usage/history`, accountA.api_key);
  assert(defaultUserPage.json().history.length === 20 && defaultUserPage.json().pagination.limit === 20, "user history default page size is 20");
  assert(defaultUserPage.json().pagination.next_cursor !== null, "user default page returns a cursor when more months exist");
  const userA2History = await history(`/v1/users/${userA2.id}/usage/history?limit=100`, accountA.api_key);
  assert(userA2History.json().history.length === 8, "user A2 history contains only its eight recorded months");
  assert(
    userA2History.json().history.map((item) => item.month).join(",")
      === months.filter((_, index) => index % 3 === 0).reverse().join(","),
    "months without a user usage row are not fabricated in that user's history",
  );
  assert(userA2History.json().history.every((item) => item.used_units === "2"), "user A2 usage is independent from user A1");
  const accountTotals = await pool.query(`
    SELECT a.month,a.used_units::text AS account_units,
           COALESCE(sum(u.used_units),0)::text AS user_units
    FROM account_monthly_usage AS a
    LEFT JOIN user_monthly_usage AS u
      ON u.account_id=a.account_id AND u.month=a.month
    WHERE a.account_id=$1
    GROUP BY a.month,a.used_units
    ORDER BY a.month
  `, [accountA.account.id]);
  assert(
    accountTotals.rows.every((row) => row.account_units === row.user_units),
    "account history totals equal the sum of accepted usage for both users each month",
  );
  const userPage = await history(`/v1/users/${userA1.id}/usage/history?limit=7`, accountA.api_key);
  assert(userPage.json().history.length === 7 && userPage.json().pagination.next_cursor !== null, "user history supports custom cursor pagination");
  const userPage2 = await history(`/v1/users/${userA1.id}/usage/history?limit=7&cursor=${encodeURIComponent(userPage.json().pagination.next_cursor)}`, accountA.api_key);
  const userPage3 = await history(`/v1/users/${userA1.id}/usage/history?limit=7&cursor=${encodeURIComponent(userPage2.json().pagination.next_cursor)}`, accountA.api_key);
  const userPage4 = await history(`/v1/users/${userA1.id}/usage/history?limit=7&cursor=${encodeURIComponent(userPage3.json().pagination.next_cursor)}`, accountA.api_key);
  const pagedUserMonths = [
    ...userPage.json().history,
    ...userPage2.json().history,
    ...userPage3.json().history,
    ...userPage4.json().history,
  ].map((item) => item.month);
  assert(pagedUserMonths.length === 23 && new Set(pagedUserMonths).size === 23, "user cursor pages contain all months once without skipped records");
  assert(pagedUserMonths.join(",") === [...pagedUserMonths].sort().reverse().join(","), "user cursor ordering remains stable newest first");

  const accountBHistory = await history("/v1/usage/account/history", accountB.api_key);
  assert(accountBHistory.json().history.length === 4, "account B sees only its own four history months");
  const foreignUserHistory = await history(`/v1/users/${userB.id}/usage/history`, accountA.api_key);
  assert(foreignUserHistory.statusCode === 404, "foreign user history is concealed with HTTP 404");
  const unknownUserHistory = await history("/v1/users/75000000-0000-4000-8000-000000000001/usage/history", accountA.api_key);
  assert(unknownUserHistory.statusCode === 404, "unknown user history returns HTTP 404");
  const invalidUserId = await history("/v1/users/not-a-uuid/usage/history", accountA.api_key);
  assert(invalidUserId.statusCode === 400, "invalid user ID returns HTTP 400");
  assert(invalidUserId.statusCode === 400 && foreignUserHistory.statusCode === 404, "invalid and foreign identifiers have distinct validation semantics");
  assert((await history("/v1/usage/account/history", undefined)).statusCode === 401, "account history rejects missing API keys");
  assert((await history("/v1/usage/account/history", "invalid-api-key")).statusCode === 401, "account history rejects invalid API keys");
  assert((await history(`/v1/users/${userA1.id}/usage/history`, undefined)).statusCode === 401, "user history rejects missing API keys");
  assert((await history(`/v1/users/${userA1.id}/usage/history`, "invalid-api-key")).statusCode === 401, "user history rejects invalid API keys");

  // Editing assigned plan definitions must not affect previously stored monthly usage.
  const accountCustom = await createPlan(accountA.api_key, "account", "Phase 4B historical account plan", 1_000, 100);
  const userCustom = await createPlan(accountA.api_key, "user", "Phase 4B historical user plan", 1_000, 100);
  await assignPlan(accountA.api_key, "account", accountCustom.id);
  await assignPlan(accountA.api_key, "user", userCustom.id, userA1.id);
  const historicalBeforePlanUpdate = await history(`/v1/users/${userA1.id}/usage/history?limit=100`, accountA.api_key);
  await app.inject({
    method: "PATCH", url: `/v1/plans/account/${accountCustom.id}`,
    headers: { "x-api-key": accountA.api_key }, payload: { monthly_allowance: 500 },
  });
  await app.inject({
    method: "PATCH", url: `/v1/plans/user/${userCustom.id}`,
    headers: { "x-api-key": accountA.api_key }, payload: { monthly_allowance: 500 },
  });
  const historicalAfterPlanUpdate = await history(`/v1/users/${userA1.id}/usage/history?limit=100`, accountA.api_key);
  assert(JSON.stringify(historicalAfterPlanUpdate.json().history) === JSON.stringify(historicalBeforePlanUpdate.json().history), "historical usage values remain unchanged after plan definition updates");
  assert(historicalAfterPlanUpdate.json().history.every((item) => Object.keys(item).sort().join(",") === "month,used_units"), "historical endpoint does not invent past plan allowances");

  const bigIntAccount = await provisionAccount("Phase 4B BIGINT Fixture Account");
  const bigIntUser = await createUser(bigIntAccount.api_key, "BIGINT Fixture User");
  const bigUsage = "9000000000000000";
  // Deliberate test-only stored usage row without a consumption history row, isolated to this fixture account.
  await pool.query(
    "INSERT INTO account_monthly_usage(account_id,month,used_units) VALUES($1,'2025-01-01',$2)",
    [bigIntAccount.account.id, bigUsage],
  );
  await pool.query(
    "INSERT INTO user_monthly_usage(account_id,user_id,month,used_units) VALUES($1,$2,'2025-01-01',$3)",
    [bigIntAccount.account.id, bigIntUser.id, bigUsage],
  );
  const bigHistory = await history("/v1/usage/account/history", bigIntAccount.api_key);
  assert(bigHistory.json().history[0].used_units === bigUsage, "history preserves large BIGINT as its exact decimal string");

  const rowsBeforeReads = await pool.query(`
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_array(account_id,month,used_units) ORDER BY account_id,month) FROM account_monthly_usage WHERE account_id=ANY($1::uuid[])), '[]'::jsonb) AS accounts,
      COALESCE((SELECT jsonb_agg(jsonb_build_array(account_id,user_id,month,used_units) ORDER BY account_id,user_id,month) FROM user_monthly_usage WHERE account_id=ANY($1::uuid[])), '[]'::jsonb) AS users
  `, [accountIds]);
  for (let index = 0; index < 3; index += 1) {
    await history("/v1/usage/account/history", accountA.api_key);
    await history(`/v1/users/${userA1.id}/usage/history`, accountA.api_key);
  }
  const rowsAfterReads = await pool.query(`
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_array(account_id,month,used_units) ORDER BY account_id,month) FROM account_monthly_usage WHERE account_id=ANY($1::uuid[])), '[]'::jsonb) AS accounts,
      COALESCE((SELECT jsonb_agg(jsonb_build_array(account_id,user_id,month,used_units) ORDER BY account_id,user_id,month) FROM user_monthly_usage WHERE account_id=ANY($1::uuid[])), '[]'::jsonb) AS users
  `, [accountIds]);
  assert(
    JSON.stringify(rowsAfterReads.rows[0].accounts) === JSON.stringify(rowsBeforeReads.rows[0].accounts)
      && JSON.stringify(rowsAfterReads.rows[0].users) === JSON.stringify(rowsBeforeReads.rows[0].users),
    "history reads do not create, update, or delete monthly rows",
  );

  const planUpdate = await app.inject({
    method: "PATCH", url: `/v1/users/${userA1.id}/plan`, headers: { "x-api-key": accountA.api_key },
    payload: { plan_id: (await pool.query("SELECT id FROM user_plans WHERE name='Premium' AND owner_account_id IS NULL")).rows[0].id },
  });
  assert(planUpdate.statusCode === 200, "user plan changes remain available after history reads");

  console.log(`Monthly history integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Monthly history integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close monthly history test app:", error);
    }
  }
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      assert(remaining.rows[0].count === 0, "monthly history tests cleaned only their scoped accounts and related rows");
    }
  } catch (error) {
    console.error("Could not clean up monthly history test data:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
