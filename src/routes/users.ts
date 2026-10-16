import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type UserRouteOptions = {
  database?: Pool;
};

type UserRow = {
  id: string;
  name: string;
  created_at: Date;
  plan_id: string | null;
  plan_name: string | null;
  monthly_allowance: string | null;
  max_units_per_request: string | null;
};

function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    plan: row.plan_id
      ? {
          id: row.plan_id,
          name: row.plan_name,
          monthly_allowance: row.monthly_allowance,
          max_units_per_request: row.max_units_per_request,
        }
      : null,
  };
}

const userSelect = `
  SELECT u.id, u.name, u.created_at,
         p.id AS plan_id, p.name AS plan_name,
         p.monthly_allowance, p.max_units_per_request
  FROM users AS u
  LEFT JOIN user_plans AS p ON p.id = u.user_plan_id
`;

export function registerUserRoutes(
  app: FastifyInstance,
  options: UserRouteOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const authenticate = requireApiKey(database);

  app.post<{ Body: { name: string } }>(
    "/v1/users",
    {
      preHandler: authenticate,
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
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const name = request.body.name.trim();
      if (name.length === 0) {
        return reply.code(400).send({ error: "User name must not be blank" });
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

        const plan = await client.query<{ id: string }>(
          `SELECT id
           FROM user_plans
           WHERE name = 'Basic' AND owner_account_id IS NULL AND is_predefined = true
           FOR KEY SHARE`,
        );

        if (plan.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(503).send({ error: "Default user plan is unavailable" });
        }

          const created = await client.query<{ id: string }>(
          `INSERT INTO users (account_id, name, user_plan_id)
           VALUES ($1, $2, $3)
            RETURNING id`,
          [request.accountId, name, plan.rows[0].id],
        );

        const user = await client.query<UserRow>(
          `${userSelect} WHERE u.id = $1 AND u.account_id = $2`,
          [created.rows[0].id, request.accountId],
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return reply.code(201).send(toPublicUser(user.rows[0]));
      } catch {
        if (transactionStarted) {
          await client.query("ROLLBACK");
        }
        return reply.code(500).send({ error: "Unable to create user" });
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/v1/users",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const result = await database.query<UserRow>(
        `${userSelect}
         WHERE u.account_id = $1
         ORDER BY u.created_at ASC, u.id ASC`,
        [request.accountId],
      );
      return reply.code(200).send({ users: result.rows.map(toPublicUser) });
    },
  );

  app.get<{ Params: { userId: string } }>(
    "/v1/users/:userId",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          properties: {
            userId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const result = await database.query<UserRow>(
        `${userSelect} WHERE u.id = $1 AND u.account_id = $2`,
        [request.params.userId, request.accountId],
      );
      if (result.rows.length !== 1) {
        return reply.code(404).send({ error: "User not found" });
      }

      return reply.code(200).send(toPublicUser(result.rows[0]));
    },
  );
}
