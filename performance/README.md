# Phase 7A performance baseline

Overall status: **PASS**. Measured at 2026-10-17T12:22:24.081Z through 2026-10-17T12:23:50.220Z.

## Reproduction and safety

From the repository root, with installed npm dependencies and Docker Compose available:

```sh
npm run perf:baseline
```

This command runs `npm run build`, `npm test`, and `npm run test:db:isolated` before benchmarks. The database regression command receives a private COMPOSE_FILE and COMPOSE_PROJECT_NAME, so it creates/drops its temporary test database inside the disposable performance PostgreSQL container. It does not target the main application cluster. To change bounded sample size: `PERF_REQUESTS=1000 PERF_REPEATS=3 npm run perf:baseline` (100–2000 requests, 1–3 repeats). Defaults: 500 requests and three repeats per scenario.

The harness creates a uniquely named Compose project, private bridge network, PostgreSQL, migration job, backend and HTTP generator. No service publishes a host port. Generated credentials live only in private temporary configuration and process/container environments. PostgreSQL uses tmpfs; no named volumes are created or removed. Cleanup removes only this project's containers/network and private files. Built benchmark images remain cached. Before/after read-only fingerprints cover every row in eight main application tables, the database inventory, persistent volume metadata, container identity/start times and health. Metadata equality does not mean the main server makes no normal background disk writes.

## Methodology

Each scenario runs 3 times with 500 measured requests per trial and 50 warmup requests on its own fresh account. Units = 1. Setup and SQL audits are outside timing; warmup remains in the database and correctness accounting. The existing predefined plans remain unchanged. The regression suite runs before measurements, so this is a warm-server baseline, not a cold-start test.

Node built-in fetch sends real POST /v1/consumptions requests over the private Docker bridge. Each closed-loop worker waits for its complete response before issuing another request. performance.now() measures monotonic wall time through full response-body reading, JSON parsing and validation. IDs are prepared before timing. Each request has a five-second timeout; each batch has a 120-second deadline. Latency excludes time waiting to be assigned to a worker. This is not an open-loop arrival-rate test and does not correct coordinated omission. Percentiles use nearest rank ceil(p*N).

A–D accept every request to one user, varying concurrency. E and F both accept 250 and reject 250 measured requests at defaults, using concurrency 20 and the same account limit; E distributes requests over ten users, F uses one. G sends one common request ID concurrently: exactly one original acceptance and 499 replays. H uses a zero user allowance: all requests are rejected. Warmups use distinct IDs; G therefore stores 51 original accepted decisions including warmup. H stores 550 rejected decisions. E/F store 550 decisions and charge 300 units including warmup.

After every trial, a repeatable-read SQL snapshot checks all original request IDs, users, units, statuses and complete stored response bodies against observed HTTP decisions; accepted sums against account and per-user monthly counters; user totals against account totals; and both quota limits. Exact retries must return identical bodies, produce one original history entry and charge once. Failed HTTP outcomes, missing samples, month rollover or any correctness mismatch invalidate the run, irrespective of throughput. PASS indicates correctness, not satisfaction of a latency SLO.

## Results

Throughput and latency columns are medians of per-trial statistics, not pooled percentiles. Request/outcome counts are **per trial**; errors sum all repeats. Accepted excludes replays; HTTP 200 response counts are separately recorded in JSON. Errors include unexpected HTTP/protocol responses, network errors and timeouts; expected quota HTTP 429 responses are not errors. See baseline.json for every duration, average/minimum/maximum latency, individual sample, outcome count and correctness result.

| Scenario | Concurrency | Requests/trial | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Replays | Errors | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A: Sequential | 1 | 500 | 123.53 | 7.77 | 13.00 | 15.44 | 500 | 0 | 0 | 0 | PASS |
| B: Moderate | 5 | 500 | 149.74 | 29.93 | 44.66 | 81.68 | 500 | 0 | 0 | 0 | PASS |
| C: Higher | 20 | 500 | 144.31 | 122.79 | 217.64 | 277.95 | 500 | 0 | 0 | 0 | PASS |
| D: Peak baseline | 50 | 500 | 154.15 | 314.00 | 397.46 | 410.74 | 500 | 0 | 0 | 0 | PASS |
| E: Shared quota / ten users | 20 | 500 | 170.66 | 114.34 | 144.09 | 169.22 | 250 | 250 | 0 | 0 | PASS |
| F: Shared quota / same user | 20 | 500 | 153.23 | 113.86 | 188.44 | 408.20 | 250 | 250 | 0 | 0 | PASS |
| G: Same-ID retries | 20 | 500 | 532.33 | 33.36 | 64.12 | 76.42 | 1 | 0 | 499 | 0 | PASS |
| H: Quota rejection | 20 | 500 | 178.11 | 104.54 | 145.69 | 159.09 | 0 | 500 | 0 | 0 | PASS |

### Every measured trial

| Scenario | Repeat | Seconds | req/s | Avg ms | Min ms | Max ms | P50 ms | P95 ms | P99 ms | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | 1 | 5.15 | 97.17 | 10.29 | 5.48 | 65.18 | 9.23 | 16.03 | 28.03 | PASS |
| B | 1 | 3.62 | 138.05 | 36.08 | 11.01 | 105.78 | 33.22 | 54.99 | 81.68 | PASS |
| C | 1 | 3.46 | 144.31 | 136.07 | 16.33 | 300.43 | 124.14 | 217.64 | 277.95 | PASS |
| D | 1 | 3.66 | 136.49 | 349.84 | 23.22 | 602.19 | 341.55 | 573.65 | 591.18 | PASS |
| E | 1 | 2.92 | 170.98 | 115.30 | 17.28 | 174.73 | 114.57 | 143.79 | 169.02 | PASS |
| F | 1 | 3.43 | 145.74 | 135.35 | 27.76 | 428.89 | 119.45 | 304.58 | 408.20 | PASS |
| G | 1 | 1.75 | 286.44 | 69.29 | 12.98 | 300.73 | 35.29 | 270.72 | 297.30 | PASS |
| H | 1 | 2.81 | 178.11 | 110.47 | 13.48 | 160.46 | 104.54 | 145.69 | 159.09 | PASS |
| A | 2 | 4.05 | 123.53 | 8.09 | 4.93 | 16.81 | 7.77 | 13.00 | 15.44 | PASS |
| B | 2 | 3.34 | 149.74 | 33.27 | 12.92 | 175.33 | 29.89 | 44.66 | 107.54 | PASS |
| C | 2 | 3.04 | 164.54 | 119.14 | 13.72 | 194.54 | 116.58 | 144.88 | 172.64 | PASS |
| D | 2 | 3.23 | 154.66 | 310.31 | 24.46 | 397.58 | 314.00 | 383.64 | 394.95 | PASS |
| E | 2 | 3.12 | 160.04 | 123.14 | 19.27 | 269.02 | 114.34 | 178.96 | 261.43 | PASS |
| F | 2 | 2.90 | 172.62 | 113.88 | 12.06 | 162.85 | 112.27 | 142.26 | 160.85 | PASS |
| G | 2 | 0.94 | 532.33 | 37.01 | 11.40 | 79.66 | 33.36 | 62.25 | 73.20 | PASS |
| H | 2 | 2.63 | 189.85 | 103.26 | 12.35 | 157.53 | 101.48 | 131.55 | 154.85 | PASS |
| A | 3 | 3.93 | 127.36 | 7.85 | 4.81 | 24.04 | 7.52 | 12.28 | 15.12 | PASS |
| B | 3 | 3.12 | 160.07 | 31.10 | 13.39 | 54.40 | 29.93 | 40.20 | 46.84 | PASS |
| C | 3 | 3.67 | 136.19 | 144.00 | 34.31 | 333.35 | 122.79 | 280.73 | 315.78 | PASS |
| D | 3 | 3.24 | 154.15 | 307.33 | 20.59 | 412.76 | 301.00 | 397.46 | 410.74 | PASS |
| E | 3 | 2.93 | 170.66 | 114.98 | 11.01 | 171.89 | 113.08 | 144.09 | 169.22 | PASS |
| F | 3 | 3.26 | 153.23 | 128.18 | 12.93 | 424.29 | 113.86 | 188.44 | 416.77 | PASS |
| G | 3 | 0.84 | 597.94 | 32.40 | 14.95 | 77.72 | 28.82 | 64.12 | 76.42 | PASS |
| H | 3 | 2.84 | 176.26 | 111.45 | 14.83 | 174.66 | 105.16 | 156.55 | 171.63 | PASS |

## Environment

Backend and PostgreSQL each have a one-CPU quota; backend memory limit is 256 MiB, PostgreSQL 512 MiB, generator one CPU/256 MiB. These are benchmark-only controls, not production changes. CPU model/count and host memory reported inside containers can differ from cgroup limits. Generator cgroup limits, PostgreSQL settings, source commit, image IDs, Docker version/storage driver and actual backend container limits are recorded below. Backend connection pool remains max 10, connection timeout 5000 ms, idle timeout 30000 ms; audit pool max 2 is used outside timing. Fastify request logging remains enabled.

```json
{
  "runtime": {
    "generator_node": "v22.23.3",
    "platform": "linux",
    "arch": "x64",
    "cpu_models": [
      "12th Gen Intel(R) Core(TM) i7-1255U"
    ],
    "visible_cpu_count": 12,
    "available_parallelism": 1,
    "visible_total_memory_bytes": 8157081600,
    "generator_cgroup_cpu_max": "100000 100000",
    "generator_cgroup_memory_max": "268435456",
    "postgresql": {
      "full_version": "PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit",
      "version": "17.11",
      "max_connections": "100",
      "shared_buffers": "128MB",
      "fsync": "on",
      "synchronous_commit": "on",
      "full_page_writes": "on"
    },
    "backend_pool": {
      "source": "src/db/pool.ts",
      "max": 10,
      "connection_timeout_ms": 5000,
      "idle_timeout_ms": 30000
    },
    "audit_pool_max": 2,
    "http_client": "Node built-in fetch default dispatcher, Docker bridge backend:3000"
  },
  "verification": {
    "status": "PASS",
    "checks": {
      "build": "PASS",
      "unit": "PASS",
      "isolation": "PASS",
      "database_regressions": "PASS",
      "benchmarks": "PASS",
      "cleanup": "PASS",
      "main_preserved": "PASS",
      "private_files_removed": "PASS"
    },
    "started_at_utc": "2026-10-17T12:21:18.380Z",
    "docker": {
      "ServerVersion": "29.8.1",
      "NCPU": 12,
      "MemTotal": 8157081600,
      "Driver": "overlayfs",
      "OSType": "linux",
      "Architecture": "x86_64"
    },
    "host": {
      "node": "v22.23.2",
      "cpu_models": [
        "12th Gen Intel(R) Core(TM) i7-1255U"
      ],
      "cpu_count": 12,
      "memory_bytes": 8157081600
    },
    "containers": {
      "postgres": {
        "image": "postgres:17-alpine",
        "image_id": "sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
        "nano_cpus": 1000000000,
        "memory_bytes": 536870912,
        "log_driver": "json-file"
      },
      "backend": {
        "image": "usage-perf-d8fcff2b0346-backend:baseline",
        "image_id": "sha256:b052541fe9487b7829d5d09af43eb3bbcde6951fb302bd3f45538bd35f6a937b",
        "nano_cpus": 1000000000,
        "memory_bytes": 268435456,
        "log_driver": "json-file"
      }
    },
    "backend_node": "v22.23.3",
    "source_commit": "3ee1a72d3e9916704d64dd73a94ae50042802ef6",
    "storage": "Disposable PostgreSQL tmpfs; no persistent volumes or host ports",
    "finished_at_utc": "2026-10-17T12:24:03.586Z"
  }
}
```

## Interpretation and limitations

Measured A to D: throughput changed from 123.53 to 154.15 req/s (1.25x), while P95 changed from 13.00 to 397.46 ms. Measured E/F: ten users achieved 170.66 req/s versus 153.23 req/s for one user (1.11x). This does not establish scaling with user count; both still share one account lock. 

The measurements above establish end-to-end throughput and latency for these bounded workloads on this machine. Compare A–D for the observed effect of concurrency: more simultaneous requests can overlap network/authentication work, while queueing can raise latency without proportional throughput gains. Compare E/F for the observed ten-user versus one-user result with matching request mix; short runs and run-to-run variation prevent treating a small difference as a general improvement.

The source locks the account row FOR UPDATE until transaction commit, before locking the user and updating counters. Consequently all consumption transactions for one account serialize, even with different users. Additional users do not remove this shared lock. This mechanism is established by code inspection; time spent waiting on that lock was not separately measured. G takes the replay path rather than repeating normal writes; H persists rejections without charging, so their speeds do not represent successful-consumption throughput.

The existing pool of ten connections can queue acquisition at concurrency 20/50. Authentication queries also use that pool. Pool wait, account-lock wait, CPU, logging, network and PostgreSQL execution contributions are hypotheses rather than separately measured bottlenecks: no profiler, wait-event sampling or pool instrumentation was added. No production algorithms or pool settings were optimized. The generator may also limit throughput under its CPU quota. A separate multi-account benchmark would be needed to assess scaling without one shared account lock; that is outside this phase.

PostgreSQL storage is tmpfs: these results do not measure persistent-disk performance, crash durability, production capacity, long-running stability or an SLO. Only three short default samples per scenario were taken, in fixed A–H order; cache/order effects and shared host activity remain possible. Use the raw individual trials to judge variation. Phase 7B has not started.
