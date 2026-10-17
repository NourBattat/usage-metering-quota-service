# Installation, configuration and operations

Commands below run from the repository root in a POSIX shell (Linux/WSL2).
Install Docker Engine with the Docker Compose plugin. Node.js 22+ and npm are
required for the documented secret-generation command and local builds/tests.
No host PostgreSQL server is required; Compose uses `postgres:17-alpine` privately.

## Private environment configuration

The [README quick start](../README.md#quick-start) creates `.env` from `.env.example`,
generates random password/token values without printing them and refuses to
overwrite an existing file. If `.env` already exists, retain its correct credentials.
Do not print/commit it. `.gitignore` and `.dockerignore` exclude actual environment files.

| Setting | Use/default |
|---|---|
| `PORT` | Host-published API port, default 3000; backend inside Compose remains on port 3000 |
| `POSTGRES_DB` | Initial database name, default `usage_metering` |
| `POSTGRES_USER` | Initial database role, default `usage_metering` |
| `POSTGRES_PASSWORD` | Required private local PostgreSQL password; no real value belongs in docs |
| `PROVISIONING_TOKEN` | Required backend/bootstrap secret; configure at least 32 characters |

Compose interpolation reads `.env` automatically; it does not export variables to
ordinary host Node processes. Do not solve an existing-volume login problem by
recreating data. Editing `POSTGRES_PASSWORD` does not rotate the existing role's
password. Keep the original settings and inspect configuration deliberately.
Avoid sharing resolved `docker compose config` output because it contains secrets.

For direct host backend development, `pg` reads `PGHOST`, `PGPORT`, `PGDATABASE`,
`PGUSER`, `PGPASSWORD`, and the app reads `PORT` and `PROVISIONING_TOKEN`.
Compose does not publish PostgreSQL to the host, so a separately reachable development
PostgreSQL instance is needed. `.env.example` documents those optional PG variables;
no dotenv loader automatically loads them for `npm run dev` or `npm start`.

## Services and first startup

```sh
docker compose up --build -d
docker compose ps -a
docker compose logs demo-bootstrap example-client
```

`up --build` also starts the complete stack in attached mode; `-d` above leaves it
running in the background. Startup dependencies are explicit:

| Service | Image/stage and responsibility | Completion behavior |
|---|---|---|
| `postgres` | PostgreSQL 17 Alpine; persistent data, internal port 5432 | Long-running, readiness checked with pg_isready |
| `migrate` | Runtime backend image; migrations then predefined seed | One-shot; exit 0 gates backend |
| `backend` | Runtime image, non-root node user; compiled Fastify API | Long-running; `/ready` healthcheck |
| `demo-bootstrap` | Separate minimal Node stage; HTTP account provisioning and private key handoff | One-shot; exit 0 gates CLI |
| `example-client` | Separate compiled CLI stage, non-root node user | One-shot; verifies demonstration and exits |

Only the backend publishes `${PORT:-3000}:3000`. Health checks at the default port:

```sh
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/ready
```

Use your configured host port if changed. Expect `{"status":"ok"}` and
`{"status":"ready"}`. Readiness becomes 503 if its database check fails;
liveness does not query the database. Migration/seed/bootstrap/CLI errors produce
nonzero one-shot exit codes; inspect their service logs without dumping private files.

## Secret handoff and API key management

Two separate named volumes exist: `postgres_data` for the database and
`demo_api_key` for the latest demo key. Bootstrap alone provisions the demo account
with the privileged token; only the backend and bootstrap receive that token.
The CLI receives the internal URL and `USAGE_API_KEY_FILE`, not database credentials.

Before provisioning, bootstrap clears stale key/temp handoff files. It creates a
0700 directory and writes an exclusive temporary key file, sets 0400 permissions,
then renames atomically to `/run/demo-secrets/account-api-key`. The directory/file
belong to the CLI UID/GID; the CLI volume mount is read-only. Bootstrap drops to
that UID/GID before its HTTP request/key write. Failure clears stale keys and
blocks CLI startup via Compose's successful-completion dependency.

If the CLI fails after successful bootstrap, the key may remain until the next
bootstrap or explicit cleanup. Clear only the demo key/temp files with:

```sh
npm run demo:cleanup-secret
```

This removes no account or volume. The backend stores only a SHA-256 account-key
hash; the raw key is returned once and cannot be recovered through the API.
There is no implemented key rotation/revocation endpoint. Keys may authorize all
account operations, including plan management; end-user login/RBAC is out of scope.
The backend serves HTTP directly; production TLS/deployment hardening is separate work.

## Rerun and stop safely

```sh
docker compose rm -f demo-bootstrap example-client
docker compose up -d example-client
docker compose logs demo-bootstrap example-client
```

Run after the previous demo completes. Only finished demo containers are removed;
bootstrap provisions a fresh account/key and all prior demo accounts remain.
The CLI requires a fresh empty account and will not reset populated usage.
See [demo actions and output](example-client.md).

```sh
docker compose stop
```

This stops the stack without deleting data. Plain `docker compose down` removes
containers/network while retaining named volumes; `down -v` removes volumes and
is not a safe routine cleanup command for this project. Changing Compose project
identity can select different volumes; keep the existing identity when preserving
an existing application's data. Do not use global Docker volume pruning.

## Local build and CLI configuration

```sh
npm ci
npm run build
```

This installs the lockfile dependencies and compiles backend to `dist/` and CLI
to `dist-client/`. `npm run build:client` compiles only the client; `npm start`
runs the compiled backend and `npm run dev` starts the TypeScript watcher.
A reachable initialized development database and exported server variables are
prerequisites for either host server command.

The host CLI command is `npm run client:demo`. Configure `USAGE_API_BASE_URL`
(default `http://localhost:3000`) and a private `USAGE_API_KEY_FILE` containing a
fresh account's real key. `USAGE_API_KEY` is supported as an environment alternative;
when a key file is configured it takes precedence. Do not paste keys into commands,
source or `.env`. The Compose flow is the reproducible automatic bootstrap path.
Changing plans is an API operation and never requires editing CLI source.
