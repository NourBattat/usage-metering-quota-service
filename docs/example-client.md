# TypeScript CLI Example Client

The example client demonstrates the quota API through real HTTP requests. It does not connect to PostgreSQL, provision accounts, or make quota decisions. The backend remains responsible for authentication, plan assignment, usage accounting, idempotency, and every accepted/rejected decision.

## Requirements

- Node.js 22 or newer.
- The backend running at `http://localhost:3000`, or an HTTP(S) URL supplied through `USAGE_API_BASE_URL`.
- A newly provisioned account with no users, no request history, and zero usage for the current UTC month.
- That account's API key, provided as `USAGE_API_KEY` or through a mounted file named by `USAGE_API_KEY_FILE`.

The client intentionally fails before making changes if the account already has users, request history, or usage. Provisioning and securely handing off a new account key are reserved for Phase 5B; this CLI never accepts or uses `PROVISIONING_TOKEN`.

## Build and run

From the repository root, build both the backend and the client:

```sh
npm run build
```

Provide the API key from a runtime secret file, then run the compiled client:

```sh
export USAGE_API_KEY_FILE=/run/secrets/usage_account_api_key
export USAGE_API_BASE_URL=http://localhost:3000
npm run client:demo
```

The mounted key file should be readable only by the intended user. As an alternative, supply `USAGE_API_KEY` through a secure runtime environment. Do not commit a key or put it in source code. The CLI never prints the key or request headers.

## Demonstration sequence

The client makes these calls using the authenticated account API key:

1. `GET /v1/usage/account`, `GET /v1/users`, and `GET /v1/requests?limit=1` verify that the account is fresh and empty.
2. `GET /v1/plans?scope=user` and `GET /v1/plans?scope=account` retrieve predefined plan IDs.
3. `POST /v1/users` creates Ahmad and Sara; `PATCH /v1/users/{userId}/plan` explicitly assigns Basic to Ahmad and Premium to Sara.
4. `POST /v1/plans/account` creates an account-owned plan with a 40-unit monthly allowance and a 100-unit per-request maximum. `PATCH /v1/accounts/me/plan` assigns it.
5. `POST /v1/consumptions` requests 10 units for Ahmad (accepted), 25 for Ahmad (Basic per-request rejection), 20 for Sara (accepted), and 15 for Sara (account monthly-allowance rejection).
6. `PATCH /v1/accounts/me/plan` switches the account to predefined Pro, using its ID from the catalog. A new 15-unit request for Sara is accepted.
7. The last accepted request is repeated with the exact same `request_id`; the client checks the `Idempotency-Replayed` response header and verifies usage did not change.
8. The client reads account and user usage, account and user plan details, and `GET /v1/requests?limit=100`. It verifies totals of 45 account units, 10 Ahmad units, and 35 Sara units, along with three accepted and two rejected decisions.

Each new decision gets a fresh random request ID. Only the explicit retry reuses an ID. The client displays the actual rejection reason and violated level returned by the backend; it does not calculate quota decisions locally.

## Error behavior

Missing key configuration and unreadable key files produce actionable configuration errors. Connection failures identify the backend origin without showing credentials. Unexpected HTTP statuses and invalid JSON are reported with the HTTP method and endpoint only; response bodies and authentication headers are not copied into errors. The CLI exits nonzero when an HTTP/API contract or demonstration expectation is wrong.

## Tests

- `npm test` runs unit tests with a fake `fetch` implementation for request headers/bodies, missing configuration, quota decisions, plan switching, idempotent replay, final totals, and secret-safe errors/output.
- With the Compose backend and PostgreSQL running, run `npm run build` and then `npm run test:client:integration` from the repository root. The separate host-side test harness provisions a dedicated account through the provisioning endpoint, passes only that account's API key to a child CLI process, verifies the real demonstration through authenticated HTTP APIs, then deletes only the account it created using a UUID-scoped command in the existing PostgreSQL container. The CLI process does not receive the provisioning token and never accesses PostgreSQL.

The CLI is not copied into or started by Docker Compose. Account provisioning automation and secret handoff remain out of scope until Phase 5B.
