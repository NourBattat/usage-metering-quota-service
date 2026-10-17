# Phase 6A: Requirements traceability and regression audit

Scope: existing behavior, test coverage, isolated database safety, and focused regressions. No product features, API contracts, migrations, dependencies, performance benchmarks, or architectural changes were introduced. Phase 6B is not started.

## Requirements authority and evidence policy

No independent official Boot.dev specification, assignment export, or authoritative specification link was found in the repository, including hidden tracked/workspace files. `AGENTS.md` is the local project specification, supplemented by the user's Phase 6A request. The A–V matrix below evaluates those local requirements. Whether they match the original Boot.dev assignment remains **UNVERIFIED** until that specification is supplied; local assumptions must not be presented as official requirements.

PASS means a relevant automated test was executed successfully during this audit. It is scoped to the behavior described, not a claim of exhaustive proof. PARTIAL means some evidence exists but a material subcase remains untested. MISSING means no implementation or test evidence was found. UNVERIFIED means execution or the authoritative specification is unavailable. No line/branch coverage percentage was measured.

Paths below are relative to the repository root. API paths are relative to the backend origin. Test abbreviations refer to the complete inventory below. Execution results are recorded at the end.

## Requirements coverage matrix

| ID | Local requirement | Implementation | API | Database evidence | Automated evidence | Status and remaining risk |
| --- | --- | --- | --- | --- | --- | --- |
| A | PostgreSQL persistence and Compose startup | `compose.yaml`, `Dockerfile`, `scripts/migrate.mjs`, `src/db/pool.ts` | `/health`, `/ready` | `postgres_data`, `pgmigrations`; six migrations | DB suite; config validation; live readiness; unchanged table/volume fingerprints | PARTIAL: real DB used successfully; restart/recreate persistence and clean image build were not exercised in 6A |
| B | Multiple accounts, provisioning, API-key authentication | `src/routes/accounts.ts:registerAccountRoutes`, `src/plugins/api-key-auth.ts:requireApiKey` | POST `/v1/accounts`, GET `/v1/accounts/me`; protected routes | `accounts.api_key_hash` unique SHA-256 check, required plan FK | account-api, users-api, focused authentication sweep | PASS for valid requests with missing/invalid keys; provisioning is separately token protected |
| C | Account isolation and user ownership | All route queries bind authenticated `accountId`; `findAssignablePlan` | user detail, usage, requests, assignments, plans | Composite user/account FKs; ownership triggers | users-api, plans-api, assignment-api, consumption-api, usage-api, monthly-history, request-history | PASS: known foreign UUIDs return 404; client ownership fields rejected; schema also rejects foreign ownership |
| D | Starter and Pro predefined account plans | `src/db/seed.ts:seedPredefinedPlans` | GET `/v1/plans?scope=account` | `account_plans`, partial unique predefined name index | seed, plans-api, assignment-api | PASS: exact local values, repeated seed and drift refusal tested; values are project assumptions |
| E | Basic and Premium predefined user plans | Same seed function; user registration | GET `/v1/plans?scope=user` | `user_plans`, required `users.user_plan_id` | seed, users-api, assignment-api | PASS: Basic default and Premium assignment; exact values remain local assumptions |
| F | Account-owned custom plans | `src/routes/plans.ts:registerPlanRoutes` | POST/GET/PATCH `/v1/plans/:scope[/:planId]` | Separate account/user plan tables, owner FK and scoped uniqueness, immutable ownership triggers | plans-api, schema, assignment, assignment-api | PASS: create, view, edit, foreign access, immutable scope, predefined read-only API |
| G | Plan edits and independent assignments | `registerPlanRoutes`, `registerPlanAssignmentRoutes` | PATCH `/v1/accounts/me/plan`, `/v1/users/:userId/plan` | Plan assignment FKs/ownership triggers; independent usage PKs | assignment-api, month-plan, concurrency | PASS: shared definition with independent balances and subsequent-limit application |
| H | Positive integer consumption units | `src/routes/consumptions.ts:bodySchema` | POST `/v1/consumptions` | Request `units` positive/bounded CHECK | consumption-api, concurrency boundary cases | PASS: zero, negatives, decimals, strings and above-cap input rejected; maximum is a local cap |
| I | Account and user monthly allowances | `registerConsumptionRoutes`, BigInt arithmetic | POST `/v1/consumptions` | Monthly usage tables and allowance checks | consumption-api, concurrency, month-plan, focused BIGINT cap | PASS: both limits enforced; zero remaining after downgrade; exact cap and +1 exercised |
| J | Account and user per-request limits | `registerConsumptionRoutes` failure collection | POST `/v1/consumptions` | Plan and snapshot request maxima | consumption-api, concurrency, client integration | PASS: separate account/user rule failures and exact boundaries |
| K | Accepted consumption updates both counters atomically | Account → user → account usage → user usage locks, one transaction | POST `/v1/consumptions` | Both counters plus request outcome commit together | consumption-api; concurrency fault-injection rollback and retry | PASS: mid-transaction user-update failure restores both counters and leaves no decision |
| L | Rejection charges neither level and persists outcome | `registerConsumptionRoutes`, accepted-only UPDATEs | POST `/v1/consumptions` | `consumption_requests_outcome_details_check`, response snapshot | consumption-api, month-plan, focused concurrent rejected retry | PASS: focused regression explicitly checks both existing nonzero counters and one rejected history row |
| M | Understandable rejection with failed level/rule | Failure list and messages in consumption route | POST `/v1/consumptions`, GET request history | `rejection_reasons`, `failed_rule_levels`, stored response JSON | consumption-api, request-history, client integration | PASS: separate and simultaneous failures; no charge on rejection |
| N | Retry persistence, conflict, concurrent idempotency, account scope | Previous-outcome lookup under account lock | POST `/v1/consumptions` | UNIQUE `(account_id, request_id)` | consumption-api, concurrency, month-plan, focused scope/rejected retry | PASS: accepted/rejected byte replay, 409 on changed user/units, accepted and rejected races, same ID in different accounts |
| O | UTC calendar months and historical retention | Month chosen with `clock_timestamp() AT TIME ZONE 'UTC'` after identity locks | Consumption and usage/history | `(account_id, month)` and `(account_id,user_id,month)` keys; month-start CHECK | month-plan, monthly-history | PASS: year boundary, explicit timezone offsets, lock-wait clock selection and old-month replay |
| P | Plan changes retain usage and affect later requests | Same account serialization lock for consumption, assignment, edits | PATCH plan routes; consumption | Stored monthly counters; per-request plan snapshots | assignment-api, month-plan, usage-api, monthly-history, concurrency | PASS: upgrade/downgrade, shared edit, history snapshots, zero remaining below consumed usage |
| Q | Concurrent requests cannot overspend or partially charge | Account row as serialization point; consistent locking order | Consumption and plan changes | Transactional row locks and unique request constraint | concurrency: same user, two users, duplicates, conflicts, plan mutation races, rollback | PASS for tested schedules; serializing each account intentionally limits per-account throughput; not a benchmark |
| R | Current usage/remaining and historical monthly totals | `src/routes/usage.ts:registerUsageRoutes` | `/v1/usage/account`, `/v1/users/:userId/usage`, corresponding `/history` | Monthly rows retained; current report read-only repeatable-read transaction | usage-api, monthly-history, focused precision | PASS: missing month is zero, reads create no rows, totals and isolation verified; monthly history returns usage, not invented historical limits |
| S | Accepted/rejected history, filters, stable cursor pagination | `src/routes/requests.ts:fetchRequestHistory`, `decodeCursor`; `usage.ts:queryHistory` | `/v1/requests`, `/v1/users/:userId/requests`, monthly history | Composite descending history indexes; six-digit timestamp cursor | request-history, monthly-history, focused insertion-between-pages | PASS: ties/microseconds, filter/scope binding, invalid cursors, end pages, concurrent newer insertion; cursors are not full snapshot tokens |
| T | Real-key runnable client shows two users, success, both rejection levels and plan change | `client/src/{cli,api,config,demo}.ts`, bootstrap script, Compose dependencies | Existing backend APIs only | Real temporary integration account and its request/usage rows | example-client unit tests; real HTTP client integration | PASS for CLI business scenario and totals; two-run Compose/secret-volume lifecycle was inspected but not rerun in 6A |
| U | Reproducible build and automated tests | `package.json`, lockfile, strict TS configs, Docker stages | N/A | Isolated runner migrates/seeds clean temporary DB | `npm run build`, `npm test`, `npm run test:db:isolated`, client integration | PARTIAL: build and suites pass; fresh `npm ci`/Docker image build not rerun; installed lockfile dependencies used |
| V | Safe secret storage, handoff and response/log projections | API-key hashing, timing-safe provisioning check, allowlisted responses/logger, bootstrap atomic rename and modes | Provisioning key returned once; authenticated subsequent reads | Only API-key hashes stored in accounts; separate demo secret volume | account-api, users-api, plans-api, bootstrap tests, CLI tests, inspected Compose harness | PARTIAL: tested responses/logs exclude secrets; runtime secret-volume/repeat-demo security test not rerun, infrastructure errors and graceful shutdown remain gaps |

## Complete test inventory

All test entry points found in this repository are listed here. `test:db` runs its scripts sequentially; it must only be invoked by the isolated runner for this audit.

| Entry point | Invocation | Coverage / behavior |
| --- | --- | --- |
| `tests/app.test.ts` | `npm test` / Vitest | 3 tests: health OK, readiness success, readiness DB failure |
| `tests/example-client.test.ts` | `npm test` / Vitest | 6 tests: missing key, mounted key, JSON/key header, complete mocked demo, safe unexpected error, unsafe URL rejection |
| `scripts/demo-bootstrap.test.mjs` | `npm test` / Node test | 5 tests: secure atomic handoff and modes, stale-key clear on missing config, clear on server error, malformed success leaves no key, Compose authority/dependency split |
| `scripts/test-db-isolated.test.mjs` | `npm test` / Node test | 11 tests after audit: unique names, unsafe names, application-name collision, success sequence, migrate/seed/suite/drop failures, inspect/create failures, unknown application configuration |
| `scripts/schema-smoke.mjs` | `test:db` item 1 | Real CHECK/FK/uniqueness failures, independent usage, history snapshots, rejection details; savepoints and outer rollback |
| `scripts/seed-smoke.mjs` | item 2 | Four exact predefined definitions, repeated seed, custom definitions preserved, drift refused, rollback restores baseline |
| `scripts/plan-assignment-smoke.mjs` | item 3 | SQL ownership triggers, invalid/missing plans, wrong scope, null assignments, immutable owner/predefined scope; rollback |
| `scripts/account-api-smoke.mjs` | item 4 | Provisioning authentication, distinct accounts/keys, hashes only in DB, /me isolation, safe responses and logs |
| `scripts/users-api-smoke.mjs` | item 5 | Default Basic, input validation, list/detail ownership, foreign UUIDs, missing/invalid keys, account-lock coordination, safe logs |
| `scripts/plans-api-smoke.mjs` | item 6 | Catalog, scopes, owned CRUD, duplicates, foreign lookup/edit, predefined refusal, numeric limits, unknown fields, safe logs |
| `scripts/plan-assignment-api-smoke.mjs` | item 7 | Account/user assignments, foreign plans/users, wrong scope, missing/unknown fields, preserved usage, account-lock wait |
| `scripts/consumption-api-smoke.mjs` | item 8 | Both counter updates, snapshots, exact retry/conflicts, each quota rule, invalid bodies/ownership, overspending race |
| `scripts/concurrency-smoke.mjs` | item 9 | 50-way same user; two-user shared account; 20 duplicate accepted requests; conflicting payloads; account/user assignment and custom-edit races; injected rollback/retry; quota boundaries |
| `scripts/month-plan-smoke.mjs` | item 10 | UTC month/year/offset and lock waits; old-month retry; upgrades/downgrades; shared-plan edits with independent allowances; original request snapshots |
| `scripts/usage-api-smoke.mjs` | item 11 | Current account/user totals, remaining, independent users, plan changes, BIGINT representation, isolation and read-only behavior |
| `scripts/monthly-history-smoke.mjs` | item 12 | 23-month fixtures, empty/gapped months, default/custom pagination, inclusive filters, invalid queries, isolation, retention after edits |
| `scripts/request-history-smoke.mjs` | item 13 | Outcomes/snapshots, equal/adjacent microsecond timestamps, keyset order, status/cursor scope, invalid dates, safe projection, read-only behavior and index query plans |
| `scripts/phase6a-regression.mjs` | item 14 (added) | Cross-account request-ID scope; rejected retry race and changed payload; nonzero counters; history insertion between pages; exact BIGINT cap/+1; authentication sweep |
| `scripts/database-smoke.mjs` | `node scripts/database-smoke.mjs` | Standalone SELECT 1 connectivity; not in `test:db`; readiness and every real DB suite also exercise connectivity |
| `scripts/example-client-integration.mjs` | `npm run test:client:integration` | Real HTTP/compiled CLI on its own temporary account, output/usage/history/plan verification, scoped account cleanup |
| `scripts/compose-demo-smoke.mjs` | `npm run test:compose:demo` | Two real Compose demos, new accounts/keys, secret modes/mounts/environment/logs, failure exits, old-data digest and volume preservation; inspected, not executed in this phase |

## Focused coverage gaps and decisions

The existing suites already cover known foreign UUIDs, custom cross-account plan assignment, invalid bodies/unknown ownership fields, numeric bounds, accepted duplicate concurrency, year/month transitions, historical retention after plan changes, and static cursor ties. Those were retained rather than duplicated.

Highest-risk additions:

1. Concurrent **rejected** duplicates: twelve requests must return one byte-identical persisted decision, eleven replay headers, one history row, and unchanged account AND user counters starting above zero. A later changed payload must return 409.
2. Request IDs are account-scoped: two accounts use the same ID successfully with separate counters.
3. Pagination with a newer insertion after page one: all original rows remain reachable once, without the new head row entering older pages.
4. BIGINT arithmetic at 8,999,999,999,999,999 + 1: both counters reach the supported cap exactly; another unit rejects and preserves both totals. The cap is below `Number.MAX_SAFE_INTEGER`; this does not claim support for all PostgreSQL BIGINT values.
5. Missing/invalid keys across read/create routes using valid request shapes, supplementing existing consumption/assignment/plan tests.
6. Runner command-level success and failure regressions with a fake Docker executable: inspect, create, migrate, seed, suite, drop, safe-name rejection and application-name collision. These tests never call real Docker.

Remaining gaps:

- Restart/recreate/crash recovery persistence is not executed; a mounted volume and unchanged rows do not prove crash recovery.
- Clean dependency installation and fresh image build are not repeated.
- Real runner failure cleanup is command-contract tested with fake Docker; no actual daemon outage/drop-permission failure or SIGKILL test was performed. `finally` cannot guarantee cleanup after process termination or loss of Docker access.
- The Compose failure helper starts a standalone failing bootstrap and checks dependency configuration; it does not itself execute an orchestrated failed dependency startup. No stronger runtime claim is made.
- The Compose preservation digest omits custom plan tables, assignment columns, key hashes and some history columns. The 6A before/after verifier instead hashes every column of all eight application/migration tables for its own DB/client run. The two-run Compose harness was not changed or executed.
- Authorization happens in `preHandler`, after schema validation. A malformed unauthenticated request may receive 400 before 401. Valid protected requests with missing/invalid keys receive 401; no contract change was made.
- Some read endpoints ignore extra query parameters (`/accounts/me`, user list/detail); mutations and reporting schemas reject unknown ownership fields. Isolation still comes from authenticated IDs.
- Monthly cursors encode only a month, without account/filter binding. Queries always bind authenticated ownership; cursor reuse can change the page boundary but cannot select another account. Stronger cursor semantics would require contract review.
- No exhaustive every-field/every-route mutation corpus, network-disconnect test, idle connection failure, or graceful shutdown test exists.

## Isolated database safety review and fix

Before this audit, the runner accepted any `usage_metering_test_[a-z0-9_]+` name, had no PostgreSQL identifier length bound, and had no explicit application-database comparison. The normal generated name was unique, and cleanup only followed successful creation, but caller-provided long names could be truncated by PostgreSQL. An explicitly shaped application database also deserved a direct refusal check.

Changes are limited to `scripts/test-db-isolated.mjs` and its test:

- Require the generated PID + 32 lowercase hex character format and at most 63 ASCII bytes.
- Read `POSTGRES_DB` from the existing PostgreSQL container and refuse equality or unknown configuration before creating anything.
- Keep the ownership guard: `databaseCreated` becomes true only after `createdb` succeeds. A failed create never triggers drop, protecting existing databases from collision cleanup.
- Pass the same validated name as a positional shell argument, not interpolated SQL/shell text.
- Override `PGDATABASE` for migrations, seed and the full `test:db` process in the backend container. This application's pg pools read standard PG variables, not a separate connection string.
- Run cleanup from `finally` after success or failure; a failed cleanup sets a nonzero exit code. Only the successfully created name is targeted. No volume removal commands exist in the runner.

Operational assumptions: PostgreSQL and backend are running, their credentials refer to the same cluster, the backend image/test scripts are current, and the configured application database is `POSTGRES_DB`. This is a trusted local integration tool, not protection against an administrator concurrently renaming/dropping/replacing databases. Abrupt termination may leave an orphan test database; do not delete it without confirming ownership.

## Code quality review

- Strict backend/client TypeScript compilation passes. SQL user values use parameters; dynamic table names are selected from fixed account/user choices, and dynamic history clauses are assembled from fixed expressions.
- Mutation routes share the account-first lock convention, with rollback guards and `finally` releases. Injected mid-transaction failure is already tested. Reporting uses read-only transactions where a coherent current plan/usage snapshot is needed.
- No product refactoring was needed. Small repeated response/remaining/error helpers exist across routes; consolidation is optional and outside this phase.
- `src/db/pool.ts` does not register an idle-pool `error` listener. An idle client error can become an unhandled EventEmitter error. `src/server.ts` does not install graceful shutdown handlers to close Fastify and the pool. These are identified operational risks, not reproduced failures or fixes made in this phase.
- Connection acquisition occurs outside route-local transaction try blocks, and some read paths rely on Fastify's default error handler. Rollback itself can also fail during connection loss. Error-envelope consistency and infrastructure-error redaction need fault-injection tests before any fix is selected. No claim is made that secrets were observed leaking.
- CLI network calls have no explicit timeout, unlike bootstrap's bounded provisioning call. A stalled dependency can delay the demo. No API/architecture change was introduced.
- API-key rotation/revocation management is not implemented. Existing local bootstrap and one-time key return are covered; a key lifecycle policy should be agreed if required by the original specification.

## Execution evidence

Results are filled from actual command output after verification. All commands were run from the repository root. Docker credentials were read from the already-running containers into a temporary verifier process's environment; no `.env` file was created and no secret values were printed. Resolved `docker compose config` output was captured and withheld because it contains credentials.

Full Docker/database/client command output is available locally in `/tmp/phase6a-verification.log`; it is an ephemeral verification artifact, not a committed deliverable.

The running container's compiled backend and migration file SHA-256 hashes were checked against the workspace before tests. Only `package.json` and the new regression script were copied into the running backend container to make the current test inventory available; no product code or application container was restarted. Future builds include these test files through the existing Dockerfile.

| Command/check | Purpose | Actual result |
| --- | --- | --- |
| `npm run build` | Compile strict backend and CLI TypeScript | Exit 0 |
| `npm test` | Vitest plus bootstrap/runner Node tests | Exit 0: 9 Vitest + 16 Node tests |
| `npm run test:db:isolated` | Create a clean DB, run six migrations, seed and all 14 DB scripts, then remove only that DB | Exit 0; all scripts passed, cleanup confirmed |
| `npm run test:client:integration` | Real HTTP and compiled CLI with its own temporary account | Exit 0; 18 reported assertions plus scoped cleanup confirmation |
| `docker compose config` | Validate fully resolved Compose configuration | Exit 0; output withheld to avoid printing secrets |
| `docker compose ps -a` | Inspect existing service state | Exit 0; backend/PostgreSQL healthy; migrate/bootstrap/client already exited 0 |
| GET `/health`, GET `/ready` | Check live HTTP health and database readiness | Both HTTP 200 |
| Before/after database checks | Compare full-row fingerprints of all seven domain tables and `pgmigrations`, plus database inventory | All unchanged; no temporary database remained |
| Before/after volume check | Compare metadata of the mounted PostgreSQL named volume | Unchanged |
| `git diff --check` | Check tracked patch whitespace | Exit 0 |

DB script reported assertion totals: schema 13; seed 25; SQL assignment 18; account API 22; plan API 47; assignment API 39; consumption API 47; concurrency 104; UTC/plan 79; current usage 29; monthly history 89; request history 43; focused 6A 15. The users script reports individual PASS lines instead of a final assertion total. Some scripts print their count before cleanup assertions, so these totals are not equivalent to a count of independent tests.

Initial sandboxed `npm test` attempts failed: nested Node process execution/capture was denied (`EPERM`). The suite was rerun with approved process permissions and passed. Docker socket access also required approval. These failures are recorded as environment restrictions, not successful runs or application defects.

The real verification was orchestrated by `/tmp/phase6a-verify.py` (an ephemeral local helper, not a project dependency). It extracted only the necessary environment settings in memory, checked running backend hashes, ran the commands above, and performed preservation comparisons in `finally`. No application database reset, application migration, volume deletion, container restart, or Git history rewrite occurred. Only the harness's newly provisioned CLI account was deleted from the application DB. Existing demo accounts had unchanged full-row fingerprints.

Repository history changed externally during this audit: HEAD advanced from `04c49e9` to `2ad4d23` (`Complete Phase 5 end-to-end demo and isolated testing`), including the already edited runner, its tests, and the package test entry. One additional runner test was added afterward. No commit, reset, checkout, or history edit was executed by this audit. The audit report and focused regression script remained new workspace files at final review; the runner test file also has an additional uncommitted regression.

## Recommendation for Phase 6B

Request the original Boot.dev specification to resolve official traceability. Prioritize controlled restart/recreate persistence verification on a disposable Compose project, pool/network fault-injection and graceful shutdown tests, and a clean image build. Decide the intended error contract before changing infrastructure-error handling. Strengthen Compose preservation snapshots and orchestrated bootstrap-failure evidence if those are included in the next approved scope. Keep performance measurement in its separately approved phase.

Phase 6A stops here. The passing local functional suites do not close the PARTIAL rows or establish official Boot.dev compliance.
