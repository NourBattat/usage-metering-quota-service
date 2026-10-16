import Fastify from "fastify";
import type { FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import { checkDatabaseConnection } from "./db/pool.js";
import { pool } from "./db/pool.js";
import { registerApiKeyAuthentication } from "./plugins/api-key-auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";

type BuildAppOptions = {
  database?: Pool;
  databaseCheck?: () => Promise<void>;
  provisioningToken?: string;
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
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await (options.databaseCheck ?? (() => checkDatabaseConnection()))();
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

  return app;
}
