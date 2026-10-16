import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type AssignmentRouteOptions = { database?: Pool };
type AssignmentBody = { plan_id: string };
type PlanScope = "account" | "user";
type PlanRow = {
  id: string;
  name: string;
  monthly_allowance: string;
  max_units_per_request: string;
  is_predefined: boolean;
};

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

async function findAssignablePlan(
  client: PoolClient,
  scope: PlanScope,
  planId: string,
  accountId: string,
): Promise<PlanRow | undefined> {
  const table = scope === "account" ? "account_plans" : "user_plans";
  const result = await client.query<PlanRow>(
    `SELECT id, name, monthly_allowance, max_units_per_request, is_predefined
     FROM ${table}
     WHERE id = $1
       AND (is_predefined = true OR owner_account_id = $2)
     FOR KEY SHARE`,
    [planId, accountId],
  );
  return result.rows[0];
}

function planResponse(scope: PlanScope, plan: PlanRow) {
  return {
    id: plan.id,
    scope,
    name: plan.name,
    monthly_allowance: plan.monthly_allowance,
    max_units_per_request: plan.max_units_per_request,
    is_predefined: plan.is_predefined,
  };
}

const accountPlanBodySchema = {
  type: "object",
  required: ["plan_id"],
  additionalProperties: false,
  properties: {
    plan_id: { type: "string", format: "uuid" },
  },
};

export function registerPlanAssignmentRoutes(
  app: FastifyInstance,
  options: AssignmentRouteOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const authenticate = requireApiKey(database);

  app.patch<{ Body: AssignmentBody }>(
    "/v1/accounts/me/plan",
    { preHandler: authenticate, schema: { body: accountPlanBodySchema } },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await client.query<{ id: string }>(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
          [request.accountId],
        );
        if (account.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        const plan = await findAssignablePlan(
          client,
          "account",
          request.body.plan_id,
          request.accountId,
        );
        if (!plan) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(404).send({ error: "Account plan not found" });
        }

        await client.query(
          "UPDATE accounts SET account_plan_id = $1 WHERE id = $2",
          [plan.id, request.accountId],
        );

        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(200).send({
          account_id: request.accountId,
          plan: planResponse("account", plan),
        });
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        if (isPgError(error, "23503") || isPgError(error, "23514") || isPgError(error, "23502")) {
          return reply.code(400).send({ error: "Account plan assignment violates database constraints" });
        }
        return reply.code(500).send({ error: "Unable to change account plan" });
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { userId: string }; Body: AssignmentBody }>(
    "/v1/users/:userId/plan",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", format: "uuid" } },
        },
        body: accountPlanBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await client.query<{ id: string }>(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
          [request.accountId],
        );
        if (account.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        const user = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE id = $1 AND account_id = $2 FOR UPDATE",
          [request.params.userId, request.accountId],
        );
        if (user.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(404).send({ error: "User not found" });
        }

        const plan = await findAssignablePlan(
          client,
          "user",
          request.body.plan_id,
          request.accountId,
        );
        if (!plan) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(404).send({ error: "User plan not found" });
        }

        await client.query(
          "UPDATE users SET user_plan_id = $1 WHERE id = $2 AND account_id = $3",
          [plan.id, request.params.userId, request.accountId],
        );

        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(200).send({
          user_id: request.params.userId,
          plan: planResponse("user", plan),
        });
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        if (isPgError(error, "23503") || isPgError(error, "23514") || isPgError(error, "23502")) {
          return reply.code(400).send({ error: "User plan assignment violates database constraints" });
        }
        return reply.code(500).send({ error: "Unable to change user plan" });
      } finally {
        client.release();
      }
    },
  );
}
