# Official requirements compliance — Phase 8B follow-up

## Authority and evidence rules

Authoritative input: user-supplied `docs/bootdev-official-requirements.txt` (local
review input; excluded from the proposed public commit because it also contains
internal training/roadmap material),
read in full, 93 lines, SHA-256
`d40d2349a202f63081a65c84aeba69e712627ca62e0cefd387730acc3f2652f2`.
The user identifies this as the original official specification; this review uses
it as authoritative, without independently certifying its provenance. Line numbers
below refer to that file. AGENTS.md remains workflow guidance; its extra details
are not invented official acceptance conditions.

PASS means implementation and executed evidence support the stated requirement,
within recorded test boundaries. PARTIAL means a requirement is only partly met;
MISSING means an expected artifact/action is absent; UNVERIFIED means available
evidence cannot establish the result. A test file alone does not establish PASS.
No universal correctness, production SLA or live interview performance is certified.

Runtime evidence is historical, not a fresh execution in this follow-up:

- [6C acceptance](phase-6c-acceptance.md) and [actual output](phase-6c-verification.txt):
  clean working-tree install/build/images/startup; all 16 DB scripts; real CLI and
  two Compose demos. The recorded suite includes account 22, plan 47, assignment 39,
  consumption 47, concurrency 104, UTC/plan 79, usage 29, monthly history 89,
  request history 43, focused regression 15, security 11 and recovery 23 assertions.
  These are script-reported groups, not coverage percentages.
- [6B report](phase-6b-report.md) and [output](phase-6b-verification.txt): controlled
  database failures, response-loss/retry, backend process restart and safe errors.
- [7C verification](../performance/phase7c-verification.json): fresh isolated
  database regressions, saved-result validation and preservation checks.
- [8B checklist](submission-checklist.md): executed build, 16 Vitest plus 33 Node
  tests, offline validation of 112 saved trials, links/routes and Mermaid parsing.
- Source review confirms no current diff from HEAD in `src/`, `client/`,
  `migrations/`, `Dockerfile` or `compose.yaml`; their latest functional commit is
  `3ee1a72` (Phase 6). Phase 7 adds benchmark infrastructure. Historical acceptance
  therefore remains relevant, but is not a clean-clone test of final publication.

## Core features, business rules and example

Every row includes exact source/test paths and its documentation. DB test PASS
rows rely on the recorded 6C/7C executions above, not new database tests.

| ID / official lines | Requirement and status | Implementation | Executed test evidence | Documentation |
|---|---|---|---|---|
| C01 / 19–23 | **PASS** — TypeScript/SQL/PostgreSQL backend called by applications; one service/database sufficient | `src/server.ts`, `src/app.ts`, `src/db/pool.ts`, `tsconfig.json`, `compose.yaml` | `npm run build`; 6C install/image/startup and DB suite | [Architecture](architecture.md), README |
| C02 / 29–37 | **PASS** — Account, owned users and named account/user plans; one resource; both levels apply | `src/routes/accounts.ts`, `src/routes/users.ts`, `src/routes/plans.ts`; `migrations/1735000000000_initial-schema.js`, `migrations/1735000000005_required-plan-assignments.js` | `scripts/schema-smoke.mjs`, `scripts/plan-assignment-smoke.mjs`, `scripts/concurrency-smoke.mjs` | [Database](database-design.md), [API](api-reference.md) |
| C03 / 38, 40 | **PASS** — Create accounts and issue separate API keys; header identifies account; reject missing/invalid keys | `src/routes/accounts.ts`, `src/plugins/api-key-auth.ts` (one-time key, hash lookup, `x-api-key`) | `scripts/account-api-smoke.mjs`, `scripts/phase6a-regression.mjs` authentication sweep | [API authentication](api-reference.md#conventions-and-authentication), [Setup](setup.md) |
| C04 / 38, 40, 45 | **PASS** — Account/user/usage/history isolation; validate supplied user's owner | `src/routes/users.ts`, `src/routes/consumptions.ts`, `src/routes/usage.ts`, `src/routes/requests.ts`, `src/routes/plans.ts`; composite ownership FKs in migrations | `scripts/users-api-smoke.mjs`, `scripts/plans-api-smoke.mjs`, `scripts/usage-api-smoke.mjs`, `scripts/request-history-smoke.mjs`, `scripts/phase6b-security.mjs` | [API](api-reference.md), [Database ownership](database-design.md#ownership-and-assignment-constraints) |
| C05 / 40 | **PASS** — Register users, assign/change both account and user plans | `src/routes/users.ts`, `src/routes/plan-assignments.ts` | `scripts/users-api-smoke.mjs`, `scripts/plan-assignment-api-smoke.mjs` | [API](api-reference.md) |
| C06 / 41 | **PASS** — Predefined account/user plans available at startup, documented example limits | `src/db/seed.ts`, `scripts/seed.mjs`, `compose.yaml` migration/seed startup gate | `scripts/seed-smoke.mjs`; 6C full startup | [Default values](predefined-plans.md), [Setup](setup.md) |
| C07 / 21, 42 | **PASS** — Account-owned custom plans: create/view/update/assign in either scope; foreign access blocked; predefined plans may be read-only | `src/routes/plans.ts`, `src/routes/plan-assignments.ts`; ownership migrations | `scripts/plans-api-smoke.mjs` (47 assertions), `scripts/plan-assignment-api-smoke.mjs` (39), including foreign update/read-only cases | [API](api-reference.md), [Architecture](architecture.md) |
| C08 / 42, 56 | **PASS** — Several users share a definition but retain independent allowances and counters | Separate plan definitions and `(account_id,user_id,month)` counters; `src/routes/consumptions.ts` | `scripts/month-plan-smoke.mjs` shared custom plan fixture, lines 285–310; `scripts/concurrency-smoke.mjs` two-user shared-account race | [Database](database-design.md), [Architecture](architecture.md) |
| C09 / 21, 58 | **PASS** — Update assigned custom definitions in place; subsequent decisions use committed values without redeploy | `src/routes/plans.ts` locks owner account before updating; `src/routes/consumptions.ts` reads current definitions after identity locks | `scripts/month-plan-smoke.mjs:298–310` updates shared allowance/max and checks both users/snapshots; `scripts/concurrency-smoke.mjs` custom account-plan update race | [Architecture transaction](architecture.md#consumption-transaction), [API](api-reference.md) |
| C10 / 43 | **PASS** — User ID, positive whole units and request ID; no partial acceptance | `src/routes/consumptions.ts` strict schema and full-unit evaluation | `scripts/consumption-api-smoke.mjs`, `scripts/phase6b-security.mjs` invalid/unsafe inputs | [API](api-reference.md) |
| C11 / 43, 49–55 | **PASS** — Both levels enforce monthly and per-request rules; user 25-unit and shared-account exhaustion cases reject | `src/routes/consumptions.ts` four checks before either counter update; BigInt arithmetic | `scripts/consumption-api-smoke.mjs`, `scripts/concurrency-smoke.mjs` exact/+1 and account-first/user-first exhaustion; CLI 25-unit rejection | [API](api-reference.md), [CLI](example-client.md) |
| C12 / 43, 54–56 | **PASS** — Accepted units charged equally to account/user; account is accepted-user sum; rejection charges zero | `src/routes/consumptions.ts` both UPDATEs and decision INSERT in one transaction; no UPDATE on rejection | `scripts/concurrency-smoke.mjs` account/user/history sum audits; `scripts/phase6a-regression.mjs` rejected retries with nonzero starting usage; saved benchmark audits | [Architecture](architecture.md), [Performance](../performance/final-report.md) |
| C13 / 44 | **PASS** — Return accepted/rejected decision, failed rule and account/user level; inspect current applied plans/limits | `src/routes/consumptions.ts` failed_rules; `src/routes/accounts.ts`, `src/routes/users.ts`, `src/routes/usage.ts`, `src/routes/plans.ts` | `scripts/consumption-api-smoke.mjs`, `scripts/usage-api-smoke.mjs`, `scripts/plans-api-smoke.mjs` | [API](api-reference.md) |
| C14 / 45 | **PASS** — Current consumed/remaining units at both levels | `src/routes/usage.ts` repeatable-read reporting, zero clamp | `scripts/usage-api-smoke.mjs` (29 assertions), `scripts/month-plan-smoke.mjs` downgrade responses | [API](api-reference.md) |
| C15 / 45, 56 | **PASS** — Query previous months and accepted/rejected outcomes; paginate history | `src/routes/usage.ts`, `src/routes/requests.ts` scoped cursor queries | `scripts/monthly-history-smoke.mjs` (89), `scripts/request-history-smoke.mjs` (43), `scripts/phase6a-regression.mjs` insertion-between-pages | [API pagination](api-reference.md#pagination) |
| C16 / 46 | **PASS** — Persist accounts/users/plans/assignments/usage/decisions through service restart | Seven tables in migrations; `compose.yaml` named `postgres_data`; no in-memory accounting | `scripts/phase6b-recovery.mjs:85–113` backend restart, unchanged plans/counters/history, accepted/rejected replay; 6C output | [Database persistence](database-design.md#migrations-seed-and-persistence), [6B](phase-6b-report.md) |
| C17 / 47 | **PASS** — Chosen API formats/endpoints and schema documented | `src/routes/`, `migrations/` | 8B route inventory checks all 20 method/path templates and JSON examples; schema smoke suite executed historically | [API](api-reference.md), [Database](database-design.md) |
| C18 / 50, 56 | **PASS** — UTC processing month, new month zero at both levels, retained previous months | `src/routes/consumptions.ts` clock_timestamp UTC after identity locks; monthly PKs | `scripts/month-plan-smoke.mjs` month/year/offset/lock-wait cases and accepted-history totals; `scripts/monthly-history-smoke.mjs` retained months | [Architecture](architecture.md#idempotency-months-and-plan-changes) |
| C19 / 58 | **PASS** — Switching plans does not reset usage or past decisions | `src/routes/plan-assignments.ts` changes only plan assignment; decision snapshots stored | `scripts/month-plan-smoke.mjs:250–283` retained current/old rows and exact original replay; shared-edit snapshot check | [Architecture](architecture.md), [API](api-reference.md) |
| C20 / 58 | **PASS** — Reduced allowance below usage means zero remaining and blocked consumption until available | `src/routes/consumptions.ts` remainingAllowance and quota comparisons; `src/routes/usage.ts` reporting clamp | `scripts/month-plan-smoke.mjs:261–278` below-usage account/user downgrade and later upgrade; `scripts/usage-api-smoke.mjs` reporting | [API](api-reference.md), README domain rules |
| C21 / 59, 82 | **PASS** — Chosen rule representation and scope; explain any additional rules if provided | Two explicit rule types in `src/routes/consumptions.ts`; no additional product rules implemented | `scripts/consumption-api-smoke.mjs` four checks; `scripts/plans-api-smoke.mjs` configuration bounds | [Architecture](architecture.md), [API](api-reference.md); optional extra rules are not mandatory |
| C22 / 61–62 | **PASS** — Working business-action client uses actual account key; two users/different plans; success/both rejection levels; plan switch without editing client; decisions/remaining shown | `client/src/demo.ts`, `client/src/api.ts`, `client/src/config.ts`, `scripts/demo-bootstrap.mjs` | `scripts/example-client-integration.mjs` 18 assertions; `scripts/compose-demo-smoke.mjs` 83 assertions/two runs in 6C; `tests/example-client.test.ts` alone is mocked, not the real-HTTP evidence | [CLI](example-client.md), [Setup](setup.md) |
| C23 / 63, 77, 85 | **PASS** — Full docker compose up --build includes backend, PostgreSQL and client; initialize/migrate/seed; configuration/instructions | `Dockerfile`, `compose.yaml`, `scripts/migrate.mjs`, `scripts/seed.mjs`, `scripts/demo-bootstrap.mjs` | `scripts/phase6c-verify.mjs` actual fresh-image Compose startup and one-shot exits; `scripts/compose-demo-smoke.mjs`; recorded 6C output | README quick start, [Setup](setup.md), [Testing](testing.md) |
| C24 / 65, 71 | **PASS** — Safe retries, atomic competing requests, preserved decisions and useful errors | `src/routes/consumptions.ts` account-first locks and persisted outcome; unique `(account_id,request_id)`; `src/app.ts` safe errors | `scripts/concurrency-smoke.mjs` same-ID/conflicting and rollback races; `scripts/phase6a-regression.mjs` rejected duplicates; `scripts/phase6b-recovery.mjs` response loss; `tests/failure-handling.test.ts` | [API retries](api-reference.md), [6B](phase-6b-report.md) |
| C25 / 58, 65, 69 | **PASS** — Correctness while plan changes compete with consumption | `src/routes/plans.ts`, `src/routes/plan-assignments.ts`, `src/routes/consumptions.ts` all coordinate on account identity lock | `scripts/concurrency-smoke.mjs` queued account assignment, user assignment and custom-definition mutation races; `scripts/month-plan-smoke.mjs` post-update decisions | [Architecture](architecture.md#consumption-transaction), [6C](phase-6c-acceptance.md) |
| C26 / 65, 73, 88 | **PASS** — Actual load results, reproducible tools/configuration/dependencies/commands, method and lessons | `scripts/perf/environment.mjs`, `scripts/perf/driver.mjs`, `scripts/perf/phase7b.mjs`, `scripts/perf/phase7b-environment.mjs`, `scripts/perf/phase7b-driver.mjs`, `scripts/perf/validate-results.mjs`, package/lockfile | `performance/baseline.json`, `performance/phase7b-tmpfs.json`, `performance/phase7b-disk.json`: 112 runs, 77,668 measured requests; 8B offline validation, all zero unexpected errors | [Performance report](../performance/final-report.md), [Testing](testing.md) |
| C27 / 73 | **UNVERIFIED** — Demonstrated performance improvement preserving correctness (evaluation criterion) | No production performance optimization/pool tuning was implemented in Phase 7 | No controlled before/after optimization evidence; replay vs new-request rates and disk vs tmpfs are not optimization proof | [Performance limits](../performance/final-report.md); rubric gap to disclose, not a stated numeric target or instruction to optimize now |
| C28 / 75 | **PASS** — Thoughtful schema, organized readable TypeScript/accounting/API | `src/routes/`, `src/db/`, `client/src/`, six migrations; direct SQL and single-service organization | Successful strict TypeScript build plus schema, ownership and concurrency suites; this supports technical review, not a guaranteed subjective grade | [Architecture](architecture.md), [Database](database-design.md) |
| C29 / 25, 79, 81, 86 | **PASS** — README API/model/keys/rules/plans/retries/assumptions/reasons/limitations and usable examples | README covers these subjects and links detailed [API](api-reference.md), [Architecture](architecture.md), [Defaults](predefined-plans.md), [Setup](setup.md), [Testing](testing.md) | 8A/8B command/link/route/JSON checks and real CLI evidence; Phase 8C corrects the stale official-spec statement; current documentation checks pass | README now states official review is complete and distinguishes core coverage from unresolved public delivery/submission |
| C30 / 82 | **PASS** — Keep required scope small; optional extras are not prerequisites | One units resource; no billing/refunds/end-user login/RBAC/distributed infrastructure in route inventory | 8B inventory of all 20 routes; DB schema inspection | README scope, [Architecture](architecture.md) |
| C31 / 84–85, 87 | **PASS** — Service, predefined plans, client, Docker artifacts and important automated tests exist | Tracked `src/`, `client/`, `migrations/`, Dockerfile/Compose, `scripts/seed.mjs`, `tests/`, `scripts/*-smoke.mjs`, package/lockfile | 6C clean-copy install/startup/integration; 8B build/unit tests; authenticated/key-isolation negatives included | README, [Testing](testing.md), [Setup](setup.md) |
| C32 / 7, 84, 88 | **PARTIAL** — Final GitHub deliverable contains complete reviewed docs plus already committed code/performance reproduction artifacts | Origin is `https://github.com/NourBattat/usage-metering-quota-service.git`; scripts/results are tracked; final docs/audits remain uncommitted/untracked; internal specification export held local | Earlier 8B normal Git access saw main `721e1ec`; Phase 8C anonymous access succeeds (A02). No final remote clean-clone acceptance | [Checklist](submission-checklist.md); public access now passes; final publication/acceptance/submission remain pending approval |
| C33 / 67, 81, 89 | **UNVERIFIED** — Student can trace a request, explain/debug/change code during discussion | [Architecture transaction flow](architecture.md#consumption-transaction), source and tests support preparation | No live student interview or debugging exercise performed | Preparation aid exists; personal demonstration remains unverified, not a missing endpoint |

## Administrative and submission requirements

| ID / official lines | Status | Evidence, limits and required action |
|---|---|---|
| A01 / 3–5, 8–10 | UNVERIFIED | TypeScript requirement is PASS (C01). Course/project sequence, mandatory roadmap adherence and eligibility cannot be proved from this repository; the referenced complete ordered course list is not supplied. Provide training records if requested by the evaluator. Optional work and subscription continuation are not service deliverables. |
| A02 / 7 | PASS | Phase 8C unauthenticated GitHub page/API GETs return 200; API reports private=false and visibility=public; credential-disabled git ls-remote succeeds on main. Earlier 8B checks returned 404 and remain historical. No visibility change was performed by this preparation. Fresh post-publication clone execution remains pending. |
| A03 / 6–7, 92–93 | UNVERIFIED | Mandatory project Google Form/final submission has no completion evidence. The supplied plain text contains “this google form” and “here” without URLs; destination links are MISSING from this copy, not proven missing from the original portal. Obtain the evaluator's links; submit and retain confirmation. Do not fabricate a URL or submit on the student's behalf. Course feedback is recommended; project form submission is mandatory. |
| A04 / 12–15, 22, 92 | UNVERIFIED | The supplied text includes training/project estimates and a final submission deadline at the end of October 20, 2026. These planning/submission conditions are not HTTP behavior; actual training adherence, completion timing and accepted submission are not proved by commit history. Meet the deadline and confirm evaluator timing/timezone if needed; internal training details remain in the held local source. |
| A05 / 89 | UNVERIFIED | AI tools are explicitly allowed; ownership/readiness is assessed in discussion (C33), not established by the presence of generated code or this audit. |

## Real blockers versus limits

No missing core product implementation was identified against the supplied brief
in this review. That conclusion relies on bounded recorded tests; it is not a
claim that every possible interleaving or failure has been tested.

Real final-submission gates still open:

1. Public access is now established (A02); a fresh unauthenticated clone and isolated acceptance of the final published commit remain pending.
2. Final README/docs/audits changes are still local; the original training/specification export is held out of the proposed public commit; the delivered
   remote tree is not yet the complete reviewed tree (C32). Publishing requires
   explicit authorization; no staging/commit/push occurs in this review.
3. The required submission/form destination and completion receipt are unavailable
   in supplied evidence (A03). Resolve the link and submit before the stated deadline.

Phase 8C pre-submission preparation corrected README's stale missing-specification
claim (C29). The official source export stays local pending explicit publication
approval; its requirements are summarized by this matrix without the full roadmap.
Performance optimization evidence is UNVERIFIED (C27): the rubric mentions
improvements, but sets no threshold or explicit additional optimization feature.
Disclose this evaluation gap; do not relabel storage/replay comparisons as an
implemented optimization, or invent a blocking numeric performance target.
Training history and interview capability need student/evaluator evidence.

TLS, rate limiting, API-key rotation/revocation, graceful signal draining,
backup/restore and disk-crash certification are not explicit requirements in this
brief. Their absence remains a limitation, not a newly invented submission blocker.
Backend process restart persistence was tested; PostgreSQL power-loss/crash recovery
was not. Users/catalog lists are unpaginated; the required history lists are paginated.
Signed cursors, extra rule types, a UI and distributed deployment are not mandated.

## Original three PARTIAL items reconsidered

- Checklist 12, security/recovery: **PARTIAL → PASS for official scope**. API-key
  validation/isolation, safe retries/competing requests, persisted state and useful
  errors have executed evidence. Production hardening was the previous broader
  boundary; it is still unimplemented and not claimed tested.
- Checklist 15, GitHub readiness: **PARTIAL → PARTIAL**. Code/performance artifacts
  exist, but final documentation is not published and submission confirmation is absent.
  Visibility was UNVERIFIED in 8B; it is now PASS after successful anonymous 8C checks (A02).
- Checklist 16, remaining limitations: **PARTIAL → PASS for disclosure/scope**.
  The full supplied specification has now been reviewed; its absence is no longer
  a blocker. Documented limits stay documented; this does not turn untested
  operational behavior into PASS. External delivery/administrative gates remain.

In the Phase 8B follow-up, checklist 14 changed PASS → PARTIAL for the stale README
statement (14 PASS / 2 PARTIAL). Authorized Phase 8C preparation now corrects that
statement: item 14 returns to PASS, yielding **15 PASS and 1 PARTIAL**. Item 15
remains PARTIAL for publication/submission/acceptance; public visibility itself now
passes. Complete official submission acceptance is not claimed.

## Verification in this follow-up

Only `docs/requirements-status.md` and `docs/submission-checklist.md` are edited.
Checks: full official-text read/hash, source/test/report inspection, unchanged
production comparison, anonymous repository access, Markdown/evidence-path checks
and `git diff --check`. Build/unit/offline-validator results above are dated prior
8B results and are not claimed rerun here. No DB/Docker mutation, benchmark,
production change, credential rotation, commit/push or Phase 8C work occurs.
Older Phase 6/8A reports retain their historically accurate missing-spec statements.

## Phase 8C preparation addendum

See [pre-submission preparation](phase-8c-preparation.md) for the reviewed file
manifest, current/history secret-scan scope, new build/unit/offline-validation
results, repeated anonymous-access checks and the proposed publication/isolated
acceptance commands. No new DB acceptance or performance optimization is claimed.
The Phase 8B verification paragraph above records that earlier phase only.
