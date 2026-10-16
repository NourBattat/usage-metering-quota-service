import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { QuotaApiClient } from "./api.js";

type Plan = {
  id: string;
  name: string;
  scope: "account" | "user";
  monthly_allowance: string;
  max_units_per_request: string;
  is_predefined: boolean;
};

type User = {
  id: string;
  name: string;
  plan: Plan | null;
};

type Usage = {
  month: string;
  plan: Plan;
  used_units: string;
  remaining_units: string;
};

type UsagePair = {
  used_units: string;
  monthly_allowance: string;
  remaining_units: string;
};

type RemainingUsage = {
  accountRemaining: string;
  userRemaining: string;
};

type FailedRule = {
  level: "account" | "user";
  rule: "max_units_per_request" | "monthly_allowance";
  message: string;
};

type Consumption = {
  status: "accepted" | "rejected";
  request_id: string;
  user_id: string;
  units: number;
  usage_month: string;
  account: UsagePair;
  user: UsagePair;
  failed_rules: FailedRule[];
};

type RequestHistory = {
  request_id: string;
  user_id: string;
  units: string;
  status: "accepted" | "rejected";
};

export type DemoOptions = {
  api: QuotaApiClient;
  writeLine?: (line: string) => void;
  requestIdFactory?: () => string;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Example check failed: ${message}`);
}

function findPredefinedPlan(plans: Plan[], scope: Plan["scope"], name: string): Plan {
  const plan = plans.find((item) => item.scope === scope && item.name === name && item.is_predefined);
  requireCondition(plan, `the predefined ${scope} plan "${name}" is missing from the plan catalog`);
  return plan;
}

function getPlans(value: unknown, scope: Plan["scope"]): Plan[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { plans?: unknown }).plans)) {
    throw new Error(`Backend returned an unexpected ${scope} plan catalog response.`);
  }
  return (value as { plans: Plan[] }).plans;
}

function getUsers(value: unknown): User[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { users?: unknown }).users)) {
    throw new Error("Backend returned an unexpected users response.");
  }
  return (value as { users: User[] }).users;
}

function requireUsage(value: unknown, label: string): Usage {
  if (!value || typeof value !== "object") {
    throw new Error(`Backend returned an unexpected ${label} usage response.`);
  }
  const usage = value as Partial<Usage>;
  if (
    typeof usage.used_units !== "string"
    || typeof usage.remaining_units !== "string"
    || typeof usage.month !== "string"
    || !usage.plan
  ) {
    throw new Error(`Backend returned an incomplete ${label} usage response.`);
  }
  return usage as Usage;
}

function requireConsumption(value: unknown): Consumption {
  if (!value || typeof value !== "object") {
    throw new Error("Backend returned an unexpected consumption response.");
  }
  const result = value as Partial<Consumption>;
  if (
    (result.status !== "accepted" && result.status !== "rejected")
    || typeof result.request_id !== "string"
    || typeof result.user_id !== "string"
    || typeof result.usage_month !== "string"
    || !result.account
    || !result.user
    || !Array.isArray(result.failed_rules)
  ) {
    throw new Error("Backend returned an incomplete consumption response.");
  }
  return result as Consumption;
}

function formatUsage(usage: RemainingUsage): string {
  return `account remaining ${usage.accountRemaining}, user remaining ${usage.userRemaining}`;
}

export async function runExampleDemo({
  api,
  writeLine = console.log,
  requestIdFactory = randomUUID,
}: DemoOptions): Promise<void> {
  writeLine("Usage Metering and Quota Service — CLI demonstration");

  // The client only accepts a newly provisioned empty account; it never resets existing usage.
  const accountBefore = requireUsage(
    (await api.request<unknown>("/v1/usage/account")).body,
    "account",
  );
  const usersBefore = getUsers((await api.request<unknown>("/v1/users")).body);
  const historyBefore = await api.request<{ history: RequestHistory[] }>("/v1/requests?limit=1");
  requireCondition(accountBefore.used_units === "0", "the selected account already has usage");
  requireCondition(usersBefore.length === 0, "the selected account already has users");
  requireCondition(Array.isArray(historyBefore.body.history) && historyBefore.body.history.length === 0, "the selected account already has request history");
  writeLine(`Fresh account verified; UTC month ${accountBefore.month}.`);

  const [accountCatalogResponse, userCatalogResponse] = await Promise.all([
    api.request<unknown>("/v1/plans?scope=account"),
    api.request<unknown>("/v1/plans?scope=user"),
  ]);
  const accountPlans = getPlans(accountCatalogResponse.body, "account");
  const userPlans = getPlans(userCatalogResponse.body, "user");
  const proPlan = findPredefinedPlan(accountPlans, "account", "Pro");
  const basicPlan = findPredefinedPlan(userPlans, "user", "Basic");
  const premiumPlan = findPredefinedPlan(userPlans, "user", "Premium");
  requireCondition(basicPlan.max_units_per_request === "20", "the Basic plan request maximum is not the expected 20 units");

  const ahmadResponse = await api.request<User>("/v1/users", {
    method: "POST",
    body: { name: "Ahmad" },
    allowedStatuses: [201],
  });
  const ahmad = ahmadResponse.body;
  requireCondition(typeof ahmad.id === "string", "user creation did not return a user ID");
  const ahmadAssignment = await api.request<{ plan: Plan }>(`/v1/users/${encodeURIComponent(ahmad.id)}/plan`, {
    method: "PATCH",
    body: { plan_id: basicPlan.id },
  });
  requireCondition(ahmadAssignment.body.plan.name === "Basic", "Ahmad was not assigned the Basic plan");

  const saraResponse = await api.request<User>("/v1/users", {
    method: "POST",
    body: { name: "Sara" },
    allowedStatuses: [201],
  });
  const sara = saraResponse.body;
  requireCondition(typeof sara.id === "string", "user creation did not return a user ID");
  const saraAssignment = await api.request<{ plan: Plan }>(`/v1/users/${encodeURIComponent(sara.id)}/plan`, {
    method: "PATCH",
    body: { plan_id: premiumPlan.id },
  });
  requireCondition(saraAssignment.body.plan.name === "Premium", "Sara was not assigned the Premium plan");

  const customPlanName = `CLI Demo ${requestIdFactory()}`;
  const customPlanResponse = await api.request<Plan>("/v1/plans/account", {
    method: "POST",
    body: {
      name: customPlanName,
      monthly_allowance: 40,
      max_units_per_request: 100,
    },
    allowedStatuses: [201],
  });
  const customPlan = customPlanResponse.body;
  requireCondition(customPlan.monthly_allowance === "40", "custom account plan allowance is not 40 units");
  requireCondition(customPlan.max_units_per_request === "100", "custom account plan request maximum is not 100 units");
  await api.request<unknown>("/v1/accounts/me/plan", {
    method: "PATCH",
    body: { plan_id: customPlan.id },
  });
  writeLine("Plans: Ahmad → Basic; Sara → Premium; account → custom 40-unit plan.");

  const decisions: Array<{ requestId: string; response: Consumption; expected: "accepted" | "rejected" }> = [];
  const decide = async (
    user: User,
    units: number,
    action: string,
    expected: "accepted" | "rejected",
    expectedLevel?: FailedRule["level"],
  ) => {
    const requestId = requestIdFactory();
    const result = await api.request<unknown>("/v1/consumptions", {
      method: "POST",
      body: { user_id: user.id, units, request_id: requestId },
      allowedStatuses: [200, 429],
    });
    const response = requireConsumption(result.body);
    requireCondition(response.request_id === requestId, `${action} returned a different request ID`);
    requireCondition(response.user_id === user.id, `${action} returned a different user ID`);
    requireCondition(response.units === units, `${action} returned a different unit count`);
    requireCondition(response.status === expected, `${action} was ${response.status}, expected ${expected}`);
    requireCondition(result.status === (expected === "accepted" ? 200 : 429), `${action} returned an unexpected HTTP status`);

    if (expected === "rejected") {
      const violatedRules = response.failed_rules.filter((rule) => expectedLevel === undefined || rule.level === expectedLevel);
      requireCondition(violatedRules.length > 0, `${action} did not report the expected ${expectedLevel ?? "quota"} violation`);
      const reasons = violatedRules.map((rule) => `${rule.level} ${rule.rule}: ${rule.message}`).join("; ");
      writeLine(`${action} — requested ${units}: REJECTED (${reasons}); ${formatUsage({
        accountRemaining: response.account.remaining_units,
        userRemaining: response.user.remaining_units,
      })}.`);
    } else {
      requireCondition(response.failed_rules.length === 0, `${action} unexpectedly reported quota failures`);
      writeLine(`${action} — requested ${units}: ACCEPTED; ${formatUsage({
        accountRemaining: response.account.remaining_units,
        userRemaining: response.user.remaining_units,
      })}.`);
    }
    decisions.push({ requestId, response, expected });
    return { requestId, response };
  };

  const firstAhmad = await decide(ahmad, 10, "Ahmad's first action", "accepted");
  await decide(ahmad, 25, "Ahmad exceeds Basic's per-request maximum", "rejected", "user");
  await decide(sara, 20, "Sara's first action", "accepted");
  await decide(sara, 15, "Sara exceeds remaining account allowance", "rejected", "account");

  await api.request<unknown>("/v1/accounts/me/plan", {
    method: "PATCH",
    body: { plan_id: proPlan.id },
  });
  writeLine("Account plan changed through the API: custom plan → Pro.");
  const saraAfterUpgrade = await decide(sara, 15, "Sara's post-upgrade action", "accepted");

  const beforeReplayAccount = requireUsage(
    (await api.request<unknown>("/v1/usage/account")).body,
    "account",
  );
  const beforeReplaySara = requireUsage(
    (await api.request<unknown>(`/v1/users/${encodeURIComponent(sara.id)}/usage`)).body,
    "user",
  );
  const replay = await api.request<unknown>("/v1/consumptions", {
    method: "POST",
    body: { user_id: sara.id, units: 15, request_id: saraAfterUpgrade.requestId },
    allowedStatuses: [200, 429],
  });
  const replayBody = requireConsumption(replay.body);
  requireCondition(replay.status === 200, "the accepted idempotent retry did not return HTTP 200");
  requireCondition(replay.headers.get("idempotency-replayed") === "true", "the backend did not identify the exact retry as a replay");
  requireCondition(isDeepStrictEqual(replayBody, saraAfterUpgrade.response), "the exact retry did not return its original decision");
  const afterReplayAccount = requireUsage(
    (await api.request<unknown>("/v1/usage/account")).body,
    "account",
  );
  const afterReplaySara = requireUsage(
    (await api.request<unknown>(`/v1/users/${encodeURIComponent(sara.id)}/usage`)).body,
    "user",
  );
  requireCondition(
    afterReplayAccount.used_units === beforeReplayAccount.used_units
      && afterReplaySara.used_units === beforeReplaySara.used_units,
    "the exact retry charged usage a second time",
  );
  writeLine(`Idempotent retry — requested 15: replayed without an extra charge; account remaining ${afterReplayAccount.remaining_units}, user remaining ${afterReplaySara.remaining_units}.`);

  const [accountUsageResponse, ahmadUsageResponse, saraUsageResponse, accountDetailsResponse, ahmadDetailsResponse, saraDetailsResponse, requestHistoryResponse] = await Promise.all([
    api.request<unknown>("/v1/usage/account"),
    api.request<unknown>(`/v1/users/${encodeURIComponent(ahmad.id)}/usage`),
    api.request<unknown>(`/v1/users/${encodeURIComponent(sara.id)}/usage`),
    api.request<{ plan: Plan }>("/v1/accounts/me"),
    api.request<User>(`/v1/users/${encodeURIComponent(ahmad.id)}`),
    api.request<User>(`/v1/users/${encodeURIComponent(sara.id)}`),
    api.request<{ history: RequestHistory[] }>("/v1/requests?limit=100"),
  ]);
  const accountUsage = requireUsage(accountUsageResponse.body, "account");
  const ahmadUsage = requireUsage(ahmadUsageResponse.body, "Ahmad");
  const saraUsage = requireUsage(saraUsageResponse.body, "Sara");
  requireCondition(accountUsage.plan.name === "Pro", "account usage does not show the Pro plan");
  requireCondition(ahmadDetailsResponse.body.plan?.name === "Basic", "Ahmad's applied plan is not Basic");
  requireCondition(saraDetailsResponse.body.plan?.name === "Premium", "Sara's applied plan is not Premium");
  requireCondition(accountDetailsResponse.body.plan.name === "Pro", "account details do not show Pro");
  requireCondition(accountUsage.used_units === "45", `expected account usage 45, received ${accountUsage.used_units}`);
  requireCondition(ahmadUsage.used_units === "10", `expected Ahmad usage 10, received ${ahmadUsage.used_units}`);
  requireCondition(saraUsage.used_units === "35", `expected Sara usage 35, received ${saraUsage.used_units}`);
  requireCondition(accountUsage.month === ahmadUsage.month && accountUsage.month === saraUsage.month, "the demonstration crossed a UTC month boundary");

  const history = requestHistoryResponse.body.history;
  requireCondition(Array.isArray(history), "account request history response is malformed");
  requireCondition(history.length === 5, `expected 5 decisions after replay, received ${history.length}`);
  requireCondition(history.filter((item) => item.status === "accepted").length === 3, "history should contain three accepted decisions");
  requireCondition(history.filter((item) => item.status === "rejected").length === 2, "history should contain two rejected decisions");
  requireCondition(new Set(history.map((item) => item.request_id)).size === 5, "idempotent replay created a duplicate history entry");

  writeLine("");
  writeLine(`Final account usage: ${accountUsage.used_units} / ${accountUsage.plan.monthly_allowance}; remaining ${accountUsage.remaining_units} (${accountUsage.plan.name}).`);
  writeLine(`Ahmad usage: ${ahmadUsage.used_units} / ${ahmadUsage.plan.monthly_allowance}; remaining ${ahmadUsage.remaining_units} (${ahmadUsage.plan.name}).`);
  writeLine(`Sara usage: ${saraUsage.used_units} / ${saraUsage.plan.monthly_allowance}; remaining ${saraUsage.remaining_units} (${saraUsage.plan.name}).`);
  writeLine(`Account request history: ${history.length} decisions (3 accepted, 2 rejected; replay did not add a row).`);
  writeLine("Both users' applied plans were retrieved and verified.");
  writeLine("Example completed successfully.");

  // Keep an explicit reference to the first decision as a demonstration invariant.
  requireCondition(firstAhmad.response.status === "accepted", "Ahmad's initial accepted request was not retained");
  requireCondition(decisions.length === 5, "the demo did not submit exactly five new decisions");
}
