import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import pg from "pg";
import { summarize, audit } from "./metrics.mjs";
import { observations } from "./phase7b-summary.mjs";

// Internal driver: run only via perf:analysis, on its private Docker network.
assert.equal(process.env.PERF_ISOLATED, "1");
assert.match(process.env.PGDATABASE ?? "", /^usage_perf_[a-f0-9]{12}$/);
assert.equal(process.env.PGHOST, "postgres");
assert.equal(process.env.PERF_API_URL, "http://backend:3000");
const count = 500;
const repeats = 3;
assert.ok(Number.isInteger(count) && count >= 100 && count <= 2000);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
const warmup = 50;
const timeoutMs = 5000;
const scenarioDeadlineMs = 120000;
const base = process.env.PERF_API_URL;
const pool = new pg.Pool({ max: 2, connectionTimeoutMillis: 5000 });
const secrets = [process.env.PROVISIONING_TOKEN, process.env.PGPASSWORD];
const output = { schema_version: 1, phase: "7B", storage: process.env.PERF_STORAGE,
  started_at_utc: new Date().toISOString(), status: "RUNNING", configuration: { requests_per_trial:count,repeats,warmup:50,units:1,
  request_timeout_ms:timeoutMs,batch_deadline_ms:scenarioDeadlineMs,sustained_duration_ms:60000,sustained_max_requests:20000,sampling_ms:250,window_ms:5000 }, trials:[] };
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
  const accountLimit = 20100;
  const userLimit = definition.reject ? 0 : 20100;
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
async function execute(f, requests, concurrency, expected, stopAfterMs = null) {
  let next = 0;
  const records = [];
  const started = performance.now();
  const deadline = started + (stopAfterMs ?? scenarioDeadlineMs);
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    while (next < requests.length) {
      if (performance.now() >= deadline) break;
      const input = requests[next++];
      const target = input.target ?? f;
      const begin = performance.now();
      let kind;
      let httpStatus = null;
      try {
        const remaining = stopAfterMs === null ? deadline - begin : timeoutMs;
        if (remaining <= 0) { kind = "timeout"; }
        else {
          const response = await fetch(base + "/v1/consumptions", { method: "POST", headers: { "content-type": "application/json", "x-api-key": target.key },
            body: JSON.stringify({user_id:input.user_id,units:input.units,request_id:input.request_id}), signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, Math.floor(remaining)))) });
          httpStatus = response.status;
          const raw = await response.text();
          const body = JSON.parse(raw);
          const replay = response.headers.get("idempotency-replayed") === "true";
          const expectedInput = expected.get(input.request_id);
          assert.ok([200, 429].includes(httpStatus));
          assert.equal(body.user_id, input.user_id); assert.equal(body.units, 1); assert.equal(body.request_id, input.request_id);
          assert.equal(body.status, httpStatus === 200 ? "accepted" : "rejected");
          if (httpStatus === 429) assert.ok(body.failed_rules.length && body.failed_rules.every(rule => rule.rule === "monthly_allowance" && rule.level === target.failureLevel));
          if (expectedInput.raw !== undefined) assert.equal(expectedInput.raw, raw);
          expectedInput.raw = raw; expectedInput.status = body.status;
          kind = replay ? "replay" : httpStatus === 200 ? "accepted" : "rejected";
        }
      } catch (error) {
        kind = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : httpStatus === null ? "network_error" : "http_error";
      }
      records.push({ latency: performance.now() - begin, kind, httpStatus, completed_ms:performance.now()-started });
    }
  }));
  const durationMs = performance.now() - started;
  const counts = Object.fromEntries(["accepted", "rejected", "replay", "http_error", "network_error", "timeout"].map(kind => [kind, records.filter(record => record.kind === kind).length]));
  return { ...summarize(records.map(record => record.latency), durationMs), total_requests: records.length,
    accepted: counts.accepted, quota_rejected: counts.rejected, idempotent_replays: counts.replay,
    http_errors: counts.http_error, network_errors: counts.network_error, timeouts: counts.timeout,
    accepted_http_responses: records.filter(record => record.httpStatus === 200).length,
    latencies_ms: records.map(record => record.latency), windows: windows(records,durationMs) };
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
function windows(records, durationMs) {
  const result=[];
  for (let start=0;start<durationMs;start+=5000) {
    const elapsed=Math.min(5000,durationMs-start);
    const samples=records.filter(r=>r.completed_ms>=start && r.completed_ms<start+5000);
    result.push({start_seconds:start/1000,duration_seconds:elapsed/1000,total_requests:samples.length,
      ...(samples.length ? summarize(samples.map(r=>r.latency),elapsed) : {throughput_rps:0,latency_ms:null}),
      errors:samples.filter(r=>['http_error','network_error'].includes(r.kind)).length,timeouts:samples.filter(r=>r.kind==='timeout').length});
  }
  return result;
}
const monitorPool = new pg.Pool({max:1,connectionTimeoutMillis:5000,application_name:'phase7b-observer'});
async function observation() {
  const backend=JSON.parse(await readFile('/telemetry/current.json','utf8'));
  const sessions=(await monitorPool.query(`SELECT state,wait_event_type,wait_event,count(*)::int AS sessions,
    count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid))>0)::int AS blocked
    FROM pg_stat_activity WHERE datname=current_database() AND application_name='phase7b-backend'
    GROUP BY state,wait_event_type,wait_event ORDER BY state,wait_event_type,wait_event`)).rows;
  const postgres = JSON.parse(await readFile('/telemetry/postgres.json','utf8'));
  assert.ok(Date.now()-Date.parse(postgres.at_utc)<5000 && Date.now()-Date.parse(backend.at_utc)<5000,'Stale telemetry');
  return {at_utc:new Date().toISOString(),backend,postgres,sessions};
}
async function observeDuring(work) {
  const samples=[]; let stop=false, failure=false;
  // Sequential sampling avoids overlapping observer queries.
  const observing=(async()=>{
    while (!stop) {
      try { samples.push(await observation()); } catch { failure=true; }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  })();
  let value;
  try { value=await work(); } finally { stop=true; await observing; }
  assert.ok(!failure && samples.length>0,'Benchmark observation failed');
  return {value,samples};
}
async function trial(experiment, layout, concurrency, repeat, reject=false, sustained=false) {
  const fixtures=[];
  for (let i=0;i<(layout==='C'?10:1);i++) fixtures.push(await fixture({id:`${experiment}-${layout}`,users:layout==='B'?10:1,reject}));
  const expected=new Map();
  const expectedByAccount=fixtures.map(()=>new Map());
  const makeInputs = number => Array.from({length:number},(_,i)=>{
    const accountIndex=i%fixtures.length; const f=fixtures[accountIndex];
    const input={user_id:f.users[Math.floor(i/fixtures.length)%f.users.length],units:1,request_id:randomUUID()};
    const decision={...input,status:null}; expected.set(input.request_id,decision); expectedByAccount[accountIndex].set(input.request_id,decision);
    return {...input,target:f};
  });
  const warming=await execute(fixtures[0],makeInputs(50),concurrency,expected);
  const requests=makeInputs(sustained?20000:count);
  const observed=await observeDuring(()=>execute(fixtures[0],requests,concurrency,expected,sustained?60000:null));
  const measured=observed.value;
  // Sustained runs intentionally stop assigning requests at 60 seconds.
  for (const [id,input] of expected) if (input.status===null) {
    expected.delete(id); for (const accountMap of expectedByAccount) accountMap.delete(id);
  }
  const checks=[];
  for (let i=0;i<fixtures.length;i++) {
    const f=fixtures[i]; const accountExpected=expectedByAccount[i];
    checks.push(audit(await snapshot(f.id),accountExpected,f.users,f.limits,[...accountExpected.values()].filter(r=>r.status==='accepted').length));
  }
  const problems=[];
  const errors = measured.http_errors+measured.network_errors+measured.timeouts+warming.http_errors+warming.network_errors+warming.timeouts;
  if (errors || measured.idempotent_replays || warming.idempotent_replays) problems.push('Unexpected HTTP failure, timeout or replay');
  if (warming.total_requests!==50 || (!sustained && measured.total_requests!==count)) problems.push('Missing requests');
  if (sustained && measured.total_requests===20000) problems.push('Request cap reached before full sustained duration');
  if (sustained && measured.duration_seconds<60) problems.push('Sustained duration too short');
  if (measured.accepted !== (reject?0:measured.total_requests) || measured.quota_rejected !== (reject?measured.total_requests:0)
      || warming.accepted !== (reject?0:50) || warming.quota_rejected !== (reject?50:0)) problems.push('Unexpected decision counts');
  if (checks.some(c=>c.status!=='PASS' || c.utc_months.length!==1)) problems.push('Database correctness failure or month rollover');
  const value={experiment,layout,concurrency,repeat,reject,sustained,measured,observation_summary:observations(observed.samples),observations:observed.samples,
    correctness:{status:problems.length?'FAILED':'PASS',failures:problems,accounts:checks}};
  output.trials.push(value);
  console.log(`${experiment}/${layout} C${concurrency} R${repeat}: ${measured.throughput_rps.toFixed(2)} req/s ${value.correctness.status}`);
  assert.equal(value.correctness.status,'PASS','Experiment invalid');
}
try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,process.env.PGDATABASE);
  const baselinePlans=await predefined();
  output.environment={node:process.version,cpu_models:[...new Set(os.cpus().map(c=>c.model))],available_parallelism:os.availableParallelism(),
    generator_cpu_max:await systemFile('/sys/fs/cgroup/cpu.max'),generator_memory_max:await systemFile('/sys/fs/cgroup/memory.max'),
    postgres:(await pool.query(`SELECT version(),current_setting('max_connections') AS max_connections,current_setting('shared_buffers') AS shared_buffers,
      current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes`)).rows[0]};
  for (let repeat=1;repeat<=3;repeat++) for (const concurrency of [1,5,20,50]) {
    // Rotate layouts by repetition to reduce fixed-order bias.
    for (const layout of ['A','B','C'].slice(repeat-1).concat(['A','B','C'].slice(0,repeat-1))) await trial('contention',layout,concurrency,repeat);
  }
  for (let repeat=1;repeat<=3;repeat++) for (const reject of (repeat%2 ? [false,true] : [true,false])) await trial('quota-cost','A',20,repeat,reject);
  for (const layout of ['A','C']) await trial('sustained',layout,20,1,false,true);
  assert.equal(await predefined(),baselinePlans); output.predefined_plans_unchanged=true; output.status='PASS';
} catch {
  output.status='FAILED'; output.failure='Setup, observation, HTTP expectations or database audit failed; this is not a valid result.'; process.exitCode=1;
} finally {
  await pool.end(); await monitorPool.end(); output.finished_at_utc=new Date().toISOString();
  const serialized=JSON.stringify(output,null,2);
  for (const secret of secrets.filter(Boolean)) assert.ok(!serialized.includes(secret),'Refusing to save credentials');
  await writeFile('/results/phase7b.json',serialized+'\n',{mode:0o600});
}
