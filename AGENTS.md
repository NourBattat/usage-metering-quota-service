
# Usage Metering and Quota Service — Codex Instructions

## Project Goal

Build a Boot.dev final project implementing a reliable usage metering and quota service.

Required technologies:
- TypeScript
- PostgreSQL
- Docker Compose

Keep the architecture simple: one backend service and one PostgreSQL database are sufficient.

The project must be understandable, testable, and defensible during a technical discussion.

## Communication and Teaching

- Explain concepts and decisions in beginner-friendly Palestinian/Levantine Arabic.
- Write all code, code comments, API documentation, and README content in English.
- Explain what each command does, why it is necessary, and where to run it.
- Explain the purpose of every important file and database table.
- Prefer simple, maintainable solutions over unnecessary abstractions.
- Never assume the student already understands a technical concept.
- Explain tradeoffs and why a particular approach was selected.

## Development Workflow

1. Inspect the repository before making changes.
2. Propose an architecture and phased implementation plan before generating substantial code.
3. Do not implement a new phase without explicit approval.
4. Work on one small, clearly defined task at a time.
5. Before editing, explain which files will change and why.
6. Do not silently add dependencies or change architectural decisions.
7. Run relevant tests after each implementation step.
8. Show the actual commands and results of verification.
9. Never claim a test passed unless it was executed successfully.
10. Fix errors before proceeding to the next phase.
11. Provide complete updated files when useful for review.
12. Never delete or modify older project copies outside this workspace.
13. Ask for approval before destructive operations.
14. Do not generate the entire project in one pass.

## Core Domain Requirements

### Accounts and Authentication

- An account represents a calling company or application.
- Each account can have multiple users.
- Each account has its own API key.
- Protected endpoints require the account API key in a request header.
- Reject missing and invalid API keys.
- Enforce strict account isolation across every relevant endpoint.
- A user must belong to the authenticated account.
- Support account creation and user registration.
- Define and document a safe account bootstrap mechanism.

### Plans

- Support account-level plans and user-level plans.
- Seed predefined account plans such as Starter and Pro.
- Seed predefined user plans such as Basic and Premium.
- Support account-owned custom plans.
- Support viewing and updating applicable plans.
- Support assigning and changing plans for accounts and users.
- Predefined plans may be read-only.
- A plan definition may be shared by multiple users.
- Every user must have an independent usage allowance.

Each plan must define:
- Monthly usage allowance.
- Maximum units allowed per request.

### Consumption

Every consumption request must contain:
- User identifier.
- Positive integer number of units.
- Unique request identifier.

A request is accepted only when BOTH account-level and user-level rules allow it.

For accepted requests:
- Add units to the account's monthly consumption.
- Add the same units to the specified user's monthly consumption.

For rejected requests:
- Consume zero units at both levels.
- Preserve the rejection in request history.
- Return an understandable rejection reason.
- Identify the account-level or user-level rule that failed.

### Monthly Usage

- Use UTC calendar months.
- Start each new UTC month with zero usage for that month.
- Preserve all previous monthly usage.
- Never erase consumption when a plan changes.
- Apply new plan limits to requests processed after the change.
- If a new limit is lower than already consumed usage, remaining allowance is zero.
- Prevent further consumption while the relevant allowance is exhausted.

### Idempotency

- A retry using an existing request ID must never charge usage twice.
- Define a clear response for an exact retry.
- Define a clear error for reusing a request ID with different parameters.
- Persist accepted and rejected request outcomes.
- Enforce idempotency safely under concurrency.
- Clearly define request ID uniqueness scope.

### Concurrency and Transactions

Correctness under concurrent requests is mandatory.

- Use PostgreSQL transactions.
- Propose and justify a concurrency-control strategy.
- Use appropriate row locking or another proven atomic strategy.
- Enforce account and user quotas atomically.
- Prevent overspending when multiple users consume simultaneously.
- Coordinate plan changes with consumption transactions.
- Consider deadlocks and consistent locking order.
- Ensure transaction failures do not produce partial consumption.
- Add automated concurrency tests.

### Reporting

Provide:
- Current account usage and remaining allowance.
- Current user usage and remaining allowance.
- Historical monthly usage.
- Accepted and rejected request history.
- Pagination for history endpoints.
- Inspection of applied plans and limits.

All account-specific data must remain isolated.

## Example Client

Provide a runnable CLI or web client that:

- Uses a real account API key.
- Simulates a business action consuming units.
- Demonstrates two users in the same account with different plans.
- Demonstrates successful consumption.
- Demonstrates user-level quota rejection.
- Demonstrates account-level quota rejection.
- Demonstrates a plan change affecting subsequent requests.
- Displays decisions and remaining allowances.

A plan change must not require modifying the client's source code.

## Docker Requirements

Running:

docker compose up --build

must start the complete stack:
- Backend service.
- PostgreSQL.
- Example client and its dependencies.

Use a reliable database initialization and migration strategy.
Seed predefined plans during startup.
Document required configuration.

## Testing Requirements

Include automated tests covering:

- Missing and invalid API keys.
- Account isolation and user ownership.
- Monthly and per-request quota boundaries.
- Successful and rejected consumption.
- Account-level and user-level rule enforcement.
- Idempotent retries and conflicting request IDs.
- Plan changes without usage resets.
- UTC month boundaries and historical usage.
- Pagination.
- Concurrent requests and prevention of quota overspending.
- Concurrent plan changes and consumption.

Do not rely only on happy-path testing.

## Performance Testing

Provide reproducible load-testing scripts, dependencies, configuration, and commands.

Measure performance using actual test runs.
Document methodology, results, and lessons learned.
Never fabricate measurements.

## Documentation and Delivery

Maintain a complete README covering:
- Installation and configuration.
- Architecture and data model.
- API endpoints and authentication.
- API key management.
- Quota enforcement.
- Plan creation and changes.
- Retry and idempotency behavior.
- UTC monthly accounting.
- Concurrency strategy.
- Running Docker Compose.
- Example client.
- Automated and performance tests.
- Assumptions and limitations.

Final deliverables:
- GitHub repository.
- Dockerfiles and Docker Compose configuration.
- Backend and example client.
- Persistent PostgreSQL storage.
- Automated tests.
- Performance test scripts and actual results.
- Complete README.

## Out of Scope

Do not implement:
- Billing or payments.
- Refunds.
- Multiple resource types.
- End-user login.
- Role-based access control.
- Distributed infrastructure.

Avoid unnecessary features and complexity.

## Implementation Phases

Phase 1: Project foundation, database schema, migrations, configuration, and Docker.

Phase 2: Accounts, API keys, users, and plan management.

Phase 3: Atomic consumption engine, quota enforcement, and idempotency.

Phase 4: Usage reports, monthly history, and pagination.

Phase 5: Example client and required demonstrations.

Phase 6: Automated tests, integration tests, and concurrency tests.

Phase 7: Reproducible performance testing and measured results.

Phase 8: Documentation, cleanup, GitHub readiness, and final verification.

Important: Testing must begin during earlier phases; do not postpone all testing until Phase 6.

## Rules Before Implementation

Before writing substantial code:

1. Inspect the current workspace.
2. Recommend a minimal technology stack.
3. Propose the database tables and relationships.
4. Propose the API endpoints.
5. Explain transaction boundaries and locking.
6. Explain idempotency and UTC monthly usage.
7. Explain account isolation and authentication.
8. Explain database initialization and Docker startup.
9. Propose the testing strategy.
10. Present a phased implementation plan.
11. Wait for explicit approval before implementing Phase 1.

Prioritize correctness, simplicity, and understanding.
