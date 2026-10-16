import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const provisioningToken = process.env.PROVISIONING_TOKEN;
if (!provisioningToken || provisioningToken.length < 32) {
  console.error("Client integration requires a configured backend provisioning token.");
  process.exit(2);
}

let accountId;
let accountApiKey;
let assertions = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
}

async function runCli(apiKey) {
  const cliPath = fileURLToPath(new URL("../dist-client/cli.js", import.meta.url));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    USAGE_API_BASE_URL: process.env.USAGE_API_BASE_URL ?? "http://127.0.0.1:3000",
    USAGE_API_KEY: apiKey,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => reject(new Error("Could not start the compiled example client.")));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function getApiJson(baseUrl, path, apiKey) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
      headers: { "x-api-key": apiKey },
    });
  } catch {
    throw new Error("Could not verify the temporary account through the backend HTTP API.");
  }
  if (response.status !== 200) {
    throw new Error(`Backend verification returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Backend verification returned invalid JSON.");
  }
}

function deleteTemporaryAccount(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Temporary account ID is invalid; refusing database cleanup.");
  }
  const user = process.env.POSTGRES_USER ?? "usage_metering";
  const database = process.env.POSTGRES_DB ?? "usage_metering";
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "compose", "exec", "-T", "postgres", "psql",
      "-U", user,
      "-d", database,
      "-v", "ON_ERROR_STOP=1",
      "-qAtc", `DELETE FROM accounts WHERE id='${id}' RETURNING id`,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => reject(new Error("Could not start scoped temporary-account cleanup through Docker Compose.")));
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("Scoped temporary-account cleanup failed."));
      resolve(stdout.trim());
    });
  });
}

try {
  const baseUrl = process.env.USAGE_API_BASE_URL ?? "http://127.0.0.1:3000";
  const provisionResponse = await fetch(new URL("/v1/accounts", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provisioning-token": provisioningToken,
    },
    body: JSON.stringify({ name: `Temporary CLI Integration ${randomUUID()}` }),
  });
  if (provisionResponse.status !== 201) {
    throw new Error(`Temporary account provisioning failed with HTTP ${provisionResponse.status}.`);
  }
  const provisioned = await provisionResponse.json();
  accountId = provisioned?.account?.id;
  accountApiKey = provisioned?.api_key;
  if (typeof accountId !== "string" || typeof accountApiKey !== "string") {
    throw new Error("Temporary account provisioning returned an incomplete response.");
  }
  assert(true, "test harness provisioned one dedicated temporary account over HTTP");

  const result = await runCli(accountApiKey);
  assert(result.code === 0, `CLI demonstration exited successfully (exit ${result.code}): ${result.stderr || "no diagnostic output"}`);
  assert(result.stdout.includes("Final account usage: 45 / 100000; remaining 99955 (Pro)."), "CLI displayed expected account usage and Pro allowance");
  assert(result.stdout.includes("Ahmad usage: 10 / 1000; remaining 990 (Basic)."), "CLI displayed expected Ahmad usage and Basic allowance");
  assert(result.stdout.includes("Sara usage: 35 / 5000; remaining 4965 (Premium)."), "CLI displayed expected Sara usage and Premium allowance");
  assert(result.stdout.includes("REJECTED (user max_units_per_request"), "CLI displayed the user-level rejection reason");
  assert(result.stdout.includes("REJECTED (account monthly_allowance"), "CLI displayed the account-level rejection reason");
  assert(result.stdout.includes("replayed without an extra charge"), "CLI demonstrated an exact idempotent retry");
  assert(!result.stdout.includes(accountApiKey) && !result.stderr.includes(accountApiKey), "CLI output does not reveal the account API key");
  assert(!result.stdout.includes(provisioningToken) && !result.stderr.includes(provisioningToken), "CLI output does not reveal the provisioning token");
  assert(!result.stderr.includes("PROVISIONING_TOKEN"), "provisioning configuration was not passed to the CLI process");

  const accountUsage = await getApiJson(baseUrl, "/v1/usage/account", accountApiKey);
  const usersResult = await getApiJson(baseUrl, "/v1/users", accountApiKey);
  const users = usersResult.users;
  if (!Array.isArray(users) || users.length !== 2) throw new Error("Backend verification did not return the two expected users.");
  const usageByName = new Map();
  for (const user of users) {
    const usage = await getApiJson(baseUrl, `/v1/users/${encodeURIComponent(user.id)}/usage`, accountApiKey);
    usageByName.set(user.name, usage);
  }
  const historyResult = await getApiJson(baseUrl, "/v1/requests?limit=100", accountApiKey);
  const decisions = historyResult.history;
  assert(accountUsage.used_units === "45", "backend account report confirms 45 accepted units");
  assert(usageByName.get("Ahmad")?.used_units === "10", "backend report confirms Ahmad used 10 units");
  assert(usageByName.get("Sara")?.used_units === "35", "backend report confirms Sara used 35 units");
  assert(Array.isArray(decisions) && decisions.length === 5, "backend history contains five unique decisions after the replay");
  assert(decisions.filter((item) => item.status === "accepted").length === 3, "backend history contains three accepted decisions");
  assert(decisions.filter((item) => item.status === "rejected").length === 2, "backend history contains two quota rejections");
  assert(new Set(decisions.map((item) => item.request_id)).size === 5, "idempotent replay created no additional history row");

  console.log(`Client integration tests passed: ${assertions} assertions`);
} catch (error) {
  let message = error instanceof Error ? error.message : "Unexpected integration error";
  for (const secret of [accountApiKey, provisioningToken]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  console.error(`Client integration test failed: ${message}`);
  process.exitCode = 1;
} finally {
  try {
    if (accountId) {
      const cleanup = await deleteTemporaryAccount(accountId);
      if (cleanup !== accountId) {
        console.error("Could not confirm cleanup of the dedicated temporary account.");
        process.exitCode = 1;
      } else {
        console.log("PASS integration cleanup deleted only the dedicated temporary account");
      }
    }
  } catch {
    console.error("Temporary account cleanup failed; no unrelated accounts were targeted.");
    process.exitCode = 1;
  } finally {
    accountApiKey = undefined;
  }
}
