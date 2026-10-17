import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import pg from "pg";

const databaseName = process.env.PGDATABASE ?? "";
assert.match(databaseName, /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/);
assert.ok(databaseName.length <= 63);
const pool = new pg.Pool({ max: 3, connectionTimeoutMillis: 2_000 });
// PostgreSQL requires ALTER DATABASE availability changes from another database.
// This maintenance connection belongs to the same disposable/test cluster only.
const controlPool = new pg.Pool({ database: "postgres", max: 1, connectionTimeoutMillis: 2_000 });
const token = process.env.PROVISIONING_TOKEN;
let server;
let base;
let account;
let user;
let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; console.log(`PASS ${message}`); }
function event(child, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for test child ${name}`)), 10_000);
    function finish(error, value) { clearTimeout(timeout); child.off("message", message); child.off("exit", exit); error ? reject(error) : resolve(value); }
    function message(value) { if (value.event === name) finish(null, value); }
    function exit() { finish(new Error(`Test child exited before ${name}`)); }
    child.on("message", message); child.once("exit", exit);
  });
}
async function start() {
  server = fork(new URL("./fixtures/phase6b-server.mjs", import.meta.url), [], {
    env: { ...process.env, PGAPPNAME: "phase6b-backend" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  server.output = "";
  server.stdout.on("data", value => { server.output += value; });
  server.stderr.on("data", value => { server.output += value; });
  base = (await event(server, "ready")).url;
}
async function stop(signal = "SIGTERM") {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  const exited = once(child, "exit"); child.kill(signal);
  let timer;
  let result;
  try {
    result = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Child shutdown timed out")); }, 10_000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
  if (signal === "SIGTERM") assert.equal(result[0], 0);
  assert.ok(!server.output.includes(token));
  if (account) assert.ok(!server.output.includes(account.api_key));
}
async function arm(fault) { const armed = event(server, "armed"); server.send({ type: "arm", fault }); await armed; }
async function api(path, payload, key = account?.api_key, method = payload === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers: { ...(key ? { "x-api-key": key } : {}),
    "content-type": "application/json", "x-provisioning-token": token }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  assert.ok(!body.includes(token));
  if (account) assert.ok(!body.includes(account.api_key));
  return { status: response.status, body, json: JSON.parse(body), replay: response.headers.get("idempotency-replayed") };
}
const consumption = id => ({ user_id: user.id, units: 3, request_id: id });
async function snapshot() {
  const result = await pool.query(`SELECT
    (SELECT COALESCE(sum(used_units),0)::text FROM account_monthly_usage WHERE account_id=$1) AS account,
    (SELECT COALESCE(sum(used_units),0)::text FROM user_monthly_usage WHERE account_id=$1) AS users,
    (SELECT count(*)::int FROM consumption_requests WHERE account_id=$1) AS history`, [account.account.id]);
  return result.rows[0];
}
function interruptedRequest(payload) {
  const request = http.request(base + "/v1/consumptions", { method: "POST", headers: {
    "content-type": "application/json", "x-api-key": account.api_key,
  } });
  const done = new Promise(resolve => { request.once("error", () => resolve()); request.once("response", response => { response.resume(); resolve(); }); });
  request.end(JSON.stringify(payload));
  return { request, done };
}
async function allowConnections(allow) {
  // The exact database was verified against current_database() before this identifier is used.
  assert.match(databaseName, /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/);
  await controlPool.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS ${allow ? "true" : "false"}`);
}
try {
  check((await pool.query("SELECT current_database() AS name")).rows[0].name === databaseName, "fault-injection connection belongs to the runner-owned database");
  await start();
  account = (await api("/v1/accounts", { name: "Phase 6B recovery" })).json;
  user = (await api("/v1/users", { name: "Recovery user" })).json;
  const accepted = await api("/v1/consumptions", consumption("persist-accepted"));
  const rejectPayload = { ...consumption("persist-rejected"), units: 21 };
  const rejected = await api("/v1/consumptions", rejectPayload);
  check(accepted.status === 200 && rejected.status === 429, "restart fixtures persist accepted and rejected decisions");
  const plansBefore = [(await api("/v1/accounts/me")).json.plan, (await api(`/v1/users/${user.id}`)).json.plan];
  const stored = await snapshot();
  await stop(); await start();
  check((await api("/ready")).status === 200, "restarted backend authenticates and reaches PostgreSQL");
  assert.deepEqual(await snapshot(), stored);

  const idle = event(server, "idle"); server.send({ type: "idle" });
  const idlePid = (await idle).pid;
  const idleError = event(server, "idle-error");
  const idleKilled = await pool.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND application_name='phase6b-backend'", [idlePid, databaseName]);
  assert.equal(idleKilled.rows[0]?.killed, true);
  await idleError;
  check((await api("/ready")).status === 200, "terminated idle test connection does not crash the backend and readiness reconnects");
  assert.deepEqual([(await api("/v1/accounts/me")).json.plan, (await api(`/v1/users/${user.id}`)).json.plan], plansBefore);
  check(true, "account/user plans, both counters and rejected history survive backend process restart");
  for (const [payload, original] of [[consumption("persist-accepted"), accepted], [rejectPayload, rejected]]) {
    const replay = await api("/v1/consumptions", payload);
    check(replay.status === original.status && replay.replay === "true" && replay.body === original.body, "restart retry replays the exact stored accepted/rejected response");
  }
  assert.deepEqual(await snapshot(), stored);

  // A real server-side query error after the account UPDATE must roll back everything.
  await arm("query");
  const failure = await api("/v1/consumptions", consumption("query-abort"));
  check(failure.status === 500, "division-by-zero inside the transaction never returns success");
  assert.deepEqual(await snapshot(), stored);
  check(true, "query failure rolls back counters and creates no false accepted history");
  check((await api("/v1/consumptions", consumption("query-abort"))).status === 200, "request succeeds after transaction query failure is removed");

  const beforeKill = await snapshot();
  await arm("terminate");
  const paused = event(server, "paused");
  const pending = api("/v1/consumptions", consumption("terminated-connection"));
  const { pid } = await paused;
  const killed = await pool.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND application_name='phase6b-backend'", [pid, databaseName]);
  check(killed.rows[0]?.killed === true, "only the paused test transaction connection is terminated");
  server.send({ type: "resume" });
  check((await pending).status === 500, "interrupted PostgreSQL connection returns failure");
  assert.deepEqual(await snapshot(), beforeKill);
  check((await api("/v1/consumptions", consumption("terminated-connection"))).status === 200, "pool obtains a healthy connection and retries without partial previous charge");

  const beforeInterrupt = await snapshot();
  await arm("before-commit");
  const beforePaused = event(server, "paused");
  const uncommitted = interruptedRequest(consumption("lost-before-commit"));
  await beforePaused;
  uncommitted.request.destroy(); await uncommitted.done;
  await stop("SIGKILL");
  await start();
  assert.deepEqual(await snapshot(), beforeInterrupt);
  check(true, "client disconnect and test backend death before COMMIT leave no charge or history");
  check((await api("/v1/consumptions", consumption("lost-before-commit"))).status === 200, "uncommitted interrupted request can be retried normally");

  await arm("lost-response");
  const afterPaused = event(server, "paused");
  const committed = interruptedRequest(consumption("lost-after-commit"));
  await afterPaused;
  const afterCommit = await snapshot();
  committed.request.destroy(); await committed.done;
  server.send({ type: "resume" });
  const retry = await api("/v1/consumptions", consumption("lost-after-commit"));
  check(retry.status === 200 && retry.replay === "true", "lost HTTP response after COMMIT replays without charging twice");
  assert.deepEqual(await snapshot(), afterCommit);
  const decision = await pool.query("SELECT response_body, count(*) OVER()::int AS count FROM consumption_requests WHERE account_id=$1 AND request_id=$2", [account.account.id, "lost-after-commit"]);
  assert.deepEqual(retry.json, decision.rows[0].response_body);
  check(decision.rows[0].count === 1, "lost response has exactly one original decision with the replayed body");

  await stop();
  await allowConnections(false);
  await start();
  check((await api("/health")).status === 200 && (await api("/ready")).status === 503, "isolated database refusing new connections leaves liveness healthy and readiness unavailable");
  check((await api("/v1/consumptions", consumption("outage"))).status === 500, "unavailable isolated database never accepts usage and returns no credentials");
  await allowConnections(true);
  check((await api("/ready")).status === 200, "readiness recovers after isolated database connections are enabled");
  check((await api("/v1/consumptions", consumption("outage"))).status === 200, "consumption resumes after temporary database unavailability");
  await stop();

  const beforeMigrations = await snapshot();
  const migrations = spawnSync(process.execPath, ["scripts/migrate.mjs"], { encoding: "utf8" });
  check(migrations.status === 0 && migrations.stdout.includes("no migrations were applied"), "migration rerun is a no-op after restart");
  assert.deepEqual(await snapshot(), beforeMigrations);
  check(true, "repeat migrations preserve existing usage and request history");
  console.log(`Phase 6B recovery tests passed: ${assertions} assertions`);
} finally {
  // Restore access even on assertion failure; never alter another database or stop PostgreSQL.
  try { await allowConnections(true); }
  finally {
    try { await stop(); }
    finally {
      try { if (account) await pool.query("DELETE FROM accounts WHERE id=$1", [account.account.id]); }
      finally { try { await pool.end(); } finally { await controlPool.end(); } }
    }
  }
}
