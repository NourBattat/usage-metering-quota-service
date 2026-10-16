import { createHash } from "node:crypto";
import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Account API integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 5, connectionTimeoutMillis: 5_000 });
const logLines = [];
const createdAccountIds = [];
const app = buildApp({
  database: pool,
  provisioningToken,
  logger: {
    level: "info",
    stream: { write: (line) => logLines.push(line) },
  },
});
let assertions = 0;
let firstApiKey;
let secondApiKey;
let appClosed = false;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
}

async function createAccount(name, token = provisioningToken) {
  return app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: typeof token === "string" ? { "x-provisioning-token": token } : {},
    payload: { name },
  });
}

try {
  await app.ready();

  const missingToken = await createAccount("Provisioning Missing Token", null);
  assert(missingToken.statusCode === 401, "missing provisioning token is rejected");
  const invalidToken = await createAccount("Provisioning Invalid Token", "incorrect-token");
  assert(invalidToken.statusCode === 401, "invalid provisioning token is rejected");

  const firstResponse = await createAccount("Phase 2A Integration Account A");
  assert(firstResponse.statusCode === 201, "valid provisioning token creates an account");
  const first = firstResponse.json();
  createdAccountIds.push(first.account.id);
  firstApiKey = first.api_key;
  assert(typeof firstApiKey === "string" && firstApiKey.length >= 40, "new account receives a secure API key once");
  assert(
    !JSON.stringify(first).includes("api_key_hash"),
    "account creation response does not expose the stored hash",
  );
  assert(first.account.plan?.name === "Starter", "new account receives the predefined Starter plan");

  const secondResponse = await createAccount("Phase 2A Integration Account B");
  assert(secondResponse.statusCode === 201, "provisioning supports creating a second account");
  const second = secondResponse.json();
  createdAccountIds.push(second.account.id);
  secondApiKey = second.api_key;
  assert(first.account.id !== second.account.id, "two provisioned accounts have different IDs");
  assert(firstApiKey !== secondApiKey, "separate accounts receive different API keys");

  const firstStoredKey = await pool.query(
    "SELECT api_key_hash FROM accounts WHERE id = $1",
    [first.account.id],
  );
  const secondStoredKey = await pool.query(
    "SELECT api_key_hash FROM accounts WHERE id = $1",
    [second.account.id],
  );
  const firstHash = createHash("sha256").update(firstApiKey, "utf8").digest("hex");
  const secondHash = createHash("sha256").update(secondApiKey, "utf8").digest("hex");
  assert(firstStoredKey.rows[0]?.api_key_hash === firstHash, "database stores only the first API key SHA-256 hash");
  assert(secondStoredKey.rows[0]?.api_key_hash === secondHash, "database stores only the second API key SHA-256 hash");
  assert(
    firstStoredKey.rows[0]?.api_key_hash !== firstApiKey
      && secondStoredKey.rows[0]?.api_key_hash !== secondApiKey,
    "plaintext API keys are not stored in account rows",
  );

  const missingApiKey = await app.inject({ method: "GET", url: "/v1/accounts/me" });
  assert(missingApiKey.statusCode === 401, "missing API key is rejected");
  const invalidApiKey = await app.inject({
    method: "GET",
    url: "/v1/accounts/me",
    headers: { "x-api-key": "invalid-api-key" },
  });
  assert(invalidApiKey.statusCode === 401, "invalid API key is rejected");

  const firstMe = await app.inject({
    method: "GET",
    url: "/v1/accounts/me",
    headers: { "x-api-key": firstApiKey },
  });
  assert(firstMe.statusCode === 200, "valid first API key accesses its account information");
  const firstMeBody = firstMe.json();
  assert(firstMeBody.id === first.account.id, "authenticated account lookup resolves the account from its API key");
  assert(firstMeBody.plan?.name === "Starter", "account information includes the assigned Starter plan");
  assert(
    !JSON.stringify(firstMeBody).includes("api_key_hash")
      && !JSON.stringify(firstMeBody).includes(firstApiKey),
    "account information never exposes key hashes or plaintext keys",
  );

  const secondMe = await app.inject({
    method: "GET",
    url: `/v1/accounts/me?account_id=${second.account.id}`,
    headers: { "x-api-key": firstApiKey },
  });
  assert(secondMe.statusCode === 200, "account A can only use the authenticated /me resource");
  assert(
    secondMe.json().id === first.account.id
      && secondMe.json().id !== second.account.id,
    "client-supplied account_id cannot switch the authenticated account",
  );

  await app.close();
  appClosed = true;
  const combinedLogs = logLines.join("");
  assert(
    !combinedLogs.includes(provisioningToken),
    "provisioning token never appears in application logs",
  );
  assert(
    !combinedLogs.includes(firstApiKey) && !combinedLogs.includes(secondApiKey),
    "plaintext API keys never appear in application logs",
  );

  console.log(`Account API integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Account API integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
    } catch {
      // The app may already be closed after the log inspection.
    }
  }
  if (createdAccountIds.length > 0) {
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [createdAccountIds]);
  }
  await pool.end();
}
