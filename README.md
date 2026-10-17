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
