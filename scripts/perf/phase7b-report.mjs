import {median} from './phase7b-summary.mjs';
const f=value=>value===null?'n/a':Number(value).toFixed(2);
function grouped(trials) {
  const groups=new Map();
  for(const t of trials) { const key=`${t.experiment}/${t.layout}/${t.concurrency}/${t.reject}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t); }
  return [...groups.values()];
}
export function report(results,verification) {
  let text=`# Phase 7B contention, pooling and sustained load

Overall status: **${verification.status}**. Existing Phase 7A files preserved: **${verification.phase7a_preserved}**.

## Reproduction

Run from the repository root after installing the existing npm dependencies, with Docker Compose available:

\`\`\`sh
npm run perf:analysis
\`\`\`

To regenerate only this Markdown report from saved JSON, run \`npm run perf:analysis:report\`; it sends no requests.

This runs tmpfs then a new disk-backed Docker volume, each with a fresh private Compose project. Each environment executes \`npm run build\`, \`npm test\` and \`npm run test:db:isolated\` before measurements. The last command receives only the private Compose configuration: never run load against the main database. Runtime configurations use fresh credentials, no published ports and a private network. The runner rejects shared containers/mounts/networks. Only the newly created disk volume is removed, after checking its unique name and Compose ownership label; no existing volume is deleted. Built test images remain cached. Main tables, database inventory, existing PostgreSQL volume metadata, container identity/start time and health are checked before/after each environment. JSON verification records the outcomes. Background PostgreSQL writes are not prevented by read-only preservation checks.

Results are written to phase7b-tmpfs.json, phase7b-disk.json and phase7b-verification.json alongside this report. Phase 7A results and scripts are fingerprinted before/after. There are no new dependencies, endpoints, migrations, production algorithm changes or optimizations.

## Benchmark files

- scripts/perf/phase7b.mjs coordinates both storage modes and fingerprints Phase 7A artifacts.
- phase7b-environment.mjs owns temporary Compose configuration, isolation checks, regression commands and cleanup.
- phase7b-backend.mjs starts the existing app with pool acquisition counters and local telemetry files; it adds no HTTP endpoint.
- phase7b-postgres.mjs samples only the generated PostgreSQL container's cgroup CPU/memory.
- phase7b-driver.mjs prepares fixtures via HTTP, sends consumption requests, observes sessions and audits persisted outcomes.
- phase7b-summary.mjs and its test calculate/check observation summaries; existing metrics.mjs supplies percentile math and correctness checks unchanged.
- phase7b-report.mjs and phase7b-render.mjs generate this document from saved measurements.

## Controlled design

Layout A: one account/one user. B: one account/ten users. C: ten accounts/one user each. All use one unit per request, fresh account-owned plans, unique IDs, allowances 20100 and per-request maximum 1. Predefined plans are unchanged. Contention uses 500 measured requests, 50 warmups, concurrency 1/5/20/50 and three repetitions. Account/user distribution is round-robin; 500 and 50 divide evenly among ten. Layout order rotates by repetition. This matches total work, not per-account work: C deliberately distributes the same total load over ten independent locks.

Quota-cost compares A at concurrency 20: all accepted versus all rejected because user allowance is zero, with 500 measured requests and 50 warmups, three repetitions and alternating acceptance/rejection order. Both paths authenticate, lock account/user, inspect plans/monthly counters and persist a history decision. Rejections skip usage increments; therefore rejection still has transaction and persistence costs.

Sustained A and C each issue requests for 60 seconds, bounded by 20000 requests, concurrency 20. No new work starts after the deadline; in-flight responses drain with a five-second timeout. Request-cap exhaustion before 60 seconds invalidates the intended sustained sample. Five-second completion windows show throughput, percentiles and errors; the final partial window is drain time and should not be compared to full windows. Each sustained configuration is sampled once per storage mode: this is a short sustained verification, not an endurance/soak test.

The client is closed-loop: one in-flight HTTP request per worker. performance.now() measures through full response-body reading/parsing/validation. Setup, warmup and direct SQL audits are excluded from measured time. Latency excludes unassigned-worker queue time and does not correct coordinated omission. Percentiles are nearest rank. Fixed-count batches have a 120-second deadline, five-second request timeouts. Warmups are included in database audits without resetting usage.

The consumption_requests table stores original decisions; account_monthly_usage and user_monthly_usage store monthly counters. Accounts, users and custom plans are created through the existing API. For every trial, repeatable-read snapshots verify exact original IDs, input ownership/units, statuses, complete stored responses, history counts, accepted sums at account/user/month levels, independent quotas, no overspending, no extra charge and no unexpected replay. Rejections must charge zero. Missing requests, errors, timeouts, month rollover or any audit mismatch fail the experiment. Every account is checked, including all ten in C.

## Observation methodology

A benchmark-only entrypoint imports the existing compiled app and pool. The pool is unchanged: max 10, connection timeout 5000 ms, idle timeout 30000 ms. A wrapper times every callback/Promise connection acquisition, including authentication and readiness queries; it records an acquisition as initially queued when no idle client exists and total clients already reach max. This classification can miss other transient conditions; actual pool.waitingCount is separately sampled. Acquisition time includes pool queueing and connection creation, not SQL/lock execution time. Snapshots include actual total, idle, total-minus-idle (which may include connecting clients), waiting and cumulative acquisition counters. Reported averages use first-to-last sample deltas, so boundary requests can be missed.

Backend pool/CPU/memory snapshots are written every 100 ms; the HTTP driver samples them and PostgreSQL activity roughly every 250 ms. A host-side observer samples only the isolated PostgreSQL container's cgroup CPU/memory roughly every second. Stale/failed observations invalidate a trial. PostgreSQL sessions are filtered by current database and backend-only application_name; audit/observer sessions are excluded. The driver audit pool allows two connections and the activity observer pool one; their idle sessions still consume PostgreSQL resources, consistently across layouts. Only state, wait-event category/name and aggregate blocker counts are collected: no query text, API keys or connection credentials. Idle ClientRead normally means waiting for a client command, not a fault. Lock transactionid/tuple waits show database contention, but the sampled event alone does not identify a particular SQL statement.

CPU percentages are cgroup usage-counter deltas divided by actual observation elapsed time (100% = one core). Missing short-interval deltas are n/a. Some short samples exceed 100% slightly: these are approximate rates from non-atomic counter/timestamp reads and periodic CPU quotas, not evidence that configured limits changed. Memory is sampled RSS/cgroup current, not a proven absolute peak or leak detector; PostgreSQL cgroup memory includes cache/tmpfs effects. Sampling misses short spikes and adds overhead. All comparisons within 7B use the same instrumentation. These numbers are not an overhead-free rerun of 7A. CPU limits remain one core per backend, PostgreSQL and generator; memory 256/512/256 MiB respectively. Logging stays enabled.
`;
  for(const data of results) {
    const trials=data.trials??[];
    text+=`\n## ${data.storage} results — ${data.status}\n\nThroughput/latencies below are medians of per-trial statistics, not pooled percentiles. Requests and decisions are per trial (sustained rows have one trial); errors/timeouts sum repetitions. Accepted excludes retries. Raw JSON includes all per-trial metrics, latency samples, five-second windows, observation samples and correctness details.\n\n| Experiment/layout | C | Repeats | Requests | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Errors | Timeouts | Correctness |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n`;
    for(const g of grouped(trials)) {const t=g[0],m=field=>f(median(g.map(field)));
      text+=`| ${t.experiment}/${t.layout}${t.reject?' rejected':''} | ${t.concurrency} | ${g.length} | ${t.measured.total_requests} | ${m(t=>t.measured.throughput_rps)} | ${['p50','p95','p99'].map(k=>m(t=>t.measured.latency_ms[k])).join(' | ')} | ${t.measured.accepted} | ${t.measured.quota_rejected} | ${g.reduce((n,t)=>n+t.measured.http_errors+t.measured.network_errors,0)} | ${g.reduce((n,t)=>n+t.measured.timeouts,0)} | ${g.every(t=>t.correctness.status==='PASS')?'PASS':'FAILED'} |\n`;
    }
    text+='\n### Pool, locks and CPU observations\n\nPeaks below are maxima across sampled repetitions; acquisition/CPU values are medians of per-trial observation summaries. CPU = percent of one core.\n\n| Experiment/layout | C | Pool total peak | Busy peak/max | Idle peak | Waiting peak | Acquisition ms | PG active peak | PG idle peak | PG lock wait peak | Backend CPU % | PG CPU % |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
    for(const g of grouped(trials)) {const t=g[0],max=k=>Math.max(...g.map(t=>t.observation_summary[k])),med=k=>f(median(g.map(t=>t.observation_summary[k]).filter(v=>v!==null)));
      text+=`| ${t.experiment}/${t.layout}${t.reject?' rejected':''} | ${t.concurrency} | ${max('pool_peak_total')} | ${max('pool_peak_checked_out')}/${t.observation_summary.pool_max} | ${max('pool_peak_idle')} | ${max('pool_peak_waiting')} | ${med('mean_acquisition_ms')} | ${max('pg_peak_active')} | ${max('pg_peak_idle')} | ${max('pg_peak_lock_wait')} | ${med('backend_cpu_percent_one_core')} | ${med('postgres_cpu_percent_one_core')} |\n`;
    }
    text+='\n### Sustained completion windows\n\n| Layout | Start s | Window s | Requests | req/s | P50 ms | P95 ms | P99 ms | Errors | Timeouts |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
    for(const t of trials.filter(t=>t.sustained)) for(const w of t.measured.windows) text+=`| ${t.layout} | ${f(w.start_seconds)} | ${f(w.duration_seconds)} | ${w.total_requests} | ${f(w.throughput_rps)} | ${['p50','p95','p99'].map(k=>w.latency_ms?f(w.latency_ms[k]):'n/a').join(' | ')} | ${w.errors} | ${w.timeouts} |\n`;
    text+='\n### Sustained memory and wait events\n\n';
    for(const t of trials.filter(t=>t.sustained)) text+=`Layout ${t.layout}:\n\n\`\`\`json\n${JSON.stringify(t.observation_summary,null,2)}\n\`\`\`\n`;
    const rates=(layout,c)=>median(trials.filter(t=>t.experiment==='contention'&&t.layout===layout&&t.concurrency===c).map(t=>t.measured.throughput_rps));
    text+=`\nLayout C median throughput across concurrency 1/5/20/50: ${[1,5,20,50].map(c=>f(rates('C',c))).join(' / ')} req/s. At concurrency 50, B/A throughput ratio = ${f(rates('B',50)/rates('A',50))}; more users under one account do not remove that account's serialization point.\n`;
    text+=`\nMeasured at concurrency 50: A ${f(rates('A',50))}, B ${f(rates('B',50))}, C ${f(rates('C',50))} req/s. C/A ratio = ${f(rates('C',50)/rates('A',50))}. These are observations on this constrained machine, not linear scaling guarantees.\n`;
    text+=`\n### Environment and verification\n\n\`\`\`json\n${JSON.stringify({environment:data.environment,verification:data.verification},null,2)}\n\`\`\`\n`;
  }
  text+='\n## Observed comparisons\n\n';
  for(const data of results) {
    const all=data.trials??[];
    const rate=(experiment,layout,c,reject=false)=>median(all.filter(t=>t.experiment===experiment&&t.layout===layout&&t.concurrency===c&&t.reject===reject).map(t=>t.measured.throughput_rps));
    const high=all.filter(t=>t.experiment==='contention'&&t.concurrency===50);
    const ioEvents=[...new Set(all.flatMap(t=>Object.keys(t.observation_summary.wait_events_peak_sessions)).filter(key=>key.includes('/IO/')))];
    text+=`${data.storage} sampled I/O events: ${ioEvents.length?ioEvents.join(', '):'none observed'}. Sampling gives event presence/peak counts, not cumulative I/O wait duration or a causal latency breakdown.\n\n`;
    const peak=(layout,k)=>Math.max(0,...high.filter(t=>t.layout===layout).map(t=>t.observation_summary[k]));
    text+=`${data.storage}: at concurrency 50, A/B/C sampled peak lock waiters = ${['A','B','C'].map(l=>peak(l,'pg_peak_lock_wait')).join('/')}; peak pool waiters = ${['A','B','C'].map(l=>peak(l,'pool_peak_waiting')).join('/')}. Accepted versus quota-rejected median throughput = ${f(rate('quota-cost','A',20))} versus ${f(rate('quota-cost','A',20,true))} req/s (rejected/accepted ${f(rate('quota-cost','A',20,true)/rate('quota-cost','A',20))}x). These paths have different write work despite matching request counts and concurrency.\n\n`;
    for(const t of all.filter(t=>t.sustained)) {
      const full=t.measured.windows.filter(w=>w.duration_seconds===5);
      const errors=t.measured.http_errors+t.measured.network_errors;
      text+=`Sustained ${data.storage}/${t.layout}: ${t.measured.total_requests} requests in ${f(t.measured.duration_seconds)} s; full-window throughput ranged ${f(Math.min(...full.map(w=>w.throughput_rps)))}–${f(Math.max(...full.map(w=>w.throughput_rps)))} req/s, first/last full-window P95 ${f(full[0]?.latency_ms?.p95)} / ${f(full.at(-1)?.latency_ms?.p95)} ms. Unexpected error rate ${f(100*errors/t.measured.total_requests)}%, timeout rate ${f(100*t.measured.timeouts/t.measured.total_requests)}%. Backend sampled RSS first/last ${t.observations[0].backend.memory.rss}/${t.observations.at(-1).backend.memory.rss} bytes; this alone cannot establish a memory leak.\n\n`;
    }
  }
  if(results.length===2) {
    const rate=(data,layout)=>median(data.trials.filter(t=>t.experiment==='contention'&&t.layout===layout&&t.concurrency===50).map(t=>t.measured.throughput_rps));
    text+=`Matching concurrency-50 disk/tmpfs throughput ratios: ${['A','B','C'].map(l=>`${l} ${f(rate(results[1],l)/rate(results[0],l))}x`).join(', ')}. A ratio alone does not isolate storage latency from the other shared host effects.\n\n`;
  }
  text+=`\n## Interpretation and storage limitations

The account FOR UPDATE lock remains held until COMMIT and precedes user locks. A and B therefore serialize on the same account regardless of user count. C removes that common account lock across accounts but still shares the ten-connection pool and CPU/storage resources. Sampled pool queues and PostgreSQL lock waits are observed measurements; the exact fraction of end-to-end latency caused by each is not separately attributed. Check the tables and raw wait-event samples before identifying a dominant limit. Pool size was observed, not tuned. Ten total clients does not mean ten executing queries: idle clients, checked-out clients waiting on locks and requests waiting to acquire a client are different states. More concurrency can increase queueing latency without raising throughput proportionally.

Tmpfs keeps PostgreSQL data/WAL in memory, bypassing physical persistent-disk latency and influencing memory pressure. The dedicated local Docker volume is disk-backed when its actual filesystem is not tmpfs; its filesystem is recorded in verification. Both runs retain fsync, synchronous_commit and full_page_writes. A disk-backed result still includes OS/device caches and Docker/virtualization effects, so it is not raw-device throughput or a power-loss durability test. The entire tmpfs run precedes disk: host activity, cache state and run order can confound attribution. Storage comparisons use newly measured matching 7B workloads, not the older 7A samples. No forced cache dropping, volume reuse, production volume mounts or crash tests were performed.

CPU utilization and throttling counters, sampled pool queueing and lock-wait counts are direct observations. Precise lock hold times, query-level execution costs, I/O wait attribution, logging costs, client bottlenecks and optimal pool sizes remain unmeasured. More accounts cannot guarantee unlimited scalability. One-minute sustained runs cannot establish long-term stability or absence of leaks. Accounts and history accumulate across trials within each disposable database; fresh fixtures isolate correctness, but table/cache growth can affect performance. No latency SLO or production-capacity claim is made. Phase 7C has not started.
`;
  return text;
}
