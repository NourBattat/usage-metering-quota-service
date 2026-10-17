import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { requireApiKey } from "../plugins/api-key-auth.js";

const MAX_UNITS_PER_REQUEST = 1_000_000;
const MAX_MONTHLY_UNITS = 9_000_000_000_000_000n;

type ConsumptionBody = {
  user_id: string;
  units: number;
  request_id: string;
};

type ConsumptionOptions = {
  database?: Pool;
  processingTimestamp?: (client: PoolClient) => Promise<string>;
};
type ExistingRequest = {
  user_id: string;
  units: string;
  response_status: number;
  response_body: Record<string, unknown>;
};
type PlanSnapshot = {
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_allowance: string;
  account_max_units_per_request: string;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_allowance: string;
  user_max_units_per_request: string;
};
type UsageRow = { used_units: string };
type FailedRule = {
  level: "account" | "user";
  rule: "max_units_per_request" | "monthly_allowance";
  message: string;
};

const bodySchema = {
  type: "object",
  required: ["user_id", "units", "request_id"],
  additionalProperties: false,
  properties: {
    user_id: { type: "string", format: "uuid" },
    units: { type: "integer", minimum: 1, maximum: MAX_UNITS_PER_REQUEST },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
  },
};

function remainingAllowance(allowance: bigint, used: bigint): bigint {
  return allowance > used ? allowance - used : 0n;
}

function serializeUsage(used: bigint, allowance: bigint) {
  return {
    used_units: used.toString(),
    monthly_allowance: allowance.toString(),
    remaining_units: remainingAllowance(allowance, used).toString(),
  };
}

export function registerConsumptionRoutes(
  app: FastifyInstance,
  options: ConsumptionOptions = {},
): void {
  const database = options.database ?? defaultPool;

  app.post<{ Body: ConsumptionBody }>(
    "/v1/consumptions",
    { preHandler: requireApiKey(database), schema: { body: bodySchema } },
    async (request, reply) => {
      if (!request.accountId) {
        return reply.code(401).send({ error: "Missing or invalid API key" });
      }
      if (request.body.request_id.trim().length === 0) {
        return reply.code(400).send({ error: "request_id must not be blank" });
      }

      const accountId = request.accountId;
      const userId = request.body.user_id.toLowerCase();
      const units = request.body.units;
      const requestId = request.body.request_id;
      const client = await database.connect();
      let transactionStarted = false;
      let releaseError: Error | undefined;
      const onConnectionError = () => {
        releaseError = new Error("Consumption connection was interrupted");
      };
      // A checked-out pg client can emit an error while no query promise is active.
      client.on("error", onConnectionError);

      try {
        await client.query("BEGIN");
        transactionStarted = true;

        // Account is the serialization point shared by account mutations and consumption.
        const account = await client.query<{ id: string }>(
          "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
          [accountId],
        );
        if (account.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(401).send({ error: "Missing or invalid API key" });
        }

        // The account lock serializes all requests for this account before this lookup.
        const previous = await client.query<ExistingRequest>(
          `SELECT user_id, units, response_status, response_body
           FROM consumption_requests
           WHERE account_id = $1 AND request_id = $2`,
          [accountId, requestId],
        );
        if (previous.rows.length === 1) {
          const original = previous.rows[0];
          await client.query("COMMIT");
          transactionStarted = false;

          if (original.user_id !== userId || original.units !== String(units)) {
            return reply.code(409).send({ error: "request_id was already used with different parameters" });
          }

          return reply
            .header("Idempotency-Replayed", "true")
            .code(original.response_status)
            .send(original.response_body);
        }

        const user = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE id = $1 AND account_id = $2 FOR UPDATE",
          [userId, accountId],
        );
        if (user.rows.length !== 1) {
          await client.query("ROLLBACK");
          transactionStarted = false;
          return reply.code(404).send({ error: "User not found" });
        }

        // The processing month is fixed after both identity locks are held.
        const processingTimestamp = options.processingTimestamp
          ? await options.processingTimestamp(client)
          : null;
        const monthResult = processingTimestamp === null
          ? await client.query<{ month: string }>(
            "SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS month",
          )
          : await client.query<{ month: string }>(
            "SELECT date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC')::date::text AS month",
            [processingTimestamp],
          );
        const usageMonth = monthResult.rows[0].month;

        await client.query(
          `INSERT INTO account_monthly_usage (account_id, month)
           VALUES ($1, $2::date)
           ON CONFLICT (account_id, month) DO NOTHING`,
          [accountId, usageMonth],
        );
        await client.query(
          `INSERT INTO user_monthly_usage (account_id, user_id, month)
           VALUES ($1, $2, $3::date)
           ON CONFLICT (account_id, user_id, month) DO NOTHING`,
          [accountId, userId, usageMonth],
        );

        // Lock usage rows in one consistent order: account first, then user.
        const accountUsageResult = await client.query<UsageRow>(
          `SELECT used_units FROM account_monthly_usage
           WHERE account_id = $1 AND month = $2::date
           FOR UPDATE`,
          [accountId, usageMonth],
        );
        const userUsageResult = await client.query<UsageRow>(
          `SELECT used_units FROM user_monthly_usage
           WHERE account_id = $1 AND user_id = $2 AND month = $3::date
           FOR UPDATE`,
          [accountId, userId, usageMonth],
        );

        const snapshots = await client.query<PlanSnapshot>(
          `SELECT
             ap.id AS account_plan_id,
             ap.name AS account_plan_name,
             ap.monthly_allowance AS account_monthly_allowance,
             ap.max_units_per_request AS account_max_units_per_request,
             up.id AS user_plan_id,
             up.name AS user_plan_name,
             up.monthly_allowance AS user_monthly_allowance,
             up.max_units_per_request AS user_max_units_per_request
           FROM accounts AS a
           JOIN account_plans AS ap ON ap.id = a.account_plan_id
           JOIN users AS u ON u.account_id = a.id AND u.id = $2
           JOIN user_plans AS up ON up.id = u.user_plan_id
           WHERE a.id = $1`,
          [accountId, userId],
        );
        if (snapshots.rows.length !== 1) {
          throw new Error("Assigned account or user plan is missing");
        }

        const snapshot = snapshots.rows[0];
        const accountUsed = BigInt(accountUsageResult.rows[0].used_units);
        const userUsed = BigInt(userUsageResult.rows[0].used_units);
        const requestedUnits = BigInt(units);
        const accountAllowance = BigInt(snapshot.account_monthly_allowance);
        const userAllowance = BigInt(snapshot.user_monthly_allowance);
        const accountRequestMaximum = BigInt(snapshot.account_max_units_per_request);
        const userRequestMaximum = BigInt(snapshot.user_max_units_per_request);
        const failures: FailedRule[] = [];

        if (requestedUnits > accountRequestMaximum) {
          failures.push({
            level: "account",
            rule: "max_units_per_request",
            message: `Requested units exceed the account plan maximum of ${accountRequestMaximum}`,
          });
        }
        if (requestedUnits > userRequestMaximum) {
          failures.push({
            level: "user",
            rule: "max_units_per_request",
            message: `Requested units exceed the user plan maximum of ${userRequestMaximum}`,
          });
        }
        if (accountUsed + requestedUnits > accountAllowance) {
          failures.push({
            level: "account",
            rule: "monthly_allowance",
            message: "The account monthly allowance would be exceeded",
          });
        }
        if (userUsed + requestedUnits > userAllowance) {
          failures.push({
            level: "user",
            rule: "monthly_allowance",
            message: "The user monthly allowance would be exceeded",
          });
        }

        const accepted = failures.length === 0;
        const nextAccountUsed = accepted ? accountUsed + requestedUnits : accountUsed;
        const nextUserUsed = accepted ? userUsed + requestedUnits : userUsed;
        if (nextAccountUsed > MAX_MONTHLY_UNITS || nextUserUsed > MAX_MONTHLY_UNITS) {
          throw new Error("Usage counter would exceed the supported BIGINT limit");
        }

        if (accepted) {
          await client.query(
            `UPDATE account_monthly_usage
             SET used_units = $1, updated_at = clock_timestamp()
             WHERE account_id = $2 AND month = $3::date`,
            [nextAccountUsed.toString(), accountId, usageMonth],
          );
          await client.query(
            `UPDATE user_monthly_usage
             SET used_units = $1, updated_at = clock_timestamp()
             WHERE account_id = $2 AND user_id = $3 AND month = $4::date`,
            [nextUserUsed.toString(), accountId, userId, usageMonth],
          );
        }

        const status = accepted ? "accepted" : "rejected";
        const responseStatus = accepted ? 200 : 429;
        const responseBody = {
          status,
          request_id: requestId,
          user_id: userId,
          units,
          usage_month: usageMonth,
          account: serializeUsage(nextAccountUsed, accountAllowance),
          user: serializeUsage(nextUserUsed, userAllowance),
          failed_rules: failures,
        };

        const storedOutcome = await client.query<{ response_body: Record<string, unknown> }>(
          `INSERT INTO consumption_requests (
             account_id, request_id, user_id, units, status,
             rejection_reasons, failed_rule_levels,
             account_plan_id, account_plan_name,
             account_monthly_allowance, account_max_units_per_request,
             user_plan_id, user_plan_name,
             user_monthly_allowance, user_max_units_per_request,
             response_status, response_body
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6::jsonb, $7::text[],
             $8, $9, $10, $11,
             $12, $13, $14, $15,
             $16, $17::jsonb
           )
           RETURNING response_body`,
          [
            accountId,
            requestId,
            userId,
            units,
            status,
            JSON.stringify(failures),
            [...new Set(failures.map((failure) => failure.level))],
            snapshot.account_plan_id,
            snapshot.account_plan_name,
            snapshot.account_monthly_allowance,
            snapshot.account_max_units_per_request,
            snapshot.user_plan_id,
            snapshot.user_plan_name,
            snapshot.user_monthly_allowance,
            snapshot.user_max_units_per_request,
            responseStatus,
            JSON.stringify(responseBody),
          ],
        );

        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(responseStatus).send(storedOutcome.rows[0].response_body);
      } catch {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // A connection that cannot roll back must never be reused by another request.
            releaseError = new Error("Consumption connection could not roll back");
          }
        }
        return reply.code(500).send({ error: "Unable to process consumption request" });
      } finally {
        client.removeListener("error", onConnectionError);
        client.release(releaseError);
      }
    },
  );
}
