# Phase 7B contention, pooling and sustained load

Overall status: **PASS**. Existing Phase 7A files preserved: **true**.

## Reproduction

Run from the repository root after installing the existing npm dependencies, with Docker Compose available:

```sh
npm run perf:analysis
```

To regenerate only this Markdown report from saved JSON, run `npm run perf:analysis:report`; it sends no requests.

This runs tmpfs then a new disk-backed Docker volume, each with a fresh private Compose project. Each environment executes `npm run build`, `npm test` and `npm run test:db:isolated` before measurements. The last command receives only the private Compose configuration: never run load against the main database. Runtime configurations use fresh credentials, no published ports and a private network. The runner rejects shared containers/mounts/networks. Only the newly created disk volume is removed, after checking its unique name and Compose ownership label; no existing volume is deleted. Built test images remain cached. Main tables, database inventory, existing PostgreSQL volume metadata, container identity/start time and health are checked before/after each environment. JSON verification records the outcomes. Background PostgreSQL writes are not prevented by read-only preservation checks.

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

## tmpfs results — PASS

Throughput/latencies below are medians of per-trial statistics, not pooled percentiles. Requests and decisions are per trial (sustained rows have one trial); errors/timeouts sum repetitions. Accepted excludes retries. Raw JSON includes all per-trial metrics, latency samples, five-second windows, observation samples and correctness details.

| Experiment/layout | C | Repeats | Requests | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Errors | Timeouts | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| contention/A | 1 | 3 | 500 | 122.61 | 7.30 | 13.11 | 19.30 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 1 | 3 | 500 | 121.06 | 7.59 | 13.30 | 18.38 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 1 | 3 | 500 | 119.98 | 7.31 | 12.56 | 20.82 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 5 | 3 | 500 | 127.68 | 34.71 | 69.22 | 91.40 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 5 | 3 | 500 | 138.51 | 29.79 | 54.33 | 91.14 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 5 | 3 | 500 | 110.03 | 28.83 | 96.59 | 108.87 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 20 | 3 | 500 | 138.97 | 141.14 | 199.62 | 221.96 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 20 | 3 | 500 | 153.28 | 128.05 | 184.32 | 199.43 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 20 | 3 | 500 | 106.19 | 187.93 | 302.45 | 412.08 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 50 | 3 | 500 | 149.96 | 316.78 | 393.06 | 401.28 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 50 | 3 | 500 | 145.45 | 332.06 | 439.23 | 454.28 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 50 | 3 | 500 | 102.12 | 486.76 | 632.96 | 695.53 | 500 | 0 | 0 | 0 | PASS |
| quota-cost/A | 20 | 3 | 500 | 144.54 | 131.90 | 189.51 | 201.82 | 500 | 0 | 0 | 0 | PASS |
| quota-cost/A rejected | 20 | 3 | 500 | 164.79 | 110.20 | 183.05 | 291.36 | 0 | 500 | 0 | 0 | PASS |
| sustained/A | 20 | 1 | 7592 | 126.11 | 144.51 | 255.38 | 393.63 | 7592 | 0 | 0 | 0 | PASS |
| sustained/C | 20 | 1 | 5627 | 93.48 | 200.23 | 379.77 | 491.28 | 5627 | 0 | 0 | 0 | PASS |

### Pool, locks and CPU observations

Peaks below are maxima across sampled repetitions; acquisition/CPU values are medians of per-trial observation summaries. CPU = percent of one core.

| Experiment/layout | C | Pool total peak | Busy peak/max | Idle peak | Waiting peak | Acquisition ms | PG active peak | PG idle peak | PG lock wait peak | Backend CPU % | PG CPU % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| contention/A | 1 | 10 | 1/10 | 10 | 0 | 0.02 | 1 | 10 | 0 | 45.91 | 57.10 |
| contention/B | 1 | 10 | 1/10 | 10 | 0 | 0.02 | 1 | 10 | 0 | 49.84 | 55.78 |
| contention/C | 1 | 10 | 1/10 | 10 | 0 | 0.02 | 1 | 10 | 0 | 50.04 | 53.73 |
| contention/A | 5 | 10 | 5/10 | 6 | 0 | 0.02 | 5 | 9 | 4 | 59.53 | 72.31 |
| contention/B | 5 | 10 | 5/10 | 9 | 0 | 0.02 | 5 | 8 | 4 | 58.09 | 64.52 |
| contention/C | 5 | 10 | 5/10 | 8 | 0 | 0.02 | 2 | 8 | 0 | 56.41 | 92.21 |
| contention/A | 20 | 10 | 10/10 | 3 | 10 | 34.39 | 10 | 8 | 9 | 55.33 | 66.01 |
| contention/B | 20 | 10 | 10/10 | 0 | 10 | 31.46 | 10 | 6 | 9 | 56.36 | 72.70 |
| contention/C | 20 | 10 | 10/10 | 7 | 10 | 44.00 | 4 | 10 | 1 | 53.00 | 99.85 |
| contention/A | 50 | 10 | 10/10 | 8 | 40 | 124.97 | 10 | 9 | 9 | 55.20 | 73.96 |
| contention/B | 50 | 10 | 10/10 | 7 | 40 | 124.32 | 10 | 9 | 9 | 56.33 | 71.83 |
| contention/C | 50 | 10 | 10/10 | 0 | 40 | 184.42 | 5 | 6 | 2 | 59.03 | 100.48 |
| quota-cost/A | 20 | 10 | 10/10 | 8 | 10 | 33.19 | 10 | 8 | 9 | 55.02 | 70.99 |
| quota-cost/A rejected | 20 | 10 | 10/10 | 1 | 10 | 29.15 | 10 | 7 | 9 | 57.26 | 73.07 |
| sustained/A | 20 | 10 | 10/10 | 10 | 10 | 38.43 | 10 | 9 | 9 | 56.67 | 71.41 |
| sustained/C | 20 | 10 | 10/10 | 10 | 11 | 49.73 | 5 | 9 | 1 | 50.96 | 96.63 |

### Sustained completion windows

| Layout | Start s | Window s | Requests | req/s | P50 ms | P95 ms | P99 ms | Errors | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 0.00 | 5.00 | 753 | 150.60 | 123.73 | 187.39 | 210.87 | 0 | 0 |
| A | 5.00 | 5.00 | 645 | 129.00 | 139.55 | 257.49 | 311.20 | 0 | 0 |
| A | 10.00 | 5.00 | 640 | 128.00 | 151.79 | 212.16 | 254.44 | 0 | 0 |
| A | 15.00 | 5.00 | 529 | 105.80 | 178.39 | 369.94 | 382.80 | 0 | 0 |
| A | 20.00 | 5.00 | 650 | 130.00 | 154.61 | 210.50 | 238.97 | 0 | 0 |
| A | 25.00 | 5.00 | 616 | 123.20 | 147.51 | 226.67 | 412.99 | 0 | 0 |
| A | 30.00 | 5.00 | 704 | 140.80 | 133.77 | 222.75 | 244.19 | 0 | 0 |
| A | 35.00 | 5.00 | 685 | 137.00 | 134.44 | 230.45 | 329.31 | 0 | 0 |
| A | 40.00 | 5.00 | 740 | 148.00 | 117.70 | 213.21 | 276.71 | 0 | 0 |
| A | 45.00 | 5.00 | 357 | 71.40 | 245.20 | 548.99 | 687.42 | 0 | 0 |
| A | 50.00 | 5.00 | 670 | 134.00 | 144.58 | 212.09 | 230.77 | 0 | 0 |
| A | 55.00 | 5.00 | 583 | 116.60 | 154.44 | 274.63 | 392.37 | 0 | 0 |
| A | 60.00 | 0.20 | 20 | 98.38 | 231.56 | 369.71 | 371.12 | 0 | 0 |
| C | 0.00 | 5.00 | 463 | 92.60 | 195.40 | 377.70 | 404.40 | 0 | 0 |
| C | 5.00 | 5.00 | 436 | 87.20 | 214.60 | 400.29 | 496.29 | 0 | 0 |
| C | 10.00 | 5.00 | 450 | 90.00 | 201.23 | 395.73 | 573.57 | 0 | 0 |
| C | 15.00 | 5.00 | 502 | 100.40 | 188.87 | 381.19 | 491.79 | 0 | 0 |
| C | 20.00 | 5.00 | 472 | 94.40 | 197.96 | 400.71 | 496.71 | 0 | 0 |
| C | 25.00 | 5.00 | 447 | 89.40 | 205.37 | 372.55 | 399.25 | 0 | 0 |
| C | 30.00 | 5.00 | 452 | 90.40 | 213.54 | 313.70 | 387.41 | 0 | 0 |
| C | 35.00 | 5.00 | 477 | 95.40 | 199.76 | 322.60 | 400.85 | 0 | 0 |
| C | 40.00 | 5.00 | 421 | 84.20 | 206.24 | 492.14 | 572.21 | 0 | 0 |
| C | 45.00 | 5.00 | 405 | 81.00 | 222.51 | 386.40 | 398.75 | 0 | 0 |
| C | 50.00 | 5.00 | 567 | 113.40 | 184.23 | 289.14 | 305.96 | 0 | 0 |
| C | 55.00 | 5.00 | 515 | 103.00 | 193.64 | 299.65 | 460.55 | 0 | 0 |
| C | 60.00 | 0.19 | 20 | 102.57 | 289.80 | 381.95 | 387.84 | 0 | 0 |

### Sustained memory and wait events

Layout A:

```json
{
  "samples": 235,
  "pool_max": 10,
  "pool_peak_total": 10,
  "pool_peak_checked_out": 10,
  "pool_peak_idle": 10,
  "pool_peak_waiting": 10,
  "sampled_acquisitions": 15166,
  "queued_acquisitions_delta": 15150,
  "mean_acquisition_ms": 38.433525530068145,
  "pg_peak_active": 10,
  "pg_peak_idle": 9,
  "pg_peak_lock_wait": 9,
  "pg_peak_blocked": 9,
  "wait_events_peak_sessions": {
    "active/none/none": 1,
    "idle/Client/ClientRead": 9,
    "active/Lock/transactionid": 1,
    "active/Lock/tuple": 8,
    "idle in transaction/Client/ClientRead": 2,
    "idle in transaction/none/none": 1,
    "idle/none/none": 1,
    "active/Client/ClientRead": 1
  },
  "backend_cpu_percent_one_core": 56.666169057478896,
  "postgres_cpu_percent_one_core": 71.40753480887955,
  "backend_throttled_periods": 29,
  "postgres_throttled_periods": 57,
  "backend_peak_rss_bytes": 92790784,
  "backend_peak_cgroup_bytes": 54304768,
  "postgres_peak_cgroup_bytes": 305745920
}
```
Layout C:

```json
{
  "samples": 211,
  "pool_max": 10,
  "pool_peak_total": 10,
  "pool_peak_checked_out": 10,
  "pool_peak_idle": 10,
  "pool_peak_waiting": 11,
  "sampled_acquisitions": 11245,
  "queued_acquisitions_delta": 11206,
  "mean_acquisition_ms": 49.72512624179596,
  "pg_peak_active": 5,
  "pg_peak_idle": 9,
  "pg_peak_lock_wait": 1,
  "pg_peak_blocked": 1,
  "wait_events_peak_sessions": {
    "active/none/none": 5,
    "idle/Client/ClientRead": 8,
    "idle/none/none": 1,
    "idle in transaction/Client/ClientRead": 10,
    "idle in transaction/none/none": 2,
    "active/Lock/transactionid": 1,
    "active/Client/ClientRead": 2
  },
  "backend_cpu_percent_one_core": 50.9569968656404,
  "postgres_cpu_percent_one_core": 96.6347596486033,
  "backend_throttled_periods": 33,
  "postgres_throttled_periods": 579,
  "backend_peak_rss_bytes": 92921856,
  "backend_peak_cgroup_bytes": 54398976,
  "postgres_peak_cgroup_bytes": 321355776
}
```

Layout C median throughput across concurrency 1/5/20/50: 119.98 / 110.03 / 106.19 / 102.12 req/s. At concurrency 50, B/A throughput ratio = 0.97; more users under one account do not remove that account's serialization point.

Measured at concurrency 50: A 149.96, B 145.45, C 102.12 req/s. C/A ratio = 0.68. These are observations on this constrained machine, not linear scaling guarantees.

### Environment and verification

```json
{
  "environment": {
    "node": "v22.23.3",
    "cpu_models": [
      "12th Gen Intel(R) Core(TM) i7-1255U"
    ],
    "available_parallelism": 1,
    "generator_cpu_max": "100000 100000",
    "generator_memory_max": "268435456",
    "postgres": {
      "version": "PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit",
      "max_connections": "100",
      "shared_buffers": "128MB",
      "fsync": "on",
      "synchronous_commit": "on",
      "full_page_writes": "on"
    }
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
    "started_at_utc": "2026-10-17T12:46:43.185Z",
    "filesystem": "tmpfs",
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
        "image": "usage-perf-8a6e0ced308d-backend:baseline",
        "image_id": "sha256:75f851490d70e67caeb9601269ae20aad182aeafffa3e1276e815df4668529d0",
        "nano_cpus": 1000000000,
        "memory_bytes": 268435456,
        "log_driver": "json-file"
      }
    },
    "backend_node": "v22.23.3",
    "source_commit": "3ee1a72d3e9916704d64dd73a94ae50042802ef6",
    "storage": "tmpfs",
    "finished_at_utc": "2026-10-17T12:53:44.932Z"
  }
}
```

## disk results — PASS

Throughput/latencies below are medians of per-trial statistics, not pooled percentiles. Requests and decisions are per trial (sustained rows have one trial); errors/timeouts sum repetitions. Accepted excludes retries. Raw JSON includes all per-trial metrics, latency samples, five-second windows, observation samples and correctness details.

| Experiment/layout | C | Repeats | Requests | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Errors | Timeouts | Correctness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| contention/A | 1 | 3 | 500 | 63.00 | 14.11 | 25.19 | 32.66 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 1 | 3 | 500 | 74.97 | 12.48 | 19.97 | 23.11 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 1 | 3 | 500 | 70.58 | 12.97 | 21.50 | 45.32 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 5 | 3 | 500 | 77.68 | 61.23 | 83.85 | 140.08 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 5 | 3 | 500 | 84.90 | 54.63 | 87.65 | 108.44 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 5 | 3 | 500 | 125.21 | 25.42 | 91.15 | 109.93 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 20 | 3 | 500 | 76.74 | 247.82 | 349.83 | 396.44 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 20 | 3 | 500 | 78.60 | 232.32 | 400.61 | 454.63 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 20 | 3 | 500 | 101.86 | 190.27 | 370.00 | 422.23 | 500 | 0 | 0 | 0 | PASS |
| contention/A | 50 | 3 | 500 | 71.81 | 652.78 | 788.44 | 820.98 | 500 | 0 | 0 | 0 | PASS |
| contention/B | 50 | 3 | 500 | 80.13 | 596.98 | 738.16 | 747.43 | 500 | 0 | 0 | 0 | PASS |
| contention/C | 50 | 3 | 500 | 100.09 | 474.74 | 778.20 | 816.08 | 500 | 0 | 0 | 0 | PASS |
| quota-cost/A | 20 | 3 | 500 | 77.47 | 235.06 | 313.25 | 374.82 | 500 | 0 | 0 | 0 | PASS |
| quota-cost/A rejected | 20 | 3 | 500 | 77.16 | 221.05 | 398.94 | 640.81 | 0 | 500 | 0 | 0 | PASS |
| sustained/A | 20 | 1 | 4706 | 77.88 | 246.20 | 348.34 | 452.27 | 4706 | 0 | 0 | 0 | PASS |
| sustained/C | 20 | 1 | 5743 | 95.54 | 195.52 | 379.33 | 476.57 | 5743 | 0 | 0 | 0 | PASS |

### Pool, locks and CPU observations

Peaks below are maxima across sampled repetitions; acquisition/CPU values are medians of per-trial observation summaries. CPU = percent of one core.

| Experiment/layout | C | Pool total peak | Busy peak/max | Idle peak | Waiting peak | Acquisition ms | PG active peak | PG idle peak | PG lock wait peak | Backend CPU % | PG CPU % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| contention/A | 1 | 10 | 1/10 | 10 | 0 | 0.03 | 1 | 10 | 0 | 43.87 | 43.26 |
| contention/B | 1 | 10 | 1/10 | 10 | 0 | 0.02 | 1 | 10 | 0 | 40.45 | 41.69 |
| contention/C | 1 | 10 | 1/10 | 10 | 0 | 0.02 | 1 | 10 | 0 | 42.80 | 43.76 |
| contention/A | 5 | 6 | 5/10 | 2 | 0 | 0.03 | 5 | 4 | 4 | 47.44 | 55.40 |
| contention/B | 5 | 10 | 5/10 | 8 | 0 | 0.02 | 5 | 10 | 4 | 44.11 | 53.64 |
| contention/C | 5 | 10 | 5/10 | 9 | 0 | 0.03 | 4 | 7 | 0 | 72.37 | 84.92 |
| contention/A | 20 | 10 | 10/10 | 9 | 10 | 61.87 | 10 | 2 | 9 | 48.34 | 56.64 |
| contention/B | 20 | 10 | 10/10 | 9 | 11 | 60.79 | 10 | 6 | 9 | 45.95 | 53.93 |
| contention/C | 20 | 10 | 10/10 | 6 | 10 | 44.76 | 8 | 4 | 1 | 58.78 | 104.21 |
| contention/A | 50 | 10 | 10/10 | 6 | 41 | 259.13 | 10 | 8 | 9 | 42.31 | 49.44 |
| contention/B | 50 | 10 | 10/10 | 7 | 41 | 230.83 | 10 | 5 | 9 | 48.47 | 56.48 |
| contention/C | 50 | 10 | 10/10 | 7 | 40 | 197.28 | 10 | 5 | 2 | 54.72 | 103.85 |
| quota-cost/A | 20 | 10 | 10/10 | 7 | 10 | 61.39 | 10 | 6 | 9 | 44.66 | 56.73 |
| quota-cost/A rejected | 20 | 10 | 10/10 | 6 | 10 | 62.38 | 10 | 9 | 9 | 46.10 | 53.75 |
| sustained/A | 20 | 10 | 10/10 | 10 | 11 | 62.66 | 10 | 8 | 9 | 47.36 | 57.16 |
| sustained/C | 20 | 10 | 10/10 | 10 | 10 | 48.68 | 9 | 7 | 1 | 53.42 | 97.31 |

### Sustained completion windows

| Layout | Start s | Window s | Requests | req/s | P50 ms | P95 ms | P99 ms | Errors | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 0.00 | 5.00 | 398 | 79.60 | 242.98 | 314.90 | 324.45 | 0 | 0 |
| A | 5.00 | 5.00 | 348 | 69.60 | 245.06 | 570.95 | 726.64 | 0 | 0 |
| A | 10.00 | 5.00 | 362 | 72.40 | 267.04 | 381.16 | 427.77 | 0 | 0 |
| A | 15.00 | 5.00 | 380 | 76.00 | 252.67 | 375.18 | 486.85 | 0 | 0 |
| A | 20.00 | 5.00 | 387 | 77.40 | 258.00 | 300.82 | 312.50 | 0 | 0 |
| A | 25.00 | 5.00 | 383 | 76.60 | 252.11 | 342.80 | 429.23 | 0 | 0 |
| A | 30.00 | 5.00 | 408 | 81.60 | 241.89 | 295.15 | 335.85 | 0 | 0 |
| A | 35.00 | 5.00 | 387 | 77.40 | 246.29 | 340.23 | 452.27 | 0 | 0 |
| A | 40.00 | 5.00 | 402 | 80.40 | 247.22 | 299.00 | 313.70 | 0 | 0 |
| A | 45.00 | 5.00 | 422 | 84.40 | 220.50 | 344.87 | 386.96 | 0 | 0 |
| A | 50.00 | 5.00 | 387 | 77.40 | 247.02 | 402.29 | 459.21 | 0 | 0 |
| A | 55.00 | 5.00 | 422 | 84.40 | 224.10 | 292.10 | 298.98 | 0 | 0 |
| A | 60.00 | 0.43 | 20 | 46.70 | 441.60 | 456.03 | 458.29 | 0 | 0 |
| C | 0.00 | 5.00 | 394 | 78.80 | 261.55 | 389.15 | 415.73 | 0 | 0 |
| C | 5.00 | 5.00 | 586 | 117.20 | 172.44 | 282.25 | 320.48 | 0 | 0 |
| C | 10.00 | 5.00 | 586 | 117.20 | 171.00 | 295.96 | 391.32 | 0 | 0 |
| C | 15.00 | 5.00 | 533 | 106.60 | 190.43 | 297.11 | 323.33 | 0 | 0 |
| C | 20.00 | 5.00 | 511 | 102.20 | 192.89 | 293.18 | 313.95 | 0 | 0 |
| C | 25.00 | 5.00 | 554 | 110.80 | 180.01 | 287.80 | 308.70 | 0 | 0 |
| C | 30.00 | 5.00 | 469 | 93.80 | 197.26 | 381.93 | 433.25 | 0 | 0 |
| C | 35.00 | 5.00 | 416 | 83.20 | 218.09 | 386.48 | 407.22 | 0 | 0 |
| C | 40.00 | 5.00 | 461 | 92.20 | 205.36 | 383.28 | 466.54 | 0 | 0 |
| C | 45.00 | 5.00 | 430 | 86.00 | 203.59 | 395.03 | 480.24 | 0 | 0 |
| C | 50.00 | 5.00 | 317 | 63.40 | 304.12 | 500.78 | 520.88 | 0 | 0 |
| C | 55.00 | 5.00 | 466 | 93.20 | 208.15 | 309.27 | 409.72 | 0 | 0 |
| C | 60.00 | 0.11 | 20 | 176.75 | 170.31 | 246.20 | 254.64 | 0 | 0 |

### Sustained memory and wait events

Layout A:

```json
{
  "samples": 236,
  "pool_max": 10,
  "pool_peak_total": 10,
  "pool_peak_checked_out": 10,
  "pool_peak_idle": 10,
  "pool_peak_waiting": 11,
  "sampled_acquisitions": 9405,
  "queued_acquisitions_delta": 9399,
  "mean_acquisition_ms": 62.65726615970321,
  "pg_peak_active": 10,
  "pg_peak_idle": 8,
  "pg_peak_lock_wait": 9,
  "pg_peak_blocked": 9,
  "wait_events_peak_sessions": {
    "idle/Client/ClientRead": 8,
    "idle in transaction/Client/ClientRead": 2,
    "active/Lock/transactionid": 1,
    "active/Lock/tuple": 8,
    "active/none/none": 2,
    "active/IO/WalSync": 1,
    "active/Client/ClientRead": 1,
    "idle in transaction/none/none": 1,
    "active/IO/WalWrite": 1,
    "idle/none/none": 1
  },
  "backend_cpu_percent_one_core": 47.36063921271814,
  "postgres_cpu_percent_one_core": 57.15636713355691,
  "backend_throttled_periods": 24,
  "postgres_throttled_periods": 21,
  "backend_peak_rss_bytes": 92676096,
  "backend_peak_cgroup_bytes": 52850688,
  "postgres_peak_cgroup_bytes": 258043904
}
```
Layout C:

```json
{
  "samples": 212,
  "pool_max": 10,
  "pool_peak_total": 10,
  "pool_peak_checked_out": 10,
  "pool_peak_idle": 10,
  "pool_peak_waiting": 10,
  "sampled_acquisitions": 11455,
  "queued_acquisitions_delta": 11390,
  "mean_acquisition_ms": 48.67584884321177,
  "pg_peak_active": 9,
  "pg_peak_idle": 7,
  "pg_peak_lock_wait": 1,
  "pg_peak_blocked": 1,
  "wait_events_peak_sessions": {
    "active/none/none": 6,
    "idle/Client/ClientRead": 7,
    "idle in transaction/Client/ClientRead": 10,
    "idle in transaction/none/none": 2,
    "active/Client/ClientRead": 2,
    "active/IO/WalSync": 1,
    "active/LWLock/WALWrite": 7,
    "active/Lock/transactionid": 1,
    "active/IO/WalWrite": 1,
    "idle in transaction/LWLock/WALWrite": 1,
    "active/LWLock/BufferContent": 1,
    "active/IO/DataFileExtend": 1,
    "active/LWLock/LockManager": 1,
    "idle/none/none": 1
  },
  "backend_cpu_percent_one_core": 53.415860901167285,
  "postgres_cpu_percent_one_core": 97.3102728438015,
  "backend_throttled_periods": 27,
  "postgres_throttled_periods": 578,
  "backend_peak_rss_bytes": 92831744,
  "backend_peak_cgroup_bytes": 53497856,
  "postgres_peak_cgroup_bytes": 305426432
}
```

Layout C median throughput across concurrency 1/5/20/50: 70.58 / 125.21 / 101.86 / 100.09 req/s. At concurrency 50, B/A throughput ratio = 1.12; more users under one account do not remove that account's serialization point.

Measured at concurrency 50: A 71.81, B 80.13, C 100.09 req/s. C/A ratio = 1.39. These are observations on this constrained machine, not linear scaling guarantees.

### Environment and verification

```json
{
  "environment": {
    "node": "v22.23.3",
    "cpu_models": [
      "12th Gen Intel(R) Core(TM) i7-1255U"
    ],
    "available_parallelism": 1,
    "generator_cpu_max": "100000 100000",
    "generator_memory_max": "268435456",
    "postgres": {
      "version": "PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit",
      "max_connections": "100",
      "shared_buffers": "128MB",
      "fsync": "on",
      "synchronous_commit": "on",
      "full_page_writes": "on"
    }
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
    "started_at_utc": "2026-10-17T12:53:45.102Z",
    "filesystem": "ext2/ext3",
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
        "image": "usage-perf-c1123e6ce80f-backend:baseline",
        "image_id": "sha256:d8bef4afd69cc610a2bb5405b3cd784a316f6dc4dbd2e73627fc0d21289ea5d3",
        "nano_cpus": 1000000000,
        "memory_bytes": 268435456,
        "log_driver": "json-file"
      }
    },
    "backend_node": "v22.23.3",
    "source_commit": "3ee1a72d3e9916704d64dd73a94ae50042802ef6",
    "storage": "disk",
    "finished_at_utc": "2026-10-17T13:02:30.351Z"
  }
}
```

## Observed comparisons

tmpfs sampled I/O events: idle in transaction/IO/WalWrite. Sampling gives event presence/peak counts, not cumulative I/O wait duration or a causal latency breakdown.

tmpfs: at concurrency 50, A/B/C sampled peak lock waiters = 9/9/2; peak pool waiters = 40/40/40. Accepted versus quota-rejected median throughput = 144.54 versus 164.79 req/s (rejected/accepted 1.14x). These paths have different write work despite matching request counts and concurrency.

Sustained tmpfs/A: 7592 requests in 60.20 s; full-window throughput ranged 71.40–150.60 req/s, first/last full-window P95 187.39 / 274.63 ms. Unexpected error rate 0.00%, timeout rate 0.00%. Backend sampled RSS first/last 91848704/92282880 bytes; this alone cannot establish a memory leak.

Sustained tmpfs/C: 5627 requests in 60.19 s; full-window throughput ranged 81.00–113.40 req/s, first/last full-window P95 377.70 / 299.65 ms. Unexpected error rate 0.00%, timeout rate 0.00%. Backend sampled RSS first/last 92340224/92393472 bytes; this alone cannot establish a memory leak.

disk sampled I/O events: active/IO/WalSync, idle in transaction/IO/WalWrite, active/IO/WalWrite, active/IO/WalInitWrite, active/IO/DataFileExtend. Sampling gives event presence/peak counts, not cumulative I/O wait duration or a causal latency breakdown.

disk: at concurrency 50, A/B/C sampled peak lock waiters = 9/9/2; peak pool waiters = 41/41/40. Accepted versus quota-rejected median throughput = 77.47 versus 77.16 req/s (rejected/accepted 1.00x). These paths have different write work despite matching request counts and concurrency.

Sustained disk/A: 4706 requests in 60.43 s; full-window throughput ranged 69.60–84.40 req/s, first/last full-window P95 314.90 / 292.10 ms. Unexpected error rate 0.00%, timeout rate 0.00%. Backend sampled RSS first/last 92676096/91967488 bytes; this alone cannot establish a memory leak.

Sustained disk/C: 5743 requests in 60.11 s; full-window throughput ranged 63.40–117.20 req/s, first/last full-window P95 389.15 / 309.27 ms. Unexpected error rate 0.00%, timeout rate 0.00%. Backend sampled RSS first/last 92229632/92610560 bytes; this alone cannot establish a memory leak.

Matching concurrency-50 disk/tmpfs throughput ratios: A 0.48x, B 0.55x, C 0.98x. A ratio alone does not isolate storage latency from the other shared host effects.


## Interpretation and storage limitations

The account FOR UPDATE lock remains held until COMMIT and precedes user locks. A and B therefore serialize on the same account regardless of user count. C removes that common account lock across accounts but still shares the ten-connection pool and CPU/storage resources. Sampled pool queues and PostgreSQL lock waits are observed measurements; the exact fraction of end-to-end latency caused by each is not separately attributed. Check the tables and raw wait-event samples before identifying a dominant limit. Pool size was observed, not tuned. Ten total clients does not mean ten executing queries: idle clients, checked-out clients waiting on locks and requests waiting to acquire a client are different states. More concurrency can increase queueing latency without raising throughput proportionally.

Tmpfs keeps PostgreSQL data/WAL in memory, bypassing physical persistent-disk latency and influencing memory pressure. The dedicated local Docker volume is disk-backed when its actual filesystem is not tmpfs; its filesystem is recorded in verification. Both runs retain fsync, synchronous_commit and full_page_writes. A disk-backed result still includes OS/device caches and Docker/virtualization effects, so it is not raw-device throughput or a power-loss durability test. The entire tmpfs run precedes disk: host activity, cache state and run order can confound attribution. Storage comparisons use newly measured matching 7B workloads, not the older 7A samples. No forced cache dropping, volume reuse, production volume mounts or crash tests were performed.

CPU utilization and throttling counters, sampled pool queueing and lock-wait counts are direct observations. Precise lock hold times, query-level execution costs, I/O wait attribution, logging costs, client bottlenecks and optimal pool sizes remain unmeasured. More accounts cannot guarantee unlimited scalability. One-minute sustained runs cannot establish long-term stability or absence of leaks. Accounts and history accumulate across trials within each disposable database; fresh fixtures isolate correctness, but table/cache growth can affect performance. No latency SLO or production-capacity claim is made. Phase 7C has not started.
