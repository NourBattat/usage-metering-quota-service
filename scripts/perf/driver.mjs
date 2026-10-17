import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import pg from "pg";
import { summarize, audit } from "./metrics.mjs";

// Internal driver: run only via perf:baseline, on its private Docker network.
assert.equal(process.env.PERF_ISOLATED, "1");
assert.match(process.env.PGDATABASE ?? "", /^usage_perf_[a-f0-9]{12}$/);
assert.equal(process.env.PGHOST, "postgres");
assert.equal(process.env.PERF_API_URL, "http://backend:3000");
const count = Number(process.env.PERF_REQUESTS ?? 500);
const repeats = Number(process.env.PERF_REPEATS ?? 3);
assert.ok(Number.isInteger(count) && count >= 100 && count <= 2000);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
const warmup = 50;
const timeoutMs = 5000;
const scenarioDeadlineMs = 120000;
const base = process.env.PERF_API_URL;
const pool = new pg.Pool({ max: 2, connectionTimeoutMillis: 5000 });
const secrets = [process.env.PROVISIONING_TOKEN, process.env.PGPASSWORD];
const definitions = [
  { id: "A", name: "Sequential", concurrency: 1, users: 1 },
  { id: "B", name: "Moderate", concurrency: 5, users: 1 },
  { id: "C", name: "Higher", concurrency: 20, users: 1 },
  { id: "D", name: "Peak baseline", concurrency: 50, users: 1 },
  { id: "E", name: "Shared quota / ten users", concurrency: 20, users: 10, mixed: true },
  { id: "F", name: "Shared quota / same user", concurrency: 20, users: 1, mixed: true },
  { id: "G", name: "Same-ID retries", concurrency: 20, users: 1, replay: true },
  { id: "H", name: "Quota rejection", concurrency: 20, users: 1, reject: true },
];
const output = { schema_version: 1, benchmark_id: randomUUID(), started_at_utc: new Date().toISOString(), status: "RUNNING",
  configuration: { requests_per_trial: count, repeats, warmup_requests_per_trial: warmup, units: 1,
    timeout_ms: timeoutMs, scenario_deadline_ms: scenarioDeadlineMs, workload: "closed-loop HTTP; one request per worker; fixtures outside timing",
    percentiles: "nearest rank ceil(p*N), no interpolation", definitions }, trials: [] };
async function systemFile(path) { try { return (await readFile(path, "utf8")).trim(); } catch { return "unavailable"; } }
async function api(method, path, body, key) {
  const response = await fetch(base + path, { method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : { "x-provisioning-token": process.env.PROVISIONING_TOKEN }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  assert.ok(response.ok, `Fixture API ${method} ${path} failed (HTTP ${response.status})`);
  return response.json();
}
async function fixture(definition) {
  const account = await api("POST", "/v1/accounts", { name: `Performance ${definition.id} ${randomUUID()}` });
  secrets.push(account.api_key);
  const accountLimit = definition.mixed ? warmup + Math.floor(count / 2) : count + warmup + 10;
  const userLimit = definition.reject ? 0 : count + warmup + 10;
  const plans = {};
  for (const scope of ["account", "user"]) {
    plans[scope] = await api("POST", `/v1/plans/${scope}`, { name: `Performance ${scope} ${randomUUID()}`,
      monthly_allowance: scope === "account" ? accountLimit : userLimit, max_units_per_request: 1 }, account.api_key);
  }
  await api("PATCH", "/v1/accounts/me/plan", { plan_id: plans.account.id }, account.api_key);
  const users = [];
  for (let i = 0; i < definition.users; i++) {
    const user = await api("POST", "/v1/users", { name: `Performance user ${i + 1}` }, account.api_key);
    await api("PATCH", `/v1/users/${user.id}/plan`, { plan_id: plans.user.id }, account.api_key);
    users.push(user.id);
  }
  // The HTTP-authenticated account must exist in this driver's isolated PostgreSQL database.
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=$1", [account.account.id])).rows[0].count, 1);
  return { id: account.account.id, key: account.api_key, users, failureLevel: definition.reject ? "user" : "account", limits: { account: accountLimit, user: userLimit } };
}
function inputs(f, number, repeated, expected) {
  const common = randomUUID();
  return Array.from({ length: number }, (_, i) => {
    const value = { user_id: f.users[i % f.users.length], units: 1, request_id: repeated ? common : randomUUID() };
    expected.set(value.request_id, { ...value, status: null });
    return value;
  });
}
async function execute(f, requests, concurrency, expected) {
  let next = 0;
  const records = [];
  const started = performance.now();
  const deadline = started + scenarioDeadlineMs;
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    while (next < requests.length) {
      if (performance.now() >= deadline) break;
      const input = requests[next++];
      const begin = performance.now();
      let kind;
      let httpStatus = null;
      try {
        const remaining = deadline - begin;
        if (remaining <= 0) { kind = "timeout"; }
        else {
          const response = await fetch(base + "/v1/consumptions", { method: "POST", headers: { "content-type": "application/json", "x-api-key": f.key },
            body: JSON.stringify(input), signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, Math.floor(remaining)))) });
          httpStatus = response.status;
          const raw = await response.text();
          const body = JSON.parse(raw);
          const replay = response.headers.get("idempotency-replayed") === "true";
          const expectedInput = expected.get(input.request_id);
          assert.ok([200, 429].includes(httpStatus));
          assert.equal(body.user_id, input.user_id); assert.equal(body.units, 1); assert.equal(body.request_id, input.request_id);
          assert.equal(body.status, httpStatus === 200 ? "accepted" : "rejected");
          if (httpStatus === 429) assert.ok(body.failed_rules.length && body.failed_rules.every(rule => rule.rule === "monthly_allowance" && rule.level === f.failureLevel));
          if (expectedInput.raw !== undefined) assert.equal(expectedInput.raw, raw);
          expectedInput.raw = raw; expectedInput.status = body.status;
          kind = replay ? "replay" : httpStatus === 200 ? "accepted" : "rejected";
        }
      } catch (error) {
        kind = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : httpStatus === null ? "network_error" : "http_error";
      }
      records.push({ latency: performance.now() - begin, kind, httpStatus });
    }
  }));
  const durationMs = performance.now() - started;
  const counts = Object.fromEntries(["accepted", "rejected", "replay", "http_error", "network_error", "timeout"].map(kind => [kind, records.filter(record => record.kind === kind).length]));
  return { ...summarize(records.map(record => record.latency), durationMs), total_requests: records.length,
    accepted: counts.accepted, quota_rejected: counts.rejected, idempotent_replays: counts.replay,
    http_errors: counts.http_error, network_errors: counts.network_error, timeouts: counts.timeout,
    accepted_http_responses: records.filter(record => record.httpStatus === 200).length,
    latencies_ms: records.map(record => record.latency) };
}
async function snapshot(id) {
  // Audit outside the timed interval; one coherent read snapshot for counters/history.
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const history = await client.query("SELECT request_id,user_id,units::text,status,response_body FROM consumption_requests WHERE account_id=$1 ORDER BY id", [id]);
    const accounts = await client.query("SELECT month::text,used_units::text FROM account_monthly_usage WHERE account_id=$1", [id]);
    const users = await client.query("SELECT month::text,user_id,used_units::text FROM user_monthly_usage WHERE account_id=$1", [id]);
    await client.query("COMMIT");
    return { history: history.rows, account_usage: accounts.rows, user_usage: users.rows };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function predefined() {
  return JSON.stringify((await pool.query(`SELECT 'account' AS scope,name,monthly_allowance::text,max_units_per_request::text FROM account_plans WHERE owner_account_id IS NULL
    UNION ALL SELECT 'user',name,monthly_allowance::text,max_units_per_request::text FROM user_plans WHERE owner_account_id IS NULL ORDER BY scope,name`)).rows);
}
try {
  assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, process.env.PGDATABASE);
  const baselinePlans = await predefined();
  const dbSettings = await pool.query(`SELECT version() AS full_version,current_setting('server_version') AS version,
    current_setting('max_connections') AS max_connections,current_setting('shared_buffers') AS shared_buffers,
    current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes`);
  output.environment = { generator_node: process.version, platform: process.platform, arch: process.arch,
    cpu_models: [...new Set(os.cpus().map(cpu => cpu.model))], visible_cpu_count: os.cpus().length,
    available_parallelism: os.availableParallelism(), visible_total_memory_bytes: os.totalmem(),
    generator_cgroup_cpu_max: await systemFile("/sys/fs/cgroup/cpu.max"), generator_cgroup_memory_max: await systemFile("/sys/fs/cgroup/memory.max"),
    postgresql: dbSettings.rows[0], backend_pool: { source: "src/db/pool.ts", max: 10, connection_timeout_ms: 5000, idle_timeout_ms: 30000 },
    audit_pool_max: 2, http_client: "Node built-in fetch default dispatcher, Docker bridge backend:3000" };
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const definition of definitions) {
      const f = await fixture(definition);
      const expected = new Map();
      const warming = await execute(f, inputs(f, warmup, false, expected), definition.concurrency, expected);
      const measuredInputs = inputs(f, count, definition.replay, expected);
      const measured = await execute(f, measuredInputs, definition.concurrency, expected);
      const state = await snapshot(f.id);
      const correctness = audit(state, expected, f.users, f.limits, warming.accepted + measured.accepted);
      const expectedAccepted = definition.reject ? 0 : definition.replay ? 1 : definition.mixed ? Math.floor(count / 2) : count;
      const expectedRejected = definition.reject ? count : definition.mixed ? count - Math.floor(count / 2) : 0;
      if (measured.total_requests !== count || warming.total_requests !== warmup || measured.accepted !== expectedAccepted || measured.quota_rejected !== expectedRejected
        || measured.idempotent_replays !== (definition.replay ? count - 1 : 0)
        || warming.accepted !== (definition.reject ? 0 : warmup) || warming.quota_rejected !== (definition.reject ? warmup : 0)
        || measured.http_errors + measured.network_errors + measured.timeouts + warming.http_errors + warming.network_errors + warming.timeouts > 0) {
        correctness.status = "FAILED"; correctness.failures.push("unexpected HTTP outcomes, errors, timeout or replay count");
      }
      if (correctness.utc_months.length !== 1) { correctness.status = "FAILED"; correctness.failures.push("UTC month changed during trial; sample is not comparable"); }
      output.trials.push({ scenario: definition.id, name: definition.name, repeat, concurrency: definition.concurrency, users: definition.users,
        measured, warmup: { requests: warmup, accepted: warming.accepted, rejected: warming.quota_rejected }, correctness });
      console.log(`Scenario ${definition.id}, repeat ${repeat}: ${measured.throughput_rps.toFixed(2)} req/s; correctness ${correctness.status}`);
      assert.equal(correctness.status, "PASS", "Benchmark correctness failed; this run is not a valid baseline");
    }
  }
  assert.equal(await predefined(), baselinePlans, "Predefined plans were modified");
  output.predefined_plans_unchanged = true;
  output.status = "PASS";
} catch {
  output.status = "FAILED";
  output.failure = "Benchmark setup, expected outcome or database correctness verification failed; no successful baseline is claimed.";
  process.exitCode = 1;
} finally {
  await pool.end();
  output.finished_at_utc = new Date().toISOString();
  const serialized = JSON.stringify(output, null, 2);
  for (const secret of secrets.filter(Boolean)) assert.ok(!serialized.includes(secret), "Refusing to write a secret into benchmark results");
  await writeFile("/results/baseline.json", serialized + "\n", { mode: 0o600 });
}
