import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const projectDirectory = process.cwd();
let backendBaseUrl = process.env.USAGE_API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let assertionCount = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertionCount += 1;
  console.log(`PASS ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDirectory,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    let detail = result.error?.message ?? result.stderr?.trim() ?? "";
    for (const name of ["PROVISIONING_TOKEN", "POSTGRES_PASSWORD", "PGPASSWORD", "USAGE_API_KEY"]) {
      const secret = process.env[name];
      if (secret) detail = detail.replaceAll(secret, "[redacted]");
    }
    throw new Error(`${command} ${args[0] ?? ""} failed with exit code ${result.status ?? "unknown"}.${detail ? ` ${detail}` : ""}`);
  }
  return result.stdout;
}

function compose(...args) {
  return run("docker", ["compose", ...args]);
}

function inspectContainer(service) {
  const containerId = compose("ps", "-aq", service).trim();
  if (!containerId) throw new Error(`Compose did not create the ${service} container.`);
  return JSON.parse(run("docker", ["inspect", containerId]))[0];
}

function waitForSuccessfulExit(service, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const container = inspectContainer(service);
    if (container.State.Status === "exited") {
      if (container.State.ExitCode !== 0) {
        throw new Error(`${service} exited with code ${container.State.ExitCode}.`);
      }
      return container;
    }
    if (container.State.Status === "dead") throw new Error(`${service} container entered the dead state.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`${service} did not finish within ${timeoutMs}ms.`);
}

function psql(sql) {
  return compose(
    "exec", "-T", "postgres", "sh", "-c",
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -c "$1"',
    "sh", sql,
  ).trim();
}

function sqlUuidArray(ids) {
  for (const id of ids) {
    if (!accountIdPattern.test(id)) throw new Error("Refusing to query with an invalid account identifier.");
  }
  return ids.length === 0 ? "ARRAY[]::uuid[]" : `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`;
}

function snapshotQuery(excludedAccountIds) {
  const excluded = sqlUuidArray(excludedAccountIds);
  const tables = ["accounts", "users", "account_plans", "user_plans", "account_monthly_usage", "user_monthly_usage", "consumption_requests"];
  const entries = tables.map(table => {
    const owner = table === "accounts" ? "id" : table.endsWith("_plans") ? "owner_account_id" : "account_id";
    const predicate = table.endsWith("_plans") ? `(${owner} IS NULL OR ${owner} <> ALL(${excluded}))` : `${owner} <> ALL(${excluded})`;
    return `'${table}', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t WHERE ${predicate})`;
  });
  return `SELECT jsonb_build_object(${entries.join(",")})::text;`;
}

function preservedDataDigest(excludedAccountIds) {
  const output = psql(snapshotQuery(excludedAccountIds));
  return createHash("sha256").update(output).digest("hex");
}

function getDemoAccounts() {
  const result = psql("SELECT COALESCE(json_agg(json_build_array(id::text,name) ORDER BY created_at,id),'[]'::json)::text FROM accounts WHERE name LIKE 'Compose Demo %';");
  return JSON.parse(result).map(([id, name]) => ({ id, name }));
}

function getDemoReport(accountId) {
  if (!accountIdPattern.test(accountId)) throw new Error("Refusing to inspect an invalid demo account identifier.");
  const result = psql(`
    SELECT json_build_object(
      'account_plan', (SELECT p.name FROM account_plans p JOIN accounts a ON a.account_plan_id=p.id WHERE a.id='${accountId}'),
      'account_used', COALESCE((SELECT sum(used_units) FROM account_monthly_usage WHERE account_id='${accountId}'),0)::text,
      'users', (SELECT COALESCE(json_agg(json_build_object(
        'name',u.name,'plan',p.name,
        'used',COALESCE((SELECT sum(used_units) FROM user_monthly_usage uu WHERE uu.account_id=u.account_id AND uu.user_id=u.id),0)::text
      ) ORDER BY u.name),'[]'::json) FROM users u JOIN user_plans p ON p.id=u.user_plan_id WHERE u.account_id='${accountId}'),
      'requests', (SELECT COALESCE(json_agg(json_build_object('status',status,'units',units::text) ORDER BY created_at,id),'[]'::json)
                   FROM consumption_requests WHERE account_id='${accountId}'),
      'accepted_units', COALESCE((SELECT sum(units) FROM consumption_requests WHERE account_id='${accountId}' AND status='accepted'),0)::text,
      'unique_request_ids', (SELECT count(DISTINCT request_id)::int FROM consumption_requests WHERE account_id='${accountId}')
    )::text;
  `);
  return JSON.parse(result);
}

function getServiceLogs(service) {
  return compose("logs", "--no-color", service);
}

function inspectClientConfig() {
  const client = inspectContainer("example-client");
  const environment = client.Config.Env ?? [];
  const variableNames = environment.map((entry) => entry.split("=", 1)[0]);
  assert(!variableNames.includes("PROVISIONING_TOKEN"), "example-client environment does not contain the provisioning token");
  assert(!variableNames.includes("PGPASSWORD") && !variableNames.includes("POSTGRES_PASSWORD"), "example-client environment contains no database password");
  assert(!["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "DATABASE_URL", "POSTGRES_DB", "POSTGRES_USER"].some(name => variableNames.includes(name)), "example-client environment contains no database connection settings or usernames");
  assert(!variableNames.includes("USAGE_API_KEY"), "account API key is not exposed as a client environment variable");
  assert(variableNames.includes("USAGE_API_KEY_FILE"), "example-client receives only the account-key file path");

  const keyMount = (client.Mounts ?? []).find((mount) => mount.Destination === "/run/demo-secrets");
  const expectedMountType = process.env.PHASE6B_DISPOSABLE === "1" ? "bind" : "volume";
  assert(keyMount?.Type === expectedMountType && keyMount.RW === false, "example-client mounts the dedicated secret mount read-only");
  assert(client.Config.User === "node", "example-client runs as the unprivileged node user");
  return client;
}

function inspectSecretFileAndLogs(bootstrapLogs, clientLogs) {
  const probe = [
    "const fs=require('node:fs');",
    "const p=process.env.DEMO_SECRET_DIR+'/account-api-key';",
    "const d=fs.statSync(process.env.DEMO_SECRET_DIR);",
    "const s=fs.statSync(p);",
    "const key=fs.readFileSync(p,'utf8').trim();",
    "const crypto=require('node:crypto');",
    "let logs='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>logs+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({mode:s.mode&511,uid:s.uid,gid:s.gid,directoryMode:d.mode&511,directoryUid:d.uid,directoryGid:d.gid,digest:crypto.createHash('sha256').update(key).digest('hex'),logsContainKey:logs.includes(key),logsContainProvisioningToken:logs.includes(process.env.PROVISIONING_TOKEN),bootstrapHasProvisioningToken:Object.hasOwn(process.env,'PROVISIONING_TOKEN')})));",
  ].join("");
  const output = run("docker", [
    "compose", "run", "--rm", "--no-deps",
    "--entrypoint", "node", "demo-bootstrap", "-e", probe,
  ], { input: `${bootstrapLogs}\n${clientLogs}` });
  return JSON.parse(output.trim());
}

function checkClientFailureExit() {
  const result = spawnSync("docker", [
    "compose", "run", "--rm", "--no-deps",
    "-e", "USAGE_API_KEY_FILE=/missing/demo-key",
    "--entrypoint", "node", "example-client", "/app/dist-client/cli.js",
  ], { cwd: projectDirectory, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert(result.status === 1, "client container exits nonzero when its key file is missing");
  assert(output.includes("Could not read the account key file"), "client startup reports a clear missing-secret error");
  assert(!output.includes("PROVISIONING_TOKEN") && !output.includes("x-api-key"), "client failure output contains no authentication material");
}

function checkBootstrapFailureBlocksClient() {
  const result = spawnSync("docker", [
    "compose", "run", "--rm", "--no-deps",
    "-e", "PROVISIONING_TOKEN=",
    "--entrypoint", "node", "demo-bootstrap", "/app/scripts/demo-bootstrap.mjs",
  ], { cwd: projectDirectory, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert(result.status === 1, "bootstrap exits nonzero when provisioning configuration is absent");
  assert(output.includes("valid server-side PROVISIONING_TOKEN"), "bootstrap reports a clear non-secret configuration error");
  assert(!output.includes("x-provisioning-token") && !output.includes("api_key"), "bootstrap failure output contains no credentials or headers");
}

async function waitForBackend() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const [health, ready] = await Promise.all([
        fetch(new URL("/health", backendBaseUrl)),
        fetch(new URL("/ready", backendBaseUrl)),
      ]);
      if (health.status === 200 && ready.status === 200) return;
    } catch {
      // The stack is starting; retry until the bounded deadline.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("Backend /health and /ready did not both return HTTP 200.");
}

async function verifyRun(knownDemoIds, newDemoIds, previousKeyDigest) {
  const bootstrap = waitForSuccessfulExit("demo-bootstrap");
  const client = waitForSuccessfulExit("example-client");
  const bootstrapLogs = getServiceLogs("demo-bootstrap");
  const clientLogs = getServiceLogs("example-client");

  assert(!bootstrapLogs.includes("x-provisioning-token"), "bootstrap logs do not contain provisioning headers");
  assert(!clientLogs.includes("x-api-key") && !clientLogs.includes("api_key"), "client logs contain no key or authentication-header markers");
  assert(client.State.ExitCode === 0 && bootstrap.State.ExitCode === 0, "bootstrap and CLI both exited successfully");
  assert(clientLogs.includes("Final account usage: 45 / 100000; remaining 99955 (Pro)."), "CLI displayed expected account usage 45");
  assert(clientLogs.includes("Ahmad usage: 10 / 1000; remaining 990 (Basic)."), "CLI displayed expected Ahmad usage 10");
  assert(clientLogs.includes("Sara usage: 35 / 5000; remaining 4965 (Premium)."), "CLI displayed expected Sara usage 35");
  assert(clientLogs.includes("REJECTED (user max_units_per_request"), "CLI demonstrated the Basic user-level rejection");
  assert(clientLogs.includes("REJECTED (account monthly_allowance"), "CLI demonstrated the account-level rejection");
  assert(clientLogs.includes("replayed without an extra charge"), "CLI demonstrated idempotent retry without charging twice");

  inspectClientConfig();
  const keyFile = inspectSecretFileAndLogs(bootstrapLogs, clientLogs);
  assert(keyFile.mode === 0o400 && keyFile.uid === 1000 && keyFile.gid === 1000, "API key file has mode 0400 and node-user ownership");
  assert(keyFile.directoryMode === 0o700 && keyFile.directoryUid === 1000 && keyFile.directoryGid === 1000, "secret directory has mode 0700 and node-user ownership");
  assert(keyFile.bootstrapHasProvisioningToken, "provisioning token is available to bootstrap only for account creation");
  assert(!keyFile.logsContainKey && !keyFile.logsContainProvisioningToken, "bootstrap and client logs contain neither the API key nor provisioning token");
  if (previousKeyDigest) assert(keyFile.digest !== previousKeyDigest, "repeat run received a different newly generated account API key");

  const allDemoAccounts = getDemoAccounts();
  const created = allDemoAccounts.filter((account) => !knownDemoIds.has(account.id));
  assert(created.length === 1, "this run provisioned exactly one fresh demo account");
  const freshAccount = created[0];
  knownDemoIds.add(freshAccount.id);
  newDemoIds.add(freshAccount.id);
  const report = getDemoReport(freshAccount.id);
  assert(report.account_plan === "Pro" && report.account_used === "45", "database confirms new demo account is on Pro with 45 units");
  assert(report.users.length === 2, "database confirms the demo created exactly two users");
  assert(report.users.find((user) => user.name === "Ahmad")?.plan === "Basic", "database confirms Ahmad is on Basic");
  assert(report.users.find((user) => user.name === "Ahmad")?.used === "10", "database confirms Ahmad used 10 units");
  assert(report.users.find((user) => user.name === "Sara")?.plan === "Premium", "database confirms Sara is on Premium");
  assert(report.users.find((user) => user.name === "Sara")?.used === "35", "database confirms Sara used 35 units");
  assert(report.requests.length === 5 && report.unique_request_ids === 5, "database has five unique decisions; replay added no request row");
  assert(report.requests.filter((request) => request.status === "accepted").length === 3, "database has exactly three accepted decisions");
  assert(report.requests.filter((request) => request.status === "rejected").length === 2, "database has exactly two rejected decisions");
  assert(report.accepted_units === "45", "rejected decisions charged zero units");

  const bootstrapConfig = inspectContainer("demo-bootstrap");
  const bootstrapMount = (bootstrapConfig.Mounts ?? []).find((mount) => mount.Destination === "/run/demo-secrets");
  assert(bootstrapMount?.RW === true, "only bootstrap has write access to the secret volume");
  return { accountId: freshAccount.id, keyDigest: keyFile.digest };
}

async function main() {
  const composeConfig = JSON.parse(compose("config", "--format", "json"));
  const disposable = process.env.PHASE6B_DISPOSABLE === "1";
  const postgresVolumeName = composeConfig.volumes?.postgres_data?.name;
  if (!disposable && (typeof postgresVolumeName !== "string" || postgresVolumeName.length === 0)) {
    throw new Error("Compose did not resolve the persistent PostgreSQL volume name.");
  }
  assert(
    composeConfig.services["example-client"].depends_on["demo-bootstrap"].condition === "service_completed_successfully",
    "Compose blocks example-client startup unless bootstrap exits successfully",
  );
  const postgresBefore = inspectContainer("postgres");
  if (disposable) {
    assert(Object.hasOwn(postgresBefore.HostConfig.Tmpfs ?? {}, "/var/lib/postgresql/data"), "disposable PostgreSQL storage is configured as tmpfs");
  }
  const volumeBefore = disposable ? null : run("docker", ["volume", "inspect", postgresVolumeName, "--format", "{{.Name}}"]);
  const knownDemoIds = new Set(getDemoAccounts().map((account) => account.id));
  const newDemoIds = new Set();
  const baselineDataDigest = preservedDataDigest([]);

  // Remove only completed one-shot service containers; never remove named volumes.
  compose("rm", "-f", "demo-bootstrap", "example-client");
  compose("up", "--build", "-d");
  if (disposable) {
    // A rebuilt backend can be recreated with a different ephemeral host port.
    const published = compose("port", "backend", "3000").trim().split("\n")[0].split(":").at(-1);
    assert(/^[0-9]+$/.test(published ?? ""), "resolved the current disposable backend port after Compose startup");
    const current = new URL(backendBaseUrl);
    const previousPort = current.port;
    current.port = published;
    backendBaseUrl = current.origin;
    if (previousPort !== published) console.log("PASS refreshed changed ephemeral backend port after image rebuild");
  }
  await waitForBackend();
  assert((await (await fetch(new URL("/health", backendBaseUrl))).status) === 200, "/health returns HTTP 200");
  assert((await (await fetch(new URL("/ready", backendBaseUrl))).status) === 200, "/ready returns HTTP 200");

  const first = await verifyRun(knownDemoIds, newDemoIds);
  checkClientFailureExit();
  checkBootstrapFailureBlocksClient();
  const secretProbe = [
    "const fs=require('node:fs');",
    "try{fs.accessSync('/run/demo-secrets/account-api-key');process.exitCode=1}",
    "catch{process.stdout.write('secret file absent')}"
  ].join("");
  const secretProbeOutput = run("docker", [
    "compose", "run", "--rm", "--no-deps",
    "--entrypoint", "node", "demo-bootstrap", "-e", secretProbe,
  ]);
  assert(secretProbeOutput.includes("secret file absent"), "failed bootstrap cleared the previous key and left no reusable file");

  compose("rm", "-f", "demo-bootstrap", "example-client");
  compose("up", "-d", "example-client");
  const second = await verifyRun(knownDemoIds, newDemoIds, first.keyDigest);
  assert(first.accountId !== second.accountId, "second demonstration uses a different fresh account");
  assert(preservedDataDigest([...newDemoIds]) === baselineDataDigest, "all PostgreSQL account, user, usage, and request data predating both demo runs is unchanged");
  if (!disposable) {
    assert(run("docker", ["volume", "inspect", postgresVolumeName, "--format", "{{.Name}}"] ).trim() === volumeBefore.trim(), "the existing PostgreSQL named volume remains present");
  } else {
    assert(inspectContainer("postgres").Id === postgresBefore.Id, "the disposable PostgreSQL container and its tmpfs remain intact across demo reruns");
  }

  const backend = inspectContainer("backend");
  const postgres = inspectContainer("postgres");
  const migration = inspectContainer("migrate");
  assert(backend.State.Status === "running" && backend.State.Health?.Status === "healthy", "backend remains running and healthy after both CLI runs");
  assert(postgres.State.Status === "running" && postgres.State.Health?.Status === "healthy", "PostgreSQL remains running and healthy after both CLI runs");
  assert(migration.State.Status === "exited" && migration.State.ExitCode === 0, "migration and seed initialization completed successfully");
  console.log(`Compose demo verification passed: ${assertionCount} assertions across two fresh accounts.`);
}

try {
  await main();
} catch (error) {
  console.error(`Compose demo verification failed: ${error instanceof Error ? error.message : "unexpected error"}`);
  process.exitCode = 1;
}
