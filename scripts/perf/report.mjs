const fixed = value => Number(value).toFixed(2);
const median = values => { const sorted = values.toSorted((a,b)=>a-b); const i=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[i] : (sorted[i-1]+sorted[i])/2; };
export function report(data) {
  const trials = data.trials ?? [];
  const rows = [];
  for (const id of [...new Set(trials.map(t=>t.scenario))]) {
    const group = trials.filter(t=>t.scenario===id); const first=group[0];
    const med = field => fixed(median(group.map(field)));
    rows.push(`| ${id}: ${first.name} | ${first.concurrency} | ${first.measured.total_requests} | ${med(t=>t.measured.throughput_rps)} | ${med(t=>t.measured.latency_ms.p50)} | ${med(t=>t.measured.latency_ms.p95)} | ${med(t=>t.measured.latency_ms.p99)} | ${first.measured.accepted} | ${first.measured.quota_rejected} | ${first.measured.idempotent_replays} | ${group.reduce((s,t)=>s+t.measured.http_errors+t.measured.network_errors+t.measured.timeouts,0)} | ${group.every(t=>t.correctness.status==='PASS')?'PASS':'FAILED'} |`);
  }
  const scenarioMedian = (id, field) => { const group=trials.filter(t=>t.scenario===id); return group.length ? median(group.map(field)) : null; };
  const rate = id => scenarioMedian(id,t=>t.measured.throughput_rps);
  const latency = id => scenarioMedian(id,t=>t.measured.latency_ms.p95);
  const comparison = rate('A') && rate('D') ? `Measured A to D: throughput changed from ${fixed(rate('A'))} to ${fixed(rate('D'))} req/s (${fixed(rate('D')/rate('A'))}x), while P95 changed from ${fixed(latency('A'))} to ${fixed(latency('D'))} ms. ` : '';
  const usersComparison = rate('E') && rate('F') ? `Measured E/F: ten users achieved ${fixed(rate('E'))} req/s versus ${fixed(rate('F'))} req/s for one user (${fixed(rate('E')/rate('F'))}x). This does not establish scaling with user count; both still share one account lock. ` : '';
  return `# Phase 7A performance baseline

Overall status: **${data.status}**. Measured at ${data.started_at_utc ?? 'unavailable'} through ${data.finished_at_utc ?? 'unavailable'}.

## Reproduction and safety

From the repository root, with installed npm dependencies and Docker Compose available:

\`\`\`sh
npm run perf:baseline
\`\`\`

This command runs \`npm run build\`, \`npm test\`, and \`npm run test:db:isolated\` before benchmarks. The database regression command receives a private COMPOSE_FILE and COMPOSE_PROJECT_NAME, so it creates/drops its temporary test database inside the disposable performance PostgreSQL container. It does not target the main application cluster. To change bounded sample size: \`PERF_REQUESTS=1000 PERF_REPEATS=3 npm run perf:baseline\` (100–2000 requests, 1–3 repeats). Defaults: 500 requests and three repeats per scenario.

The harness creates a uniquely named Compose project, private bridge network, PostgreSQL, migration job, backend and HTTP generator. No service publishes a host port. Generated credentials live only in private temporary configuration and process/container environments. PostgreSQL uses tmpfs; no named volumes are created or removed. Cleanup removes only this project's containers/network and private files. Built benchmark images remain cached. Before/after read-only fingerprints cover every row in eight main application tables, the database inventory, persistent volume metadata, container identity/start times and health. Metadata equality does not mean the main server makes no normal background disk writes.

## Methodology

Each scenario runs ${data.configuration?.repeats ?? '?'} times with ${data.configuration?.requests_per_trial ?? '?'} measured requests per trial and 50 warmup requests on its own fresh account. Units = 1. Setup and SQL audits are outside timing; warmup remains in the database and correctness accounting. The existing predefined plans remain unchanged. The regression suite runs before measurements, so this is a warm-server baseline, not a cold-start test.

Node built-in fetch sends real POST /v1/consumptions requests over the private Docker bridge. Each closed-loop worker waits for its complete response before issuing another request. performance.now() measures monotonic wall time through full response-body reading, JSON parsing and validation. IDs are prepared before timing. Each request has a five-second timeout; each batch has a 120-second deadline. Latency excludes time waiting to be assigned to a worker. This is not an open-loop arrival-rate test and does not correct coordinated omission. Percentiles use nearest rank ceil(p*N).

A–D accept every request to one user, varying concurrency. E and F both accept 250 and reject 250 measured requests at defaults, using concurrency 20 and the same account limit; E distributes requests over ten users, F uses one. G sends one common request ID concurrently: exactly one original acceptance and 499 replays. H uses a zero user allowance: all requests are rejected. Warmups use distinct IDs; G therefore stores 51 original accepted decisions including warmup. H stores 550 rejected decisions. E/F store 550 decisions and charge 300 units including warmup.

After every trial, a repeatable-read SQL snapshot checks all original request IDs, users, units, statuses and complete stored response bodies against observed HTTP decisions; accepted sums against account and per-user monthly counters; user totals against account totals; and both quota limits. Exact retries must return identical bodies, produce one original history entry and charge once. Failed HTTP outcomes, missing samples, month rollover or any correctness mismatch invalidate the run, irrespective of throughput. PASS indicates correctness, not satisfaction of a latency SLO.

## Results

Throughput and latency columns are medians of per-trial statistics, not pooled percentiles. Request/outcome counts are **per trial**; errors sum all repeats. Accepted excludes replays; HTTP 200 response counts are separately recorded in JSON. Errors include unexpected HTTP/protocol responses, network errors and timeouts; expected quota HTTP 429 responses are not errors. See baseline.json for every duration, average/minimum/maximum latency, individual sample, outcome count and correctness result.

| Scenario | Concurrency | Requests/trial | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Replays | Errors | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${rows.join('\n')}

### Every measured trial

| Scenario | Repeat | Seconds | req/s | Avg ms | Min ms | Max ms | P50 ms | P95 ms | P99 ms | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${trials.map(t=>`| ${t.scenario} | ${t.repeat} | ${fixed(t.measured.duration_seconds)} | ${fixed(t.measured.throughput_rps)} | ${['average','minimum','maximum','p50','p95','p99'].map(k=>fixed(t.measured.latency_ms[k])).join(' | ')} | ${t.correctness.status} |`).join('\n')}

## Environment

Backend and PostgreSQL each have a one-CPU quota; backend memory limit is 256 MiB, PostgreSQL 512 MiB, generator one CPU/256 MiB. These are benchmark-only controls, not production changes. CPU model/count and host memory reported inside containers can differ from cgroup limits. Generator cgroup limits, PostgreSQL settings, source commit, image IDs, Docker version/storage driver and actual backend container limits are recorded below. Backend connection pool remains max 10, connection timeout 5000 ms, idle timeout 30000 ms; audit pool max 2 is used outside timing. Fastify request logging remains enabled.

\`\`\`json
${JSON.stringify({runtime:data.environment, verification:data.verification},null,2)}
\`\`\`

## Interpretation and limitations

${comparison}${usersComparison}

The measurements above establish end-to-end throughput and latency for these bounded workloads on this machine. Compare A–D for the observed effect of concurrency: more simultaneous requests can overlap network/authentication work, while queueing can raise latency without proportional throughput gains. Compare E/F for the observed ten-user versus one-user result with matching request mix; short runs and run-to-run variation prevent treating a small difference as a general improvement.

The source locks the account row FOR UPDATE until transaction commit, before locking the user and updating counters. Consequently all consumption transactions for one account serialize, even with different users. Additional users do not remove this shared lock. This mechanism is established by code inspection; time spent waiting on that lock was not separately measured. G takes the replay path rather than repeating normal writes; H persists rejections without charging, so their speeds do not represent successful-consumption throughput.

The existing pool of ten connections can queue acquisition at concurrency 20/50. Authentication queries also use that pool. Pool wait, account-lock wait, CPU, logging, network and PostgreSQL execution contributions are hypotheses rather than separately measured bottlenecks: no profiler, wait-event sampling or pool instrumentation was added. No production algorithms or pool settings were optimized. The generator may also limit throughput under its CPU quota. A separate multi-account benchmark would be needed to assess scaling without one shared account lock; that is outside this phase.

PostgreSQL storage is tmpfs: these results do not measure persistent-disk performance, crash durability, production capacity, long-running stability or an SLO. Only three short default samples per scenario were taken, in fixed A–H order; cache/order effects and shared host activity remain possible. Use the raw individual trials to judge variation. Phase 7B has not started.
`;
}
