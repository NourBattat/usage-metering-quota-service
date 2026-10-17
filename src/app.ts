import Fastify from "fastify";
import { STATUS_CODES } from "node:http";
import type { FastifyServerOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { pool } from "./db/pool.js";
import { registerApiKeyAuthentication } from "./plugins/api-key-auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerConsumptionRoutes } from "./routes/consumptions.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerPlanAssignmentRoutes } from "./routes/plan-assignments.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerUsageRoutes } from "./routes/usage.js";

type BuildAppOptions = {
  database?: Pool;
  databaseCheck?: () => Promise<void>;
  provisioningToken?: string;
  consumptionTimestamp?: (client: PoolClient) => Promise<string>;
  logger?: FastifyServerOptions["logger"];
};

export function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? pool;
  const providedLogger = options.logger;
  const app = Fastify({
    logger: providedLogger === false
      ? false
      : {
        ...(typeof providedLogger === "object" ? providedLogger : {}),
      serializers: {
          ...(typeof providedLogger === "object" ? providedLogger.serializers : {}),
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    ajv: {
      customOptions: { removeAdditional: false, coerceTypes: false },
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error !== null
      && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode : 500;
    if (statusCode < 500) return reply.send(error);
    // Infrastructure errors may contain connection details; never serialize or log them.
    const databaseCode = typeof error === "object" && error !== null
      && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code : undefined;
    // Keep the bounded SQLSTATE diagnostic and request ID, never message/detail/hint/SQL.
    request.log.error({ statusCode, ...(databaseCode ? { databaseCode } : {}) }, "Request failed");
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode] ?? "Internal Server Error",
      message: "Internal Server Error",
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await (options.databaseCheck ?? (() => database.query("SELECT 1")))();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  registerApiKeyAuthentication(app);
  registerAccountRoutes(app, {
    database,
    provisioningToken: options.provisioningToken,
  });
  registerUserRoutes(app, { database });
  registerPlanRoutes(app, { database });
  registerPlanAssignmentRoutes(app, { database });
  registerConsumptionRoutes(app, {
    database,
    processingTimestamp: options.consumptionTimestamp,
  });
  registerUsageRoutes(app, { database });
  registerRequestRoutes(app, { database });

  return app;
}
