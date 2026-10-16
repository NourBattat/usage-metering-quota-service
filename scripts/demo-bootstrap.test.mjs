import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDemoBootstrap } from "./demo-bootstrap.mjs";

const PROVISIONING_TOKEN = "unit-test-provisioning-token-that-is-long-enough";
const ACCOUNT_API_KEY = "unit-test-account-api-key-never-print-this-value";
const CLIENT_UID = typeof process.getuid === "function" ? process.getuid() : 1000;
const CLIENT_GID = typeof process.getgid === "function" ? process.getgid() : 1000;

async function makeSecretDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "quota-demo-secret-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  });
  return directory;
}

function bootstrapOptions(directory, overrides = {}) {
  return {
    env: {
      PROVISIONING_TOKEN,
      DEMO_API_BASE_URL: "http://backend:3000",
      DEMO_SECRET_DIR: directory,
      DEMO_CLIENT_UID: String(CLIENT_UID),
      DEMO_CLIENT_GID: String(CLIENT_GID),
      ...overrides,
    },
    dropPrivilegesAfterSetup: false,
  };
}

test("provisions a new account over HTTP and atomically hands off a mode-0400 key", async (t) => {
  const directory = await makeSecretDirectory(t);
  const messages = [];
  let requests = 0;
  const fetchImplementation = async (url, init) => {
    requests += 1;
    assert.equal(String(url), "http://backend:3000/v1/accounts");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-provisioning-token"], PROVISIONING_TOKEN);
    assert.deepEqual(JSON.parse(init.body).name.startsWith("Compose Demo "), true);
    return new Response(JSON.stringify({ account: { id: "10000000-0000-4000-8000-000000000001" }, api_key: ACCOUNT_API_KEY }), { status: 201 });
  };

  await runDemoBootstrap({ ...bootstrapOptions(directory), fetchImplementation, writeLine: (message) => messages.push(message) });

  const keyPath = join(directory, "account-api-key");
  assert.equal((await readFile(keyPath, "utf8")).trim(), ACCOUNT_API_KEY);
  const keyInfo = await stat(keyPath);
  assert.equal(keyInfo.mode & 0o777, 0o400);
  assert.equal(keyInfo.uid, CLIENT_UID);
  assert.equal(keyInfo.gid, CLIENT_GID);
  assert.deepEqual(await readdir(directory), ["account-api-key"]);
  assert.equal(requests, 1);
  assert.ok(messages.every((message) => !message.includes(PROVISIONING_TOKEN) && !message.includes(ACCOUNT_API_KEY)));
});

test("clears an old key before failing when provisioning configuration is missing", async (t) => {
  const directory = await makeSecretDirectory(t);
  await writeFile(join(directory, "account-api-key"), ACCOUNT_API_KEY, { mode: 0o400 });
  const options = bootstrapOptions(directory, { PROVISIONING_TOKEN: undefined });

  await assert.rejects(runDemoBootstrap(options), /valid server-side PROVISIONING_TOKEN/);
  assert.deepEqual(await readdir(directory), []);
});

test("clears an old key on backend error and never prints the response body", async (t) => {
  const directory = await makeSecretDirectory(t);
  await writeFile(join(directory, "account-api-key"), ACCOUNT_API_KEY, { mode: 0o400 });
  const messages = [];

  await assert.rejects(runDemoBootstrap({
    ...bootstrapOptions(directory),
    fetchImplementation: async () => new Response(JSON.stringify({ error: ACCOUNT_API_KEY }), { status: 503 }),
    writeLine: (message) => messages.push(message),
  }), /failed with HTTP 503/);
  assert.deepEqual(await readdir(directory), []);
  assert.ok(messages.every((message) => !message.includes(ACCOUNT_API_KEY) && !message.includes(PROVISIONING_TOKEN)));
});

test("does not leave a key file after a malformed successful response", async (t) => {
  const directory = await makeSecretDirectory(t);
  await assert.rejects(runDemoBootstrap({
    ...bootstrapOptions(directory),
    fetchImplementation: async () => new Response(JSON.stringify({ account: { id: "10000000-0000-4000-8000-000000000001" }, api_key: "short" }), { status: 201 }),
  }), /did not contain a usable new account key/);
  assert.deepEqual(await readdir(directory), []);
});

test("Compose separates bootstrap authority, client key file, and successful-start dependencies", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const bootstrapService = compose.split("  demo-bootstrap:\n")[1].split("\n  example-client:")[0];
  const clientService = compose.split("  example-client:\n")[1].split("\nvolumes:")[0];

  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(bootstrapService, /PROVISIONING_TOKEN:/);
  assert.doesNotMatch(clientService, /PROVISIONING_TOKEN|POSTGRES_PASSWORD|PGPASSWORD/);
  assert.match(clientService, /USAGE_API_KEY_FILE: \/run\/demo-secrets\/account-api-key/);
  assert.match(clientService, /demo_api_key:\/run\/demo-secrets:ro/);
  assert.match(dockerfile, /FROM node:22-alpine AS demo-bootstrap/);
  assert.match(dockerfile, /FROM node:22-alpine AS example-client/);
  assert.match(dockerfile, /USER node\nENTRYPOINT \["node", "\/app\/dist-client\/cli.js"\]/);
});
