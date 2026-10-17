import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm, lstat, cp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// A clean current-working-tree copy; no Git clone and no main-stack rollout.
const workspaceRoot = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "usage-phase6c-"));
const project = `usage-phase6c-${randomBytes(6).toString("hex")}`;
const root = join(directory, "source");
const configFile = join(directory, "compose.json");
const excluded = new Set([".git", "node_modules", "dist", "dist-client", "coverage", ".aws", ".codex", ".agents"]);
await cp(workspaceRoot, root, { recursive: true, filter: source => {
  const relative = source.slice(workspaceRoot.length + 1);
  const parts = relative.split("/");
  return !parts.some(part => excluded.has(part) || (part.startsWith(".env") && part !== ".env.example") || part.endsWith(".log"));
} });
console.log("PASS copied current working tree, including uncommitted changes, without Git, dependencies, builds or private environment files");
const env = { ...process.env, POSTGRES_DB: "phase6c_app", POSTGRES_USER: "phase6c",
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"), PROVISIONING_TOKEN: randomBytes(32).toString("hex") };
function run(args, { capture = false, environment = env, input, workingDirectory = root } = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd: workingDirectory, env: environment, encoding: "utf8", input,
    maxBuffer: 16 * 1024 * 1024, stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} failed (exit ${result.status ?? "unknown"}); captured diagnostics are withheld to protect secrets`);
  return result.stdout;
}
async function command(args, environment = env) {
  console.log(`COMMAND ${args.join(" ")}`);
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: root, env: environment, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => resolveExit(code));
  });
  console.log(`EXIT ${code}`); assert.equal(code, 0);
}
const config = JSON.parse(run(["docker", "compose", "config", "--format", "json"], { capture: true, workingDirectory: workspaceRoot }));
const mainName = config.name;
const inspect = service => JSON.parse(run(["docker", "inspect", `${mainName}-${service}-1`], { capture: true }))[0];
const mainPostgres = inspect("postgres");
const mainBackend = inspect("backend");

function mainSql(query) {
  return run(["docker", "exec", mainPostgres.Id, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -v ON_ERROR_STOP=1 -c "$1"', "sh", query], { capture: true });
}
function mainSnapshot() {
  return ["accounts", "users", "account_plans", "user_plans", "account_monthly_usage", "user_monthly_usage", "consumption_requests", "pgmigrations"]
    .map(table => mainSql(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM ${table} t`)).join(":");
}
const baseline = mainSnapshot();
const volumeNames = mainPostgres.Mounts.filter(m => m.Type === "volume").map(m => m.Name);
assert.ok(volumeNames.length);
const volumesBefore = run(["docker", "volume", "inspect", ...volumeNames], { capture: true });
const mainDatabasesBefore = mainSql("SELECT datname FROM pg_database ORDER BY datname");
console.log("PASS captured original application full-row fingerprints, database inventory and PostgreSQL volume metadata");

config.name = project;
config.networks = { default: { name: `${project}_default` } };
config.volumes = {};

config.services.postgres.volumes = [];
config.services.postgres.tmpfs = ["/var/lib/postgresql/data"];
for (const service of ["backend", "migrate"]) {
  config.services[service].image = `${project}-backend:acceptance`;
  config.services[service].build = { context: root, dockerfile: "Dockerfile", target: "runtime" };
  config.services[service].volumes = [];
}
config.services.backend.ports = [{ target: 3000, published: "0", protocol: "tcp", mode: "ingress" }];
const secretDirectory = join(directory, "demo-secrets"); await mkdir(secretDirectory, { mode: 0o700 });
for (const service of ["demo-bootstrap", "example-client"]) {
  config.services[service].image = `${project}-${service}:acceptance`;
  config.services[service].build = { context: root, dockerfile: "Dockerfile", target: service };
  config.services[service].volumes = [{ type: "bind", source: secretDirectory, target: "/run/demo-secrets", read_only: service === "example-client" }];
}

await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
env.COMPOSE_FILE = configFile; env.COMPOSE_PROJECT_NAME = project;
const compose = (...args) => run(["docker", "compose", ...args]);
function disposableSql(query) {
  return run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query], { capture: true });
}
async function waitHealthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const id = run(["docker", "compose", "ps", "-q", "backend"], { capture: true }).trim();
    if (id) {
      const state = JSON.parse(run(["docker", "inspect", id], { capture: true }))[0].State;
      if (state.Health?.Status === "healthy") return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error("Disposable backend did not become healthy");
}
let started = false;
try {
  // All mounts must be binds or tmpfs. No persistent PostgreSQL test volume is created.
  for (const service of Object.values(config.services)) {
    assert.ok((service.volumes ?? []).every(mount => mount.type === "bind"));
  }
  await command(["npm", "ci"]);
  await command(["npm", "run", "build"]);
  await command(["npm", "test"]);
  await command(["docker", "compose", "build", "--no-cache"]);
  started = true;
  await command(["docker", "compose", "up", "--build", "-d"]);
  await waitHealthy();
  const port = run(["docker", "compose", "port", "backend", "3000"], { capture: true }).trim().split("\n")[0].split(":").at(-1);
  env.USAGE_API_BASE_URL = `http://127.0.0.1:${port}`; env.PORT = port;
  const pgId = run(["docker", "compose", "ps", "-q", "postgres"], { capture: true }).trim();
  const testPg = JSON.parse(run(["docker", "inspect", pgId], { capture: true }))[0];
  assert.ok(testPg.Id !== mainPostgres.Id && Object.hasOwn(testPg.HostConfig.Tmpfs ?? {}, "/var/lib/postgresql/data"));
  run(["docker", "exec", pgId, "awk", '$2=="/var/lib/postgresql/data" && $3=="tmpfs" {ok=1} END {exit !ok}', "/proc/mounts"], { capture: true });
  console.log("PASS disposable PostgreSQL uses tmpfs and a different container from the main service");

  const backendId = run(["docker", "compose", "ps", "-q", "backend"], { capture: true }).trim();
  for (const folder of ["dist", "migrations"]) {
    for (const entry of await readdir(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = join(entry.parentPath, entry.name);
      const relative = absolute.slice(root.length + 1);
      const expected = createHash("sha256").update(await readFile(absolute)).digest("hex");
      const actual = run(["docker", "exec", backendId, "sha256sum", `/app/${relative}`], { capture: true }).split(/\s/)[0];
      assert.equal(actual, expected, `Built image differs for ${relative}`);
    }
  }
  console.log("PASS fresh runtime image compiled backend and migrations match the clean build (no source bind mount)");
  for (const service of ["backend", "migrate", "demo-bootstrap", "example-client"]) {
    const id = run(["docker", "compose", "ps", "-aq", service], { capture: true }).trim();
    const inspection = JSON.parse(run(["docker", "inspect", id], { capture: true }))[0];
    const probe = `const fs=require('node:fs');const p='/app/';const forbidden=['.git','.env','.env.local','.aws','.codex','tests','src','client'];if(forbidden.some(x=>fs.existsSync(p+x)))process.exit(1);console.log('PASS runtime application directory excludes private source/development files');`;
    run(["docker", "run", "--rm", "--entrypoint", "node", inspection.Config.Image, "-e", probe], { capture: true });
  }
  console.log("PASS fresh application images omit private .env/Git/config files and raw source/tests from /app");

  // Exercise real owned DB creation/drop while failing only a selected runner command.
  const fakeBin = join(directory, "bin"); await mkdir(fakeBin);
  const dockerBinary = run(["which", "docker"], { capture: true }).trim();
  await writeFile(join(fakeBin, "docker"), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
const stage=args.includes('scripts/migrate.mjs')?'migrate':args.includes('seed')?'seed':args.includes('test:db')?'suite':'';
if(stage && stage===process.env.PHASE6B_FAIL_STAGE)process.exit(1);
const r=spawnSync(${JSON.stringify(dockerBinary)},args,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o700 });
  const databaseInventory = disposableSql("SELECT datname FROM pg_database ORDER BY datname");
  for (const stage of ["migrate", "seed", "suite"]) {
    const result = spawnSync(process.execPath, ["scripts/test-db-isolated.mjs"], { cwd: root, encoding: "utf8",
      env: { ...env, PATH: `${fakeBin}${delimiter}${env.PATH}`, PHASE6B_FAIL_STAGE: stage } });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("Temporary test database created.") && result.stdout.includes("was removed."));
    assert.equal(disposableSql("SELECT datname FROM pg_database ORDER BY datname"), databaseInventory);
    console.log(`PASS real runner-owned database cleanup after controlled ${stage} command failure`);
  }
  await command(["npm", "run", "test:db:isolated"]);
  await command(["npm", "run", "test:client:integration"]);
  await command(["npm", "run", "test:compose:demo"], { ...env, PHASE6B_DISPOSABLE: "1" });
  const currentPort = run(["docker", "compose", "port", "backend", "3000"], { capture: true }).trim().split("\n")[0].split(":").at(-1);
  env.USAGE_API_BASE_URL = `http://127.0.0.1:${currentPort}`; env.PORT = currentPort;
  console.log("PASS acceptance API origin refreshed after Compose demo restarts");
  // Successful one-shot state must be observed before inducing an expected failure.
  for (const service of ["migrate", "demo-bootstrap", "example-client"]) {
    const id = run(["docker", "compose", "ps", "-aq", service], { capture: true }).trim();
    const state = JSON.parse(run(["docker", "inspect", id], { capture: true }))[0].State;
    assert.equal(state.Status, "exited"); assert.equal(state.ExitCode, 0);
  }
  console.log("PASS migrations, bootstrap and CLI one-shot services all exited 0 on the fresh deployment");
  // Exercise Compose's dependency gate, not just a standalone failing bootstrap.
  compose("rm", "-f", "demo-bootstrap", "example-client");
  config.services["demo-bootstrap"].environment.PROVISIONING_TOKEN = "";
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const failedBootstrap = spawnSync("docker", ["compose", "up", "-d", "example-client"], { cwd: root, env, encoding: "utf8" });
  assert.ifError(failedBootstrap.error);
  assert.notEqual(failedBootstrap.status, 0);
  const clientId = run(["docker", "compose", "ps", "-aq", "example-client"], { capture: true }).trim();
  assert.ok(clientId);
  const blockedClient = JSON.parse(run(["docker", "inspect", clientId], { capture: true }))[0];
  assert.equal(blockedClient.State.Status, "created");
  await assert.rejects(lstat(join(secretDirectory, "account-api-key")), error => error.code === "ENOENT");
  console.log("PASS orchestrated bootstrap configuration failure blocks CLI startup and clears the old key");
  for (const path of ["/health", "/ready"]) {
    const response = await fetch(env.USAGE_API_BASE_URL + path);
    assert.equal(response.status, 200); console.log(`PASS disposable GET ${path} HTTP 200`);
  }
  run(["docker", "compose", "config"], { capture: true });
  console.log("PASS disposable docker compose config (resolved secrets withheld)");
  await command(["docker", "compose", "ps", "-a"]);
} finally {
  if (started) {
    // Only our uniquely named project is removed; no -v and no Docker volume deletion.
    compose("down", "--timeout", "10");
    console.log("PASS disposable containers/network removed without any volume deletion");
  }
  assert.equal(mainSnapshot(), baseline, "Original application rows changed");
  assert.equal(mainSql("SELECT datname FROM pg_database ORDER BY datname"), mainDatabasesBefore);
  assert.equal(run(["docker", "volume", "inspect", ...volumeNames], { capture: true }), volumesBefore);
  assert.equal(JSON.parse(run(["docker", "inspect", mainBackend.Id], { capture: true }))[0].State.Health.Status, "healthy");
  for (const path of ["/health", "/ready"]) {
    const address = mainBackend.NetworkSettings.Ports["3000/tcp"][0].HostPort;
    assert.equal((await fetch(`http://127.0.0.1:${address}${path}`)).status, 200);
    console.log(`PASS main GET ${path} HTTP 200`);
  }
  console.log("PASS original application rows, database inventory, PostgreSQL volume and healthy backend preserved");
  await rm(directory, { recursive: true, force: true });
  console.log("PASS private test configuration and demo handoff files removed");
}
console.log("Phase 6C clean working-tree deployment and acceptance verification passed.");
