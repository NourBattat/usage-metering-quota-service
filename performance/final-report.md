# Final performance analysis — Phase 7C

Validation status: **PASS**. The measured runs are the saved October 17, 2026 Phase 7A/7B runs. Phase 7C introduces no new performance measurements, production changes, pool tuning or optimizations. The original reports are archived snapshots: wording such as "Phase 7B has not started" describes their historical scope. This document is the final interpretation.

## Evidence validation and arithmetic

The offline validator reads every latency sample and audit summary, checks experiment/repetition coverage, outcome counts, measured versus warmup work, rate and percentile arithmetic, completion windows, actual pool settings and cached observation summaries. It also regenerates both historical reports in memory and compares them byte-for-byte to the saved Markdown. Original inputs are hashed, never rewritten. Validation details and SHA-256 hashes: [phase7c-validation.json](phase7c-validation.json).

| Dataset | Completed runs | Measured requests | Warmups | Accepted originals | Rejected originals | Replays | Unexpected HTTP / transport / timeout |
|---|---:|---:|---:|---:|---:|---:|---|
| 7A tmpfs | 24 | 12000 | 1200 | 7503 | 3000 | 1497 | 0 / 0 / 0 |
| 7B tmpfs | 44 | 34219 | 2200 | 32719 | 1500 | 0 | 0 / 0 / 0 |
| 7B disk | 44 | 31449 | 2200 | 29949 | 1500 | 0 | 0 / 0 / 0 |

Total: 112 completed runs, 77668 measured requests and 5600 warmups. The Phase 7B subset is 88 runs, 65668 measured requests and 4400 warmups. Accepted counts exclude idempotent replays. Every request uses one unit. Expected quota HTTP 429 responses are not unexpected errors.

Throughput is completed requests divided by measured monotonic duration in seconds. Sort a trial's N latency samples ascending; P50/P95/P99 are samples at one-based positions ceil(0.50N), ceil(0.95N), ceil(0.99N). Average uses all samples; min/max use the extremes. For three repetitions, calculate each trial's statistic first, sort its three values and select the middle value. For example, 7A sequential throughput 97.17, 123.53, 127.36 yields median 123.53 req/s. The median throughput and median percentile can come from different trials. These are not pooled percentiles or total-requests/total-time aggregate rates. No confidence interval is established by three repetitions.

**Validation findings:** no numerical or workload-count inconsistency was found, and no targeted benchmark rerun is needed. Saved completion windows can be recalculated by slicing the completion-ordered latency array using each saved window count; original completion timestamps are absent, so exact boundary assignment cannot be independently reconstructed. Phase 7B stores warmup outcomes indirectly in original-history audit counts; the validator checks measured + 50 decisions, expected acceptance/rejection and user/account totals. It does not invent a missing per-request warmup log.

## Methodology and environment

Real HTTP POST /v1/consumptions calls reach Fastify and real PostgreSQL. Closed-loop workers issue one request at a time, using Node fetch over a private Docker bridge. performance.now() measures until full response-body reading, parsing and validation. IDs, fixture setup, 50 warmups and final SQL audits are outside measured time. Warmup charges/history remain in correctness totals. The database server has already executed regression tests, so this is a warm-server baseline. Request timeouts are 5000 ms; fixed-count batches have a 120-second deadline. Latency excludes waiting for worker assignment; no open-loop offered-rate or coordinated-omission correction was used.

Measured environment: Node v22.23.3 inside containers, host Node v22.23.2; PostgreSQL 17.11; Docker Engine 29.8.1, Linux x86_64, Docker storage driver overlayfs. Host CPU: 12th Gen Intel(R) Core(TM) i7-1255U, 12 visible logical CPUs; reported memory 8157081600 bytes (7.60 GiB). This is the user's local WSL2/Docker setup; current verification records the WSL kernel separately because the historical JSON did not retain its exact kernel release. Recorded image IDs/source commit remain in raw JSON; floating image tags and npm ranges mean a later run can use newer software, so record its versions instead of expecting identical numbers.

Backend, PostgreSQL and generator each have a one-CPU quota, not a dedicated physical core. Backend/generator memory limits are 256 MiB each; PostgreSQL 512 MiB. The actual backend pg pool allows 10 clients, with a 5000-ms connection timeout and 30000-ms idle timeout; authentication and readiness use it too. Audit/observer pools allow 2/1 clients. PostgreSQL max_connections=100, shared_buffers=128MB; fsync, synchronous_commit and full_page_writes are on in both storage modes. Logging stays enabled.

Phase 7A uses tmpfs. Phase 7B uses fresh tmpfs and a new local Docker volume; the recorded volume filesystem is 'ext2/ext3', distinct from tmpfs. This filesystem label does not identify physical media, controller cache or bare-metal disk latency. No cache dropping or durability/crash test was performed.

## Phase 7A baseline

Each row is three runs of 500 measured requests plus 50 warmups per run. Accepted/rejected/replay counts below are per run; rate and percentile columns are medians. All rows have zero transport errors/timeouts as well as zero unexpected HTTP errors.

| Scenario | C | Requests/run | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Replays | Unexpected errors | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A: Sequential | 1 | 500 | 123.53 | 7.77 | 13.00 | 15.44 | 500 | 0 | 0 | 0 | PASS |
| B: Moderate | 5 | 500 | 149.74 | 29.93 | 44.66 | 81.68 | 500 | 0 | 0 | 0 | PASS |
| C: Higher | 20 | 500 | 144.31 | 122.79 | 217.64 | 277.95 | 500 | 0 | 0 | 0 | PASS |
| D: Peak baseline | 50 | 500 | 154.15 | 314.00 | 397.46 | 410.74 | 500 | 0 | 0 | 0 | PASS |
| E: Shared quota / ten users | 20 | 500 | 170.66 | 114.34 | 144.09 | 169.22 | 250 | 250 | 0 | 0 | PASS |
| F: Shared quota / same user | 20 | 500 | 153.23 | 113.86 | 188.44 | 408.20 | 250 | 250 | 0 | 0 | PASS |
| G: Same-ID retries | 20 | 500 | 532.33 | 33.36 | 64.12 | 76.42 | 1 | 0 | 499 | 0 | PASS |
| H: Quota rejection | 20 | 500 | 178.11 | 104.54 | 145.69 | 159.09 | 0 | 500 | 0 | 0 | PASS |

**Observed:** sequential to concurrency 50 increased median throughput from 123.53 to 154.15 req/s (1.25x), while P95 rose from 13.00 to 397.46 ms. More concurrency did not provide proportional throughput. E/F share an equal 250-accept/250-reject measured mix: ten users 170.66 versus one user 153.23 req/s; this is not an all-accepted scalability test.

**Replay comparison:** G returns one original acceptance and 499 exact replays per run, with 51 stored accepted originals including 50 distinct warmups. A normal new-request C20 workload achieves 144.31 req/s; G achieves 532.33 req/s. G has a different execution path and only one original write in the measured batch. It is not a normal-consumption throughput improvement or a general retry-storm capacity guarantee. Runtime checks verified identical replay response bodies and one charge; full original HTTP bodies are not in saved JSON.

## Controlled account/user concurrency comparison

A = one account/one user. B = one account/ten users. C = ten independent accounts/one user each. Each row has three runs, 500 measured requests/run and 50 warmups/run; all accepted, zero replays. Units=1, account/user allowances=20100 and per-request maximum=1; new account-owned fixtures are created for every trial. Requests distribute round-robin; layout order rotates by repetition. Total work is equal, while C spreads it across independent account locks.

| Storage | Layout | Concurrency | req/s | P50 ms | P95 ms | P99 ms | Accepted/rejected per run | Errors/timeouts | Correctness |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| tmpfs | A | 1 | 122.61 | 7.30 | 13.11 | 19.30 | 500/0 | 0 | PASS |
| tmpfs | A | 5 | 127.68 | 34.71 | 69.22 | 91.40 | 500/0 | 0 | PASS |
| tmpfs | A | 20 | 138.97 | 141.14 | 199.62 | 221.96 | 500/0 | 0 | PASS |
| tmpfs | A | 50 | 149.96 | 316.78 | 393.06 | 401.28 | 500/0 | 0 | PASS |
| tmpfs | B | 1 | 121.06 | 7.59 | 13.30 | 18.38 | 500/0 | 0 | PASS |
| tmpfs | B | 5 | 138.51 | 29.79 | 54.33 | 91.14 | 500/0 | 0 | PASS |
| tmpfs | B | 20 | 153.28 | 128.05 | 184.32 | 199.43 | 500/0 | 0 | PASS |
| tmpfs | B | 50 | 145.45 | 332.06 | 439.23 | 454.28 | 500/0 | 0 | PASS |
| tmpfs | C | 1 | 119.98 | 7.31 | 12.56 | 20.82 | 500/0 | 0 | PASS |
| tmpfs | C | 5 | 110.03 | 28.83 | 96.59 | 108.87 | 500/0 | 0 | PASS |
| tmpfs | C | 20 | 106.19 | 187.93 | 302.45 | 412.08 | 500/0 | 0 | PASS |
| tmpfs | C | 50 | 102.12 | 486.76 | 632.96 | 695.53 | 500/0 | 0 | PASS |
| disk | A | 1 | 63.00 | 14.11 | 25.19 | 32.66 | 500/0 | 0 | PASS |
| disk | A | 5 | 77.68 | 61.23 | 83.85 | 140.08 | 500/0 | 0 | PASS |
| disk | A | 20 | 76.74 | 247.82 | 349.83 | 396.44 | 500/0 | 0 | PASS |
| disk | A | 50 | 71.81 | 652.78 | 788.44 | 820.98 | 500/0 | 0 | PASS |
| disk | B | 1 | 74.97 | 12.48 | 19.97 | 23.11 | 500/0 | 0 | PASS |
| disk | B | 5 | 84.90 | 54.63 | 87.65 | 108.44 | 500/0 | 0 | PASS |
| disk | B | 20 | 78.60 | 232.32 | 400.61 | 454.63 | 500/0 | 0 | PASS |
| disk | B | 50 | 80.13 | 596.98 | 738.16 | 747.43 | 500/0 | 0 | PASS |
| disk | C | 1 | 70.58 | 12.97 | 21.50 | 45.32 | 500/0 | 0 | PASS |
| disk | C | 5 | 125.21 | 25.42 | 91.15 | 109.93 | 500/0 | 0 | PASS |
| disk | C | 20 | 101.86 | 190.27 | 370.00 | 422.23 | 500/0 | 0 | PASS |
| disk | C | 50 | 100.09 | 474.74 | 778.20 | 816.08 | 500/0 | 0 | PASS |

**Observed:** at C50, tmpfs A/B/C = 149.96/145.45/102.12 req/s; disk A/B/C = 71.81/80.13/100.09 req/s. Adding users under one account did not remove its shared serialization point. Independent accounts reduced sampled lock contention, but produced lower throughput on tmpfs and higher throughput on disk in this setup. The conclusion depends on resource/storage conditions; it is not linear scalability with account count.

## Pool, PostgreSQL locks, CPU and WAL

C50 observations below summarize three repetitions. Busy/pending/lock columns are sampled maxima across repetitions. Acquisition and CPU columns are medians of per-trial summaries; throttle columns list each repetition's counter delta.

| Storage | Layout | Busy peak/max | Pool pending peak | PG lock wait peak | Acquisition ms | PG CPU % of one core | PG throttled periods per run |
|---|---|---:|---:|---:|---:|---:|---|
| tmpfs | A | 10/10 | 40 | 9 | 124.97 | 73.96 | 6/2/2 |
| tmpfs | B | 10/10 | 40 | 9 | 124.32 | 71.83 | 1/1/1 |
| tmpfs | C | 10/10 | 40 | 2 | 184.42 | 100.48 | 27/37/38 |
| disk | A | 10/10 | 41 | 9 | 259.13 | 49.44 | 6/6/11 |
| disk | B | 10/10 | 41 | 9 | 230.83 | 56.48 | 0/3/0 |
| disk | C | 10/10 | 40 | 2 | 197.28 | 103.85 | 32/35/47 |

**Direct observations:** backend clients reached 10/10 busy, with pending acquisition queues up to 41 (readiness probes share the pool). One-account workloads sampled up to nine PostgreSQL lock waiters, versus up to two in the ten-account C50 workloads. Lock/tuple and Lock/transactionid events were recorded. Ten-account PostgreSQL CPU rates were near one full core, with throttled periods. Disk samples also contain IO/WalSync, IO/WalWrite, IO/WalInitWrite, IO/DataFileExtend and LWLock/WALWrite events. Presence/peak counts do not measure cumulative wait duration. ClientRead generally means waiting for the client to issue another command, not a database failure.

**Interpretation:** independent accounts reduce one shared row-lock queue but still compete for the same pool, PostgreSQL CPU quota, WAL/storage and backend execution. Lower lock waiting can expose another resource limit. Pool wait is time before obtaining a client; row-lock wait occurs after a transaction has a client. A client waiting on a row lock occupies a pool slot and can make other requests wait for acquisition. This explains why total connections, busy clients, executing queries and waiting HTTP requests are different quantities.

**Unverified hypotheses:** exact latency fractions attributable to account locks, individual SQL statements, logging, network/client overhead and storage synchronization were not isolated. CPU quota pressure and sampled WAL waits are observed; their precise causal contribution is not. No optimal pool size or benefit from increasing it has been measured. More connections could add contention rather than fix the limiting resource.

Observation limits: a benchmark-only entrypoint wraps the existing pool connect method without changing its settings or application SQL. Local backend telemetry is written every 100 ms; the driver samples it and pg_stat_activity about every 250 ms. PostgreSQL cgroups are sampled about every second. CPU is a usage-counter delta over sample elapsed time; non-atomic counter/timestamp reads and periodic quotas make short samples approximate, sometimes slightly above 100%. Pool acquisition includes connection creation as well as queueing. First/last sample boundaries can miss work. Pool counters include authentication/readiness. No query text or credentials are recorded. The instrumentation itself adds overhead, so 7A and 7B are not an overhead-free before/after optimization comparison.

## Accepted versus quota-rejected cost

One account/user, concurrency 20, three runs per outcome/storage, 500 measured requests plus 50 warmups, unique request IDs. Only user monthly allowance changes to zero for rejection; all other workload settings match.

| Storage | Outcome | req/s | P50 ms | P95 ms | P99 ms | Accepted/rejected per run | Errors/timeouts | Correctness |
|---|---|---:|---:|---:|---:|---|---:|---|
| tmpfs | Accepted | 144.54 | 131.90 | 189.51 | 201.82 | 500/0 | 0 | PASS |
| tmpfs | User quota rejected | 164.79 | 110.20 | 183.05 | 291.36 | 0/500 | 0 | PASS |
| disk | Accepted | 77.47 | 235.06 | 313.25 | 374.82 | 500/0 | 0 | PASS |
| disk | User quota rejected | 77.16 | 221.05 | 398.94 | 640.81 | 0/500 | 0 | PASS |

**Observed:** rejection is faster on tmpfs (164.79 versus 144.54 req/s) but has nearly the same throughput on disk (77.16 versus 77.47). Rejections still authenticate, take account/user locks, inspect limits and persist a decision before COMMIT; they skip counter increments. Zero charge does not mean zero transaction/WAL cost. Equal or different throughput alone does not identify the exact cost of each SQL operation.

## Sustained verification and storage comparison

One 60-second run per layout/storage, concurrency 20, cap 20000 requests and 50 warmups. No new requests start after 60 seconds; in-flight responses drain. All measured requests below are accepted. Five-second completion windows, memory/CPU samples and full observation summaries remain in the original [7B report](phase7b-report.md) and JSON. The last partial drain window should not be compared to full five-second windows.

| Storage | Layout | Requests | Seconds incl. drain | req/s | P50 ms | P95 ms | P99 ms | Error/timeout rate | Correctness |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| tmpfs | A | 7592 | 60.20 | 126.11 | 144.51 | 255.38 | 393.63 | 0% / 0% | PASS |
| tmpfs | C | 5627 | 60.19 | 93.48 | 200.23 | 379.77 | 491.28 | 0% / 0% | PASS |
| disk | A | 4706 | 60.43 | 77.88 | 246.20 | 348.34 | 452.27 | 0% / 0% | PASS |
| disk | C | 5743 | 60.11 | 95.54 | 195.52 | 379.33 | 476.57 | 0% / 0% | PASS |

**Observed:** disk/tmpfs C50 median throughput ratios are approximately 0.48 for A, 0.55 for B and 0.98 for C. Storage made a large difference in some workloads and little difference in C under these resource limits. The tmpfs suite ran before disk; cache state, accumulated table/history size and shared host activity can confound attribution. A Docker volume includes filesystem/device caches and virtualization, while tmpfs avoids persistent storage latency and affects memory pressure. The measurements establish neither raw-disk throughput nor power-loss durability.

## Correctness evidence and its limits

The runtime audit reads consumption_requests for original outcomes and account_monthly_usage/user_monthly_usage for counters in a repeatable-read snapshot outside timing. It compares request IDs, user ownership, units, statuses and stored response bodies with observed HTTP decisions, sums accepted units, checks both quotas and requires matching history counts. Rejections charge zero; retries do not add a second history row or charge. Predefined plan definitions are checked unchanged. All 112 completed trials saved PASS audit summaries and zero unexpected errors/timeouts.

Phase 7C independently recalculates saved counter totals, expected original-history counts, quota bounds and planned user distributions for all-accepted workloads. Mixed 7A E does not promise a per-user acceptance ordering under concurrency; its saved per-user totals are checked against summed account usage and attempt bounds. Full original histories and HTTP bodies were not retained after disposable databases were removed. This validates recorded evidence of successful at-run audits, not a new SQL inspection of deleted databases. It does not prove correctness for all possible failures/interleavings. The [Phase 6 acceptance](../docs/phase-6c-acceptance.md) and integration/concurrency/failure tests provide separate, bounded evidence; they do not establish exhaustive correctness or official Boot.dev certification.

Account-level serialization is an intentional correctness trade-off: locking the account before the user and holding locks through COMMIT provides one coordination point for both quotas, idempotency and plan mutations. Accepted changes and decision history commit atomically; rejected requests preserve history without increments. This prevents tested overspending/double-charge races and makes lock order understandable, while limiting concurrent progress inside a busy account. Removing that coordination without another proven atomic strategy would risk correctness. No locking change was made.

## Reproduction, isolation and cleanup

Requirements: local Linux/WSL2 with Docker Engine/Compose plugin, a cgroup-v2 Docker runtime exposing the sampled files for 7B, Node.js 22+ and npm. Run commands from the repository root. Existing main PostgreSQL/backend services must already be running under the project's default Compose identity for read-only preservation checks. Resolved main configuration is captured without printing secrets. Benchmark/test environments generate their own database credentials and provisioning token; no account API key is supplied manually.

Install the existing locked dependencies if needed, then validate saved data without Docker or HTTP:

```sh
npm ci
npm run perf:validate
```

To reproduce new measurements deliberately (these commands overwrite the corresponding prior result/report files, so first save copies of measurements you want to retain):

```sh
npm run perf:baseline
npm run perf:analysis
```

7A defaults: eight scenarios, three repetitions, 500 requests plus 50 warmups, concurrency 1/5/20/50 as in the baseline table, tmpfs. Bounded override example: PERF_REQUESTS=1000 PERF_REPEATS=3 npm run perf:baseline (100–2000 requests, 1–3 repetitions). The final validator intentionally validates the saved default 500/3 configuration; alternative runs require their own recorded analysis.

7B: 36 contention + 6 quota-cost + 2 sustained trials per storage mode, 44 each, 88 total. No configurable pool tuning is performed. Every environment runs build/unit/database regressions before load. Configurations live in private /tmp directories (mode 0700, config mode 0600). Each project uses distinct PostgreSQL/backend containers, network and database name; no host ports are published. Before/after table fingerprints, database inventory, main container identity/start/health and volume metadata check preservation. These are logical data/metadata checks, not proof of zero normal PostgreSQL background disk writes.

The test runner creates a new usage_metering_test_* database, migrates/seeds it, runs all 16 DB scripts and drops only that generated test database in finally. For Phase 7C verification without load:

```sh
npm run perf:verify
```

This creates a fresh disposable tmpfs PostgreSQL/backend project, runs npm run build, npm test and npm run test:db:isolated with private COMPOSE_FILE/COMPOSE_PROJECT_NAME, validates saved measurements, then removes only its containers/network/private files. No new benchmark smoke test is necessary because saved configurations, calculations and render consistency validate successfully; database verification separately exercises the fresh image and runner. Do not invoke internal driver scripts against an application database.

Expected outputs: 7A baseline.json and README.md under performance/; 7B phase7b-tmpfs.json, phase7b-disk.json, phase7b-verification.json and phase7b-report.md; offline validation phase7c-validation.json and final-report.md; current verification phase7c-verification.json. npm run perf:analysis:report only regenerates the 7B Markdown from saved JSON. The old JSON files are preserved during 7C.

Cleanup uses docker compose down --timeout 10 for the unique disposable project without -v. Only 7B's newly created, initially absent, ownership-checked performance volume is explicitly removed; existing application volumes are never removed. Private config/results/telemetry files are removed, while uniquely tagged test images remain cached. On unexpected interruption, inspect the specific generated project before resuming cleanup; do not use global prune or application down -v commands.


## Phase 7C executed verification

Recorded at 2026-10-17T13:14:56.142Z; status **PASS**. Evidence: [phase7c-verification.json](phase7c-verification.json).

| Check | Executed result |
|---|---|
| build | PASS |
| unit | PASS |
| isolation | PASS |
| database_regressions | PASS |
| saved_results_validation | PASS |
| production_diff | PASS |
| cleanup | PASS |
| main_preserved | PASS |
| private_files_removed | PASS |
| saved_artifacts_preserved | PASS |

The command inventory is npm run build, npm test, docker compose build backend, docker compose up -d backend, npm run test:db:isolated, npm run perf:validate and docker compose down --timeout 10. All Docker operations select the generated temporary project; main container start times and historical artifact fingerprints are retained in the verification JSON. The recorded host kernel is 6.6.87.2-microsoft-standard-WSL2. No benchmark workload was executed in 7C.

## Phase 7C file manifest and repository status

| File | Phase 7C purpose |
|---|---|
| README.md | Replace only the previous performance subsections with a coherent final performance section |
| package.json | Add perf:validate and perf:verify; include the validator regression test in npm test |
| scripts/perf/validate-results.mjs | Offline arithmetic, coverage, audit-summary, report-preservation and scoped secret validation |
| scripts/perf/validate-results.test.mjs | Reject corrupted metrics, duplicate repetitions, extra charges, incomplete preservation checks and secret-bearing reports |
| scripts/perf/final-report.mjs | Generate this final analysis from unchanged saved measurements |
| scripts/perf/phase7c-verify.mjs | Build/unit/isolated DB verification with temporary resources and main-environment preservation checks; no load generation |
| performance/final-report.md | Final analysis, tables, limitations and reproducible commands |
| performance/phase7c-validation.json | Validation results and original artifact hashes |
| performance/phase7c-verification.json | Current verification, preservation and cleanup evidence |

At Phase 7C review, README.md and package.json are modified; performance/ and scripts/perf/ contain untracked work from Phases 7A/7B as well as the new 7C files. Earlier untracked work is retained. Production source, client logic, migrations, Docker product definitions and package-lock.json have no diff. No commit/push was made, and these working-tree artifacts are not evidence of publication to GitHub. Archived reports remain available and byte-for-byte unchanged.

## Limitations and practical conclusions

This is a local WSL/Docker, hardware-dependent benchmark with a ten-client pool and one-CPU container quotas, not a production-scale capacity measurement. External network latency, open-loop overload behavior, long-term endurance, optimal resource/pool sizing and crash durability have not been established. Sustained tests lasted about 60 seconds, one sample per layout/storage. No official SLA or latency/throughput target was provided. No performance improvement was implemented or claimed.

Possible future experiments, not changes made here: profile transaction/lock duration; run controlled CPU-quota and pool-size sweeps while retaining quota/idempotency tests; investigate measured WAL/storage costs; compare multiple generator processes and open-loop arrivals; run longer bounded endurance tests; examine query plans only after collecting execution evidence. Any future lock/transaction changes must preserve account/user quota and idempotency atomicity. Measurements should decide whether an optimization is justified.

Phase 7 evidence is ready for review before Phase 8. Phase 8 repository-wide documentation, cleanup, GitHub/publication readiness and final delivery checks remain separate work requiring approval. No commit or push was performed.
