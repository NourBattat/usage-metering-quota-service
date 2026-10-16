import Fastify from "fastify";
import { checkDatabaseConnection } from "./db/pool.js";

export function buildApp(databaseCheck = checkDatabaseConnection) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await databaseCheck();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return app;
}
