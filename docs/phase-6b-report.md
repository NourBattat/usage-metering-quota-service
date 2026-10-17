# Phase 6B: Security, failure recovery, persistence, and regression hardening

## Scope and safety

This phase tests existing behavior only. No new API endpoints, schema migrations, dependencies, load generators, benchmarks, billing, or frontend features were added. The Phase 6A specification limitation remains: an independent official Boot.dev assignment is not present, so this is evidence against the local requirements, not certification of official compliance.

All fault injection runs on runner-owned databases inside a separate disposable Compose project. The main PostgreSQL and backend containers are never stopped, restarted, or used for fault injection. The disposable PostgreSQL data directory is a verified `tmpfs` mount, not a persistent named volume. Test backend processes have independent random loopback ports and connect only to a validated `usage_metering_test_<pid>_<hex>` database. The harness verifies `current_database()` before injecting faults. Connection termination also requires the exact target PID, test database name, and `phase6b-backend` application name.

`npm run test:phase6b` derives a separate Compose configuration from the repository's actual configuration, uses a unique project name and random published port, generates its own credentials, and starts the existing five-service stack. It binds current workspace build artifacts read-only into the disposable services. It reuses locally available service images and installed dependencies; it does not install packages or rebuild images. PostgreSQL uses tmpfs and the secret handoff uses a private temporary bind directory. Cleanup removes only that project's containers and network with `docker compose down` (without `-v`). No Docker volume deletion command is used.

Before and after the run, full-row fingerprints of the main database's seven domain tables plus `pgmigrations`, its database inventory, and persistent PostgreSQL volume metadata are compared. The main running backend is not redeployed with the corrections during this phase; the current workspace build is tested in isolation. The main backend must remain healthy and both `/health` and `/ready` must return 200. Existing application rows and Git history are preserved. The dedicated HTTP client test creates and removes its own account only inside the disposable environment.

## Reproduction and commands

Run from the repository root, with Node.js 22, installed lockfile dependencies, Docker/Compose access, and the existing main stack and its locally built service images available:

```sh
npm run build
npm test
npm run test:phase6b
```

- `build` compiles backend and CLI TypeScript into their existing ignored build directories.
- `test` executes Vitest and bootstrap/runner Node tests. Runner unit tests use fake Docker and never touch a real database.
- `test:phase6b` creates the disposable environment, validates its tmpfs isolation, exercises runner cleanup after controlled command failures, runs the full `npm run test:db:isolated`, runs `npm run test:client:integration`, runs the real two-run Compose demo, validates Compose and health, then cleans up and compares the original application's preservation evidence.

Do not invoke raw `test:db` against populated application data. Both new database suites refuse non-test database names. Temporary credentials and resolved Compose configuration are not printed. The generated configuration and demo handoff are stored under a private `/tmp/usage-phase6b-*` directory with configuration mode 0600. That directory is a runtime artifact and is not committed. The private directory, generated configuration, and secret handoff are removed after container cleanup and preservation checks; cleanup failures are reported rather than silently ignored.

## Bugs reproduced before correction

Four new Vitest regressions were run before product edits: all four failed. A later real connection-termination run reproduced a fifth bug, which was also captured by a failing unit regression before correction. Sentinel credentials in these tests are artificial strings, not real secrets.

| Bug | Observed root cause | Minimal correction | Regression evidence |
| --- | --- | --- | --- |
| Raw infrastructure error disclosure | Database authentication lookup errors propagated to Fastify's default handler, which returned the raw Error message and could log its details | `src/app.ts` sanitizes only unhandled 5xx errors, preserves status and the `statusCode/error/message` envelope, and logs only safe status/SQLSTATE metadata with the request ID, never raw error details | `tests/failure-handling.test.ts` and `scripts/phase6b-security.mjs`: exact 500 envelope, no message/detail/hint credential markers in response/logs, safe SQLSTATE diagnostic |
| Readiness checks the wrong pool under injection | `buildApp({database})` still used the global pool for its default readiness check | Default `/ready` query uses the same selected database as routes; explicit `databaseCheck` remains supported | Same test file verifies exactly one query to the injected database; real isolated outage returns 503 then recovers |
| Idle pool errors can terminate the backend | The shared pg pool had no `error` listener; idle connection errors are EventEmitter errors | `src/db/pool.ts` handles the event with a fixed non-sensitive diagnostic; pg already removes the failed idle client | Unit emit regression plus real termination of one idle test connection, followed by readiness recovery |
| Rollback failure replaces the controlled consumption response and may return a bad client | Awaiting ROLLBACK inside catch could itself throw; finally called release without an error | `src/routes/consumptions.ts` catches rollback failure, discards that client using `release(error)`, and returns the existing consumption 500 body | Unit regression asserts exact existing body and discard argument; real in-transaction connection termination leaves both counters/history unchanged and retries successfully |
| Checked-out connection error can terminate the backend | A leased pg client can emit an error between query promises, when pg-pool's idle listener is not attached | Consumption installs a temporary error listener for the lease, marks the connection for discard, and removes the listener before release | Unit lease-error regression plus real PID-scoped termination followed by a 500 and successful retry |

The user explicitly approved changing only the generic unhandled 5xx message to `Internal Server Error`. Client 4xx errors and operation-specific explicit error responses are unchanged. No other response contract changes were made.

## Deterministic interruption methodology

`scripts/fixtures/phase6b-server.mjs` is a test-only backend process using the production compiled application and pg pool. It wraps only the injected database interface and uses Node IPC to pause at specific transaction boundaries. These controls are not HTTP endpoints and are not present in the production server.

- Query failure: execute real PostgreSQL division-by-zero after the account counter UPDATE and before the user counter UPDATE. The transaction must roll back both counters and its outcome.
- Connection interruption: pause after the account UPDATE, terminate only that exact test connection, resume the request, and verify a 500 plus no partial writes and subsequent recovery.
- Before COMMIT: pause after insertion of the uncommitted outcome. Destroy the real HTTP client socket, then SIGKILL only that disposable backend child. Restart a new child against the same database; the pending transaction must be absent and retry must succeed normally.
- After COMMIT: let COMMIT finish, pause before the database wrapper returns to the route, destroy the real HTTP socket, and resume. Retry must replay the stored response without charging again and with exactly one history row.
- Temporary DB unavailability: stop only the test child, set `ALLOW_CONNECTIONS false` only for the validated owned test database, and start a new child. `/health` must remain 200, `/ready` must be 503, and consumption must fail. Restore connections through a maintenance connection to the disposable cluster's `postgres` database, then verify readiness and consumption recover. A `finally` block restores database access even if an assertion fails.

A client disconnect alone does not promise rollback: the committed and uncommitted cases are deliberately controlled separately. A transaction can commit even if its client never receives a response, which is why persisted request IDs are required.

## Scenario results

The table separates executed tests from source-only checks. PASS entries are filled only after actual successful execution.

| Scenario | Expected behavior | Actual observation / status | Test file | Implementation |
| --- | --- | --- | --- | --- |
| Unhandled DB error and logs | 500 with no raw credential detail | PASS — HTTP 500 and captured logs exclude the injected credential marker | `tests/failure-handling.test.ts` | `src/app.ts`, API-key auth |
| Correct readiness database | Selected database is queried, failure gives 503 | PASS — exactly one injected DB query; readiness returns 503 on failure | Same | `src/app.ts` |
| Idle connection failure | Process survives and a new query reconnects | PASS — emitted unit error handled; real terminated idle test connection reconnects | Unit tests, `scripts/phase6b-recovery.mjs` | `src/db/pool.ts` |
| Failure after account UPDATE | 500, no partial charge or false accepted row | PASS — HTTP 500; both counters and history equal the pre-request snapshot | `scripts/phase6b-recovery.mjs` | consumption transaction |
| Aborted transaction before COMMIT | No usage/history; retry succeeds | PASS — killed uncommitted test backend leaves no writes; retry succeeds | Same and test server fixture | consumption, PostgreSQL transactions |
| Checked-out connection interrupted | 500, safe discard, no partial commit, recovery | PASS — real PID-scoped termination gives 500, safe discard, unchanged snapshot and successful retry | Same | consumption rollback/release |
| Isolated database unavailable/restored | Health 200, readiness 503 then 200, fail then resume | PASS — isolated DB connection refusal gives health 200/readiness 503; restore gives readiness 200 and accepted consumption | Same | readiness, auth, pg pool |
| Backend process restart | Plans, key authentication, both counters and both outcomes survive | PASS — restarted test process uses the same key, plans, counters and accepted/rejected history | Same | persisted tables and API routes |
| Accepted/rejected replay after restart | Same stored body and status; no additional charge | PASS — both accepted and rejected responses replay with identical raw body/status after restart | Same | idempotency lookup/snapshots |
| Client loses precommit request | Rollback after test process death; retry establishes original decision | PASS — real HTTP disconnect and test process SIGKILL before commit leave no usage/history | Same | PostgreSQL rollback and request uniqueness |
| Client loses committed response | Replay; exactly one decision and one charge | PASS — committed response loss replays the stored body, counters unchanged, exactly one decision | Same | persisted response and unique request ID |
| Repeat migrations | No migrations applied, data unchanged | PASS — rerun reports no applied migrations and preserves the data snapshot | Same | `scripts/migrate.mjs` |
| Authentication/foreign UUIDs/custom plans/hash storage | Reject unauthorized access without disclosure | PASS — all earlier account/user/plan/authentication/schema suites executed successfully | account/users/plans/assignment/consumption scripts | auth, routes, schema constraints |
| Long/malformed requests and unsafe integers | Reject without modifying existing counters/history | PASS — invalid long/typed/unsafe values and malformed JSON rejected; complete usage/history snapshot unchanged | `scripts/phase6b-security.mjs` | request schemas |
| Cross-account/tampered/forged cursors | Reject mismatched cursor context; SQL always scopes ownership | PASS — cross-account context rejected; re-encoded cursor remains constrained by SQL ownership | Same plus request-history suite | `src/routes/requests.ts`, `usage.ts` |
| Bootstrap network/malformed JSON failures | No reusable key; unrelated files preserved; safe errors | PASS — network and malformed JSON cases leave no key; stale temp files removed, unrelated file retained | `scripts/demo-bootstrap.test.mjs` | bootstrap |
| Actual demo key permissions/env/logs | 0400 key, 0700 directory, read-only client mount; no DB/provisioning credentials in CLI | PASS — two complete demos validate modes, non-root identity, read-only mount, safe logs and credential isolation | `scripts/compose-demo-smoke.mjs` | Compose, Dockerfile, bootstrap |
| Runner success and controlled migrate/seed/suite failure | Remove only its own created DB; inventory restored | PASS — real owned databases removed after success and controlled migrate/seed/suite command failure; inventories restored | runner unit tests; `scripts/phase6b-verify.mjs` | isolated runner |
| Unsafe DB names/application-name collision | Refuse before create/drop | PASS — all unsafe-name, unknown-app-name, application-name collision and create-failure unit checks pass | `scripts/test-db-isolated.test.mjs` | isolated runner |
| Main application/volume preservation | No preexisting row, DB inventory or volume metadata changes | PASS — all eight main table fingerprints, database inventory and persistent volume metadata unchanged | `scripts/phase6b-verify.mjs` | isolated infrastructure |
| Docker build context exclusions | `.env` and `.env.*` excluded; example template allowed | Source inspection plus unit assertions; no image rebuild claimed | bootstrap tests, `.dockerignore` | Dockerfile/build context |

## Security interpretation and remaining risks

- API key hashing, provisioning token rejection, foreign custom-plan rejection, ownership field rejection and normal secret-free responses are already covered by earlier suites, which are rerun. New tests focus on previously missing error and cursor cases.
- Request cursors are encoded, not cryptographically signed. Malformed versions/scope/keys/dates are rejected, and a re-encoded cursor is still constrained by the authenticated account SQL predicate. A signed cursor would be an API/design decision and was not introduced. Monthly cursors remain unbound page boundaries; they cannot select a foreign account.
- Validation still precedes the authentication preHandler. Malformed unauthenticated bodies can get 400; valid protected requests without a valid key get 401. This ordering was not changed.
- This run proves backend process restart persistence against a live disposable PostgreSQL, not PostgreSQL crash durability or storage hardware recovery. The main PostgreSQL container is never killed. No disk-backed PostgreSQL restart is claimed from a tmpfs-based test.
- Application shutdown in `src/server.ts` still lacks explicit graceful signal handlers. Controlled process death is tested and database transactions recover, but graceful production draining is not implemented or claimed.
- Other mutation handlers still rely on the global sanitized handler if their rollback fails. Only the consumption rollback/discard regression was demonstrated and corrected; no broad transaction refactor was made.
- The idle-pool diagnostic deliberately excludes raw connection errors. Unhandled request failures log their HTTP status and a bounded SQLSTATE code when present, correlated by the logger's request ID; messages, details, hints, SQL and connection strings are omitted. Operational request failures can be counted by their safe status log, but detailed secure telemetry is outside this phase.
- COMMIT acknowledgement loss can be ambiguous to a caller; retries must retain the original request ID. A changed ID could create a separate charge. The tested HTTP response-loss case does not simulate every database protocol/network failure timing.
- Runner `finally` cleanup cannot survive host SIGKILL, daemon loss or disk failure. Command-contract failures and actual owned-database cleanup are tested; arbitrary host termination remains outside the guarantees.
- The verification harness requires existing local Docker service images and installed host dependencies. It does not prove a clean network dependency install or fresh Docker image build. Test secrets/configuration must not be printed or committed.

## Files changed and final verification

Final commands were executed from the repository root:

| Command | Actual result |
| --- | --- |
| `npm run build` | Exit 0; strict backend and CLI compilation |
| `npm test` | Exit 0; 3 Vitest files, 16 tests passed; Node test runner 18 tests passed (7 bootstrap + 11 isolated runner) |
| `npm run test:db:isolated` (inside disposable Compose environment) | Exit 0; six migrations/seed and all 16 database scripts, including all Phase 1–6A regressions, passed; owned DB removed |
| `npm run test:client:integration` (same environment) | Exit 0; 18 reported assertions plus scoped cleanup confirmation |
| `npm run test:compose:demo` (same environment) | Exit 0; 82 reported assertions across two fresh accounts |
| Orchestrated missing-token bootstrap test | Expected Compose nonzero result; bootstrap fails, client remains Created, old key absent; harness passes |
| `docker compose config` | Exit 0; resolved secret-bearing output withheld |
| `docker compose ps -a` | Exit 0; disposable backend/PostgreSQL healthy; bootstrap exit 1 and unstarted client are the deliberately induced final scenario |
| Main and disposable GET `/health`, GET `/ready` | HTTP 200 on both services' healthy paths; isolated outage additionally proves readiness 503 |
| `npm run test:phase6b` (final attempt) | Exit 0; disposable services/network/configuration/secrets removed, main preservation checks passed |
| `git diff --check` | Exit 0 |

Database script reports retain their original per-script counts. The new security script reports **11** grouped assertions and the recovery script reports **23**. Earlier reported counts are schema 13, seed 25, SQL assignment 18, account API 22, plan API 47, assignment API 39, consumption API 47, concurrency 104, UTC/plan 79, usage API 29, monthly history 89, request history 43, Phase 6A 15. The user suite prints individual PASS lines rather than a summary total. These counts are not independent test-case or coverage percentages, and some scripts count cleanup separately.

A supplementary read-only inspection of the actual main CLI container verified that no `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PROVISIONING_TOKEN`, or inline `USAGE_API_KEY` setting is present; `USAGE_API_KEY_FILE` is present. The latest complete demo run also executes this strengthened environment-name check for both disposable clients.

Actual output excerpts are in [phase-6b-verification.txt](phase-6b-verification.txt). Full local logs are `/tmp/phase6b-unit-tests.log` and `/tmp/phase6b-verification.log`. No secret values are included in the committed excerpts.

Earlier attempts are not counted as passing: the initial four unit regressions failed as expected; the fifth lease-error regression also failed before correction. The first disposable attempt had an incorrect Docker tmpfs-inspection assumption. A later attempt reproduced the checked-out-client crash. Another required a separate maintenance connection because PostgreSQL forbids disallowing connections to the current database. A subsequent attempt completed all database/client suites but stopped at the old demo harness's named-volume assumption. The test harness was corrected to support explicitly marked tmpfs isolation while retaining the named-volume requirement in normal mode. Every attempt ran main-data preservation checks and safe disposable cleanup. Runtime files left by the first two attempts were separately removed only after checking their exact owned project names and confirming no containers remained.

Phase 6B changes:

- `src/app.ts`: selected-pool readiness and approved safe unhandled 5xx handling.
- `src/db/pool.ts`: fixed-message idle-pool error listener.
- `src/routes/consumptions.ts`: lease error listener, failed-rollback handling and client discard.
- `tests/failure-handling.test.ts`: seven focused failure/error-contract tests.
- `scripts/fixtures/phase6b-server.mjs`: guarded test-only HTTP server with IPC transaction gates.
- `scripts/phase6b-recovery.mjs`: real PostgreSQL failure/restart/interruption regressions.
- `scripts/phase6b-security.mjs`: malformed requests and cursor/account isolation regressions.
- `scripts/phase6b-verify.mjs`: disposable Compose orchestration, real runner-failure cleanup and main preservation checks.
- `scripts/compose-demo-smoke.mjs`: configurable API origin, full-column preservation digest including plan tables, explicit CLI database-env check, and test-only tmpfs/private-bind support.
- `scripts/demo-bootstrap.test.mjs`: directory mode, stale temporary-file cleanup/network failure and malformed JSON checks.
- `package.json`: include both database regressions and expose `test:phase6b`.
- This report and its actual-output excerpt.

Preexisting Phase 6A workspace changes (including the runner's additional test and untracked 6A documentation/regression script) were retained. No commits, pushes, resets, checkouts, history edits, dependency changes, or changes to older project copies were performed.

## Readiness for Phase 6C

The executed functional, security and recovery regressions pass. Phase 6C may be reviewed with the remaining limits above: no official specification, clean image build, disk-backed PostgreSQL crash-recovery proof, or graceful production shutdown guarantee. The main running service was intentionally not restarted/redeployed; the fixes are in the workspace build and were executed in the disposable environment. A future rollout needs its own reviewed scope. No Phase 6C work has started.

## Focused error-sanitization follow-up

The user's follow-up explicitly reaffirmed that only unhandled 5xx messages should be sanitized. The exact 500 response is `{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}`. Other existing HTTP statuses are preserved, including the tested 503 envelope. Existing 4xx and explicit operational error responses are unchanged.

The added real-PostgreSQL regression executes an anonymous `DO` block that raises an `XX000` error with artificial private message/detail/hint markers during the authentication database lookup. It creates no tables or functions and changes no schema or rows. The test verifies the exact generic HTTP 500 envelope, absence of every marker and the API-key marker from the response and captured logs, and presence of only the safe SQLSTATE diagnostic with a request ID in the failure log. The generic unit regression additionally checks the same logging policy using a `28P01` error. No real secret values are used as markers.

Affected files for this follow-up are `src/app.ts`, `tests/failure-handling.test.ts`, `scripts/phase6b-security.mjs`, and the Phase 6B report/evidence. No migrations, routes, dependencies, or unrelated behavior were changed.

Follow-up verification completed successfully: build and all seven affected error-handling tests passed, `npm test` passed 16 Vitest plus 18 Node tests, and `npm run test:phase6b` exited 0 with all 16 database scripts, the real PostgreSQL redaction regression, 18 CLI assertions and 82 Compose assertions. Main application fingerprints and PostgreSQL volume metadata were unchanged, both main health endpoints returned 200, and the disposable resources and private runtime files were removed. No main-service rollout occurred. Phase 6B stops for review.
