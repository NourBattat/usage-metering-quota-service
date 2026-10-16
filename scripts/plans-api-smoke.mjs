import pg from "pg";
import { buildApp } from "../dist/app.js";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Plan API integration tests require PROVISIONING_TOKEN of at least 32 characters.");
  process.exit(2);
}

const pool = new pg.Pool({ max: 10, connectionTimeoutMillis: 5_000 });
const logLines = [];
const createdAccountIds = [];
const app = buildApp({
  database: pool,
  provisioningToken,
  logger: { level: "info", stream: { write: (line) => logLines.push(line) } },
});
let appClosed = false;
let assertions = 0;
let accountAKey;
let accountBKey;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

async function provisionAccount(name) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: { "x-provisioning-token": provisioningToken },
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Plan API test setup could not create an account (HTTP ${response.statusCode})`);
  }
  const result = response.json();
  createdAccountIds.push(result.account.id);
  return result;
}

async function inject(method, url, apiKey, payload) {
  return app.inject({
    method,
    url,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

try {
  await app.ready();
  const accountA = await provisionAccount("Phase 2C.1 Plan Test A");
  accountAKey = accountA.api_key;
  const accountB = await provisionAccount("Phase 2C.1 Plan Test B");
  accountBKey = accountB.api_key;

  const missingListKey = await inject("GET", "/v1/plans", undefined);
  assert(missingListKey.statusCode === 401, "plan catalog rejects a missing API key");
  const invalidListKey = await inject("GET", "/v1/plans", "invalid-api-key");
  assert(invalidListKey.statusCode === 401, "plan catalog rejects an invalid API key");

  const predefinedList = await inject("GET", "/v1/plans", accountAKey);
  assert(predefinedList.statusCode === 200, "authenticated account can list plans");
  const initialPredefined = predefinedList.json().plans;
  assert(
    initialPredefined.some((plan) => plan.scope === "account" && plan.name === "Starter")
      && initialPredefined.some((plan) => plan.scope === "account" && plan.name === "Pro"),
    "catalog includes predefined account plans",
  );
  assert(
    initialPredefined.some((plan) => plan.scope === "user" && plan.name === "Basic")
      && initialPredefined.some((plan) => plan.scope === "user" && plan.name === "Premium"),
    "catalog includes predefined user plans",
  );
  const accountOnlyCatalog = await inject("GET", "/v1/plans?scope=account", accountAKey);
  assert(
    accountOnlyCatalog.statusCode === 200
      && accountOnlyCatalog.json().plans.every((plan) => plan.scope === "account"),
    "scope filter returns account plans only",
  );
  const userOnlyCatalog = await inject("GET", "/v1/plans?scope=user", accountAKey);
  assert(
    userOnlyCatalog.statusCode === 200
      && userOnlyCatalog.json().plans.every((plan) => plan.scope === "user"),
    "scope filter returns user plans only",
  );

  const missingScope = await inject("GET", "/v1/plans", accountAKey);
  assert(missingScope.statusCode === 200, "catalog is available without an optional scope filter");
  const invalidScope = await inject("GET", "/v1/plans/invalid/00000000-0000-4000-8000-000000000001", accountAKey);
  assert(invalidScope.statusCode === 400, "invalid plan scope is rejected");

  const createAccountPlan = await inject("POST", "/v1/plans/account", accountAKey, {
    name: "A Custom Account Plan",
    monthly_allowance: 25000,
    max_units_per_request: 250,
  });
  assert(createAccountPlan.statusCode === 201, "account can create an account-scoped custom plan");
  const accountPlan = createAccountPlan.json();
  assert(
    accountPlan.scope === "account"
      && accountPlan.is_predefined === false
      && accountPlan.monthly_allowance === "25000"
      && accountPlan.max_units_per_request === "250",
    "created account plan returns the expected scope and numeric limits",
  );

  const createUserPlan = await inject("POST", "/v1/plans/user", accountAKey, {
    name: "A Custom User Plan",
    monthly_allowance: 3000,
    max_units_per_request: 30,
  });
  assert(createUserPlan.statusCode === 201, "account can create a user-scoped custom plan");
  const userPlan = createUserPlan.json();
  assert(userPlan.scope === "user" && userPlan.is_predefined === false, "user plan is in the separate user scope");

  const ownedCatalog = await inject("GET", "/v1/plans", accountAKey);
  assert(
    ownedCatalog.json().plans.some((plan) => plan.id === accountPlan.id)
      && ownedCatalog.json().plans.some((plan) => plan.id === userPlan.id),
    "catalog includes both custom plans owned by the authenticated account",
  );

  const duplicateAccountPlan = await inject("POST", "/v1/plans/account", accountAKey, {
    name: "A Custom Account Plan",
    monthly_allowance: 100,
    max_units_per_request: 1,
  });
  assert(duplicateAccountPlan.statusCode === 409, "duplicate custom plan name returns HTTP 409");

  const foreignList = await inject("GET", "/v1/plans", accountBKey);
  assert(
    !foreignList.json().plans.some((plan) => plan.id === accountPlan.id || plan.id === userPlan.id),
    "another account's custom plans are excluded from the catalog",
  );
  const foreignGet = await inject("GET", `/v1/plans/account/${accountPlan.id}`, accountBKey);
  assert(foreignGet.statusCode === 404, "another account cannot retrieve a custom plan");
  const foreignUserPlanGet = await inject("GET", `/v1/plans/user/${userPlan.id}`, accountBKey);
  assert(foreignUserPlanGet.statusCode === 404, "another account cannot retrieve a custom user plan");
  const ownedGet = await inject("GET", `/v1/plans/account/${accountPlan.id}`, accountAKey);
  assert(ownedGet.statusCode === 200 && ownedGet.json().id === accountPlan.id, "owner can retrieve its custom plan");

  const updateAccountPlan = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountAKey, {
    name: "A Custom Account Plan Updated",
    monthly_allowance: 26000,
    max_units_per_request: 260,
  });
  assert(updateAccountPlan.statusCode === 200, "owner can update a custom plan");
  assert(
    updateAccountPlan.json().name === "A Custom Account Plan Updated"
      && updateAccountPlan.json().monthly_allowance === "26000"
      && updateAccountPlan.json().max_units_per_request === "260",
    "updated custom plan returns new values",
  );

  const storedUpdate = await pool.query(
    "SELECT name, monthly_allowance, max_units_per_request, owner_account_id, is_predefined FROM account_plans WHERE id = $1",
    [accountPlan.id],
  );
  assert(
    storedUpdate.rows[0]?.name === "A Custom Account Plan Updated"
      && storedUpdate.rows[0]?.monthly_allowance === "26000"
      && storedUpdate.rows[0]?.owner_account_id === accountA.account.id
      && storedUpdate.rows[0]?.is_predefined === false,
    "plan update persists in PostgreSQL without changing ownership or predefined status",
  );

  const updateUserPlan = await inject("PATCH", `/v1/plans/user/${userPlan.id}`, accountAKey, {
    monthly_allowance: 3500,
  });
  assert(updateUserPlan.statusCode === 200 && updateUserPlan.json().monthly_allowance === "3500", "owner can update a user plan limit");

  const foreignUpdate = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountBKey, {
    monthly_allowance: 999,
  });
  assert(foreignUpdate.statusCode === 404, "another account cannot update a custom plan");
  const foreignUserUpdate = await inject("PATCH", `/v1/plans/user/${userPlan.id}`, accountBKey, {
    monthly_allowance: 999,
  });
  assert(foreignUserUpdate.statusCode === 404, "another account cannot update a custom user plan");

  const predefinedId = initialPredefined.find((plan) => plan.scope === "account" && plan.name === "Starter").id;
  const predefinedGet = await inject("GET", `/v1/plans/account/${predefinedId}`, accountBKey);
  assert(predefinedGet.statusCode === 200, "predefined plans are visible to every authenticated account");
  const predefinedUpdate = await inject("PATCH", `/v1/plans/account/${predefinedId}`, accountAKey, {
    monthly_allowance: 999,
  });
  assert(predefinedUpdate.statusCode === 403, "editing a predefined plan is rejected");
  const basicId = initialPredefined.find((plan) => plan.scope === "user" && plan.name === "Basic").id;
  const predefinedUserUpdate = await inject("PATCH", `/v1/plans/user/${basicId}`, accountAKey, {
    monthly_allowance: 999,
  });
  assert(predefinedUserUpdate.statusCode === 403, "editing a predefined user plan is rejected");

  const invalidBodies = [
    [{ name: "Negative Allowance", monthly_allowance: -1, max_units_per_request: 1 }, "negative allowance"],
    [{ name: "Zero Request Limit", monthly_allowance: 1, max_units_per_request: 0 }, "zero request limit"],
    [{ name: "Decimal Allowance", monthly_allowance: 1.5, max_units_per_request: 1 }, "decimal allowance"],
    [{ name: "String Allowance", monthly_allowance: "100", max_units_per_request: 1 }, "string allowance"],
    [{ name: "Boolean Request Limit", monthly_allowance: 100, max_units_per_request: true }, "boolean request limit"],
    [{ name: 123, monthly_allowance: 100, max_units_per_request: 1 }, "non-string plan name"],
    [{ name: "Unsafe Allowance", monthly_allowance: Number.MAX_SAFE_INTEGER + 1, max_units_per_request: 1 }, "unsafe integer"],
    [{ name: "Out of Range Allowance", monthly_allowance: 9_000_000_000_000_001, max_units_per_request: 1 }, "allowance over database maximum"],
    [{ name: "Large Request Limit", monthly_allowance: 1, max_units_per_request: 1_000_001 }, "request limit over database maximum"],
    [{ name: "Unknown Field", monthly_allowance: 1, max_units_per_request: 1, owner_account_id: accountB.account.id }, "client-controlled ownership"],
  ];
  for (const [body, label] of invalidBodies) {
    const response = await inject("POST", "/v1/plans/account", accountAKey, body);
    assert(response.statusCode === 400, `invalid ${label} is rejected`);
  }

  const invalidUpdate = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountAKey, {
    monthly_allowance: 3.14,
  });
  assert(invalidUpdate.statusCode === 400, "decimal plan update is rejected");
  const ownershipUpdate = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountAKey, {
    owner_account_id: accountB.account.id,
  });
  assert(ownershipUpdate.statusCode === 400, "client cannot change plan ownership");
  const predefinedFlagUpdate = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountAKey, {
    is_predefined: true,
  });
  assert(predefinedFlagUpdate.statusCode === 400, "client cannot change predefined status");
  const emptyUpdate = await inject("PATCH", `/v1/plans/account/${accountPlan.id}`, accountAKey, {});
  assert(emptyUpdate.statusCode === 400, "empty plan update is rejected");

  const missingPlan = await inject("GET", "/v1/plans/user/70000000-0000-4000-8000-000000000001", accountAKey);
  assert(missingPlan.statusCode === 404, "unknown plan returns HTTP 404");
  const invalidGetKey = await inject("GET", `/v1/plans/account/${accountPlan.id}`, "invalid-api-key");
  assert(invalidGetKey.statusCode === 401, "plan retrieval rejects an invalid API key");
  const missingCreateKey = await app.inject({
    method: "POST",
    url: "/v1/plans/user",
    payload: { name: "Unauthenticated", monthly_allowance: 1, max_units_per_request: 1 },
  });
  assert(missingCreateKey.statusCode === 401, "plan creation rejects a missing API key");

  const beforeCustomPlanRows = await pool.query(
    "SELECT count(*)::int AS count FROM account_plans WHERE owner_account_id = $1",
    [accountA.account.id],
  );
  assert(beforeCustomPlanRows.rows[0]?.count === 1, "invalid and duplicate requests created no extra account plans");
  assert(!logLines.join("").includes(accountAKey) && !logLines.join("").includes(accountBKey), "plan route logs do not contain API keys");

  console.log(`Plan API integration tests passed: ${assertions} assertions`);
} catch (error) {
  console.error("Plan API integration tests failed:", error);
  process.exitCode = 1;
} finally {
  if (!appClosed) {
    try {
      await app.close();
      appClosed = true;
    } catch (error) {
      console.error("Could not close plan integration app:", error);
    }
  }
  try {
    if (createdAccountIds.length > 0) {
      await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [createdAccountIds]);
      const remaining = await pool.query(
        "SELECT count(*)::int AS count FROM accounts WHERE id = ANY($1::uuid[])",
        [createdAccountIds],
      );
      assert(remaining.rows[0]?.count === 0, "integration cleanup removed only its owned test accounts");
    }
  } catch (error) {
    console.error("Could not clean up plan test accounts:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
