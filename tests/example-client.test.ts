import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaApiClient } from "../client/src/api.js";
import { loadClientConfig } from "../client/src/config.js";
import { runExampleDemo } from "../client/src/demo.js";

const API_KEY = "test-account-key-never-print-this";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const AHMAD_ID = "20000000-0000-4000-8000-000000000001";
const SARA_ID = "20000000-0000-4000-8000-000000000002";

const accountStarter = {
  id: "30000000-0000-4000-8000-000000000001",
  scope: "account" as const,
  name: "Starter",
  monthly_allowance: "10000",
  max_units_per_request: "100",
  is_predefined: true,
};
const accountPro = {
  id: "30000000-0000-4000-8000-000000000002",
  scope: "account" as const,
  name: "Pro",
  monthly_allowance: "100000",
  max_units_per_request: "1000",
  is_predefined: true,
};
const basic = {
  id: "40000000-0000-4000-8000-000000000001",
  scope: "user" as const,
  name: "Basic",
  monthly_allowance: "1000",
  max_units_per_request: "20",
  is_predefined: true,
};
const premium = {
  id: "40000000-0000-4000-8000-000000000002",
  scope: "user" as const,
  name: "Premium",
  monthly_allowance: "5000",
  max_units_per_request: "100",
  is_predefined: true,
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createFakeBackend() {
  const users = new Map<string, { id: string; name: string; plan: typeof basic | typeof premium }>();
  const userUsage = new Map<string, number>();
  const requests = new Map<string, { status: number; body: Record<string, unknown> }>();
  const history: Array<Record<string, unknown>> = [];
  let nextUser = 0;
  let accountUsed = 0;
  let accountPlan = accountStarter;
  let customPlan: Record<string, unknown> | null = null;
  let accountPlanChanges = 0;
  let premiumAssignments = 0;
  let repeatedRequestCount = 0;

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(API_KEY);

    if (url.pathname === "/v1/usage/account" && method === "GET") {
      return jsonResponse({
        month: "2026-10",
        plan: accountPlan,
        used_units: String(accountUsed),
        remaining_units: String(Math.max(0, Number(accountPlan.monthly_allowance) - accountUsed)),
      });
    }
    if (url.pathname === "/v1/users" && method === "GET") {
      return jsonResponse({ users: [...users.values()] });
    }
    if (url.pathname === "/v1/requests" && method === "GET") {
      return jsonResponse({ account_id: ACCOUNT_ID, history: [...history], pagination: { limit: 100, next_cursor: null } });
    }
    if (url.pathname === "/v1/plans" && method === "GET") {
      if (url.searchParams.get("scope") === "account") {
        return jsonResponse({ plans: [accountStarter, accountPro] });
      }
      return jsonResponse({ plans: [basic, premium] });
    }
    if (url.pathname === "/v1/users" && method === "POST") {
      nextUser += 1;
      const user = {
        id: nextUser === 1 ? AHMAD_ID : SARA_ID,
        name: String(requestBody.name),
        plan: basic,
      };
      users.set(user.id, user);
      userUsage.set(user.id, 0);
      return jsonResponse(user, 201);
    }
    const userPlanMatch = /^\/v1\/users\/([^/]+)\/plan$/.exec(url.pathname);
    if (userPlanMatch && method === "PATCH") {
      const user = users.get(decodeURIComponent(userPlanMatch[1]));
      if (!user) return jsonResponse({ error: API_KEY }, 404);
      user.plan = requestBody.plan_id === premium.id ? premium : basic;
      if (user.plan === premium) premiumAssignments += 1;
      return jsonResponse({ user_id: user.id, plan: user.plan });
    }
    if (url.pathname === "/v1/plans/account" && method === "POST") {
      customPlan = {
        id: "30000000-0000-4000-8000-000000000003",
        scope: "account",
        name: requestBody.name,
        monthly_allowance: String(requestBody.monthly_allowance),
        max_units_per_request: String(requestBody.max_units_per_request),
        is_predefined: false,
      };
      return jsonResponse(customPlan, 201);
    }
    if (url.pathname === "/v1/accounts/me/plan" && method === "PATCH") {
      accountPlanChanges += 1;
      accountPlan = requestBody.plan_id === accountPro.id ? accountPro : customPlan as typeof accountStarter;
      return jsonResponse({ account_id: ACCOUNT_ID, plan: accountPlan });
    }
    if (url.pathname === "/v1/consumptions" && method === "POST") {
      const userId = String(requestBody.user_id);
      const requestId = String(requestBody.request_id);
      const units = Number(requestBody.units);
      const user = users.get(userId);
      if (!user) return jsonResponse({ error: API_KEY }, 404);
      const previous = requests.get(requestId);
      if (previous) {
        repeatedRequestCount += 1;
        return jsonResponse(previous.body, previous.status, { "idempotency-replayed": "true" });
      }

      const failures: Array<{ level: string; rule: string; message: string }> = [];
      if (units > Number(user.plan.max_units_per_request)) {
        failures.push({ level: "user", rule: "max_units_per_request", message: "Basic request maximum exceeded" });
      }
      if (accountUsed + units > Number(accountPlan.monthly_allowance)) {
        failures.push({ level: "account", rule: "monthly_allowance", message: "Account allowance would be exceeded" });
      }
      const accepted = failures.length === 0;
      if (accepted) {
        accountUsed += units;
        userUsage.set(userId, (userUsage.get(userId) ?? 0) + units);
      }
      const body = {
        status: accepted ? "accepted" : "rejected",
        request_id: requestId,
        user_id: userId,
        units,
        usage_month: "2026-10-01",
        account: {
          used_units: String(accountUsed),
          monthly_allowance: accountPlan.monthly_allowance,
          remaining_units: String(Number(accountPlan.monthly_allowance) - accountUsed),
        },
        user: {
          used_units: String(userUsage.get(userId)),
          monthly_allowance: user.plan.monthly_allowance,
          remaining_units: String(Number(user.plan.monthly_allowance) - (userUsage.get(userId) ?? 0)),
        },
        failed_rules: failures,
      };
      const status = accepted ? 200 : 429;
      requests.set(requestId, { status, body });
      history.push({ request_id: requestId, user_id: userId, units: String(units), status: body.status });
      return jsonResponse(body, status);
    }
    const userUsageMatch = /^\/v1\/users\/([^/]+)\/usage$/.exec(url.pathname);
    if (userUsageMatch && method === "GET") {
      const user = users.get(decodeURIComponent(userUsageMatch[1]));
      if (!user) return jsonResponse({ error: API_KEY }, 404);
      const used = userUsage.get(user.id) ?? 0;
      return jsonResponse({
        month: "2026-10",
        plan: user.plan,
        used_units: String(used),
        remaining_units: String(Number(user.plan.monthly_allowance) - used),
      });
    }
    const userDetailsMatch = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
    if (userDetailsMatch && method === "GET") {
      const user = users.get(decodeURIComponent(userDetailsMatch[1]));
      return user ? jsonResponse(user) : jsonResponse({ error: API_KEY }, 404);
    }
    if (url.pathname === "/v1/accounts/me" && method === "GET") {
      return jsonResponse({ id: ACCOUNT_ID, plan: accountPlan });
    }
    return jsonResponse({ error: API_KEY }, 500);
  };

  return {
    fetchImplementation,
    snapshot: () => ({
      accountUsed,
      userUsage: Object.fromEntries(userUsage),
      history: [...history],
      accountPlan,
      accountPlanChanges,
      premiumAssignments,
      repeatedRequestCount,
    }),
  };
}

describe("example client configuration", () => {
  it("requires an account API key and reports no secret values", async () => {
    await expect(loadClientConfig({})).rejects.toThrow("USAGE_API_KEY or USAGE_API_KEY_FILE");
    await expect(loadClientConfig({ USAGE_API_KEY: "" })).rejects.toThrow("USAGE_API_KEY or USAGE_API_KEY_FILE");
  });

  it("reads the API key from a mounted file without printing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quota-cli-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "account-key");
    await writeFile(keyPath, `${API_KEY}\n`, { mode: 0o600 });
    const config = await loadClientConfig({ USAGE_API_KEY_FILE: keyPath });
    expect(config.apiKey).toBe(API_KEY);
    expect(config.apiBaseUrl).toBe("http://localhost:3000");
  });
});

describe("example client HTTP handling and demonstration", () => {
  it("sends JSON with the account key and accepts only declared statuses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(API_KEY);
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "Ahmad" });
      return jsonResponse({ id: AHMAD_ID }, 201);
    });
    const api = new QuotaApiClient({ apiBaseUrl: "http://localhost:3000", apiKey: API_KEY }, fetchMock);
    const result = await api.request<{ id: string }>("/v1/users", {
      method: "POST", body: { name: "Ahmad" }, allowedStatuses: [201],
    });
    expect(result.status).toBe(201);
    expect(result.body.id).toBe(AHMAD_ID);
  });

  it("runs the real demo flow, verifies quotas, plan changes, replay, and final totals without leaking the key", async () => {
    const backend = createFakeBackend();
    const api = new QuotaApiClient({ apiBaseUrl: "http://localhost:3000", apiKey: API_KEY }, backend.fetchImplementation);
    const output: string[] = [];
    let nextId = 0;
    await runExampleDemo({ api, writeLine: (line) => output.push(line), requestIdFactory: () => `demo-id-${++nextId}` });

    const snapshot = backend.snapshot();
    expect(snapshot.accountUsed).toBe(45);
    expect(snapshot.userUsage[AHMAD_ID]).toBe(10);
    expect(snapshot.userUsage[SARA_ID]).toBe(35);
    expect(snapshot.history).toHaveLength(5);
    expect(snapshot.history.filter((entry) => entry.status === "accepted")).toHaveLength(3);
    expect(snapshot.history.filter((entry) => entry.status === "rejected")).toHaveLength(2);
    expect(snapshot.accountPlan.name).toBe("Pro");
    expect(snapshot.accountPlanChanges).toBe(2);
    expect(snapshot.premiumAssignments).toBe(1);
    expect(snapshot.repeatedRequestCount).toBe(1);
    expect(output.join("\n")).toContain("user max_units_per_request");
    expect(output.join("\n")).toContain("account monthly_allowance");
    expect(output.join("\n")).toContain("Final account usage: 45 / 100000");
    expect(output.join("\n")).toContain("Ahmad usage: 10 / 1000");
    expect(output.join("\n")).toContain("Sara usage: 35 / 5000");
    expect(output.join("\n")).not.toContain(API_KEY);
  });

  it("fails clearly on unexpected API errors without copying response text or secrets", async () => {
    const fetchMock: typeof fetch = async () => jsonResponse({ error: `backend leaked ${API_KEY}` }, 500);
    const api = new QuotaApiClient({ apiBaseUrl: "http://localhost:3000", apiKey: API_KEY }, fetchMock);
    const output: string[] = [];
    await expect(runExampleDemo({ api, writeLine: (line) => output.push(line) })).rejects.toThrow("unexpected HTTP 500");
    expect(output.join("\n")).not.toContain(API_KEY);
  });

  it("rejects embedded URL credentials and non-HTTP transports", () => {
    expect(() => new QuotaApiClient({ apiBaseUrl: "http://user:pass@localhost:3000", apiKey: API_KEY })).toThrow("without embedded credentials");
    expect(() => new QuotaApiClient({ apiBaseUrl: "file:///tmp/api", apiKey: API_KEY })).toThrow("HTTP(S)");
  });
});
