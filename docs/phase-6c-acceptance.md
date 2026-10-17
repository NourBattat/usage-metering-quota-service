# Phase 6C: Final acceptance and release readiness

## Scope and source identity

This review evaluates the **current local working tree**, including the uncommitted Phase 6A/6B fixes and tests. It is not a remote GitHub clone, and no commit or push was performed. Repository HEAD at the start is `2ad4d23` (`Complete Phase 5 end-to-end demo and isolated testing`). The clean-copy harness deliberately includes untracked project files while excluding `.git`, dependencies, build output, private environment/configuration directories and logs.

No independent official Boot.dev specification was found in the repository. `AGENTS.md` and the explicitly approved phase instructions are the local acceptance requirements. Every PASS below concerns those local requirements and the executed cases. Official Boot.dev equivalence remains UNVERIFIED; no official requirements or measurements are invented.

Changes in 6C are test orchestration and small documentation additions only. Application source, endpoints, migrations, dependencies and business behavior were not changed. Performance testing has not begun.

## Verification method and safety

`scripts/phase6c-verify.mjs` copies the working tree into a private `/tmp/usage-phase6c-*` directory with no `node_modules`, `dist`, `dist-client`, `.git`, actual `.env` files or private cloud/agent configuration. It runs `npm ci`, compiles both TypeScript projects, runs unit tests, and builds new uniquely tagged application images using the real Dockerfile with `docker compose build --no-cache`. The deployment starts with `docker compose up --build -d` under a separate project name and random API port.

The acceptance backend, migration, bootstrap and CLI services execute code copied into their freshly built images. No source/dependency/build directory is bind-mounted into those services. Image SHA-256 checks compare every compiled backend and migration file against the independent clean-copy build, so the corrected Phase 6B code is actually exercised. The test PostgreSQL container is distinct from the main container, with `/var/lib/postgresql/data` verified as tmpfs inside the container. Only the dedicated temporary demo-secret directory is bind-mounted between bootstrap and CLI, with read-only CLI access.

Before/after main-environment checks compare full-row fingerprints of `accounts`, `users`, `account_plans`, `user_plans`, `account_monthly_usage`, `user_monthly_usage`, `consumption_requests`, and `pgmigrations`, the database inventory, and persistent PostgreSQL volume metadata. The main backend is not rebuilt, restarted, or redeployed. Its healthy state and `/health`/`/ready` responses must remain intact. Fault injection, temporary databases, test-account cleanup and intentional bootstrap failures target the disposable environment only.

Cleanup uses `docker compose down --timeout 10` for the unique acceptance project, without `-v`, then removes its private source/configuration/secret directory. No Docker volume deletion or pruning is performed. Fresh uniquely tagged image artifacts remain locally; they contain no runtime-generated secrets. Credentials are generated at runtime, passed through the temporary Compose configuration/environment, and never printed. The resolved Compose output is captured rather than displayed.

## Phase 6B correction review

| Correction | Source evidence | Executed coverage and scope |
| --- | --- | --- |
| Generic unhandled 5xx responses | `src/app.ts` global handler retains HTTP status and standard envelope, returns generic message; explicit reply bodies bypass it | Seven tests in `tests/failure-handling.test.ts`, plus real PostgreSQL `XX000` regression in `scripts/phase6b-security.mjs`; 500 exact envelope, 503 status/envelope, unchanged 400 validation and explicit consumption 500 |
| Correct readiness connection | `/ready` defaults to the database selected by `buildApp`, retaining explicit test override support | Injected-pool query count and real isolated database refusal/recovery; live fresh-image readiness |
| Idle pool error handling | `src/db/pool.ts` catches idle errors with a fixed non-sensitive diagnostic; pg removes failed idle clients | Unit emit and actual PID-scoped termination of an idle test connection; process stays alive and reconnects |
| Checked-out client error handling | Consumption installs a lease-only error listener, marks failed clients for discard and removes the listener before release | Unit listener/discard checks and actual checked-out test connection termination after account UPDATE |
| ROLLBACK failure handling | Consumption catches rollback failure and calls `release(error)`, retaining its explicitly defined operational response | Exact response/discard unit test plus real aborted/terminated transaction recovery and unchanged usage/history |

Safe logging retains HTTP status, request ID and a bounded SQLSTATE code when available. Raw error messages, detail/hint fields, SQL, connection strings and credentials are omitted. The 500 message-only change was explicitly approved. No Phase 6B business feature, new endpoint or migration exceeds that scope. Test fixtures add IPC-only controls to a separate test process, not to the product HTTP server.

## Complete executed command inventory

The outer invocation runs from the real repository root:

```sh
npm run test:phase6c
```

The following run in the clean temporary copy, with `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` selecting only the generated acceptance environment:

```sh
npm ci
npm run build
npm test
docker compose build --no-cache
docker compose up --build -d
npm run test:db:isolated
npm run test:client:integration
npm run test:compose:demo
docker compose config
docker compose ps -a
docker compose down --timeout 10
```

Additional controlled runner commands: `node scripts/test-db-isolated.mjs` three times with a private Docker-command wrapper that deliberately fails the migration, seed, or suite command after real owned-database creation. Each is expected to exit 1 and restore the disposable database inventory. Normal isolated success creates a unique database, executes `node scripts/migrate.mjs`, `npm run seed`, and the full `npm run test:db`, then drops only that generated database.

The full database suite runs these existing scripts sequentially: `schema-smoke`, `seed-smoke`, `plan-assignment-smoke`, `account-api-smoke`, `users-api-smoke`, `plans-api-smoke`, `plan-assignment-api-smoke`, `consumption-api-smoke`, `concurrency-smoke`, `month-plan-smoke`, `usage-api-smoke`, `monthly-history-smoke`, `request-history-smoke`, `phase6a-regression`, `phase6b-security`, and `phase6b-recovery` (all `.mjs` under `scripts/`).

The Compose demo additionally uses `docker compose rm -f demo-bootstrap example-client`, `docker compose up --build -d`, `docker compose up -d example-client`, and temporary `docker compose run --rm --no-deps` diagnostic probes. Those commands act on the acceptance project only. After successful one-shot exit checks, a deliberately empty bootstrap token is tested with `docker compose up -d example-client`; its nonzero result, blocked client startup and absent old key are expected assertions.

Read-only probes use `docker inspect`, `docker volume inspect`, `docker compose port`, `docker compose ps -q/-aq`, `docker exec ... sha256sum`, `/proc/mounts` inspection with `awk`, `docker run --rm --entrypoint node` image filesystem checks, and `psql` SELECTs for fingerprints/inventory. HTTP checks are performed with Node fetch and the existing CLI integration harness. No secret values are command-line arguments. Final workspace checks include `node --check scripts/phase6c-verify.mjs`, `git diff --check`, `git status --short` and `git log -1 --oneline`.

## Backend and CLI acceptance

The real HTTP CLI harness provisions its own account, executes the compiled CLI and then reads `/v1/usage/account`, `/v1/users`, each `/v1/users/:userId/usage`, and `/v1/requests?limit=100`. Expected totals are account **45**, Ahmad **10** on Basic, Sara **35** on Premium; the account ends on Pro. Five unique decisions comprise three accepted and two rejected requests, and the retry adds no history row or usage. Its own temporary account is then removed inside the disposable environment.

The Compose harness executes two additional demos with fresh account keys and compares all columns of preexisting account/plan/user/usage/request rows. It validates key mode 0400, directory mode 0700, node UID/GID, read-only client mount, no provisioning or database configuration in the client, and no actual key/token in bootstrap/client logs. All one-shot services must be observed exited 0 before the final deliberately induced bootstrap failure.

| Endpoint area | Existing executed test evidence | Acceptance behavior |
| --- | --- | --- |
| `/health`, `/ready` | app unit tests, recovery suite, live deployment | Healthy paths 200; isolated database outage makes readiness 503 while health remains 200 |
| POST `/v1/accounts`, GET `/v1/accounts/me` | account API, security suite, real CLI harness | Provisioning token required, fresh key returned once, hash storage, authenticated account selection, safe responses |
| `/v1/users[/:userId]` | users API and client integration | Basic default, two independent users, foreign UUID concealed with 404, safe list/detail projections |
| `/v1/plans`, `/v1/plans/:scope[/:planId]` | seed, plans API, assignment tests | Local predefined catalog, owned custom CRUD, read-only predefined plans, wrong scope/foreign plans rejected |
| Account/user `/plan` assignments | SQL/API assignment, month-plan, concurrency | Ownership enforced; independent assignments; subsequent limits change without counter reset |
| POST `/v1/consumptions` | consumption, concurrency, month-plan, 6A/6B regressions | Atomic accepted charges; zero-charge rejections; exact retries and 409 conflicts; safe infrastructure errors |
| Current and historical usage | usage API, monthly-history, precision regressions | Accepted totals, zero missing month, retained UTC months, independent users, pagination and ownership |
| Account/user request history | request-history, 6A/6B security | Accepted/rejected details and applied snapshots, stable microsecond cursors, scope/filter checks and safe projections |

## Local requirements acceptance matrix

Each result is scoped to executed cases, not exhaustive correctness or official Boot.dev certification. Test labels refer to the command inventory above; the detailed 6A matrix remains a source/constraint reference.

| ID | Requirement | Implementation evidence | Automated evidence | Observed result and status |
| --- | --- | --- | --- | --- |
| A | PostgreSQL persistence and Compose startup | `compose.yaml`, `Dockerfile`, `scripts/migrate.mjs`, `src/db/pool.ts`; `postgres_data`, `pgmigrations`; six migrations | DB suite; config validation; live readiness; unchanged table/volume fingerprints | PARTIAL — fresh stack and backend restart tested; main persistent volume preserved; disk-backed PostgreSQL crash recovery not tested |
| B | Multiple accounts, provisioning, API-key authentication | `src/routes/accounts.ts:registerAccountRoutes`, `src/plugins/api-key-auth.ts:requireApiKey`; `accounts.api_key_hash` unique SHA-256 check, required plan FK | account-api, users-api, focused authentication sweep | PASS — valid requests with missing/invalid keys; provisioning is separately token protected |
| C | Account isolation and user ownership | All route queries bind authenticated `accountId`; `findAssignablePlan`; Composite user/account FKs; ownership triggers | users-api, plans-api, assignment-api, consumption-api, usage-api, monthly-history, request-history | PASS — known foreign UUIDs return 404; client ownership fields rejected; schema also rejects foreign ownership |
| D | Starter and Pro predefined account plans | `src/db/seed.ts:seedPredefinedPlans`; `account_plans`, partial unique predefined name index | seed, plans-api, assignment-api | PASS — exact local values, repeated seed and drift refusal tested; values are project assumptions |
| E | Basic and Premium predefined user plans | Same seed function; user registration; `user_plans`, required `users.user_plan_id` | seed, users-api, assignment-api | PASS — Basic default and Premium assignment; exact values remain local assumptions |
| F | Account-owned custom plans | `src/routes/plans.ts:registerPlanRoutes`; Separate account/user plan tables, owner FK and scoped uniqueness, immutable ownership triggers | plans-api, schema, assignment, assignment-api | PASS — create, view, edit, foreign access, immutable scope, predefined read-only API |
| G | Plan edits and independent assignments | `registerPlanRoutes`, `registerPlanAssignmentRoutes`; Plan assignment FKs/ownership triggers; independent usage PKs | assignment-api, month-plan, concurrency | PASS — shared definition with independent balances and subsequent-limit application |
| H | Positive integer consumption units | `src/routes/consumptions.ts:bodySchema`; Request `units` positive/bounded CHECK | consumption-api, concurrency boundary cases | PASS — zero, negatives, decimals, strings and above-cap input rejected; maximum is a local cap |
| I | Account and user monthly allowances | `registerConsumptionRoutes`, BigInt arithmetic; Monthly usage tables and allowance checks | consumption-api, concurrency, month-plan, focused BIGINT cap | PASS — both limits enforced; zero remaining after downgrade; exact cap and +1 exercised |
| J | Account and user per-request limits | `registerConsumptionRoutes` failure collection; Plan and snapshot request maxima | consumption-api, concurrency, client integration | PASS — separate account/user rule failures and exact boundaries |
| K | Accepted consumption updates both counters atomically | Account → user → account usage → user usage locks, one transaction; Both counters plus request outcome commit together | consumption-api; concurrency fault-injection rollback and retry | PASS — mid-transaction user-update failure restores both counters and leaves no decision |
| L | Rejection charges neither level and persists outcome | `registerConsumptionRoutes`, accepted-only UPDATEs; `consumption_requests_outcome_details_check`, response snapshot | consumption-api, month-plan, focused concurrent rejected retry | PASS — focused regression explicitly checks both existing nonzero counters and one rejected history row |
| M | Understandable rejection with failed level/rule | Failure list and messages in consumption route; `rejection_reasons`, `failed_rule_levels`, stored response JSON | consumption-api, request-history, client integration | PASS — separate and simultaneous failures; no charge on rejection |
| N | Retry persistence, conflict, concurrent idempotency, account scope | Previous-outcome lookup under account lock; UNIQUE `(account_id, request_id)` | consumption-api, concurrency, month-plan, focused scope/rejected retry | PASS — accepted/rejected byte replay, 409 on changed user/units, accepted and rejected races, same ID in different accounts |
| O | UTC calendar months and historical retention | Month chosen with `clock_timestamp() AT TIME ZONE 'UTC'` after identity locks; `(account_id, month)` and `(account_id,user_id,month)` keys; month-start CHECK | month-plan, monthly-history | PASS — year boundary, explicit timezone offsets, lock-wait clock selection and old-month replay |
| P | Plan changes retain usage and affect later requests | Same account serialization lock for consumption, assignment, edits; Stored monthly counters; per-request plan snapshots | assignment-api, month-plan, usage-api, monthly-history, concurrency | PASS — upgrade/downgrade, shared edit, history snapshots, zero remaining below consumed usage |
| Q | Concurrent requests cannot overspend or partially charge | Account row as serialization point; consistent locking order; Transactional row locks and unique request constraint | concurrency: same user, two users, duplicates, conflicts, plan mutation races, rollback | PASS — tested schedules; serializing each account intentionally limits per-account throughput; not a benchmark |
| R | Current usage/remaining and historical monthly totals | `src/routes/usage.ts:registerUsageRoutes`; Monthly rows retained; current report read-only repeatable-read transaction | usage-api, monthly-history, focused precision | PASS — missing month is zero, reads create no rows, totals and isolation verified; monthly history returns usage, not invented historical limits |
| S | Accepted/rejected history, filters, stable cursor pagination | `src/routes/requests.ts:fetchRequestHistory`, `decodeCursor`; `usage.ts:queryHistory`; Composite descending history indexes; six-digit timestamp cursor | request-history, monthly-history, focused insertion-between-pages | PASS — ties/microseconds, filter/scope binding, invalid cursors, end pages, concurrent newer insertion; cursors are not full snapshot tokens |
| T | Real-key runnable client shows two users, success, both rejection levels and plan change | `client/src/{cli,api,config,demo}.ts`, bootstrap script, Compose dependencies; Real temporary integration account and its request/usage rows | example-client unit tests; real HTTP client integration | PASS — real HTTP CLI totals 45/10/35 and two full Compose demos; failure gate and key lifecycle checked |
| U | Reproducible build and automated tests | `package.json`, lockfile, strict TS configs, Docker stages; Isolated runner migrates/seeds clean temporary DB | `npm run build`, `npm test`, `npm run test:db:isolated`, client integration | PASS — clean lockfile install, strict TS builds, fresh Docker image builds and all existing regressions execute successfully |
| V | Safe secret storage, handoff and response/log projections | API-key hashing, timing-safe provisioning check, allowlisted responses/logger, bootstrap atomic rename and modes; Only API-key hashes stored in accounts; separate demo secret volume | account-api, users-api, plans-api, bootstrap tests, CLI tests, inspected Compose harness | PASS for tested controls — real PostgreSQL redaction, actual key/env/log checks; operational limits below remain |
| Official | Original Boot.dev specification compliance | Independent specification absent | No authoritative specification comparison possible | UNVERIFIED; all A–V rows refer to the local specification |
| Delivery | GitHub includes current implementation | Local HEAD plus uncommitted/untracked files | Git status inspected; no clone/push acceptance | UNVERIFIED remote state; current local changes are not demonstrated on GitHub |
| Performance | Reproducible load tests and measured results | Intentionally reserved for Phase 7 | No benchmarks executed in Phase 6C | MISSING as a final deliverable; expected pending Phase 7 |
| Documentation | Complete final README/API reference | Current README and docs are partial delivery documentation | Startup and verification commands reviewed; key flows exercised | PARTIAL; final API/error/architecture reference is reserved for Phase 8 |

## Database consistency and security interpretation

The concurrency suite compares account usage to the sum of user usage and accepted request units, tests shared account exhaustion and independent users, exact accepted retries, conflicting payloads (409), rollback fault injection and plan mutation races. The 6A suite adds concurrent rejected retries with both counters already nonzero, request-ID scope across accounts, pagination during insertion and exact arithmetic at the supported BIGINT cap. The month/plan and historical suites retain previous UTC months, cover December/January and timezone offsets, preserve counters through plan changes, and preserve applied request-plan snapshots.

The 6B suite uses actual PostgreSQL failures and guarded test-process control to exercise division-by-zero after the account update, lease and idle connection termination, loss of a client response before/after commit, backend process restart, temporary test-database connection refusal and recovery, and repeat migrations. Every destructive target is a uniquely named runner-owned database in the separate acceptance cluster. No raw `test:db` command points at the populated application database.

Malformed bodies, unknown mutation/report fields, foreign users/plans, unsafe numeric values, invalid/tampered cursors and account reuse are checked without changing counters/history. Some read-only user/account routes accept extra query fields but always select ownership from authentication; this is documented existing behavior, not a promise that every endpoint rejects every unknown query field. Validation precedes authentication, so malformed unauthenticated requests may return 400; valid protected requests with missing/invalid API keys return 401.

No real hardcoded credentials were identified in reviewed source/configuration: `.env.example` contains placeholders, test constants are artificial markers, and live API keys/provisioning credentials are generated at runtime. Installed dependency audit output is evidence from this run, not proof of absence of all vulnerabilities. Docker image checks inspect selected forbidden paths under `/app`, not a byte-for-byte forensic scan of every base-image layer.

## Documentation review and unresolved limits

- README Docker startup, random local secrets, Compose service dependencies, rerun behavior, secret cleanup and safe shutdown match the implementation. A small correction adds `npm ci` before local build/tests. Short authentication/error/clean-acceptance sections point to this evidence; no broad README rewrite was performed.
- Authentication headers, minimum provisioning-token length, one-time account key return and SHA-256 storage are documented. Full endpoint contracts, monthly/idempotency/locking explanations and a final configuration/limitations reference still need Phase 8 completion.
- The existing runner must use current built image scripts; old main containers do not automatically include uncommitted fixes. The 6C run builds new isolated images and explicitly compares compiled content; the main backend stays on its previously running image/code.
- The original Boot.dev specification is unavailable and remote GitHub content was not cloned/verified. Local uncommitted work is not a deliverable already published on GitHub.
- Backend process restart persistence is exercised; disk-backed PostgreSQL crash/restart, storage hardware failure, graceful production signal draining, and arbitrary COMMIT acknowledgement-loss timings are not fully verified. The acceptance PostgreSQL is tmpfs. No such unexecuted scenario is marked PASS.
- PostgreSQL and Node base-image tags are floating (`postgres:17-alpine`, `node:22-alpine`); this demonstrates today's clean build with the lockfile, not future bit-for-bit identical base images.
- Runtime backend images intentionally retain the repository's `scripts` tree, including integration tests and the guarded test fixture, because the existing isolated test runner executes them inside the backend image. Raw `src`, `client`, `tests`, Git/private environment files are absent under `/app`. Image packaging is functional but not minimal; splitting test-only scripts into a test image would be a separately reviewed packaging change.
- Cursor signatures, rate limiting, API-key rotation and production deployment automation are not introduced. Existing scoped SQL prevents foreign data access despite cursors being encoded rather than signed.
- Cleanup cannot guarantee removal after host SIGKILL or Docker daemon loss. Main-data preservation checks assume no unrelated actor is concurrently modifying main application rows.
- The acceptance harness currently requires the existing main stack only for read-only preservation comparisons. Product startup uses newly built images and an independently initialized PostgreSQL; it does not consume existing main database data.

## Phase 6C changes

Only these files are added/changed by this phase:

- `scripts/phase6c-verify.mjs`: clean working-tree copy, lockfile install/build/tests, cache-disabled image builds, image-content checks, isolated acceptance and preservation orchestration.
- `scripts/compose-demo-smoke.mjs`: refresh the disposable backend's ephemeral API port after Compose can recreate it during image rebuild; normal production/demo API behavior is unchanged.
- `package.json`: add `test:phase6c`, without dependency changes.
- `README.md`: add missing local dependency-install command and compact authentication/error/isolated-acceptance notes.
- `docs/phase-6c-acceptance.md` and `docs/phase-6c-verification.txt`: acceptance report and actual output excerpts.

All Phase 6A/6B modified/untracked files were already present at the start and remain preserved. No application TypeScript, migration, Dockerfile, Compose product definition, lockfile, CLI business logic or API endpoint was edited in 6C. No commits or pushes were made.

The first clean attempt successfully installed dependencies, built TypeScript/images, started the stack, passed all database/CLI tests, and then failed the Compose demo's health wait. The demo retained a host API port selected before a rebuild/recreation of the disposable backend. Test infrastructure was corrected to resolve the current published port after Compose startup, and the outer acceptance origin is refreshed after the demo. This is a test orchestration correction, not a quota/authentication behavior change. Cleanup and original-application preservation succeeded on that failed attempt. It is not counted as a successful complete acceptance run.

## Final execution results and readiness

The final `npm run test:phase6c` invocation exited **0**. Actual output excerpts are in [phase-6c-verification.txt](phase-6c-verification.txt); the complete local command log is `/tmp/phase6c-verification.log`.

| Acceptance check | Actual result |
| --- | --- |
| Clean working-tree copy | PASS; excludes installed dependencies, build output, Git and private environment files; includes local Phase 6 changes |
| `npm ci` | Exit 0; 128 packages installed; audit reported 0 known vulnerabilities in this run |
| `npm run build` | Exit 0; strict backend and CLI TypeScript compilation |
| `npm test` | Exit 0; 3 Vitest files / 16 tests and 18 Node tests (7 bootstrap, 11 isolated-runner) |
| `docker compose build --no-cache` | Exit 0; new backend/runtime, bootstrap and CLI image targets built from the clean context |
| `docker compose up --build -d` | Exit 0; separate PostgreSQL initialized, migrations/seed completed, backend healthy, bootstrap/CLI ran |
| Image-content proof | PASS; every compiled backend/migration file matches the independent clean build; selected private/source/development paths absent under `/app`; no source bind mount |
| `npm run test:db:isolated` | Exit 0; all 16 database scripts passed; six migrations/seed applied to the owned temporary database, which was removed |
| Controlled runner failures | PASS; actual owned databases cleaned after expected migrate/seed/suite command failures, inventory restored |
| `npm run test:client:integration` | Exit 0; 18 reported assertions plus dedicated-account cleanup; API confirms account 45, Ahmad 10, Sara 35 |
| `npm run test:compose:demo` | Exit 0; 83 assertions across two fresh demo accounts; preexisting disposable application rows retained |
| Successful one-shot service states | PASS; migrate, bootstrap and CLI all observed exited 0 before the intentional failure test |
| Orchestrated bootstrap failure | PASS; intentionally missing token causes expected nonzero bootstrap exit, client remains Created and stale key is absent |
| Healthy endpoint paths | Both main and disposable `/health` and `/ready` return HTTP 200; outage test separately proves readiness 503 |
| Compose config / service inspection | Exit 0; resolved secret-bearing config output withheld; final disposable bootstrap exit 1/blocked client are expected negative-test states |
| Cleanup | PASS; only disposable containers/network/source/config/credentials removed; no volume deletion |
| Main application preservation | PASS; eight full-row table fingerprints, database inventory and persistent PostgreSQL volume metadata unchanged; main backend healthy |
| `node --check scripts/phase6c-verify.mjs`, `git diff --check` | Exit 0 |

Per-script reported counts: schema 13; seed 25; SQL assignment 18; account API 22; plan API 47; assignment API 39; consumption API 47; concurrency 104; UTC/plan 79; current usage 29; monthly history 89; request history 43; 6A regressions 15; 6B security 11; 6B recovery 23. The users suite reports individual PASS lines instead of a final total. These are reported assertion groups, not a line-coverage percentage or a claim that each count is an independent test case.

The second clean run recorded `PASS refreshed changed ephemeral backend port after image rebuild`, confirming the environment condition behind the first test-harness failure. All other successful results in this final table are from the completed clean run, not inferred from source existence or the earlier failed attempt.

No unresolved product failure was observed in the executed acceptance cases. The remaining unverified operational, packaging, documentation, GitHub and official-specification items above remain explicit limitations. No performance measurements are claimed.

**Decision:** Phase 6 is ready for the user to review progression to Phase 7 performance testing on the verified local working tree. This does not establish publication of the changes on GitHub or deployment of the fixes to the main backend. The main services deliberately remain on their previously running code/image. Phase 7 has not started; approval is required before proceeding.

Final Git status (all preexisting Phase 6A/6B work retained; no commits or pushes):

```text
 M README.md
 M package.json
 M scripts/compose-demo-smoke.mjs
 M scripts/demo-bootstrap.test.mjs
 M scripts/test-db-isolated.test.mjs
 M src/app.ts
 M src/db/pool.ts
 M src/routes/consumptions.ts
?? docs/phase-6a-audit.md
?? docs/phase-6b-report.md
?? docs/phase-6b-verification.txt
?? docs/phase-6c-acceptance.md
?? docs/phase-6c-verification.txt
?? scripts/fixtures/
?? scripts/phase6a-regression.mjs
?? scripts/phase6b-recovery.mjs
?? scripts/phase6b-security.mjs
?? scripts/phase6b-verify.mjs
?? scripts/phase6c-verify.mjs
?? tests/failure-handling.test.ts
```

Phase 6C stops here for review.
