import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type AccountRouteOptions = {
  database?: Pool;
  provisioningToken?: string;
};

function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;

  const providedHash = createHash("sha256").update(provided, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function registerAccountRoutes(
  app: FastifyInstance,
  options: AccountRouteOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const provisioningToken = options.provisioningToken ?? process.env.PROVISIONING_TOKEN;

  app.post<{ Body: { name: string } }>(
    "/v1/accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const presentedToken = request.headers["x-provisioning-token"];
      if (typeof provisioningToken !== "string" || provisioningToken.length < 32) {
        return reply.code(503).send({ error: "Account provisioning is not configured" });
      }
      if (
        typeof presentedToken !== "string"
        || !tokenMatches(presentedToken, provisioningToken)
      ) {
        return reply.code(401).send({ error: "Invalid provisioning token" });
      }

      const name = request.body.name.trim();
      if (name.length === 0) {
        return reply.code(400).send({ error: "Account name must not be blank" });
      }

      const client = await database.connect();
      const apiKey = randomBytes(32).toString("base64url");
      const apiKeyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
      let transactionStarted = false;

      try {
        await client.query("BEGIN");
        transactionStarted = true;

        const planResult = await client.query<{
          id: string;
          name: string;
          monthly_allowance: string;
          max_units_per_request: string;
        }>(
          `SELECT id, name, monthly_allowance, max_units_per_request
           FROM account_plans
           WHERE name = 'Starter' AND owner_account_id IS NULL AND is_predefined = true
           FOR KEY SHARE`,
        );

        if (planResult.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(503).send({ error: "Default account plan is unavailable" });
        }

        const plan = planResult.rows[0];
        const accountResult = await client.query<{
          id: string;
          name: string;
          created_at: Date;
        }>(
          `INSERT INTO accounts (name, api_key_hash, account_plan_id)
           VALUES ($1, $2, $3)
           RETURNING id, name, created_at`,
          [name, apiKeyHash, plan.id],
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return reply.code(201).send({
          account: {
            id: accountResult.rows[0].id,
            name: accountResult.rows[0].name,
            created_at: accountResult.rows[0].created_at,
            plan: {
              id: plan.id,
              name: plan.name,
              monthly_allowance: plan.monthly_allowance,
              max_units_per_request: plan.max_units_per_request,
            },
          },
          api_key: apiKey,
        });
      } catch {
        if (transactionStarted) {
          await client.query("ROLLBACK");
        }
        return reply.code(500).send({ error: "Unable to create account" });
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/v1/accounts/me",
    { preHandler: requireApiKey(database) },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const result = await database.query<{
        id: string;
        name: string;
        created_at: Date;
        plan_id: string | null;
        plan_name: string | null;
        monthly_allowance: string | null;
        max_units_per_request: string | null;
      }>(
        `SELECT a.id, a.name, a.created_at,
                p.id AS plan_id, p.name AS plan_name,
                p.monthly_allowance, p.max_units_per_request
         FROM accounts AS a
         LEFT JOIN account_plans AS p ON p.id = a.account_plan_id
         WHERE a.id = $1`,
        [request.accountId],
      );

      if (result.rows.length !== 1) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const account = result.rows[0];
      return reply.code(200).send({
        id: account.id,
        name: account.name,
        created_at: account.created_at,
        plan: account.plan_id
          ? {
              id: account.plan_id,
              name: account.plan_name,
              monthly_allowance: account.monthly_allowance,
              max_units_per_request: account.max_units_per_request,
            }
          : null,
      });
    },
  );
}
