import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Request history integration tests require PROVISIONING_TOKEN of at least 32 characters.");
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
    method: "POST", url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken }, payload: { name },
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

async function createPlan(apiKey, scope, name, allowance, maximum) {
  const response = await app.inject({
    method: "POST", url: `/v1/plans/${scope}`, headers: { "x-api-key": apiKey },
    payload: {
      name: `${name} ${randomUUID()}`,
      monthly_allowance: allowance,
      max_units_per_request: maximum,
    },
  });
  if (response.statusCode !== 201) throw new Error(`History setup plan failed (HTTP ${response.statusCode})`);
  return response.json();
}

async function assignPlan(apiKey, scope, planId, userId) {
  return app.inject({
    method: "PATCH",
    url: scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${userId}/plan`,
    headers: { "x-api-key": apiKey }, payload: { plan_id: planId },
  });
}

async function consume(apiKey, userId, units, requestId) {
  return app.inject({
    method: "POST", url: "/v1/consumptions", headers: { "x-api-key": apiKey },
    payload: { user_id: userId, units, request_id: requestId },
  });
}

async function get(url, apiKey) {
  return app.inject({
    method: "GET", url,
    headers: apiKey === undefined ? {} : { "x-api-key": apiKey },
  });
}

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 4C Request History A");
  const accountB = await provisionAccount("Phase 4C Request History B");
  const emptyAccount = await provisionAccount("Phase 4C Request History Empty");
  const userA = await createUser(accountA.api_key, "Request History User A");
  const secondUserA = await createUser(accountA.api_key, "Request History User A2");
  const userB = await createUser(accountB.api_key, "Request History User B");

  const accountPlan = await createPlan(accountA.api_key, "account", "Phase 4C Account", 100, 100);
  const userPlan = await createPlan(accountA.api_key, "user", "Phase 4C User", 100, 5);
  assert((await assignPlan(accountA.api_key, "account", accountPlan.id)).statusCode === 200, "test account plan assigned");
  assert((await assignPlan(accountA.api_key, "user", userPlan.id, userA.id)).statusCode === 200, "test user plan assigned");

  const outcomes = [];
  outcomes.push(await consume(accountA.api_key, userA.id, 3, "phase4c-accepted-a"));
  outcomes.push(await consume(accountA.api_key, userA.id, 6, "phase4c-rejected-a"));
  outcomes.push(await consume(accountA.api_key, secondUserA.id, 2, "phase4c-accepted-a2"));
  outcomes.push(await consume(accountA.api_key, userA.id, 1, "phase4c-accepted-a-second"));
  outcomes.push(await consume(accountA.api_key, userA.id, 101, "phase4c-rejected-account"));
  assert(outcomes.map((response) => response.statusCode).join(",") === "200,429,200,200,429", "fixtures include accepted and persisted rejected decisions");

  const accountBPlan = await createPlan(accountB.api_key, "user", "Phase 4C Other Account", 100, 100);
  assert((await assignPlan(accountB.api_key, "user", accountBPlan.id, userB.id)).statusCode === 200, "other account user plan assigned");
  assert((await consume(accountB.api_key, userB.id, 4, "phase4c-accepted-b")).statusCode === 200, "other account has an independent decision");

  // Include equal timestamps and adjacent microseconds to verify exact keyset pagination.
  const fixtureTimes = [
    "2025-03-01T12:00:00.000001Z",
    "2025-03-01T12:00:00.000001Z",
    "2025-03-01T12:00:00.000002Z",
    "2025-03-01T12:00:00.000003Z",
    "2025-03-01T12:00:00.000004Z",
  ];
  for (let index = 0; index < outcomes.length; index += 1) {
    await pool.query(
      "UPDATE consumption_requests SET created_at=$1::timestamptz WHERE account_id=$2 AND request_id=$3",
      [fixtureTimes[index], accountA.account.id, outcomes[index].json().request_id],
    );
  }
  await pool.query(
    "UPDATE consumption_requests SET created_at='2025-03-01T12:00:00.000005Z'::timestamptz WHERE account_id=$1 AND request_id=$2",
    [accountB.account.id, "phase4c-accepted-b"],
  );

  const emptyHistory = await get("/v1/requests", emptyAccount.api_key);
  assert(emptyHistory.statusCode === 200 && emptyHistory.json().history.length === 0, "empty account receives an empty history");
  assert(emptyHistory.json().pagination.next_cursor === null, "empty history has no next cursor");

  const first = await get("/v1/requests?limit=2", accountA.api_key);
  assert(first.statusCode === 200 && first.json().history.length === 2, "account history honors its requested page size");
  const firstPage = first.json();
  assert(firstPage.history[0].created_at === "2025-03-01T12:00:00.000004Z", "history serializes PostgreSQL UTC timestamps without losing microseconds");
  assert(firstPage.history[0].status === "rejected" && firstPage.history[0].response_status === 429, "history identifies rejected outcomes and stored HTTP status");
  assert(firstPage.history[0].rejection_reasons.length > 0 && firstPage.history[0].failed_rule_levels.includes("account"), "rejected history includes safe reasons and failed rule levels");
  assert(firstPage.history[0].usage_month === outcomes[4].json().usage_month, "history extracts the original UTC usage month");
  assert(firstPage.history[0].account_plan.name === accountPlan.name && firstPage.history[0].user_plan.name === userPlan.name, "history returns the plan snapshots applied at decision time");
  assert(firstPage.history.every((item) => item.units === "101" || item.units === "1"), "history preserves BIGINT unit counts as exact decimal strings");
  assert(firstPage.history.every((item) => !("response_body" in item) && !("api_key" in item)), "history exposes an allowlisted projection, not stored response bodies or credentials");

  const cursorPayload = decodeCursor(firstPage.pagination.next_cursor);
  assert(cursorPayload.created_at.endsWith(".000003Z") && cursorPayload.account_id === accountA.account.id, "opaque cursor retains microsecond timestamp and authenticated account scope");
  const second = await get(`/v1/requests?limit=2&cursor=${encodeURIComponent(firstPage.pagination.next_cursor)}`, accountA.api_key);
  const third = await get(`/v1/requests?limit=2&cursor=${encodeURIComponent(second.json().pagination.next_cursor)}`, accountA.api_key);
  const allPages = [...firstPage.history, ...second.json().history, ...third.json().history];
  const expectedOrder = [...allPages].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  assert(allPages.length === 5 && new Set(allPages.map((item) => item.id)).size === 5, "all pages contain every account decision once without gaps or duplicates");
  assert(allPages.map((item) => item.id).join(",") === expectedOrder.map((item) => item.id).join(","), "timestamp ties use descending UUID tie-break order");
  assert(allPages.map((item) => item.created_at).includes("2025-03-01T12:00:00.000001Z"), "cursor pagination retains tied timestamps exactly");
  assert(third.json().pagination.next_cursor === null, "last request-history page has no cursor");

  const accepted = await get("/v1/requests?status=accepted&limit=100", accountA.api_key);
  const rejected = await get("/v1/requests?status=rejected&limit=100", accountA.api_key);
  assert(accepted.json().history.length === 3 && accepted.json().history.every((item) => item.status === "accepted"), "accepted status filter returns only accepted decisions");
  assert(rejected.json().history.length === 2 && rejected.json().history.every((item) => item.status === "rejected"), "rejected status filter returns only rejected decisions");
  const filteredPage = await get("/v1/requests?status=accepted&limit=1", accountA.api_key);
  const filteredNext = await get(`/v1/requests?status=accepted&limit=1&cursor=${encodeURIComponent(filteredPage.json().pagination.next_cursor)}`, accountA.api_key);
  assert(filteredNext.statusCode === 200 && filteredNext.json().history.every((item) => item.status === "accepted"), "status filter is bound into and preserved by its cursor");
  const cursorWithDifferentStatus = await get(`/v1/requests?status=rejected&cursor=${encodeURIComponent(filteredPage.json().pagination.next_cursor)}`, accountA.api_key);
  assert(cursorWithDifferentStatus.statusCode === 400, "cursor cannot be reused with a different status filter");
  const invalidCalendarCursor = Buffer.from(JSON.stringify({ ...cursorPayload, created_at: "2025-02-31T12:00:00.000001Z" }), "utf8").toString("base64url");
  assert((await get(`/v1/requests?cursor=${encodeURIComponent(invalidCalendarCursor)}`, accountA.api_key)).statusCode === 400, "cursor rejects impossible calendar timestamps");

  const userHistory = await get(`/v1/users/${userA.id}/requests?limit=100`, accountA.api_key);
  assert(userHistory.statusCode === 200 && userHistory.json().history.length === 4, "user history includes only that owned user's requests");
  assert(userHistory.json().history.every((item) => item.user_id === userA.id), "user route never returns another user's records");
  const foreignUser = await get(`/v1/users/${userB.id}/requests`, accountA.api_key);
  assert(foreignUser.statusCode === 404, "foreign user history is concealed with HTTP 404");
  const userCursor = await get(`/v1/users/${userA.id}/requests?limit=1`, accountA.api_key);
  const cursorOnOtherUser = await get(`/v1/users/${secondUserA.id}/requests?cursor=${encodeURIComponent(userCursor.json().pagination.next_cursor)}`, accountA.api_key);
  assert(cursorOnOtherUser.statusCode === 400, "cursor cannot be reused for a different user scope");
  const accountCursorAsUser = await get(`/v1/users/${userA.id}/requests?cursor=${encodeURIComponent(firstPage.pagination.next_cursor)}`, accountA.api_key);
  assert(accountCursorAsUser.statusCode === 400, "account cursor cannot be reused on a user endpoint");

  const accountBHistory = await get("/v1/requests", accountB.api_key);
  assert(accountBHistory.json().history.length === 1 && accountBHistory.json().history[0].request_id === "phase4c-accepted-b", "account B sees only its own request decisions");
  assert((await get("/v1/requests", undefined)).statusCode === 401, "account request history rejects missing API keys");
  assert((await get("/v1/requests", "invalid-history-key")).statusCode === 401, "account request history rejects invalid API keys");
  assert((await get(`/v1/users/${userA.id}/requests`, undefined)).statusCode === 401, "user request history rejects missing API keys");
  assert((await get(`/v1/users/${userA.id}/requests`, "invalid-history-key")).statusCode === 401, "user request history rejects invalid API keys");

  for (const [query, label] of [
    ["status=pending", "unsupported status"],
    ["limit=0", "zero limit"],
    ["limit=101", "limit above maximum"],
    ["page=2", "unsupported query parameter"],
    ["cursor=not-a-cursor", "malformed cursor"],
  ]) {
    const response = await get(`/v1/requests?${query}`, accountA.api_key);
    assert(response.statusCode === 400, `${label} is rejected with HTTP 400`);
  }

  const rowsBeforeReads = await pool.query(
    "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=ANY($1::uuid[])",
    [accountIds],
  );
  for (let index = 0; index < 3; index += 1) {
    await get("/v1/requests?limit=2", accountA.api_key);
    await get(`/v1/users/${userA.id}/requests?status=rejected`, accountA.api_key);
  }
  const rowsAfterReads = await pool.query(
    "SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=ANY($1::uuid[])",
    [accountIds],
  );
  assert(rowsAfterReads.rows[0].count === rowsBeforeReads.rows[0].count, "request history reads are read-only");

  // Verify the existing composite indexes can satisfy the production keyset query forms.
  const explainClient = await pool.connect();
  try {
    await explainClient.query("BEGIN");
    await explainClient.query("SET LOCAL enable_seqscan = off");
    const accountPlan = await explainClient.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM consumption_requests
      WHERE account_id=$1 AND (created_at,id)<($2::timestamptz,$3::uuid)
      ORDER BY created_at DESC,id DESC LIMIT 3
    `, [accountA.account.id, "2025-03-01T12:00:00.000004Z", firstPage.history[0].id]);
    const userPlan = await explainClient.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM consumption_requests
      WHERE account_id=$1 AND user_id=$2 AND status='rejected'
        AND (created_at,id)<($3::timestamptz,$4::uuid)
      ORDER BY created_at DESC,id DESC LIMIT 3
    `, [accountA.account.id, userA.id, "2025-03-01T12:00:00.000004Z", firstPage.history[0].id]);
    const accountExplain = JSON.stringify(accountPlan.rows[0]["QUERY PLAN"]);
    const userExplain = JSON.stringify(userPlan.rows[0]["QUERY PLAN"]);
    assert(accountExplain.includes("consumption_requests_account_history_idx"), "account history keyset uses the existing account composite index");
    assert(userExplain.includes("consumption_requests_user_history_idx"), "user history keyset uses the existing user composite index");
    console.log("EXPLAIN account:", accountExplain);
    console.log("EXPLAIN user:", userExplain);
    await explainClient.query("ROLLBACK");
  } finally {
    explainClient.release();
  }

  console.log(`Request history integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Request history integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close request history test app:", error);
    }
  }
  try {
    if (accountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
      const remaining = await pool.query(
        "SELECT count(*)::int AS count FROM accounts WHERE id=ANY($1::uuid[])",
        [accountIds],
      );
      assert(remaining.rows[0].count === 0, "request-history tests cleaned only their scoped accounts and dependent data");
    }
  } catch (error) {
    console.error("Could not clean up request-history test data:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
