import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../dist/app.js";
assert.match(process.env.PGDATABASE ?? "", /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/);
const pool = new pg.Pool({ max: 3 });
const token = process.env.PROVISIONING_TOKEN;
const app = buildApp({ database: pool, provisioningToken: token, logger: false });
const accounts = [];
let assertions = 0;
function check(ok, text) { assert.ok(ok, text); assertions++; console.log(`PASS ${text}`); }
async function call(method, url, key, payload) {
  return app.inject({ method, url, headers: key ? { "x-api-key": key } : {}, payload });
}
async function fixture(name) {
  const response = await app.inject({ method: "POST", url: "/v1/accounts", headers: { "x-provisioning-token": token }, payload: { name } });
  assert.equal(response.statusCode, 201);
  const result = response.json(); accounts.push(result.account.id);
  const user = await call("POST", "/v1/users", result.api_key, { name: "Security user" });
  assert.equal(user.statusCode, 201);
  return { ...result, user: user.json() };
}
async function digest() {
  return (await pool.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY account_id,month),'[]') FROM account_monthly_usage t WHERE account_id=ANY($1::uuid[])) AS account_usage,
    (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY account_id,user_id,month),'[]') FROM user_monthly_usage t WHERE account_id=ANY($1::uuid[])) AS user_usage,
    (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM consumption_requests t WHERE account_id=ANY($1::uuid[])) AS history`, [accounts])).rows[0];
}
try {
  // Generate a real PostgreSQL ErrorResponse without changing tables or schema.
  const logs = [];
  const failingApp = buildApp({
    database: { query: () => pool.query(`DO $$ BEGIN
      RAISE EXCEPTION USING ERRCODE = 'XX000',
        MESSAGE = 'private-postgresql-message-marker',
        DETAIL = 'private-postgresql-detail-marker',
        HINT = 'private-postgresql-credential-marker';
    END $$`) },
    logger: { stream: { write: line => logs.push(line) } },
  });
  try {
    const failure = await failingApp.inject({ url: "/v1/accounts/me", headers: { "x-api-key": "regression-key-do-not-log" } });
    assert.equal(failure.statusCode, 500);
    assert.deepEqual(failure.json(), { statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" });
    for (const marker of ["private-postgresql-message-marker", "private-postgresql-detail-marker", "private-postgresql-credential-marker", "regression-key-do-not-log"]) {
      assert.ok(!failure.body.includes(marker) && !logs.join("").includes(marker));
    }
    const diagnostic = logs.map(line => JSON.parse(line)).find(line => line.msg === "Request failed");
    assert.equal(diagnostic.databaseCode, "XX000");
    assert.ok(diagnostic.reqId);
    check(true, "real PostgreSQL internal message/detail/hint never appear in HTTP 500 or logs; only safe SQLSTATE and request ID are logged");
  } finally { await failingApp.close(); }
  const a = await fixture("Phase 6B security A");
  const b = await fixture("Phase 6B security B");
  for (const f of [a, b]) {
    for (let n=0; n<2; n++) assert.equal((await call("POST", "/v1/consumptions", f.api_key, { user_id:f.user.id, units:1, request_id:`security-${n}` })).statusCode, 200);
  }
  const baseline = await digest();
  const valid = { user_id:a.user.id, units:1, request_id:"invalid-case" };
  const invalidBodies = [
    { ...valid, request_id:"x".repeat(201) }, { ...valid, request_id:"" }, { ...valid, request_id:17 },
    { ...valid, user_id:"x".repeat(1000) }, { ...valid, units:Number.MAX_SAFE_INTEGER+1 },
    { ...valid, units:null }, { ...valid, units:true }, { ...valid, units:{} },
    { ...valid, account_id:b.account.id }, { ...valid, unexpected:"field" },
    { ...valid, units:0 }, { ...valid, units:-1 }, { ...valid, units:0.1 },
  ];
  for (const payload of invalidBodies) assert.equal((await call("POST", "/v1/consumptions", a.api_key, payload)).statusCode, 400);
  check(true, "long/empty/typed request IDs, invalid UUIDs, unsafe integers, malformed units and unknown properties are rejected");
  const malformed = await app.inject({ method:"POST", url:"/v1/consumptions", headers:{ "x-api-key":a.api_key,"content-type":"application/json" }, payload:'{"units":' });
  check(malformed.statusCode === 400, "malformed JSON is rejected without executing consumption");
  for (const scope of ["tenant", "ACCOUNT", "users"]) {
    assert.equal((await call("POST", `/v1/plans/${scope}`, a.api_key, { name:"Invalid",monthly_allowance:1,max_units_per_request:1 })).statusCode,400);
  }
  check(true, "unsupported plan scopes do not select arbitrary database tables");
  const page = (await call("GET", "/v1/requests?limit=1", a.api_key)).json();
  const cursor = page.pagination.next_cursor;
  assert.ok(cursor);
  check((await call("GET", `/v1/requests?cursor=${cursor}`, b.api_key)).statusCode===400, "request cursor cannot be reused by another authenticated account");
  const decoded=JSON.parse(Buffer.from(cursor,"base64url"));
  for (const altered of [{...decoded,v:2},{...decoded,user_id:b.user.id},{...decoded,extra:true},{...decoded,created_at:"2025-99-99T00:00:00.000000Z"}]) {
    const bad=Buffer.from(JSON.stringify(altered)).toString("base64url");
    assert.equal((await call("GET",`/v1/requests?cursor=${bad}`,a.api_key)).statusCode,400);
  }
  check(true,"tampered cursor version, user scope, extra keys and impossible dates are rejected");
  // Re-encoding a cursor is possible; SQL must still scope every result to the authenticated account.
  const forged=Buffer.from(JSON.stringify({...decoded,account_id:b.account.id})).toString("base64url");
  const safe=await call("GET",`/v1/requests?cursor=${forged}`,b.api_key);
  assert.equal(safe.statusCode,200);
  check(safe.json().history.every(row=>row.user_id===b.user.id),"a re-encoded cursor still cannot bypass SQL account ownership");
  const monthly=Buffer.from("9999-12").toString("base64url");
  const months=await call("GET",`/v1/usage/account/history?cursor=${monthly}`,b.api_key);
  check(months.statusCode===200 && months.json().account_id===b.account.id,"unbound monthly cursor still returns only authenticated account usage");
  for (const f of [a,b]) {
    const response=await call("GET","/v1/accounts/me",f.api_key);
    check(!response.body.includes(f.api_key)&&!response.body.includes("api_key_hash")&&!response.body.includes(token),"account response excludes API key, hash and provisioning token");
  }
  assert.deepEqual(await digest(),baseline);
  check(true,"every malformed/cursor/read request leaves both counters and all existing history unchanged");
  console.log(`Phase 6B security tests passed: ${assertions} assertions`);
} finally {
  try { await app.close(); }
  finally { try { if(accounts.length)await pool.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])",[accounts]); } finally {await pool.end();} }
}
