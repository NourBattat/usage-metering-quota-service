import { isDeepStrictEqual } from "node:util";

export function summarize(latencies, durationMs) {
  if (!latencies.length || !Number.isFinite(durationMs) || durationMs <= 0
    || latencies.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Latency samples and duration must be finite nonnegative measurements with positive duration.");
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    duration_seconds: durationMs / 1000,
    throughput_rps: latencies.length * 1000 / durationMs,
    latency_ms: { average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      minimum: sorted[0], maximum: sorted.at(-1), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}

// This audit includes warmup as well as measured requests, including every UTC month.
export function audit(snapshot, expected, users, limits, originalAccepted) {
  const failures = [];
  const account = new Map();
  const perUser = new Map();
  const seen = new Set();
  let accepted = 0;
  for (const row of snapshot.history) {
    const input = expected.get(row.request_id);
    if (seen.has(row.request_id)) failures.push("duplicate history request ID");
    seen.add(row.request_id);
    if (!input || input.user_id !== row.user_id || String(input.units) !== row.units || input.status !== row.status) failures.push("history does not match original input/decision");
    if (input?.raw && !isDeepStrictEqual(JSON.parse(input.raw), row.response_body)) failures.push("stored response differs from observed HTTP decision");
    const month = row.response_body?.usage_month;
    if (!/^\d{4}-\d{2}-01$/.test(month ?? "")) failures.push("invalid stored UTC month");
    if (row.status === "accepted") {
      accepted++;
      account.set(month, (account.get(month) ?? 0n) + BigInt(row.units));
      const key = `${month}/${row.user_id}`;
      perUser.set(key, (perUser.get(key) ?? 0n) + BigInt(row.units));
    }
  }
  if (seen.size !== expected.size || snapshot.history.length !== expected.size) failures.push("missing or extra original decision history");
  if (accepted !== originalAccepted) failures.push("accepted history differs from original accepted HTTP decisions");
  const accountRows = new Map(snapshot.account_usage.map(row => [row.month, BigInt(row.used_units)]));
  const userRows = new Map(snapshot.user_usage.map(row => [`${row.month}/${row.user_id}`, BigInt(row.used_units)]));
  for (const key of new Set([...accountRows.keys(), ...account.keys()])) {
    if ((accountRows.get(key) ?? 0n) !== (account.get(key) ?? 0n)) failures.push("account usage differs from accepted units");
    const userSum = snapshot.user_usage.filter(row => row.month === key).reduce((sum, row) => sum + BigInt(row.used_units), 0n);
    if ((accountRows.get(key) ?? 0n) !== userSum) failures.push("account usage differs from user sum");
    if ((accountRows.get(key) ?? 0n) > BigInt(limits.account)) failures.push("account quota overspending");
  }
  for (const key of new Set([...userRows.keys(), ...perUser.keys()])) {
    if ((userRows.get(key) ?? 0n) !== (perUser.get(key) ?? 0n)) failures.push("user usage differs from accepted units");
    if ((userRows.get(key) ?? 0n) > BigInt(limits.user)) failures.push("user quota overspending");
  }
  if (snapshot.user_usage.some(row => !users.includes(row.user_id))) failures.push("foreign user counter");
  return { status: failures.length ? "FAILED" : "PASS", failures: [...new Set(failures)],
    original_decisions: snapshot.history.length, accepted_decisions: accepted,
    rejected_decisions: snapshot.history.filter(row => row.status === "rejected").length,
    account_units: snapshot.account_usage.reduce((sum, row) => sum + BigInt(row.used_units), 0n).toString(),
    user_units: users.map((id, index) => ({ user: index + 1, used_units: snapshot.user_usage.filter(row => row.user_id === id).reduce((sum, row) => sum + BigInt(row.used_units), 0n).toString() })),
    utc_months: [...new Set(snapshot.history.map(row => row.response_body?.usage_month))].sort() };
}
