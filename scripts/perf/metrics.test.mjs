import assert from "node:assert/strict";
import test from "node:test";
import { summarize, audit } from "./metrics.mjs";

test("nearest-rank percentiles, throughput and average use actual samples without sorting the caller array", () => {
  const values = [5, 1, 4, 2, 3];
  assert.deepEqual(summarize(values, 1000), { duration_seconds: 1, throughput_rps: 5,
    latency_ms: { average: 3, minimum: 1, maximum: 5, p50: 3, p95: 5, p99: 5 } });
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
  assert.equal(summarize(Array.from({ length: 100 }, (_, i) => i + 1), 500).latency_ms.p99, 99);
});
test("invalid or missing measurements cannot produce a successful summary", () => {
  for (const [samples, duration] of [[[], 1], [[1], 0], [[NaN], 1], [[-1], 1]]) assert.throws(() => summarize(samples, duration));
});
const expected = new Map([["ok", { user_id: "u", units: 1, status: "accepted" }], ["no", { user_id: "u", units: 1, status: "rejected" }]]);
function fixture() { return { account_usage: [{ month: "2026-01-01", used_units: "1" }],
  user_usage: [{ month: "2026-01-01", user_id: "u", used_units: "1" }],
  history: [...expected].map(([request_id, row]) => ({ ...row, units: "1", request_id, response_body: { usage_month: "2026-01-01" } })) }; }
test("one accepted decision and one rejection charge once", () => {
  assert.equal(audit(fixture(), expected, ["u"], { account: 1, user: 1 }, 1).status, "PASS");
});
test("charging rejected or retried requests fails the audit", () => {
  const data = fixture(); data.account_usage[0].used_units = "2"; data.user_usage[0].used_units = "2";
  assert.equal(audit(data, expected, ["u"], { account: 3, user: 3 }, 1).status, "FAILED");
});
test("duplicate/missing history and quota overspending fail even if counters agree", () => {
  const data = fixture(); data.history.push(data.history[0]);
  assert.equal(audit(data, expected, ["u"], { account: 10, user: 10 }, 1).status, "FAILED");
  assert.equal(audit(fixture(), expected, ["u"], { account: 0, user: 0 }, 1).status, "FAILED");
});
test("history must preserve the complete HTTP decision body", () => {
  const data = fixture();
  const observed = new Map([...expected].map(([id,input]) => [id, { ...input, raw: JSON.stringify({ usage_month: "2026-01-01", status: input.status }) }]));
  assert.equal(audit(data, observed, ["u"], { account: 1, user: 1 }, 1).status, "FAILED");
  for (const row of data.history) row.response_body.status = row.status;
  assert.equal(audit(data, observed, ["u"], { account: 1, user: 1 }, 1).status, "PASS");
});
