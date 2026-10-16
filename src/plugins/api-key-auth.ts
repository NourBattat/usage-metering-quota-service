import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyRequest {
    accountId: string | null;
  }
}

export function registerApiKeyAuthentication(app: FastifyInstance): void {
  app.decorateRequest("accountId", null);
}

export function requireApiKey(database: Pool = defaultPool) {
  return async function authenticateApiKey(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const apiKey = request.headers["x-api-key"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      await reply.code(401).send({ error: "Missing or invalid API key" });
      return;
    }

    const apiKeyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
    const result = await database.query<{ id: string }>(
      "SELECT id FROM accounts WHERE api_key_hash = $1",
      [apiKeyHash],
    );

    if (result.rows.length !== 1) {
      await reply.code(401).send({ error: "Missing or invalid API key" });
      return;
    }

    request.accountId = result.rows[0].id;
  };
}
