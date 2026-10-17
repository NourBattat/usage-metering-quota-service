# Testing and verification

Run these commands from the repository root. Node.js 22+, npm and installed
lockfile dependencies are needed for host tests. Docker commands additionally
need Docker Engine/Compose access. [Setup](setup.md) describes configuration.

## Build and unit tests: no database required

```sh
npm ci
npm run build
npm test
```

`build` compiles strict backend TypeScript and the separate CLI project.
`test` runs Vitest backend/CLI/error-handler tests followed by Node tests for
bootstrap permissions/secret handling, isolated database-runner safety,
performance metrics and saved-result validation. It does not start Docker or
connect to application PostgreSQL. The saved performance files are fixtures for
validator tests and must remain in the checkout. Tests cover failure cases as
well as successful behavior; no line/branch coverage percentage is claimed.

## PostgreSQL integration and concurrency

With the intended Compose `postgres` and current `backend` services already
running (the backend image contains test scripts):

```sh
npm run test:db:isolated
```

This command creates a unique `usage_metering_test_<pid>_<random>` database inside
the selected PostgreSQL cluster. It applies all six migrations, seeds plans and
runs `npm run test:db` inside the backend container with only `PGDATABASE` pointing
to that temporary DB. `finally` force-drops only the database it successfully
created. It rejects unknown/application database names and unsafe identifier shapes.
It never resets the populated `POSTGRES_DB` or deletes volumes. It shares the
selected PostgreSQL server's resources; it is not a separate cluster by itself.
Abrupt host/daemon termination can prevent cleanup, so inspect ownership before
removing any orphaned test database.

**Never run raw `npm run test:db` against a populated application/demo database.**
Its scripts create/delete fixtures, deliberately break test connections/transactions
and exercise failure recovery. The guarded wrapper supplies the intended isolation.
For a fully separate PostgreSQL/backend project, `npm run perf:verify` runs build,
unit and the guarded DB suite in disposable tmpfs storage with read-only main-stack
preservation comparisons; it does not generate performance load. It regenerates
Phase 7C validation/report outputs, so preserve copies before using it to retain
historical artifact bytes.

The 16 DB scripts cover schema and ownership constraints; seed idempotence;
account provisioning/API-key rejection; users and cross-account concealment;
custom/predefined plans and assignment; both quota levels and per-request limits;
accepted/rejected outcomes; exact/conflicting retries; simultaneous user/account
consumption; plan changes racing consumption; UTC month boundaries; usage precision
and zero-clamped downgrades; monthly and microsecond decision-history pagination;
controlled rollback/client disconnect/lost response/connection failures; safe 5xx
responses and readiness recovery. See the [6A audit](phase-6a-audit.md),
[6B security/recovery report](phase-6b-report.md) and [6C acceptance](phase-6c-acceptance.md).
Those are dated execution evidence, not exhaustive proofs.

## Real compiled CLI integration

Requires compiled `dist-client`, the configured backend/PostgreSQL running, and
a provisioning token matching that backend. Load only the trusted private `.env`
in a subshell, which removes the exported secrets when it exits:

```sh
(
  set -a
  . ./.env
  set +a
  export USAGE_API_BASE_URL="http://127.0.0.1:${PORT:-3000}"
  npm run test:client:integration
)
```

The harness provisions its own temporary account over HTTP, runs the compiled
CLI, checks account=45/Ahmad=10/Sara=35 and three accepted/two rejected original
decisions, verifies secret-safe output, then deletes only that account through
Docker PostgreSQL cleanup. Custom `POSTGRES_DB`/`POSTGRES_USER` must match the
selected Compose services. `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME` and API URL must
refer to the same environment. This is a fixture-mutating test, not a read-only
inspection of the application.

## Compose demo acceptance

With local `.env` configured, use an environment where rebuilding/recreating
services and creating two demo accounts is intended:

```sh
npm run test:compose:demo
```

This harness invokes `docker compose up --build -d`, replaces completed demo
containers and runs two fresh demos. It checks service dependency gates, health,
key file/directory permissions and owner, read-only mounts, client environment,
secret-safe logs, repeatable results and preservation of preexisting rows/volumes.
The two demo accounts remain as history. It may recreate the backend as part of
Compose build/up, so do not treat this as a no-restart check on a valuable running
stack. Phase 8A documentation verification deliberately does not execute it.

For clean-copy acceptance on a disposable project instead, the existing
`npm run test:phase6c` harness installs/builds a filtered working-tree copy and
runs DB/CLI/Compose checks with private config and tmpfs PostgreSQL. It includes
controlled failures and cleanup of its own resources. The main stack must be
running for read-only before/after preservation comparisons. This is not an
independent remote GitHub clone verification.

## Performance and offline evidence

```sh
npm run perf:validate
```

This needs no Docker: it checks saved request counts, repetitions, per-trial
latency/rate calculations, outcomes, original audit summaries, five-second windows
and report consistency. It regenerates `performance/phase7c-validation.json` and
`performance/final-report.md`. It cannot inspect deleted original benchmark DBs.
Save copies or run in a temporary review copy when preserving historical bytes.

```sh
npm run perf:baseline
npm run perf:analysis
```

These are deliberate, bounded benchmark runs with fresh isolated PostgreSQL/backend
containers, no host-published ports and generated credentials. They overwrite their
own prior measurement files; save copies first. 7A uses tmpfs; 7B additionally uses
an initially absent ownership-checked disk test volume and removes only that new
volume. Existing application volumes remain untouched. See the
[final performance report](../performance/final-report.md) for exact counts,
concurrency, CPU/memory limits, warmup, timing, sampling, cleanup and limitations.

Passing tests establish evidence for executed cases, not universal correctness,
a production SLA, official Boot.dev certification or proof of GitHub publication.
