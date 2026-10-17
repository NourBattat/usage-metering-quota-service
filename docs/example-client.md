# TypeScript CLI Example Client

The example client demonstrates the quota API through real HTTP requests. It does not connect to PostgreSQL, provision accounts, or make quota decisions. The backend remains responsible for authentication, plan assignment, usage accounting, idempotency, and every accepted/rejected decision.

## Requirements

- Docker Engine with the Docker Compose plugin.
- A local `.env` file created from `.env.example`, with a unique PostgreSQL password and a random provisioning token of at least 32 characters.
- No host PostgreSQL installation or exposed PostgreSQL port is needed.

Compose starts PostgreSQL, then the migration/seed job, then the healthy backend, a one-shot account bootstrap, and finally the example CLI. The bootstrap is the only demo service that receives `PROVISIONING_TOKEN`; it provisions a brand-new account over HTTP. The CLI is a separate non-root service and receives only a read-only-mounted API key file. Both services exit after the demonstration while the backend and PostgreSQL remain running.

## Environment variables

- `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`: local database initialization settings. They stay inside Compose; PostgreSQL has no host-published port.
- `PROVISIONING_TOKEN`: required by the existing backend account-provisioning endpoint and the dedicated bootstrap service. Generate a local value with `openssl rand -hex 32`. It is never provided to the CLI.
- `PORT`: optional host port for the backend API; its default is `3000`.
- `DEMO_API_BASE_URL`, `DEMO_SECRET_DIR`, `DEMO_CLIENT_UID`, and `DEMO_CLIENT_GID`: internal bootstrap settings defined by Compose. Keep their defaults unless changing the container user/mount together.
- `USAGE_API_BASE_URL` and `USAGE_API_KEY_FILE`: client settings defined by Compose. The base URL uses internal Docker DNS (`http://backend:3000`); the key path points to the read-only shared secret volume.

Do not put an account API key in `.env`, Compose, or a command-line argument. The bootstrap creates it at runtime and hands it to the client using an atomic file rename. The dedicated `demo_api_key` volume is separate from `postgres_data`; bootstrap deletes the prior key before each provisioning attempt, creates the directory as `0700`, and creates the final file as `0400`, owned by the CLI's `node` UID/GID. Bootstrap drops to that UID/GID before making the HTTP provisioning request and writing the key. The CLI mounts the volume read-only. Removing one-shot containers does not erase the volume, but the next bootstrap clears its old key before it can start a new client run.

## First-time startup and repeated demonstrations

From the repository root, use the [README quick start](../README.md#quick-start)
to create a new private `.env` without overwriting an existing file. Keep existing
database credentials when using an existing volume; [setup](setup.md) explains why.

Do not print or commit the completed `.env` file. Start the complete application and demo:

```sh
docker compose up --build -d
docker compose ps -a
docker compose logs demo-bootstrap example-client
```

`docker compose up --build -d` automatically launches one demo on first startup. It does not continually restart the completed one-shot jobs. To run the demo again with a newly provisioned account, remove only the finished one-shot containers and start the client service again:

```sh
docker compose rm -f demo-bootstrap example-client
docker compose up -d example-client
docker compose logs demo-bootstrap example-client
```

Compose starts the bootstrap dependency again before the CLI. Backend and PostgreSQL stay up. The new run uses a fresh API key and fresh account; it never resets old account usage. Each successful demo account remains in the database as a historical demo account. No existing account or database volume is removed.

To clear only the stale key file without deleting any account or volume, run:

```sh
npm run demo:cleanup-secret
```

That command invokes the bootstrap image in clear-only mode and removes only `account-api-key` and its temporary handoff files from `demo_api_key`. Do not use `docker compose down -v`; it would delete persistent volumes.

## Expected output

The CLI prints each action, requested units, backend decision, rejection reason and violated level, plus account/user remaining allowances. Its final summary is:

- Account: 45 used, 99,955 remaining on Pro.
- Ahmad: 10 used, 990 remaining on Basic.
- Sara: 35 used, 4,965 remaining on Premium.
- Five unique history records: three accepted and two rejected. Exact retry adds no units or record.

The user-level rejection is Ahmad's 25-unit request against Basic's 20-unit request maximum. The account-level rejection is Sara's 15-unit request while only 10 units remain on the 40-unit custom account plan. After switching the account to Pro, Sara's new 15-unit request succeeds.

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

See [testing instructions and side effects](testing.md) before selecting a target
environment. In particular, the Compose harness can rebuild/recreate the backend;
it is not a read-only verification of a valuable running stack.

- `npm run build` compiles backend TypeScript and the separate CLI TypeScript project. Runtime images do not include development dependencies.
- `npm test` runs existing backend/CLI Vitest tests plus bootstrap tests for provisioning, missing configuration, permission bits, stale-key clearing, and secret-safe logs, along with Compose dependency and environment-isolation checks.
- After `.env` is configured, `npm run test:compose:demo` performs a real two-run Compose demonstration. It verifies service health/exit codes, read-only secret handoff and permissions, no key or token in logs/client environment, both runs' expected usage, fresh account/key on rerun, unchanged pre-existing database rows, and continued presence/health of PostgreSQL and the backend. It intentionally leaves the two new demo accounts as history and does not delete volumes.
- `npm run test:db:isolated` creates a unique temporary database in the running PostgreSQL service, applies migrations and seed, runs the full `test:db` suite with the test database selected, and removes only that temporary database even when tests fail. The populated application/demo database and its volume are never reset or used. Treat `npm run test:db` as an isolated-database-only command; do not run it directly against a populated application database.
- To run `npm run test:client:integration`, load the ignored environment file into the current shell without echoing it (`set -a; . ./.env; set +a`), then unset the secrets after the command. The harness creates and removes only its own temporary account.

The Compose CLI is a one-shot service; its logs remain available with `docker compose logs example-client` until that service container is removed for the next run. If CLI execution fails after bootstrap, the mounted API key remains until a subsequent bootstrap clears it or `npm run demo:cleanup-secret` removes it. `docker compose stop` safely stops the stack without removing persistent PostgreSQL data; never use `docker compose down -v` for ordinary cleanup.
