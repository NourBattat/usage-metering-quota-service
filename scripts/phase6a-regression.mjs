import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../dist/app.js";

// This suite must run through test:db:isolated, never against application data.
assert.match(process.env.PGDATABASE ?? "", /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/);
const token = process.env.PROVISIONING_TOKEN;
assert.ok(token && token.length >= 32, "A provisioning token is required");
const pool = new pg.Pool({ max: 12, connectionTimeoutMillis: 5_000 });
const app = buildApp({ database: pool, provisioningToken: token, logger: false });
const ownedAccounts = [];
let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`PASS ${message}`);
}
async function request(method, url, key, payload) {
  return app.inject({ method, url, headers: key ? { "x-api-key": key } : {}, payload });
}
async function fixture(name) {
  const response = await app.inject({ method: "POST", url: "/v1/accounts",
    headers: { "x-provisioning-token": token }, payload: { name } });
  assert.equal(response.statusCode, 201);
  const account = response.json();
  ownedAccounts.push(account.account.id);
  const user = await request("POST", "/v1/users", account.api_key, { name: "Regression user" });
  assert.equal(user.statusCode, 201);
  return { id: account.account.id, key: account.api_key, user: user.json().id };
}
async function consume(f, units, id) {
  return request("POST", "/v1/consumptions", f.key, { user_id: f.user, units, request_id: id });
}
async function counters(f) {
  const result = await pool.query(`SELECT
    (SELECT COALESCE(sum(used_units),0)::text FROM account_monthly_usage WHERE account_id=$1) AS account,
    (SELECT COALESCE(sum(used_units),0)::text FROM user_monthly_usage WHERE account_id=$1 AND user_id=$2) AS user`, [f.id, f.user]);
  return result.rows[0];
}
try {
  const a = await fixture("Phase 6A A");
  const b = await fixture("Phase 6A B");
  const first = await consume(a, 1, "shared-account-scoped-id");
  const other = await consume(b, 2, "shared-account-scoped-id");
  check(first.statusCode === 200 && other.statusCode === 200, "identical request IDs in different accounts establish independent decisions");
  assert.deepEqual(await counters(a), { account: "1", user: "1" });
  assert.deepEqual(await counters(b), { account: "2", user: "2" });
  check(true, "account-scoped idempotency preserves independent counters");

  const rejected = await Promise.all(Array.from({ length: 12 }, () => consume(a, 21, "concurrent-rejected")));
  check(rejected.every(r => r.statusCode === 429), "all concurrent rejected retries return the persisted rejection");
  check(new Set(rejected.map(r => r.body)).size === 1, "concurrent rejected retries have byte-identical bodies");
  check(rejected.filter(r => r.headers["idempotency-replayed"] === "true").length === 11, "exactly eleven rejected retries carry the replay header");
  assert.deepEqual(await counters(a), { account: "1", user: "1" });
  check(true, "rejected concurrent retries preserve both existing nonzero counters");
  const persisted = await pool.query("SELECT count(*)::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id=$2", [a.id, "concurrent-rejected"]);
  check(persisted.rows[0].count === 1, "concurrent rejected request ID creates exactly one history record");
  check((await consume(a, 22, "concurrent-rejected")).statusCode === 409, "changed payload conflicts with an already rejected request ID");

  // Existing tests cover static ties/microseconds; this covers a new row between pages.
  const initial = await request("GET", "/v1/requests?limit=1", a.key);
  assert.equal(initial.statusCode, 200);
  const originalRows = (await request("GET", "/v1/requests?limit=100", a.key)).json().history;
  assert.equal((await consume(a, 1, "insert-between-pages")).statusCode, 200);
  const seen = [...initial.json().history];
  let cursor = initial.json().pagination.next_cursor;
  while (cursor) {
    const next = await request("GET", `/v1/requests?limit=1&cursor=${cursor}`, a.key);
    assert.equal(next.statusCode, 200);
    seen.push(...next.json().history);
    cursor = next.json().pagination.next_cursor;
  }
  check(seen.length === originalRows.length && new Set(seen.map(r => r.id)).size === originalRows.length
    && originalRows.every(r => seen.some(s => s.id === r.id)), "newer insertion between pages neither skips nor duplicates original history rows");
  check(!seen.some(r => r.request_id === "insert-between-pages"), "newer insert is visible on refresh rather than leaking into older cursor pages");

  const max = 9_000_000_000_000_000;
  for (const scope of ["account", "user"]) {
    const plan = await request("POST", `/v1/plans/${scope}`, a.key,
      { name: `Precision ${scope}`, monthly_allowance: max, max_units_per_request: 1_000_000 });
    assert.equal(plan.statusCode, 201);
    const assigned = await request("PATCH", scope === "account" ? "/v1/accounts/me/plan" : `/v1/users/${a.user}/plan`, a.key, { plan_id: plan.json().id });
    assert.equal(assigned.statusCode, 200);
  }
  const month = first.json().usage_month;
  await pool.query("UPDATE account_monthly_usage SET used_units=$1 WHERE account_id=$2 AND month=$3", [String(max - 1), a.id, month]);
  await pool.query("UPDATE user_monthly_usage SET used_units=$1 WHERE account_id=$2 AND user_id=$3 AND month=$4", [String(max - 1), a.id, a.user, month]);
  const exact = await consume(a, 1, "bigint-exact-cap");
  check(exact.statusCode === 200 && exact.json().account.used_units === String(max)
    && exact.json().user.used_units === String(max), "BIGINT arithmetic reaches the supported cap exactly at both levels");
  const beyond = await consume(a, 1, "bigint-over-cap");
  check(beyond.statusCode === 429 && beyond.json().failed_rules.length === 2, "one unit beyond the supported allowance rejects at both levels");
  assert.deepEqual(await counters(a), { account: String(max), user: String(max) });
  check(true, "BIGINT cap rejection leaves both counters unchanged");
  const report = await request("GET", "/v1/usage/account", a.key);
  check(report.json().used_units === String(max) && report.json().remaining_units === "0", "current report serializes the cap without rounding or negative remaining usage");

  // Valid bodies make these authentication tests independent of validation order.
  const routes = [
    ["GET", "/v1/accounts/me"], ["GET", "/v1/users"], ["POST", "/v1/users", { name: "Unauthenticated" }],
    ["GET", `/v1/users/${a.user}`], ["GET", "/v1/plans"],
    ["POST", "/v1/plans/user", { name: "Unauthorized", monthly_allowance: 1, max_units_per_request: 1 }],
    ["GET", "/v1/usage/account"], ["GET", `/v1/users/${a.user}/usage`],
    ["GET", "/v1/usage/account/history"], ["GET", `/v1/users/${a.user}/usage/history`],
    ["GET", "/v1/requests"], ["GET", `/v1/users/${a.user}/requests`],
  ];
  for (const [method, url, payload] of routes) {
    for (const key of [undefined, "invalid-phase6a-key"]) {
      assert.equal((await request(method, url, key, payload)).statusCode, 401, `${method} ${url}`);
    }
  }
  check(true, "read and create endpoint authentication rejects missing and invalid keys with valid request shapes");
  console.log(`Phase 6A focused regression tests passed: ${assertions} assertions`);
} catch (error) {
  // Assertion messages do not include request headers, response bodies, or keys.
  console.error(`Phase 6A regression failed: ${error instanceof Error ? error.message : "Unknown failure"}`);
  process.exitCode = 1;
} finally {
  try {
    await app.close();
  } finally {
    try {
      if (ownedAccounts.length) await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [ownedAccounts]);
    } finally {
      await pool.end();
    }
  }
}
