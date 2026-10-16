import { createHash } from "node:crypto";
import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("User API integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 10, connectionTimeoutMillis: 5_000 });
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
let appClosed = false;
let accountAKey;
let accountBKey;

function assert(condition, label) {
  if (!condition) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Test setup could not provision account (HTTP ${response.statusCode})`);
  }
  const result = response.json();
  createdAccountIds.push(result.account.id);
  return result;
}

async function createUser(apiKey, payload) {
  return app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": apiKey },
    payload,
  });
}

try {
  await app.ready();

  const accountA = await provisionAccount("Phase 2B User Integration Account A");
  accountAKey = accountA.api_key;
  const accountB = await provisionAccount("Phase 2B User Integration Account B");
  accountBKey = accountB.api_key;
  assert(accountA.account.id !== accountB.account.id, "integration creates two distinct accounts");

  const missingKey = await app.inject({ method: "POST", url: "/v1/users", payload: { name: "No Key User" } });
  assert(missingKey.statusCode === 401, "user creation rejects a missing API key");
  const invalidKey = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": "not-a-valid-api-key" },
    payload: { name: "Invalid Key User" },
  });
  assert(invalidKey.statusCode === 401, "user creation rejects an invalid API key");

  const missingName = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": accountAKey },
    payload: {},
  });
  assert(missingName.statusCode === 400, "user creation rejects a missing name");
  const blankName = await createUser(accountAKey, { name: "   " });
  assert(blankName.statusCode === 400, "user creation rejects a blank name");
  const numericName = await createUser(accountAKey, { name: 123 });
  assert(numericName.statusCode === 400, "user creation rejects a non-string name without coercion");
  const extraAccountId = await createUser(accountAKey, {
    name: "Client Ownership Override",
    account_id: accountB.account.id,
  });
  assert(extraAccountId.statusCode === 400, "client-provided account_id is rejected by request validation");

  const userA1Response = await createUser(accountAKey, { name: "Account A User One" });
  assert(userA1Response.statusCode === 201, "valid API key creates a user with HTTP 201");
  const userA1 = userA1Response.json();
  assert(userA1.plan?.name === "Basic", "new user receives the predefined Basic plan");
  assert(
    userA1.plan?.monthly_allowance === "1000"
      && userA1.plan?.max_units_per_request === "20",
    "Basic plan response includes the documented project assumptions",
  );

  const userA2Response = await createUser(accountAKey, { name: "Account A User Two" });
  assert(userA2Response.statusCode === 201, "second user can be created in Account A");
  const userA2 = userA2Response.json();
  assert(userA1.id !== userA2.id, "users created in the same account have separate IDs");

  const userBResponse = await createUser(accountBKey, { name: "Account B User One" });
  assert(userBResponse.statusCode === 201, "user can be created in separate Account B");
  const userB = userBResponse.json();

  const storedUsers = await pool.query(
    "SELECT id, account_id, user_plan_id, user_plan_owner_account_id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[userA1.id, userA2.id, userB.id]],
  );
  assert(storedUsers.rows.length === 3, "database contains the three created integration users");
  assert(
    storedUsers.rows.filter((row) => row.account_id === accountA.account.id).length === 2
      && storedUsers.rows.find((row) => row.id === userB.id)?.account_id === accountB.account.id,
    "authenticated account IDs, not request bodies, determine user ownership",
  );
  const basicPlan = await pool.query(
    "SELECT id FROM user_plans WHERE name = 'Basic' AND owner_account_id IS NULL AND is_predefined = true",
  );
  assert(
    storedUsers.rows.every((row) => row.user_plan_id === basicPlan.rows[0]?.id)
      && storedUsers.rows.every((row) => row.user_plan_owner_account_id === null),
    "all new users reference the shared predefined Basic plan with no owner",
  );

  const listA = await app.inject({
    method: "GET",
    url: "/v1/users",
    headers: { "x-api-key": accountAKey },
  });
  assert(listA.statusCode === 200, "authenticated account can list its users");
  const listedA = listA.json().users;
  assert(
    listedA.length === 2
      && listedA.some((user) => user.id === userA1.id)
      && listedA.some((user) => user.id === userA2.id),
    "Account A list includes both Account A users",
  );
  const repeatedListA = await app.inject({
    method: "GET",
    url: "/v1/users",
    headers: { "x-api-key": accountAKey },
  });
  assert(
    repeatedListA.json().users.map((user) => user.id).join(",")
      === listedA.map((user) => user.id).join(","),
    "user list ordering is stable across repeated requests",
  );
  assert(
    !listedA.some((user) => user.id === userB.id),
    "Account A list excludes Account B users",
  );
  assert(
    !JSON.stringify(listA.json()).includes("account_id")
      && !JSON.stringify(listA.json()).includes("api_key_hash"),
    "user list omits internal ownership columns and secrets",
  );

  const getUser = await app.inject({
    method: "GET",
    url: `/v1/users/${userA1.id}`,
    headers: { "x-api-key": accountAKey },
  });
  assert(getUser.statusCode === 200 && getUser.json().id === userA1.id, "account can retrieve its user by ID");

  const foreignUser = await app.inject({
    method: "GET",
    url: `/v1/users/${userB.id}`,
    headers: { "x-api-key": accountAKey },
  });
  assert(foreignUser.statusCode === 404, "cross-account user lookup returns 404");
  assert(
    JSON.stringify(foreignUser.json()) === JSON.stringify({ error: "User not found" }),
    "cross-account and missing users have the same response",
  );

  const unknownUser = await app.inject({
    method: "GET",
    url: "/v1/users/60000000-0000-4000-8000-000000000001",
    headers: { "x-api-key": accountAKey },
  });
  assert(unknownUser.statusCode === 404, "unknown user ID returns 404");
  const missingListKey = await app.inject({ method: "GET", url: "/v1/users" });
  assert(missingListKey.statusCode === 401, "user listing rejects a missing API key");
  const invalidListKey = await app.inject({
    method: "GET",
    url: "/v1/users",
    headers: { "x-api-key": "not-a-valid-api-key" },
  });
  assert(invalidListKey.statusCode === 401, "user listing rejects an invalid API key");

  const userAuthKeyHash = createHash("sha256").update(accountAKey, "utf8").digest("hex");
  assert(
    !logLines.join("").includes(accountAKey)
      && !logLines.join("").includes(accountBKey)
      && !logLines.join("").includes(provisioningToken)
      && !logLines.join("").includes(userAuthKeyHash),
    "application logs contain no API keys, provisioning token, or API key hashes",
  );

  const accountLockClient = await pool.connect();
  let accountLockHeld = false;
  try {
    await accountLockClient.query("BEGIN");
    await accountLockClient.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountA.account.id]);
    accountLockHeld = true;
    let creationFinished = false;
    const pendingCreation = createUser(accountAKey, { name: "Account A Lock-Test User" }).finally(() => {
      creationFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!creationFinished, "user registration waits for the authenticated account lock");
    await accountLockClient.query("COMMIT");
    accountLockHeld = false;
    const serializedCreation = await pendingCreation;
    assert(serializedCreation.statusCode === 201, "user registration continues after the account lock is released");
  } finally {
    if (accountLockHeld) await accountLockClient.query("ROLLBACK");
    accountLockClient.release();
  }

  console.log("Scenario verified: Account A has two users; Account B has one; Account A receives 404 for Account B's user.");
} catch (error) {
  console.error("User API integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close integration Fastify app cleanly:", error);
    }
  }

  try {
    if (createdAccountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [createdAccountIds]);
    }
  } catch (error) {
    console.error("Could not clean up integration accounts using the configured PostgreSQL pool:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
