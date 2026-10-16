import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

type RequestHistoryOptions = { database?: Pool };
type RequestStatus = "accepted" | "rejected";
type CursorPayload = {
  v: 1;
  scope: "account" | "user";
  account_id: string;
  user_id: string | null;
  status: RequestStatus | null;
  created_at: string;
  id: string;
};
type RequestRow = {
  id: string;
  request_id: string;
  user_id: string;
  units: string;
  status: RequestStatus;
  rejection_reasons: unknown;
  failed_rule_levels: string[];
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_units_per_request: string;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_allowance: string;
  user_max_units_per_request: string;
  response_status: number;
  response_body: Record<string, unknown>;
  created_at: string;
};

type CursorContext = {
  scope: "account" | "user";
  accountId: string;
  userId: string | null;
  status: RequestStatus | null;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
// PostgreSQL TIMESTAMPTZ supports microseconds; retain all six fractional digits in every cursor.
const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$";

const historyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["accepted", "rejected"] },
    limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
    cursor: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9_-]+$" },
  },
};

const requestParamsSchema = {
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", format: "uuid" },
  },
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && new RegExp(UUID_PATTERN).test(value);
}

function isValidCursorTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, context: CursorContext): CursorPayload | undefined | null {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) return null;

  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return null;
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const payload = value as Partial<CursorPayload>;
    const expectedKeys = ["v", "scope", "account_id", "user_id", "status", "created_at", "id"];
    if (Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",")) return null;
    if (
      payload.v !== 1
      || payload.scope !== context.scope
      || payload.account_id !== context.accountId
      || payload.user_id !== context.userId
      || payload.status !== context.status
      || typeof payload.created_at !== "string"
      || !new RegExp(TIMESTAMP_PATTERN).test(payload.created_at)
      || !isValidCursorTimestamp(payload.created_at)
      || !isUuid(payload.id)
    ) {
      return null;
    }
    return payload as CursorPayload;
  } catch {
    return null;
  }
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_LIMIT ? limit : null;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return value;
}

function toPublicHistoryItem(row: RequestRow) {
  const responseBody = row.response_body ?? {};
  return {
    id: row.id,
    request_id: row.request_id,
    user_id: row.user_id,
    units: row.units,
    status: row.status,
    rejection_reasons: parseStoredJson(row.rejection_reasons),
    failed_rule_levels: row.failed_rule_levels,
    failed_rules: parseStoredJson(responseBody.failed_rules ?? []),
    account_plan: {
      id: row.account_plan_id,
      name: row.account_plan_name,
      monthly_allowance: row.account_monthly_allowance,
      max_units_per_request: row.account_max_units_per_request,
    },
    user_plan: {
      id: row.user_plan_id,
      name: row.user_plan_name,
      monthly_allowance: row.user_monthly_allowance,
      max_units_per_request: row.user_max_units_per_request,
    },
    usage_month: responseBody.usage_month ?? null,
    created_at: row.created_at,
    response_status: row.response_status,
  };
}

async function fetchRequestHistory(
  database: Pool,
  context: CursorContext,
  limit: number,
  cursor: CursorPayload | undefined,
): Promise<{ items: ReturnType<typeof toPublicHistoryItem>[]; nextCursor: string | null }> {
  const values: Array<string | number> = [context.accountId];
  const where = ["account_id = $1"];

  if (context.userId !== null) {
    values.push(context.userId);
    where.push(`user_id = $${values.length}`);
  }
  if (context.status !== null) {
    values.push(context.status);
    where.push(`status = $${values.length}`);
  }
  if (cursor) {
    values.push(cursor.created_at, cursor.id);
    where.push(`(request.created_at, request.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);

  const result = await database.query<RequestRow>(
    `SELECT
       id::text AS id,
       request_id,
       user_id::text AS user_id,
       units::text AS units,
       status,
       rejection_reasons,
       failed_rule_levels,
       account_plan_id::text AS account_plan_id,
       account_plan_name,
       account_monthly_allowance::text AS account_monthly_allowance,
       account_max_units_per_request::text AS account_max_units_per_request,
       user_plan_id::text AS user_plan_id,
       user_plan_name,
       user_monthly_allowance::text AS user_monthly_allowance,
       user_max_units_per_request::text AS user_max_units_per_request,
       response_status,
       response_body,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM consumption_requests AS request
     WHERE ${where.join(" AND ")}
    ORDER BY request.created_at DESC, request.id DESC
     LIMIT $${values.length}`,
    values,
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({
        v: 1,
        scope: context.scope,
        account_id: context.accountId,
        user_id: context.userId,
        status: context.status,
        created_at: last.created_at,
        id: last.id,
      })
    : null;
  return { items: rows.map(toPublicHistoryItem), nextCursor };
}

async function historyHandler(
  database: Pool,
  context: CursorContext,
  query: RequestHistoryQuery,
  reply: FastifyReply,
) {
  const limit = parseLimit(query.limit);
  if (limit === null) return reply.code(400).send({ error: "limit must be an integer between 1 and 100" });

  const cursor = decodeCursor(query.cursor, context);
  if (cursor === null) {
    return reply.code(400).send({ error: "cursor is malformed or does not match this scope and filter" });
  }

  const result = await fetchRequestHistory(database, context, limit, cursor);
  return reply.code(200).send({
    ...(context.scope === "account" ? { account_id: context.accountId } : { user_id: context.userId }),
    history: result.items,
    pagination: { limit, next_cursor: result.nextCursor },
  });
}

type RequestHistoryQuery = { status?: RequestStatus; limit?: string; cursor?: string };

export function registerRequestRoutes(
  app: FastifyInstance,
  options: RequestHistoryOptions = {},
): void {
  const database = options.database ?? defaultPool;
  const authenticate = requireApiKey(database);

  app.get<{ Querystring: RequestHistoryQuery }>(
    "/v1/requests",
    { preHandler: authenticate, schema: { querystring: historyQuerySchema } },
    async (request, reply) => {
      if (!request.accountId) return reply.code(401).send({ error: "Missing or invalid API key" });
      return historyHandler(database, {
        scope: "account",
        accountId: request.accountId,
        userId: null,
        status: request.query.status ?? null,
      }, request.query, reply);
    },
  );

  app.get<{ Params: { userId: string }; Querystring: RequestHistoryQuery }>(
    "/v1/users/:userId/requests",
    {
      preHandler: authenticate,
      schema: { params: requestParamsSchema, querystring: historyQuerySchema },
    },
    async (request, reply) => {
      if (!request.accountId) return reply.code(401).send({ error: "Missing or invalid API key" });
      const user = await database.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 AND account_id = $2",
        [request.params.userId, request.accountId],
      );
      if (user.rows.length !== 1) return reply.code(404).send({ error: "User not found" });

      return historyHandler(database, {
        scope: "user",
        accountId: request.accountId,
        userId: request.params.userId,
        status: request.query.status ?? null,
      }, request.query, reply);
    },
  );
}
