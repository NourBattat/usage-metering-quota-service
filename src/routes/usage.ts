import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type UsageRouteOptions = { database?: Pool };
type HistoryQuery = {
  from_month?: string;
  to_month?: string;
  limit?: string;
  cursor?: string;
};
type HistoryRow = { month: string; used_units: string };
type PlanLimitsRow = {
  id: string;
  name: string;
  monthly_allowance: string;
  max_units_per_request: string;
  used_units: string | null;
};

function calculateRemaining(allowanceValue: string, usedValue: string | null): string {
  const allowance = BigInt(allowanceValue);
  const used = BigInt(usedValue ?? "0");
  return (allowance > used ? allowance - used : 0n).toString();
}

function monthlyUsageResponse(month: string, plan: PlanLimitsRow) {
  const usedUnits = plan.used_units ?? "0";
  return {
    month,
    plan: {
      id: plan.id,
      name: plan.name,
      monthly_allowance: plan.monthly_allowance,
      max_units_per_request: plan.max_units_per_request,
    },
    used_units: usedUnits,
    remaining_units: calculateRemaining(plan.monthly_allowance, usedUnits),
  };
}

const historyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    from_month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
    to_month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
    limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
    cursor: { type: "string", minLength: 1, maxLength: 16, pattern: "^[A-Za-z0-9_-]+$" },
  },
};

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

function isValidMonth(value: string | undefined): boolean {
  return value === undefined
    || (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0);
}

function decodeMonthCursor(cursor: string | undefined): string | null | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(cursor)) return null;

  try {
    const month = Buffer.from(cursor, "base64url").toString("ascii");
    if (Buffer.from(month, "ascii").toString("base64url") !== cursor || !isValidMonth(month)) {
      return null;
    }
    return month;
  } catch {
    return null;
  }
}

function parseHistoryQuery(query: HistoryQuery):
  | { error: string }
  | { fromMonth?: string; toMonth?: string; limit: number; cursorMonth?: string } {
  if (!isValidMonth(query.from_month) || !isValidMonth(query.to_month)) {
    return { error: "Months must use the YYYY-MM format with a valid calendar month" };
  }
  if (query.from_month && query.to_month && query.from_month > query.to_month) {
    return { error: "from_month must not be later than to_month" };
  }

  const parsedLimit = query.limit === undefined ? DEFAULT_HISTORY_LIMIT : Number(query.limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_HISTORY_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}` };
  }

  const cursorMonth = decodeMonthCursor(query.cursor);
  if (cursorMonth === null) return { error: "cursor must be a base64url-encoded YYYY-MM month" };
  return { fromMonth: query.from_month, toMonth: query.to_month, limit: parsedLimit, cursorMonth };
}

function encodeMonthCursor(month: string): string {
  return Buffer.from(month, "ascii").toString("base64url");
}

async function queryHistory(
  database: Pool,
  table: "account_monthly_usage" | "user_monthly_usage",
  accountId: string,
  userId: string | undefined,
  filters: { fromMonth?: string; toMonth?: string; limit: number; cursorMonth?: string },
): Promise<{ history: HistoryRow[]; nextCursor: string | null }> {
  const values: Array<string | number> = [accountId];
  const predicates = ["account_id = $1"];

  if (userId !== undefined) {
    values.push(userId);
    predicates.push(`user_id = $${values.length}`);
  }
  if (filters.fromMonth) {
    values.push(`${filters.fromMonth}-01`);
    predicates.push(`month >= $${values.length}::date`);
  }
  if (filters.toMonth) {
    values.push(`${filters.toMonth}-01`);
    predicates.push(`month <= $${values.length}::date`);
  }
  if (filters.cursorMonth) {
    values.push(`${filters.cursorMonth}-01`);
    predicates.push(`month < $${values.length}::date`);
  }

  values.push(filters.limit + 1);
  const result = await database.query<HistoryRow>(
    `SELECT to_char(usage.month, 'YYYY-MM') AS month, usage.used_units::text AS used_units
     FROM ${table} AS usage
     WHERE ${predicates.join(" AND ")}
     ORDER BY usage.month DESC
     LIMIT $${values.length}`,
    values,
  );

  const hasMore = result.rows.length > filters.limit;
  const history = hasMore ? result.rows.slice(0, filters.limit) : result.rows;
  const lastMonth = history.at(-1)?.month;
  return {
    history,
    nextCursor: hasMore && lastMonth ? encodeMonthCursor(lastMonth) : null,
  };
}

async function currentUtcMonth(database: Pool): Promise<string> {
  const result = await database.query<{ month: string }>(
    "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
  );
  return result.rows[0].month;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  options: UsageRouteOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const authenticate = requireApiKey(database);

  app.get(
    "/v1/usage/account",
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionStarted = true;

        const monthResult = await client.query<{ month: string }>(
          "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
        );
        const result = await client.query<PlanLimitsRow>(
          `SELECT
             p.id, p.name, p.monthly_allowance, p.max_units_per_request,
             u.used_units
           FROM accounts AS a
           JOIN account_plans AS p ON p.id = a.account_plan_id
           LEFT JOIN account_monthly_usage AS u
             ON u.account_id = a.id AND u.month = $2::date
           WHERE a.id = $1`,
          [request.accountId, monthResult.rows[0].month],
        );

        if (result.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        const response = monthlyUsageResponse(monthResult.rows[0].month, result.rows[0]);
        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(200).send(response);
      } catch {
        if (transactionStarted) await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Unable to retrieve account usage" });
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { userId: string } }>(
    "/v1/users/:userId/usage",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }

      const client = await database.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionStarted = true;

        const monthResult = await client.query<{ month: string }>(
          "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
        );
        const result = await client.query<PlanLimitsRow>(
          `SELECT
             p.id, p.name, p.monthly_allowance, p.max_units_per_request,
             usage.used_units
           FROM users AS u
           JOIN user_plans AS p ON p.id = u.user_plan_id
           LEFT JOIN user_monthly_usage AS usage
             ON usage.account_id = u.account_id
            AND usage.user_id = u.id
            AND usage.month = $3::date
           WHERE u.id = $1 AND u.account_id = $2`,
          [request.params.userId, request.accountId, monthResult.rows[0].month],
        );

        if (result.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(404).send({ error: "User not found" });
        }

        const response = monthlyUsageResponse(monthResult.rows[0].month, result.rows[0]);
        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(200).send(response);
      } catch {
        if (transactionStarted) await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Unable to retrieve user usage" });
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Querystring: HistoryQuery }>(
    "/v1/usage/account/history",
    {
      preHandler: authenticate,
      schema: { querystring: historyQuerySchema },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }
      const filters = parseHistoryQuery(request.query);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });

      const result = await queryHistory(
        database,
        "account_monthly_usage",
        request.accountId,
        undefined,
        filters,
      );
      return reply.code(200).send({
        account_id: request.accountId,
        history: result.history,
        pagination: {
          limit: filters.limit,
          next_cursor: result.nextCursor,
        },
      });
    },
  );

  app.get<{ Params: { userId: string }; Querystring: HistoryQuery }>(
    "/v1/users/:userId/usage/history",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", format: "uuid" } },
        },
        querystring: historyQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }
      const filters = parseHistoryQuery(request.query);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });

      const user = await database.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 AND account_id = $2",
        [request.params.userId, request.accountId],
      );
      if (user.rows.length !== 1) {
        return reply.code(404).send({ error: "User not found" });
      }

      const result = await queryHistory(
        database,
        "user_monthly_usage",
        request.accountId,
        request.params.userId,
        filters,
      );
      return reply.code(200).send({
        user_id: request.params.userId,
        history: result.history,
        pagination: {
          limit: filters.limit,
          next_cursor: result.nextCursor,
        },
      });
    },
  );
}
