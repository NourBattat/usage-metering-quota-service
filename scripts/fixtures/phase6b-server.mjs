import assert from "node:assert/strict";
import { buildApp } from "../../dist/app.js";
import { pool } from "../../dist/db/pool.js";

// Test-only IPC controls. No diagnostic endpoints or production fault switches exist.
assert.match(process.env.PGDATABASE ?? "", /^usage_metering_test_[1-9][0-9]*_[a-f0-9]{32}$/);
let fault;
let resume;
const database = {
  query: (...args) => pool.query(...args),
  connect: async () => {
    const client = await pool.connect();
    return {
      on: (...args) => client.on(...args),
      removeListener: (...args) => client.removeListener(...args),
      release: (...args) => client.release(...args),
      query: async (sql, ...args) => {
        const result = await client.query(sql, ...args);
        const afterUpdate = sql.trim().startsWith("UPDATE account_monthly_usage");
        if (afterUpdate && fault === "query") {
          fault = undefined;
          await client.query("SELECT 1 / 0");
        }
        if ((afterUpdate && fault === "terminate") || (sql === "COMMIT" && fault === "lost-response")) {
          fault = undefined;
          await new Promise(resolve => {
            resume = resolve;
            process.send({ event: "paused", pid: client.processID });
          });
        }
        // Pause before COMMIT by intercepting the final outcome insert instead.
        if (sql.trim().startsWith("INSERT INTO consumption_requests") && fault === "before-commit") {
          fault = undefined;
          await new Promise(resolve => {
            resume = resolve;
            process.send({ event: "paused", pid: client.processID });
          });
          await client.query("SELECT 1 / 0");
        }
        return result;
      },
    };
  },
};
const app = buildApp({ database, logger: false });
process.on("message", async message => {
  if (message.type === "arm") { fault = message.fault; process.send({ event: "armed" }); }
  if (message.type === "resume") { resume?.(); resume = undefined; }
  if (message.type === "idle") {
    const result = await pool.query("SELECT pg_backend_pid() AS pid");
    pool.once("error", () => process.send({ event: "idle-error" }));
    process.send({ event: "idle", pid: result.rows[0].pid });
  }
});
process.on("SIGTERM", async () => {
  try { await app.close(); await pool.end(); process.exitCode = 0; }
  catch { process.exitCode = 1; }
  process.disconnect();
});
await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ event: "ready", url: `http://127.0.0.1:${app.server.address().port}` });
