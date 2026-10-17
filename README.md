# Usage Metering and Quota Service

A TypeScript, Fastify, and PostgreSQL service that makes account- and user-level usage decisions atomically. Docker Compose starts PostgreSQL, applies migrations and predefined plans, starts the backend, provisions a fresh demo account, and runs the CLI example.

## Quick start

Requirements: Docker Engine with the Compose plugin, Node.js 22+ and npm for local tests, and OpenSSL for generating local-only secrets.

Clone the repository and open its root directory, then create a private local environment file and fill it with random values without printing those values:

```sh
cp .env.example .env
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
PROVISIONING_TOKEN="$(openssl rand -hex 32)"
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${POSTGRES_PASSWORD}/; s/^PROVISIONING_TOKEN=.*/PROVISIONING_TOKEN=${PROVISIONING_TOKEN}/" .env
unset POSTGRES_PASSWORD PROVISIONING_TOKEN
```

`.env` is ignored by Git and excluded from Docker build context. Do not commit it. Start the complete stack and its first demo:

```sh
docker compose up --build -d
docker compose ps -a
docker compose logs demo-bootstrap example-client
```

The one-shot bootstrap and CLI should both exit with status 0. PostgreSQL and the backend remain running. Check API health from the host:

```sh
curl -fsS -o /dev/null -w '/health HTTP %{http_code}\n' http://localhost:3000/health
curl -fsS -o /dev/null -w '/ready HTTP %{http_code}\n' http://localhost:3000/ready
```

The final demo totals are account 45 units, Ahmad 10 units on Basic, and Sara 35 units on Premium. The two quota rejections charge zero; the exact idempotent retry adds neither usage nor a history row.

## Run the demo again

Completed one-shot containers do not rerun automatically. Remove only those containers, then start the client service again; Compose recreates bootstrap first and provisions a new account and key:

```sh
docker compose rm -f demo-bootstrap example-client
docker compose up -d example-client
docker compose ps -a
docker compose logs demo-bootstrap example-client
```

Each demo account remains in PostgreSQL as historical data. No account usage is reset and no prior demo account is deleted. The `postgres_data` volume is persistent; **never use `docker compose down -v`** for routine shutdown or demonstration reruns.

## Services and secret handoff

- `postgres` stores the application data on the private Compose network and `postgres_data` volume; port 5432 is not published to the host.
- `migrate` waits for healthy PostgreSQL, applies migrations, then seeds predefined plans in the existing order.
- `backend` waits for the migration/seed job and healthy PostgreSQL; it is the only service publishing the API port.
- `demo-bootstrap` waits for the healthy backend and provisions one account through its HTTP endpoint. Only this service and the backend receive `PROVISIONING_TOKEN`.
- `example-client` waits for successful bootstrap, runs as the non-root `node` user, and receives only `USAGE_API_KEY_FILE` plus the internal backend URL. It receives neither the provisioning token nor database credentials.

The API key is passed through the dedicated `demo_api_key` named volume, separate from `postgres_data`. Bootstrap clears old key/temp files before provisioning, creates the directory with mode `0700`, writes to an exclusive temporary file, changes the file to mode `0400`, and atomically renames it to `account-api-key`. The key file and directory are owned by the CLI UID/GID. The CLI mounts the volume read-only. Bootstrap failure clears the previous key and, because of `service_completed_successfully`, prevents the client from starting. If the CLI itself fails after bootstrap succeeded, the key remains in the dedicated volume until the next bootstrap clears it or the operator runs the cleanup command below.

To clear only the demo key file and temporary handoff files without removing any account or volume:

```sh
npm run demo:cleanup-secret
```

Logs show actions and decisions, never authentication headers, API keys, provisioning tokens, or database passwords. The actual values live in the local ignored `.env` and the protected runtime handoff file; do not print either.

For the full scenario, expected output, and API call sequence, see [docs/example-client.md](docs/example-client.md). Predefined local plan assumptions are described in [docs/predefined-plans.md](docs/predefined-plans.md).

## Tests and verification

Build backend and CLI TypeScript, and run the unit/security tests:

```sh
npm ci
npm run build
npm test
```

Run all PostgreSQL integration tests on an isolated temporary database (requires the Compose PostgreSQL and backend services to be running):

```sh
npm run test:db:isolated
```

This command generates a unique database name with a test-only prefix, creates that database inside the existing PostgreSQL service, runs migrations and seed there, runs `test:db` with only `PGDATABASE` overridden for the backend test process, and force-drops only that generated database in `finally`. The populated `POSTGRES_DB` demo database and its volume are not used, truncated, reset, or deleted. The lower-level `npm run test:db` command is an isolated-database-only suite; do not point it at a database containing real or demo data.

Run the HTTP client integration test using a dedicated temporary account. Load the ignored `.env` into the current shell without printing it, then run the harness:

```sh
set -a
. ./.env
set +a
npm run test:client:integration
unset POSTGRES_PASSWORD PROVISIONING_TOKEN
```

The harness creates and later removes only its own temporary account. The Compose-level security and repeatability test executes two full demos on two additional fresh accounts and verifies volumes/data remain intact:

```sh
npm run test:compose:demo
```

It may take a few minutes. It leaves the two demo accounts as history and does not remove volumes. Inspect its services/logs with `docker compose ps -a` and `docker compose logs demo-bootstrap example-client`.

## Safe shutdown

Stop the services while preserving both named volumes:

```sh
docker compose stop
```

`docker compose down` also removes containers and the network but keeps named volumes unless `-v` is specified. Never run `docker compose down -v` when you need to preserve PostgreSQL data.

## Authentication and internal errors

Protected `/v1` endpoints use the account key in `x-api-key`. Account provisioning uses `POST /v1/accounts` with `x-provisioning-token`; the configured server-side token must be at least 32 characters. Provisioning returns the new account key once; PostgreSQL stores its SHA-256 hash. Treat the key as a secret.

Unhandled HTTP 5xx errors return a generic message while preserving their HTTP status and standard response fields. Server logs retain safe HTTP status, request ID and SQLSTATE metadata, without raw database messages, SQL or connection credentials. Existing validation (4xx), quota rejection and explicitly defined operational error responses retain their own behavior.

## Isolated clean acceptance verification

From the repository root, with Node.js 22+, Docker/Compose access and the existing main stack running for read-only preservation checks:

```sh
npm run test:phase6c
```

This verifies a temporary copy of the **current working tree**, including uncommitted work. It installs dependencies, builds TypeScript and new Docker images without cache, and runs the regression suites and demo in a separate Compose project with temporary PostgreSQL storage. It does not rebuild or restart the main stack. Temporary test databases, containers, configuration and credentials are cleaned up without deleting persistent PostgreSQL volumes. New uniquely tagged test images remain locally. This is not a GitHub-clone verification.

See [docs/phase-6c-acceptance.md](docs/phase-6c-acceptance.md) for scope, commands, acceptance evidence and remaining limitations. Full documentation completion and performance testing are separate phases.

## Performance testing and results

Performance was measured through real HTTP `POST /v1/consumptions` requests to
Fastify and PostgreSQL in disposable Docker environments. The saved local
WSL2/Docker runs comprise **112 completed trials, 77,668 measured requests and
5,600 warmups**, with zero unexpected HTTP errors, transport errors or timeouts.
Expected quota rejections are counted separately. The [final performance report](performance/final-report.md)
contains every configuration, sustained windows references, environment details,
correctness evidence, limitations and future experiment directions.

### Methodology and baseline

Each fixed-count trial uses 500 requests, one unit per request, 50 warmups and
fresh account-owned fixtures. Results below are medians of three per-trial
statistics; accepted/rejected/replay counts are per trial. Sorting three values
and selecting the middle gives the median; percentile medians are not pooled
percentiles. Within a trial, P50/P95/P99 use nearest rank `ceil(p*N)`.
Monotonic timing includes the complete HTTP response and validation. Fixture
setup, warmup and final SQL audits are excluded from measured time. Closed-loop
workers wait for a response before their next request; no external network or
open-loop overload capacity was measured.

Phase 7A baseline, using tmpfs:

| Scenario | Concurrency | req/s | P50 ms | P95 ms | P99 ms | Accepted | Rejected | Replays |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A: Sequential | 1 | 123.53 | 7.77 | 13.00 | 15.44 | 500 | 0 | 0 |
| B: Moderate | 5 | 149.74 | 29.93 | 44.66 | 81.68 | 500 | 0 | 0 |
| C: Higher | 20 | 144.31 | 122.79 | 217.64 | 277.95 | 500 | 0 | 0 |
| D: Peak baseline | 50 | 154.15 | 314.00 | 397.46 | 410.74 | 500 | 0 | 0 |
| E: Shared quota / ten users | 20 | 170.66 | 114.34 | 144.09 | 169.22 | 250 | 250 | 0 |
| F: Shared quota / same user | 20 | 153.23 | 113.86 | 188.44 | 408.20 | 250 | 250 | 0 |
| G: Same-ID retries | 20 | 532.33 | 33.36 | 64.12 | 76.42 | 1 | 0 | 499 |
| H: Quota rejection | 20 | 178.11 | 104.54 | 145.69 | 159.09 | 0 | 500 | 0 |

Sequential to concurrency 50 increases throughput only 1.25x while P95 grows
from 13.00 to 397.46 ms. E/F use a matched half-accepted/half-rejected mix.
G measures one original write plus 499 replays, so its higher throughput does
not represent ordinary new-consumption capacity. Replays preserve the original
decision and do not add another charge or history row.

### Accounts, storage, connections and locks

Phase 7B controls the request mix: all 500 requests succeed, with three runs
per configuration. A = one account/one user; B = one account/ten users;
C = ten independent accounts/one user each. All share the same backend and
PostgreSQL resources. The full report includes concurrency 1, 5, 20 and 50;
this table shows concurrency 50. Wait counts are sampled peaks across runs;
throughput, P95 and CPU are medians of per-trial statistics.

| Storage | Layout | req/s | P95 ms | PG lock wait peak | Pool pending peak | PG CPU % of one core |
|---|---|---:|---:|---:|---:|---:|
| tmpfs | A | 149.96 | 393.06 | 9 | 40 | 73.96 |
| tmpfs | B | 145.45 | 439.23 | 9 | 40 | 71.83 |
| tmpfs | C | 102.12 | 632.96 | 2 | 40 | 100.48 |
| disk | A | 71.81 | 788.44 | 9 | 41 | 49.44 |
| disk | B | 80.13 | 738.16 | 9 | 41 | 56.48 |
| disk | C | 100.09 | 778.20 | 2 | 40 | 103.85 |

Observed: the pool reached 10/10 busy clients, and PostgreSQL lock waiting fell
with independent accounts. PostgreSQL CPU approached its one-core quota and
throttling occurred; disk samples also recorded WAL synchronization. Slightly
above-100% short CPU estimates reflect approximate sampling, not changed limits.
These observations do not isolate the precise contribution of each resource.
Pool acquisition waits occur before a client is obtained; database lock waits
hold an already-acquired client. More users share the same account lock.
More accounts remove that common lock but still compete for CPU, connections
and WAL/storage, explaining why lower lock contention need not improve throughput.

The account lock is intentionally held through COMMIT to coordinate account/user
quotas, request idempotency and plan changes atomically. This favors simple,
understandable correctness while serializing consumption within an account.
No lock strategy, pool size or production algorithm was optimized.

Matched accepted/rejected workloads at concurrency 20 measured 144.54/164.79
req/s on tmpfs and 77.47/77.16 on disk. Rejections skip counter increments but
still authenticate, lock, persist history and commit; zero charge is not zero cost.
Sustained runs lasted about 60 seconds at concurrency 20, capped at 20,000
requests: one/ten-account rates were 126.11/93.48 req/s on tmpfs and
77.88/95.54 on disk. All four passed final database checks.

### Correctness and limitations

Runtime SQL snapshots checked accepted sums against account/user monthly
counters, both quotas, original decisions and stored response bodies. Rejections
charged zero and retries charged once. The offline validator recalculates all
saved samples, counts, per-account/user evidence and historical report tables.
Original disposable databases and complete HTTP bodies are no longer retained;
this is validation of saved at-run audit evidence, not an exhaustive proof under
every failure or concurrency condition. See the separate [Phase 6 acceptance](docs/phase-6c-acceptance.md).

The local environment used Node 22.23.3, PostgreSQL 17.11, Docker Engine 29.8.1,
an i7-1255U host with 12 visible logical CPUs and 8,157,081,600 bytes reported
memory. Backend/PostgreSQL/generator each had a one-CPU quota and memory limits
of 256/512/256 MiB; the backend pool remained 10 clients. tmpfs does not represent
persistent disk I/O. The dedicated disk volume still includes caches and Docker
virtualization. Host activity, fixed storage order, sampling overhead and hardware
limit comparisons. One-minute runs establish neither long-term endurance nor
absence of leaks. No official SLA, performance target or production-scale capacity
claim is provided.

### Reproduce and validate

Run from the repository root with Node.js 22+, npm and Docker Engine/Compose.
For 7B observations, Docker must expose cgroup-v2 CPU/memory files. The main
PostgreSQL/backend must already run under the default Compose identity for
read-only preservation checks. No main-stack restart is part of these commands.

```sh
npm ci
npm run perf:validate
npm run perf:verify
```

`perf:validate` needs no Docker: it validates saved data and writes
`performance/phase7c-validation.json` and `performance/final-report.md`.
`perf:verify` runs `npm run build`, `npm test`, and `npm run test:db:isolated`
inside an orchestration using a fresh disposable PostgreSQL/backend project,
then validates saved data without generating benchmark traffic. It writes
`performance/phase7c-verification.json`. The DB suite creates, migrates, seeds
and removes only its generated test database inside that temporary cluster.

To deliberately collect new measurements (save copies first: these overwrite
the corresponding previous result files):

```sh
npm run perf:baseline
npm run perf:analysis
```

7A writes `performance/baseline.json` and `performance/README.md`; 7B writes
`performance/phase7b-{tmpfs,disk,verification}.json` and `phase7b-report.md`.
`npm run perf:analysis:report` regenerates only the 7B Markdown.
Benchmark credentials are generated privately; no API key is pasted into commands.
Each environment has its own containers, database and network with no published
ports. Cleanup removes its containers/network/private files; only 7B's newly
created ownership-checked volume is deleted. Existing volumes and main data
are checked for preservation. Test images remain cached. Phase 7C preserves
all original 7A/7B measurements and reports.

Possible future work is measurement first: profile transaction/lock time, vary
CPU/pool limits in controlled tests, investigate observed WAL costs, compare
open-loop generators and run longer bounded workloads. Any optimization must
retain atomic quotas and idempotency. None was implemented in Phase 7.
