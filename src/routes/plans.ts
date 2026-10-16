import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type PlanScope = "account" | "user";
type PlanRouteOptions = { database?: Pool };
type PlanRow = {
  id: string;
  name: string;
  monthly_allowance: string;
  max_units_per_request: string;
  is_predefined: boolean;
};
type PlanInput = {
  name?: string;
  monthly_allowance?: number;
  max_units_per_request?: number;
};

const PLAN_LIMIT_MAX = 9_000_000_000_000_000;
const REQUEST_LIMIT_MAX = 1_000_000;

function tableForScope(scope: PlanScope): "account_plans" | "user_plans" {
  return scope === "account" ? "account_plans" : "user_plans";
}

function publicPlan(scope: PlanScope, row: PlanRow) {
  return {
    id: row.id,
    scope,
    name: row.name,
    monthly_allowance: row.monthly_allowance,
    max_units_per_request: row.max_units_per_request,
    is_predefined: row.is_predefined,
  };
}

function isSupportedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

const scopeParamsSchema = {
  type: "object",
  required: ["scope"],
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: ["account", "user"] },
  },
};

const planParamsSchema = {
  type: "object",
  required: ["scope", "planId"],
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: ["account", "user"] },
    planId: { type: "string", format: "uuid" },
  },
};

const createPlanBodySchema = {
  type: "object",
  required: ["name", "monthly_allowance", "max_units_per_request"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    monthly_allowance: {
      type: "integer",
      minimum: 0,
      maximum: PLAN_LIMIT_MAX,
    },
    max_units_per_request: {
      type: "integer",
      minimum: 1,
      maximum: REQUEST_LIMIT_MAX,
    },
  },
};

const updatePlanBodySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    monthly_allowance: {
      type: "integer",
      minimum: 0,
      maximum: PLAN_LIMIT_MAX,
    },
    max_units_per_request: {
      type: "integer",
      minimum: 1,
      maximum: REQUEST_LIMIT_MAX,
    },
  },
};

function validNumericFields(input: PlanInput): boolean {
  return (input.monthly_allowance === undefined
      || isSupportedInteger(input.monthly_allowance, 0, PLAN_LIMIT_MAX))
    && (input.max_units_per_request === undefined
      || isSupportedInteger(input.max_units_per_request, 1, REQUEST_LIMIT_MAX));
}

export function registerPlanRoutes(
  app: FastifyInstance,
  options: PlanRouteOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const authenticate = requireApiKey(database);

  app.get<{ Querystring: { scope?: PlanScope } }>(
    "/v1/plans",
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["account", "user"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const scopes: PlanScope[] = request.query.scope
        ? [request.query.scope]
        : ["account", "user"];
      const plans = [];

      for (const scope of scopes) {
        const table = tableForScope(scope);
        const result = await database.query<PlanRow>(
          `SELECT id, name, monthly_allowance, max_units_per_request, is_predefined
           FROM ${table}
           WHERE is_predefined = true OR owner_account_id = $1
           ORDER BY is_predefined DESC, name ASC, id ASC`,
          [request.accountId],
        );
        plans.push(...result.rows.map((row) => publicPlan(scope, row)));
      }

      return reply.code(200).send({ plans });
    },
  );

  app.get<{ Params: { scope: PlanScope; planId: string } }>(
    "/v1/plans/:scope/:planId",
    { preHandler: authenticate, schema: { params: planParamsSchema } },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const table = tableForScope(request.params.scope);
      const result = await database.query<PlanRow>(
        `SELECT id, name, monthly_allowance, max_units_per_request, is_predefined
         FROM ${table}
         WHERE id = $1
           AND (is_predefined = true OR owner_account_id = $2)`,
        [request.params.planId, request.accountId],
      );
      if (result.rows.length !== 1) {
        return reply.code(404).send({ error: "Plan not found" });
      }

      return reply.code(200).send(publicPlan(request.params.scope, result.rows[0]));
    },
  );

  app.post<{ Params: { scope: PlanScope }; Body: PlanInput }>(
    "/v1/plans/:scope",
    {
      preHandler: authenticate,
      schema: { params: scopeParamsSchema, body: createPlanBodySchema },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }
      if (!validNumericFields(request.body)) {
        return reply.code(400).send({ error: "Plan limits must be safe integers within supported ranges" });
      }

      const name = request.body.name?.trim();
      if (!name) {
        return reply.code(400).send({ error: "Plan name must not be blank" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await client.query(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
          [request.accountId],
        );
        if (account.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        const table = tableForScope(request.params.scope);
        const result = await client.query<PlanRow>(
          `INSERT INTO ${table} (
             owner_account_id, name, monthly_allowance, max_units_per_request, is_predefined
           ) VALUES ($1, $2, $3, $4, false)
           RETURNING id, name, monthly_allowance, max_units_per_request, is_predefined`,
          [
            request.accountId,
            name,
            request.body.monthly_allowance,
            request.body.max_units_per_request,
          ],
        );

        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(201).send(publicPlan(request.params.scope, result.rows[0]));
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        if (isPgError(error, "23505")) {
          return reply.code(409).send({ error: "A plan with this name already exists in this scope" });
        }
        if (isPgError(error, "23514") || isPgError(error, "22003")) {
          return reply.code(400).send({ error: "Plan values violate database constraints" });
        }
        return reply.code(500).send({ error: "Unable to create plan" });
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { scope: PlanScope; planId: string }; Body: PlanInput }>(
    "/v1/plans/:scope/:planId",
    {
      preHandler: authenticate,
      schema: { params: planParamsSchema, body: updatePlanBodySchema },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }
      if (!validNumericFields(request.body)) {
        return reply.code(400).send({ error: "Plan limits must be safe integers within supported ranges" });
      }

      const name = request.body.name?.trim();
      if (request.body.name !== undefined && !name) {
        return reply.code(400).send({ error: "Plan name must not be blank" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await client.query(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
          [request.accountId],
        );
        if (account.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        const table = tableForScope(request.params.scope);
        const existing = await client.query<PlanRow>(
          `SELECT id, name, monthly_allowance, max_units_per_request, is_predefined
           FROM ${table}
           WHERE id = $1 AND owner_account_id = $2 AND is_predefined = false
           FOR UPDATE`,
          [request.params.planId, request.accountId],
        );

        if (existing.rows.length !== 1) {
          const predefined = await client.query(
            `SELECT 1 FROM ${table} WHERE id = $1 AND is_predefined = true`,
            [request.params.planId],
          );
          await client.query("ROLLBACK");
          transactionStarted = false;
          if (predefined.rows.length === 1) {
            return reply.code(403).send({ error: "Predefined plans cannot be modified" });
          }
          return reply.code(404).send({ error: "Plan not found" });
        }

        const current = existing.rows[0];
        const result = await client.query<PlanRow>(
          `UPDATE ${table}
           SET name = $1, monthly_allowance = $2, max_units_per_request = $3
           WHERE id = $4 AND owner_account_id = $5 AND is_predefined = false
           RETURNING id, name, monthly_allowance, max_units_per_request, is_predefined`,
          [
            name ?? current.name,
            request.body.monthly_allowance ?? current.monthly_allowance,
            request.body.max_units_per_request ?? current.max_units_per_request,
            request.params.planId,
            request.accountId,
          ],
        );

        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(200).send(publicPlan(request.params.scope, result.rows[0]));
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        if (isPgError(error, "23505")) {
          return reply.code(409).send({ error: "A plan with this name already exists in this scope" });
        }
        if (isPgError(error, "23514") || isPgError(error, "22003")) {
          return reply.code(400).send({ error: "Plan values violate database constraints" });
        }
        return reply.code(500).send({ error: "Unable to update plan" });
      } finally {
        client.release();
      }
    },
  );
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
