import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { EventEmitter } from "node:events";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

const SECRET = "regression-credential-must-not-appear";

describe("database failure safety", () => {
  it("preserves the status and envelope of an unhandled 503 while sanitizing its message", async () => {
    const database = { query: async () => { throw Object.assign(new Error(SECRET), { statusCode: 503 }); } } as unknown as Pool;
    const app = buildApp({ database, logger: false });
    try {
      const response = await app.inject({ url: "/v1/accounts/me", headers: { "x-api-key": SECRET } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ statusCode: 503, error: "Service Unavailable", message: "Internal Server Error" });
    } finally { await app.close(); }
  });

  it("keeps existing client validation responses informative", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/consumptions", payload: {
        user_id: "20000000-0000-4000-8000-000000000001", units: 0, request_id: "invalid" } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Bad Request");
      expect(response.json().message).toContain("units");
    } finally { await app.close(); }
  });
  it("does not expose authentication database errors in HTTP responses or logs", async () => {
    const output: string[] = [];
    const database = { query: async () => { throw Object.assign(new Error(SECRET), {
      code: "28P01", detail: SECRET, hint: SECRET,
    }); } } as unknown as Pool;
    const app = buildApp({ database, logger: { stream: { write: (line: string) => { output.push(line); } } } });
    try {
      const response = await app.inject({ url: "/v1/accounts/me", headers: { "x-api-key": SECRET } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" });
      expect(response.body).not.toContain(SECRET);
      expect(output.join("")).not.toContain(SECRET);
      const diagnostic = output.map(line => JSON.parse(line)).find(line => line.msg === "Request failed");
      expect(diagnostic.databaseCode).toBe("28P01");
      expect(diagnostic.statusCode).toBe(500);
      expect(diagnostic.reqId).toBeTruthy();
    } finally { await app.close(); }
  });

  it("readiness queries the same injected database used by routes", async () => {
    let attempts = 0;
    const database = { query: async () => { attempts += 1; throw new Error(SECRET); } } as unknown as Pool;
    const app = buildApp({ database, logger: false });
    try {
      const response = await app.inject({ url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(SECRET);
      expect(attempts).toBe(1);
    } finally { await app.close(); }
  });

  it("handles idle pool errors without throwing or printing raw connection errors", () => {
    expect(() => pool.emit("error", new Error(SECRET))).not.toThrow();
  });

  it("returns the existing consumption error and discards the client if rollback fails", async () => {
    let releasedWithError: unknown;
    const client = Object.assign(new EventEmitter(), {
      query: async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        throw new Error(SECRET);
      },
      release: (error?: unknown) => { releasedWithError = error; },
    });
    const database = { query: async () => ({ rows: [{ id: "10000000-0000-4000-8000-000000000001" }] }),
      connect: async () => client } as unknown as Pool;
    const app = buildApp({ database, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/consumptions",
        headers: { "x-api-key": SECRET }, payload: { user_id: "20000000-0000-4000-8000-000000000001", units: 1, request_id: "rollback-failure" } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Unable to process consumption request" });
      expect(releasedWithError).toBeInstanceOf(Error);
      expect(response.body).not.toContain(SECRET);
    } finally { await app.close(); }
  });

  it("handles a checked-out connection error between consumption queries", async () => {
    let discarded: unknown;
    const client = Object.assign(new EventEmitter(), {
      query: async (sql: string) => {
        if (sql === "BEGIN") {
          client.emit("error", new Error(SECRET));
          throw new Error(SECRET);
        }
        throw new Error(SECRET);
      },
      release: (error?: unknown) => { discarded = error; },
    });
    const database = { query: async () => ({ rows: [{ id: "10000000-0000-4000-8000-000000000001" }] }), connect: async () => client } as unknown as Pool;
    const app = buildApp({ database, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/consumptions", headers: { "x-api-key": SECRET },
        payload: { user_id: "20000000-0000-4000-8000-000000000001", units: 1, request_id: "checked-out-error" } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Unable to process consumption request" });
      expect(discarded).toBeInstanceOf(Error);
      expect(client.listenerCount("error")).toBe(0);
    } finally { await app.close(); }
  });
});
