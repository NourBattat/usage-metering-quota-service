import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createIsolatedDatabaseName } from "./test-db-isolated.mjs";

test("temporary integration database names are fresh and constrained to the dedicated test prefix", () => {
  const first = createIsolatedDatabaseName();
  const second = createIsolatedDatabaseName();
  const pattern = /^usage_metering_test_[a-z0-9_]+$/;

  assert.match(first, pattern);
  assert.match(second, pattern);
  assert.notEqual(first, second);
  assert.notEqual(first, "usage_metering");
  assert.notEqual(second, "usage_metering");
  assert.ok(first.length <= 63 && second.length <= 63);
});

// This executable records Docker arguments without contacting Docker or PostgreSQL.
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AUDIT_COMMAND_LOG, JSON.stringify(args) + '\\n');
const operation = args.includes('printenv') ? 'inspect'
  : args.some(x => x.includes('createdb ')) ? 'create'
  : args.some(x => x.includes('dropdb ')) ? 'drop'
  : args.includes('scripts/migrate.mjs') ? 'migrate'
  : args.includes('seed') ? 'seed' : 'suite';
if (operation === 'inspect') process.stdout.write(process.env.AUDIT_APPLICATION_DB);
if (process.env.AUDIT_FAIL === operation) process.exit(1);
`;

async function runWithFakeDocker(t, { name, fail = "", applicationDatabase = "usage_metering" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "quota-runner-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "docker"), fakeDocker, { mode: 0o700 });
  const log = join(directory, "commands.jsonl");
  await writeFile(log, "");
  const runnerUrl = new URL("./test-db-isolated.mjs", import.meta.url).href;
  const code = `import { runIsolatedDatabaseTests } from ${JSON.stringify(runnerUrl)};
    await runIsolatedDatabaseTests(${JSON.stringify(name === undefined ? {} : { name })});`;
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, AUDIT_COMMAND_LOG: log,
    AUDIT_FAIL: fail, AUDIT_APPLICATION_DB: applicationDatabase };
  // Child CLIs must not inherit Node's internal test-reporter IPC protocol.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env,
  });
  assert.ifError(result.error);
  const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { ...result, calls };
}

test("unsafe names are rejected before any Docker operation", async t => {
  for (const name of ["usage_metering", "postgres", "template1", "usage_metering_test_legacy",
    "usage_metering_test_1_" + "a".repeat(64), "usage_metering_test_1_abc;DROP DATABASE postgres", null]) {
    const result = await runWithFakeDocker(t, { name });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
});

test("even a correctly shaped application database name is never created or dropped", async t => {
  const name = createIsolatedDatabaseName();
  const result = await runWithFakeDocker(t, { name, applicationDatabase: name });
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 1);
  assert.ok(result.calls[0].includes("printenv"));
});

test("unknown application database configuration prevents all mutations", async t => {
  const result = await runWithFakeDocker(t, { applicationDatabase: "" });
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 1);
  assert.ok(result.calls[0].includes("printenv"));
});

test("success runs migrations, seed, and the entire suite before dropping only its database", async t => {
  const result = await runWithFakeDocker(t);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.calls)}`);
  assert.equal(result.calls.length, 6);
  const name = result.calls[1].at(-1);
  assert.equal(result.calls[5].at(-1), name);
  for (const [index, expected] of [[2, "scripts/migrate.mjs"], [3, "seed"], [4, "test:db"]]) {
    assert.ok(result.calls[index].includes(`PGDATABASE=${name}`));
    assert.ok(result.calls[index].includes(expected));
  }
  assert.ok(result.calls[5].some(arg => arg.startsWith("dropdb ")));
});

for (const fail of ["migrate", "seed", "suite", "drop"]) {
  test(`${fail} failure exits nonzero and attempts cleanup only for the created database`, async t => {
    const result = await runWithFakeDocker(t, { fail });
    assert.equal(result.status, 1);
    const createdName = result.calls[1].at(-1);
    const cleanup = result.calls.at(-1);
    assert.ok(cleanup.some(arg => arg.startsWith("dropdb ")));
    assert.equal(cleanup.at(-1), createdName);
    assert.equal(result.calls.filter(args => args.some(arg => arg.startsWith("dropdb "))).length, 1);
  });
}

for (const fail of ["inspect", "create"]) {
  test(`${fail} failure never drops an unowned or preexisting database`, async t => {
    const result = await runWithFakeDocker(t, { fail });
    assert.equal(result.status, 1);
    assert.ok(!result.calls.some(args => args.some(arg => arg.startsWith("dropdb "))));
  });
}
