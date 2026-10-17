# HTTP API reference

Default local base URL: `http://localhost:3000`. Request bodies use
`Content-Type: application/json`. Examples use invented UUIDs and omitted secrets;
replace IDs with values returned by your own account. Examples describe contracts,
not commands that should be replayed against historical demo accounts.

## Conventions and authentication

- **Account key:** every `/v1` route except account provisioning requires `x-api-key`.
  The backend derives the account from that key; there is no account-selection query parameter.
- **Provisioning token:** `POST /v1/accounts` requires `x-provisioning-token`,
  not an account key. Keep it with a trusted administrator/bootstrap process.
- **Public:** `/health` and `/ready` need neither header.
- UUID path/body IDs must be valid UUIDs. Names are trimmed and must not become blank.
  Account/user names allow 1–200 characters; plan names 1–100.
- JSON numeric inputs are integers, not numeric strings. Fastify type coercion is
  disabled. Documented body schemas reject unknown fields. Query schemas for plans,
  usage and history reject unsupported query keys; account/user basic reads do not
  define equivalent strict query schemas. Validation can precede authentication.
- Plan limits, usage counters and request-history `units` are decimal **strings**
  in responses. Consumption request/response `units` is a bounded JSON number.
  Do not convert large returned counters to JavaScript `Number`; use `BigInt` or strings.
- Current resource representations may show `plan: null` defensively, but the
  migrated database requires assigned account/user plan IDs.
- Expected quota rejection is 429. A valid API key does not imply a request must
  be accepted; both account and user rules apply.

## Route inventory

The inventory contains 20 method/path templates; `scope` is `account` or `user`.
All successful responses are JSON. Path parameters and endpoint-specific query
fields are detailed below. Common errors apply to every protected endpoint.

| Method | Path | Auth | Success | Endpoint-specific expected failures |
|---|---|---|---|---|
| POST | `/v1/accounts` | Provisioning token | 201 account + one-time key | 400 name/body, 401 token, 503 provisioning/default plan unavailable, 500 create failure |
| GET | `/v1/accounts/me` | Account key | 200 account | 401 no authenticated account |
| POST | `/v1/users` | Account key | 201 user | 400 name/body, 503 default plan unavailable, 500 create failure |
| GET | `/v1/users` | Account key | 200 users array | Common errors |
| GET | `/v1/users/:userId` | Account key | 200 user | 400 UUID, 404 unknown/foreign user |
| GET | `/v1/plans` | Account key | 200 visible plans array | 400 invalid scope/query |
| GET | `/v1/plans/:scope/:planId` | Account key | 200 plan | 400 scope/UUID, 404 invisible/missing/wrong-scope plan |
| POST | `/v1/plans/:scope` | Account key | 201 owned plan | 400 body/constraints, 409 duplicate name, 500 create failure |
| PATCH | `/v1/plans/:scope/:planId` | Account key | 200 updated plan | 400 body/constraints, 403 predefined, 404 foreign/missing, 409 duplicate name, 500 update failure |
| PATCH | `/v1/accounts/me/plan` | Account key | 200 assignment | 400 body/constraints, 404 unavailable account plan, 500 assignment failure |
| PATCH | `/v1/users/:userId/plan` | Account key | 200 assignment | 400 body/UUID/constraints, 404 unknown/foreign user or unavailable user plan, 500 assignment failure |
| POST | `/v1/consumptions` | Account key | 200 accepted | 400 body, 404 unknown/foreign user, 409 conflicting ID, 429 quota rejection, 500 processing failure |
| GET | `/v1/usage/account` | Account key | 200 current account usage | 400 unsupported query, 500 read failure |
| GET | `/v1/users/:userId/usage` | Account key | 200 current user usage | 400 UUID/query, 404 unknown/foreign user, 500 read failure |
| GET | `/v1/usage/account/history` | Account key | 200 monthly page | 400 month/range/limit/cursor/query |
| GET | `/v1/users/:userId/usage/history` | Account key | 200 monthly page | 400 UUID/query, 404 unknown/foreign user |
| GET | `/v1/requests` | Account key | 200 decision page | 400 filter/limit/cursor/query |
| GET | `/v1/users/:userId/requests` | Account key | 200 decision page | 400 UUID/query, 404 unknown/foreign user |
| GET | `/health` | Public | 200 liveness | Does not inspect PostgreSQL |
| GET | `/ready` | Public | 200 readiness | 503 when PostgreSQL check fails |

No account/user/plan deletion, API-key rotation/revocation or end-user login route
is implemented. A foreign user's UUID is treated as not found. API responses never
include stored API-key hashes or another account's custom plans/data.

## Account provisioning and information

`POST /v1/accounts` body:

```json
{"name":"Example Company"}
```

201 response (the placeholder below is not a usable credential):

```json
{
  "account": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Example Company",
    "created_at": "2026-10-01T10:00:00.000Z",
    "plan": {
      "id": "33333333-3333-4333-8333-333333333333",
      "name": "Starter",
      "monthly_allowance": "10000",
      "max_units_per_request": "100"
    }
  },
  "api_key": "<returned once; secret omitted>"
}
```

Save the returned raw key privately. `GET /v1/accounts/me` returns the inner account
object, with the current assigned plan, **without** an `api_key` or `account` wrapper.
The backend never returns the key again. Provisioning requires configured server
`PROVISIONING_TOKEN` length at least 32; default Starter must have been seeded.
No body may provide an account plan or API key at creation.

## Users

`POST /v1/users` accepts only `{"name":"Ahmad"}` and assigns predefined Basic.
It returns 201 with this user shape; `GET /v1/users/:userId` returns the same shape
with the current plan:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "name": "Ahmad",
  "created_at": "2026-10-01T10:01:00.000Z",
  "plan": {
    "id": "44444444-4444-4444-8444-444444444444",
    "name": "Basic",
    "monthly_allowance": "1000",
    "max_units_per_request": "20"
  }
}
```

`GET /v1/users` returns `{"users":[...]}` in ascending creation-time/UUID order.
This list is not paginated. User creation/lookup always uses the authenticated
account. Assignment is a separate request, not a creation-body field.

## Plans and assignments

`GET /v1/plans` returns `{"plans":[...]}` containing predefined plans and the
caller's custom plans. Optional `scope=account` or `scope=user` limits the catalog;
omitting it includes account then user plans. Within each scope: predefined first,
then name and UUID ascending. No pagination is implemented here.

`GET /v1/plans/:scope/:planId` returns one visible plan. `POST /v1/plans/:scope`
creates a custom plan in the caller's ownership. Required creation body:

```json
{"name":"Team Allowance","monthly_allowance":20000,"max_units_per_request":100}
```

201 response (also the plan-detail/update response shape):

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "scope": "account",
  "name": "Team Allowance",
  "monthly_allowance": "20000",
  "max_units_per_request": "100",
  "is_predefined": false
}
```

`monthly_allowance`: integer 0–9,000,000,000,000,000.
`max_units_per_request`: integer 1–1,000,000. Both are required on creation.
`PATCH /v1/plans/:scope/:planId` accepts one or more of `name`,
`monthly_allowance`, `max_units_per_request`; omitted fields retain their values.
Empty/unknown-field objects and numeric strings are invalid. For example:

```json
{"monthly_allowance":25000}
```

Ownership and predefined status cannot be set or changed through these bodies.
A duplicate custom name within one account and scope yields 409; a predefined
plan update yields 403; a foreign custom plan yields 404. Editing a shared owned
user plan affects future new decisions for all users assigned to it, without
combining or resetting their counters.

Assign an applicable predefined or owned plan using either endpoint:

- `PATCH /v1/accounts/me/plan`
- `PATCH /v1/users/:userId/plan`

Both require exactly `{"plan_id":"55555555-5555-4555-8555-555555555555"}` with
a plan ID from the matching scope. The account assignment returns:

```json
{
  "account_id": "11111111-1111-4111-8111-111111111111",
  "plan": {
    "id": "55555555-5555-4555-8555-555555555555",
    "scope": "account",
    "name": "Team Allowance",
    "monthly_allowance": "20000",
    "max_units_per_request": "100",
    "is_predefined": false
  }
}
```

User assignment uses `user_id` instead of `account_id` and a `scope: "user"`
plan. Limits/usage are not reset. A wrong-scope, foreign or absent plan is 404;
a foreign/absent user is 404. See [locking and plan-change coordination](architecture.md).

## Consumption and retries

`POST /v1/consumptions` accepts exactly:

```json
{
  "user_id": "22222222-2222-4222-8222-222222222222",
  "units": 10,
  "request_id": "example-action-001"
}
```

`units` is an integer 1–1,000,000. `request_id` is a nonblank string of 1–200
characters, retained as supplied, case-sensitive and unique **within the account**.
`user_id` must belong to that account for a new decision. There is no client-supplied
month or account selector. Account and user per-request and monthly checks all apply.

A first accepted request on Starter/Basic returns 200:

```json
{
  "status": "accepted",
  "request_id": "example-action-001",
  "user_id": "22222222-2222-4222-8222-222222222222",
  "units": 10,
  "usage_month": "2026-10-01",
  "account": {"used_units":"10","monthly_allowance":"10000","remaining_units":"9990"},
  "user": {"used_units":"10","monthly_allowance":"1000","remaining_units":"990"},
  "failed_rules": []
}
```

A new 25-unit request for that Basic user after this acceptance returns 429:

```json
{
  "status": "rejected",
  "request_id": "example-action-002",
  "user_id": "22222222-2222-4222-8222-222222222222",
  "units": 25,
  "usage_month": "2026-10-01",
  "account": {"used_units":"10","monthly_allowance":"10000","remaining_units":"9990"},
  "user": {"used_units":"10","monthly_allowance":"1000","remaining_units":"990"},
  "failed_rules": [
    {"level":"user","rule":"max_units_per_request","message":"Requested units exceed the user plan maximum of 20"}
  ]
}
```

Other rule names/levels are `monthly_allowance` and `account`. Multiple failures
can be returned. These are understandable quota decisions with saved history;
validation/authentication/not-found/conflict/infrastructure failures do not create
new quota-decision records. Rejection may create zero month rows but charges zero.

Repeat the same account/request ID, same user UUID and units to get the stored
HTTP status/body plus `Idempotency-Replayed: true`. This applies to 200 and 429,
after plan edits, user-plan changes and UTC month changes. The replay does not
reflect current remaining allowance; query current usage separately. Reusing an
ID with different user/units returns 409:

```json
{"error":"request_id was already used with different parameters"}
```

After a lost response or infrastructure failure, retry the same ID to resolve a
possibly committed original request. Use a new ID for a new intended action;
retrying a saved quota rejection will not re-evaluate it after an upgrade.

## Current and historical usage

`GET /v1/usage/account` and `GET /v1/users/:userId/usage` take no query parameters.
They return 200 with current UTC month, current assigned plan, counters and
remaining allowance. Example user response after 10 Basic units:

```json
{
  "month": "2026-10-01",
  "plan": {
    "id":"44444444-4444-4444-8444-444444444444",
    "name":"Basic","monthly_allowance":"1000","max_units_per_request":"20"
  },
  "used_units":"10",
  "remaining_units":"990"
}
```

The account endpoint has the same shape with account limits/totals. Missing current
rows read as zero; these reads do not initialize counters. Remaining allowance
cannot be negative and past consumption is preserved after plan changes.

`GET /v1/usage/account/history` and `GET /v1/users/:userId/usage/history` accept:

| Query | Meaning |
|---|---|
| `from_month` | Optional inclusive lower bound, valid `YYYY-MM`, year greater than zero |
| `to_month` | Optional inclusive upper bound, valid `YYYY-MM`; must not precede lower bound |
| `limit` | Default 20, integer text 1–100, no leading zeros |
| `cursor` | Server-returned monthly cursor, described below |

Example: `/v1/usage/account/history?from_month=2026-01&to_month=2026-10&limit=20`.
The account response uses `account_id`; the user response uses `user_id`:

```json
{
  "account_id":"11111111-1111-4111-8111-111111111111",
  "history":[{"month":"2026-10","used_units":"10"}],
  "pagination":{"limit":20,"next_cursor":null}
}
```

Only existing monthly rows appear, newest first, including zero rows created by
rejected first requests. Months with no stored row are omitted. Historical monthly
pages do not include historical plan limits; decision history supplies per-request snapshots.

## Request decision history

`GET /v1/requests` selects the authenticated account; `GET /v1/users/:userId/requests`
selects its owned user. Optional queries: `status=accepted` or `status=rejected`,
`limit` (default 20, 1–100, no leading zeros), `cursor` (server-returned).
There is no request-history month filter or single-request lookup endpoint.

Both return `history` and `pagination`; the outer ID is `account_id` or `user_id`:

```json
{
  "account_id":"11111111-1111-4111-8111-111111111111",
  "history":[
    {
      "id":"66666666-6666-4666-8666-666666666666",
      "request_id":"example-action-001",
      "user_id":"22222222-2222-4222-8222-222222222222",
      "units":"10",
      "status":"accepted",
      "rejection_reasons":[],
      "failed_rule_levels":[],
      "failed_rules":[],
      "account_plan":{"id":"33333333-3333-4333-8333-333333333333","name":"Starter","monthly_allowance":"10000","max_units_per_request":"100"},
      "user_plan":{"id":"44444444-4444-4444-8444-444444444444","name":"Basic","monthly_allowance":"1000","max_units_per_request":"20"},
      "usage_month":"2026-10-01",
      "created_at":"2026-10-01T10:02:00.123456Z",
      "response_status":200
    }
  ],
  "pagination":{"limit":20,"next_cursor":null}
}
```

Rejected entries preserve detailed failure objects and unique failed levels,
e.g. `rejection_reasons`/`failed_rules` contain the failed-rule objects and
`failed_rule_levels` contains `"user"`, `"account"` or both. Plan names/limits are
snapshots at processing time. History does not expose the complete stored response
body or API-key hashes. A replay creates no additional history item.

## Pagination

When `pagination.next_cursor` is non-null, send that exact string as `cursor` to
the same endpoint with the same filters. `next_cursor: null` means no further
page was found. Both histories use keyset pagination (continue after a key), not
numeric offsets. Pages are separate reads, not one cross-page database snapshot.

- **Monthly history:** descending month, cursor is canonical base64url of
  `YYYY-MM` (maximum 16 characters). It supplies an exclusive older-month bound;
  ownership/range predicates are always enforced. This cursor is not bound to
  account/user/filter context; reusing it changes only the page boundary.
- **Decision history:** descending `(created_at, id)`, preserving six timestamp
  fractional digits. Canonical base64url cursor (maximum 1024 characters) encodes
  version, account/user scope, account ID, optional user/status, timestamp and UUID.
  A mismatch with endpoint/account/user/status returns 400. Changing the page
  limit is allowed; changing the status filter requires starting a new traversal.

Cursors are encoded, not signed or encrypted. Treat them as opaque, do not
construct them, and do not mistake them for authentication tokens. SQL ownership
checks remain necessary regardless of cursor contents. Unsupported query fields
and malformed months/limits/cursors yield 400.

## Health, readiness and error responses

`GET /health` always answers `200 {"status":"ok"}` while the handler is reachable;
it is liveness, not a database test. `GET /ready` performs `SELECT 1`: success is
`200 {"status":"ready"}`, failure is `503 {"status":"unavailable"}`.

Common valid-request authentication failure is 401:

```json
{"error":"Missing or invalid API key"}
```

Application-defined errors use `{"error":"..."}`. Schema validation errors are
Fastify 400 responses, for example this sanitized envelope (message wording can
vary with the violated schema):

```json
{"statusCode":400,"error":"Bad Request","message":"body must have required property 'user_id'"}
```

Unhandled 5xx errors retain HTTP status and standard fields, with a generic message:

```json
{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}
```

Explicit operational errors keep their existing small bodies, such as
`500 {"error":"Unable to process consumption request"}`. Other operation failures
use the route-specific create/update/assignment/read messages in source. Readiness
and provisioning 503 responses are explicit contracts too. Do not assume every
500/503 uses one universal envelope. Server logs omit raw SQL/internal PostgreSQL
messages and credentials from the global HTTP error handler; safe status/request
ID/SQLSTATE metadata remains. Error handling is not a complete production security policy.
