# Phase 8C pre-submission preparation

Scope: documentation correction/review, current-tree and existing-history secret
review, anonymous public-access checks, build/unit/offline performance validation,
and a proposed publication/acceptance plan. No commit, push, staging, visibility
change, database mutation, Docker startup or new benchmark is performed here.

## Current result

- README accurately states that the supplied official requirements were reviewed.
- [Compliance matrix](requirements-status.md) retains exact implementation,
  executed-test and documentation evidence: no missing mandatory core feature was
  identified. [Checklist](submission-checklist.md): **15 PASS, 1 PARTIAL**.
- Public access now passes. Anonymous GitHub page/API requests returned 200; API
  reports `private=false`, `visibility=public`, default branch `main`. Credential-
  disabled `git ls-remote` returned main at
  `721e1ec8251dce8ddf77a9361b6b4ee1cafbca69`, matching local HEAD. Earlier 8B 404s
  are historical; this preparation did not change visibility.
- Final documentation is still local. No fresh clone of a final published commit
  has been accepted, and no required submission/form receipt is available.
- Optimization improvement evidence and live interview/training-record evidence
  remain unverified; no untested behavior is upgraded to PASS.

## Reviewed file manifest

This reviews every modified/untracked file, not an instruction to stage it.
Already tracked source, migrations, seed, tests, Docker/package configuration and
performance evidence remain in the existing commit and have no new changes.

| File | Review and proposed disposition |
|---|---|
| `README.md` | Existing Phase 8A rewrite plus authorized official-review correction; include after diff approval |
| `docs/example-client.md` | Existing setup/test-side-effect clarifications; include |
| `docs/api-reference.md` | 20 actual route templates, key authentication, inputs/responses, retries and cursors; include |
| `docs/architecture.md` | Actual startup/secret flow and account-first transactions; include |
| `docs/database-design.md` | Seven domain tables, six migrations, ownership and snapshots; include |
| `docs/setup.md` | Runtime variables, service gates, fresh demo rerun and non-destructive stop; include |
| `docs/testing.md` | Actual test entry points, prerequisites, mutation boundaries and isolation; include |
| `docs/requirements-status.md` | Official technical matrix and externally unverified delivery/administrative items; include after reviewing this summarized public text |
| `docs/submission-checklist.md` | Current checklist with dated audit evidence; include |
| `docs/phase-8a-review.md` | Project engineering audit, historically accurate phase statements; include |
| `docs/phase-8c-preparation.md` | This report and proposed future commands; include after review |
| `docs/bootdev-official-requirements.txt` | User-provided authoritative local input also contains internal training/roadmap material. **Hold locally; exclude from proposed public commit unless separately approved.** No content was edited or deleted |

The matrix/checklist identify the local source by name/hash and describe the
requirements; they do not depend on a Markdown link to publishing that export.
No private environment file, build output, dependency tree, DB dump or runtime
secret file belongs in the proposed commit. Existing `AGENTS.md` is tracked project
workflow guidance; no history removal is proposed. Historical audit reports are
project evidence, not proof of a new execution.

## Secret audit: candidates and existing Git history

Final verification expands the earlier reachable-history scan to **all local Git
objects**, including unreferenced/unreachable objects: 12 commits, 176 blobs and
89 trees. Git reports `is-shallow-repository=false`. Of these, 19 blobs and 29 trees
are outside refs/reflogs. Every blob and commit message/metadata was scanned;
there are no annotated tag objects. Trees map objects back to file paths. All 108
tracked/nonignored candidate files were also scanned. No private-key/environment/
dump file path was identified in the reviewed history inventory.

Anonymous remote heads/tags inspection advertised only `main`, at the same full
SHA as local HEAD. Thus the advertised public branch history is present locally;
no remote branch/tag divergence was observed. This is not a claim about hidden PR
refs, deleted remote history or hosting caches.

Checks cover known current local credential values, private-key markers, GitHub/AWS
token formats, credential-bearing database URLs, bearer tokens, credential-valued
literals/defaults and report fields. Values are never printed. Broad first-pass
matches were triaged: JS variable references and a package command were not
credentials; fixed literals in mock/bootstrap tests and injected database-error
regressions were synthetic fixtures. Exact reviewed error-fixture file versions
were identified before clearing those matches. The expanded scan immediately
reported an additional candidate in an unreachable version of
`tests/failure-handling.test.ts`; context review and a value-withheld equality
check confirmed the same synthetic mock-database error marker as the current unit
test. No history edit or credential rotation followed. No unresolved actual credential
finding remains in the reviewed working tree or reachable local history.

Limits: this custom bounded source scan is not a universal secret detector or a
third-party credential validity service. It excludes unknown/hidden remote-only refs, existing images/registry layers, GitHub Actions
logs/artifacts and hosting caches. No remote refs were fetched and no secret was
sent to a validation service. Do not interpret a clear scan as an absolute absence
of secrets. No credential rotation or history rewrite was attempted or needed by
these findings; a future real finding must stop publication for separate review.

## Actual verification

Commands ran from the repository root with installed lockfile dependencies.
Performance validation ran in a private temporary copy because it regenerates
its validation/final-report outputs. Original measurement/report bytes remain
unchanged and the temporary copy was removed. No load was generated.

| Command/check | Result |
|---|---|
| `npm run build` | Exit 0; backend and CLI compiled |
| `npm test` | Exit 0; 16 Vitest and 33 Node tests, zero failures |
| `npm run perf:validate` | Exit 0 in private copy; 24 + 44 + 44 saved trials validated; 77,668 measured requests, 5,600 warmups |
| Documentation | 126 local links/anchors, 93 npm references, 24 JSON examples and 20 routes checked; proposed public copy also passes with training export omitted |
| Mermaid | All four diagrams parsed again in final verification using temporary Mermaid 11.12.0/jsdom 26.1.0; GitHub visual rendering remains pending |
| `git diff --check` | Exit 0 |
| Preservation | Candidate fingerprints show only README, the two current audit docs and this new report changed in 8C; official text, source/client/migrations/scripts/packages/Docker/performance unchanged |

Final build/unit/validation logs are `/tmp/phase8c-final-build.log`,
`/tmp/phase8c-final-unit.log` and `/tmp/phase8c-final-perf.log`. Final scan/public
summaries are `/tmp/phase8c-final-history.json` and `/tmp/phase8c-final-public.json`.
These supplement the earlier `/tmp/phase8c-*.log` records; scan/public
summaries contain paths/types/statuses only. They are not proposed commit files.
No application database query or Docker operation was needed in this preparation.
Pinned Mermaid tooling and proposed-public validation copies were removed after
checks. The held training export is unchanged. README already contains the correct
official-review statement; no additional README correction was necessary in this
final verification. The planned 11-file commit manifest remains unchanged.

## Proposed commit/push plan — do not execute yet

Run from the repository root only after reviewing and explicitly approving the
final file list. First confirm `main`, intended origin and a clean index using
`git status --short`, `git diff --cached --name-only` and `git diff --check`.
If anything is already staged unexpectedly, stop and review instead of silently
unstaging someone else's work. Review tracked diffs and every untracked file in
the manifest above. Confirm the official training export stays untracked.

Use explicit paths rather than broad staging:

```sh
git add -- README.md docs/example-client.md docs/api-reference.md \
  docs/architecture.md docs/database-design.md docs/setup.md docs/testing.md \
  docs/requirements-status.md docs/submission-checklist.md \
  docs/phase-8a-review.md docs/phase-8c-preparation.md
git diff --cached --name-only
git diff --cached --check
git diff --cached --stat
```

Review the exact staged diff locally after the secret scan. Confirm it contains
exactly these 11 files, no production/configuration/measurement changes and no
`docs/bootdev-official-requirements.txt` or `.env`. Re-scan if any bytes changed.
Then, only with explicit commit/push approval:

```sh
git commit -m "Finalize documentation and submission readiness review"
git push origin main
```

Before pushing, check the remote ref again. If remote main advanced, stop and
review divergence; do not force-push, reset or rewrite history. Approval must cover
the actual reviewed commit. Record its full SHA for the post-publication check.
The project form/portal submission is separate and is not performed by Git push.

## Fresh anonymous clone after publication — not executed

Use a new temporary parent from a neutral directory, not the existing workspace.
No token, credential helper, custom Git config or authenticated URL is needed:

```sh
clone_parent="$(mktemp -d /tmp/usage-public-clone-XXXXXX)"
env -u GH_TOKEN -u GITHUB_TOKEN -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
  git -c credential.helper= -c core.askPass= clone \
  https://github.com/NourBattat/usage-metering-quota-service.git "$clone_parent/source"
cd "$clone_parent/source"
git rev-parse HEAD
npm ci
npm run build
npm test
npm run perf:validate
```

Compare HEAD to the approved/published full SHA before testing. A mismatch means
stop and choose the intended commit; clone success alone is not code acceptance.
These commands install/build/test the remote checkout, not copied dependencies.
Offline validation rewrites reports only inside that new checkout. Keep its logs
and record software versions. Confirm the internal training export and real `.env`
are absent. Do not copy the existing workspace's `.env` into this clone.

## Isolated full-stack acceptance after cloning — not executed

Run the following inside that fresh clone, in a subshell. It generates new random
credentials in memory, writes a mode-0600 temporary Compose config, selects a new
project/network, replaces PostgreSQL storage with tmpfs and uses a private bind
directory for the demo key. No existing application volume is mounted or removed.
The only published port is a random loopback backend port. It requires Docker
Compose, Python 3, GNU timeout (Linux/WSL2) and the build above; it does not require
the main stack to exist. The client completion wait is bounded to 180 seconds.

```sh
(
  set -eu
  acceptance_dir="$(mktemp -d /tmp/usage-remote-acceptance-XXXXXX)"
  acceptance_project="$(basename "$acceptance_dir" | tr '[:upper:]' '[:lower:]')"
  export ACCEPTANCE_DIR="$acceptance_dir" COMPOSE_PROJECT_NAME="$acceptance_project"
  export POSTGRES_DB=acceptance POSTGRES_USER=acceptance
  export POSTGRES_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  export PROVISIONING_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  export PORT=0
  python3 <<'PY'
import json, os, pathlib, subprocess
root = pathlib.Path(os.environ['ACCEPTANCE_DIR'])
project = os.environ['COMPOSE_PROJECT_NAME']
config = json.loads(subprocess.check_output(
    ['docker', 'compose', '-f', 'compose.yaml', 'config', '--format', 'json']))
config['name'] = project
config['networks'] = {'default': {'name': project + '_default'}}
config['volumes'] = {}
pg = config['services']['postgres']
pg['volumes'] = []
pg['tmpfs'] = ['/var/lib/postgresql/data']
pg['ports'] = []
config['services']['backend']['ports'] = [
    {'target': 3000, 'published': '0', 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]
secret = root / 'demo-secrets'
secret.mkdir(mode=0o700)
for name in ['backend', 'migrate', 'demo-bootstrap', 'example-client']:
    config['services'][name]['build']['context'] = str(pathlib.Path.cwd())
for name in ['demo-bootstrap', 'example-client']:
    config['services'][name]['volumes'] = [{
        'type': 'bind', 'source': str(secret), 'target': '/run/demo-secrets',
        'read_only': name == 'example-client'}]
assert not config['volumes'] and not pg['volumes']
path = root / 'compose.json'
with path.open('x', opener=lambda p, flags: os.open(p, flags, 0o600)) as out:
    json.dump(config, out)
PY
  export COMPOSE_FILE="$acceptance_dir/compose.json"
  cleanup() {
    # Failure leaves private files for ownership-aware inspection; no broad cleanup.
    docker compose run --rm --no-deps demo-bootstrap node scripts/demo-bootstrap.mjs --clear-only || return
    docker compose down --timeout 10 || return
    case "$acceptance_dir" in
      /tmp/usage-remote-acceptance-*) rm -rf -- "$acceptance_dir" ;;
    esac
  }
  trap cleanup EXIT
  docker compose up --build -d
  client_id="$(docker compose ps -aq example-client)"
  test "$(timeout 180s docker wait "$client_id")" = 0
  for service in migrate demo-bootstrap example-client; do
    service_id="$(docker compose ps -aq "$service")"
    test "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$service_id")" = 'exited 0'
  done
  mapping="$(docker compose port backend 3000)"
  export USAGE_API_BASE_URL="http://127.0.0.1:${mapping##*:}"
  curl -fsS "$USAGE_API_BASE_URL/health"
  curl -fsS "$USAGE_API_BASE_URL/ready"
  npm run test:db:isolated
  npm run test:client:integration
  docker compose logs demo-bootstrap example-client
)
```

Verify the first demo shows account=45, Ahmad=10, Sara=35 and three accepted/two
rejected original decisions, plus the plan-change/replay demonstration. The real
CLI integration separately asserts these totals using its own account. The DB
runner creates/removes only its own test database inside this disposable cluster.
The full stack is built from the remote clone without mounting application source.

Do not run the default Compose configuration or `test:compose:demo` from the
valuable workspace for this check. Keep `COMPOSE_FILE` and project identity scoped
to the disposable subshell. Never print resolved Compose config, environment or
key files. Cleanup above removes only its own containers/network/private files;
no volume deletion or pruning is used. Verify the unique project's containers and
network are gone. If interrupted or cleanup fails, inspect that exact project and
its private path before any manual action. Preserve the clone/logs until reviewed.
This is future disposable acceptance, not a claim it passed in preparation.

After successful acceptance, review GitHub links/diagrams and the exact public
submission URL, obtain the real form/portal link, submit before the stated deadline
and retain the confirmation. Public access and a push do not constitute form
submission or proof of interview readiness.
