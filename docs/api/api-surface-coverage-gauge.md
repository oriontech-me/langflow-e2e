# API surface coverage gauge — scope, denominator and detection

**Last validated:** Langflow 1.13.x (`1.13.0.dev0` and `1.13.0.dev1`)

Owning issue: #1692 (Wave 7 — OSS API coverage). This document is the standing
answer to *"how much of the OSS REST API do we cover?"*, so the denominator stops
being re-decided per family — the role `docs/component-distribution-policy.md`
plays for component availability.

---

## What this validates *(required)*

The gauge itself, pinned behaviourally by `tests/fixtures/api-coverage-gate.spec.ts`
and by unit tests on its pure functions. Three claims:

1. The **denominator** is the instance's own route table, not `/openapi.json`.
2. A spec's **declaration** of what it covers is verified against what it actually
   requested — a declared-but-uncalled operation fails the test.
3. Every path that cannot produce a verdict says so, naming the cause. An
   unreadable baseline, an unresolvable route table and a `200` carrying no routes
   are `UNKNOWN`, never a clean 100 %.

---

## Why `/openapi.json` is not the denominator

Measured on `langflowai/langflow-nightly:latest` — `1.13.0.dev0` (port 7860) and
`1.13.0.dev1` (port 7880). Both serve an identical schema, so this is the image's
behaviour and not one container's state.

| Source | Operations (method + path) |
|---|---|
| `GET /openapi.json` | 86 paths / **120** |
| The instance's router table | 287 raw → **254** after collapsing duplicate-registration pairs |
| … present in the schema | 117 |
| … **hidden** (`include_in_schema=False`) | **137** |

Routes that are alive and absent from the schema. Unauthenticated `403`/`422`/`401`
proves the route exists; a path that does **not** exist answers `404` on `GET` (the
SPA catch-all) and `405` on `POST`, so the two are distinguishable without a token:

| Route | Unauthenticated answer |
|---|---|
| `POST /api/v1/login` | `422` |
| `POST /api/v1/refresh` | `401` |
| `GET /api/v1/api_key/` | `403` |
| `GET /api/v1/variables/` | `403` |
| `POST /api/v1/custom_component` | `403` |
| `POST /api/v1/validate/{code,prompt}` | `403` |
| `GET /api/v1/knowledge_bases/` | `403` |
| `GET /api/v1/memories/` | `403` |
| `GET /api/v1/models/providers` | `403` |
| `GET /api/v1/mcp/sse` | `403` |

Three of those families are already driven by existing specs (`variables`,
`api_key`, `custom_component`), so a schema-derived gauge would report 100 % with
tests this suite already has sitting outside the denominator.

### The walk has to reach the app-level routers too

`langflow.api.router.router` is not the whole app. The **health** and **log**
routers are mounted directly on the application, so a walk of `router` alone
misses `GET /health`, `/health_check`, `/healthz`, `/logs` and `/logs-stream` —
five operations `/openapi.json` *does* expose. Found by this gate on its first
real run, which reported them as phantom additions; the invariant that catches it
now lives in the unit tests: **every operation the schema exposes must be present
in the baseline**, so a router the walk never reached fails the refresh instead of
warning on every run afterwards.

### Reading the route table is not a `for` loop

FastAPI defers included routers. `langflow.api.router.router.routes` holds **2**
entries, both `fastapi.routing._IncludedRouter`, with `methods=None` and `path=None`
— a naive read reports **0 operations**, which is indistinguishable from a broken
import and would read as a clean 0/0. The extraction recurses through
`_IncludedRouter.original_router`, accumulating `include_context.prefix`, and a
resolution it cannot complete is a named failure, never an empty inventory.

### A trailing slash is not always an alias — measured

The obvious normalisation (strip the trailing slash) is **wrong**, and the pilot
family is where it breaks. `POST /api/v2/files/batch/` is registered *only* with the
slash; without it the request falls through to `/api/v2/files/{file_id}`:

| Request | Answer |
|---|---|
| `POST /api/v2/files/batch/` | `200`, `application/x-zip-compressed` |
| `POST /api/v2/files/batch` | `405 Method Not Allowed` |
| `DELETE /api/v2/files/batch` | `422` `uuid_parsing`, `loc: ["path","file_id"]`, `input: "batch"` |

So the canonical key keeps the **registered spelling**, and two forms collapse into
one operation only when the router registered both (which is the common case, e.g.
`/api/v2/files` and `/api/v2/files/`). Normalising by `rstrip("/")` would emit a key
no client can call.

The same collapse is applied to the **live** side of the comparison, and that half
is not symmetry for its own sake: `/openapi.json` exposes both `/api/v2/files` and
`/api/v2/files/`, so comparing a collapsed baseline against an uncollapsed schema
reported the twin as `ADDED` on a surface that had not changed — a drift warning
firing on every run, which is the noise #1084 was raised about. Found by the gate
on its first real run, and pinned by a unit test that also checks the collapse does
**not** swallow a genuinely new slash-only route.

### The inventory does not over-report — verified, not assumed

All **50** parameter-free in-scope `GET` operations answer `403` (43), `200` (6) or
`307` (1). **Zero** `404`. The liveness probe is part of the baseline refresh for
that reason: it is what distinguishes a route the package registers from one the
build actually serves, and it is cheap.

---

## Definitions

- **Covered** — an `@api` spec drives the operation **on purpose** and asserts the
  status **and** the body shape (its key fields). Incidental traffic a UI spec's
  page happens to emit does not count; neither does a mention in a spec doc. The
  gap between that and any grep-based proxy is the reason the gauge exists: a
  count of "the path appears somewhere under `tests/`" put ~123 of the then-199
  operations in the covered column when the issue was filed, while the measured
  figure after the pilot — the first honest one — is **15 / 204**. The proxy was
  only ever used to *size* the work, and it is not the definition.
- **Denominator** — the route table, keyed by `METHOD path`, with the scope
  exclusions below applied from a declared list carrying a reason per family, and
  committed as `tests/assets/api/api-surface-baseline.json`. Refreshed by
  `npm run api:baseline`, whose diff is **committed on purpose**: a self-updating
  baseline makes every surface change invisible exactly once.
- **Detection** — the spec declares the operations it covers; the fixture records
  the requests it actually issued; a declared operation the spec never called
  **fails the test**, naming it. Verified in both directions for the reason
  `page.expectKnownHttpError()` is: a declaration whose justification expired
  silently is the failure #1084 was raised about, and a printed warning would be
  one more line nobody reads.

---

## Scope

**204 operations in scope** — 114 in the schema, 90 hidden. Excluded: 50, each with
a reason that is not "hard".

| Excluded | Ops | Why |
|---|---|---|
| `authz/*` | 24 | The OSS authorization service is pass-through (`enforce()` returns True and logs that it did), so an assertion here would assert nothing. The `@enterprise` lane already drives these paths against an instance that enforces. |
| `store/*` | 9 | The Langflow Store is an external service, unreachable in CI — already a documented exemption in `tests/fixtures/http-error-policy.ts`. Covering it would mean asserting a mock. |
| `agentic/*` | 10 | AI-assist: needs a live provider plus its own flag, and every assertion would depend on the model electing to act — the opposite of the `any-completion` tier (#1187). |
| `predict`, `process`, `task`, `upload` | 4 | Deprecation stubs. `GET /api/v1/task/x` answers `400` `"The /task endpoint is deprecated and will be removed in a future version. Please use /run instead."` |
| `voice/*`, `extensions/*` | 3 | A WebSocket / ElevenLabs surface, and a plugin SSE channel. |

Exclusions live in the inventory script as data with a `reason` per family, so the
report can print them. A family added to the router with no classification is
reported, not silently dropped — the rule `--mode=check` already applies to the
`lfx` subtrees in `scripts/watch-upstream-areas.mjs`.

---

## Mechanism

Mirrors the component-catalog machinery one-for-one, because that mechanism is
already trusted here and its failure modes are already understood (#1040, #980,
#1012):

| Piece | This gauge | Catalog precedent |
|---|---|---|
| Snapshot | `tests/helpers/other/api-surface-drift.ts` | `component-catalog-drift.ts` |
| Committed baseline | `tests/assets/api/api-surface-baseline.json` | `tests/assets/catalog/component-catalog-baseline.json` |
| Refresh command | `npm run api:baseline` | `npm run catalog:baseline` |
| Verdict at the gate | reported in `tests/globalSetup.ts` | same file, beside it |
| Unit coverage | `npm run test:units` | same |

The verdict is a **pure function that cannot throw** — `globalSetup` holds only
I/O. That layering is what made the catalog guarantee testable instead of asserted,
and the lesson it cost is recorded in `CLAUDE.md`: the first version compared
outside both try blocks and aborted a whole run with `TypeError` on a hand-repaired
baseline.

It **warns, never fails**: a new route costs nobody a test, and a removed one is
legitimate when the image dropped a surface we do not test. What it must never do
is read as clean without a verdict.

Coverage is written per test (one file per test id, so workers do not contend) into
`.api-coverage/`, and aggregated by `npm run api:coverage`, which prints
`covered / 204` per family **and names the uncovered operations** — a bare
percentage hides which ones, the lesson `reports/spec-durations.json` paid for
(#1326).

**The records live outside `test-results/` on purpose, and it is not a preference.**
Playwright wipes its output directory at the start of every run, and the
`@destructive` lane is by definition a *second* run: with the records under
`test-results/`, the destructive pass deleted the normal pass's records and the
report read **3/204** where the truth was **15**. Measured, then fixed. Surviving
records need the opposite guard, so the report drops any whose spec file no longer
exists — naming them, because a number that falls with no explanation is the
report shape #1012 forbids — and `npm run api:coverage -- --reset` clears them.

Only records from `tests/tests-automations/` count. `tests/fixtures/
api-coverage-gate.spec.ts` declares real operation keys and issues them against a
**local stub server**; on the report's first run it credited three operations while
asserting nothing about Langflow. A fixture gate spec is a self-test of the
harness, and the harness cannot be evidence about the product.

---

## Validation criterion *(required)*

- The baseline reproduces byte-identically from a running nightly, twice in a row
  (it carries no timestamp for exactly this reason).
- `npm run api:coverage` prints `files 15/15` once the pilot lands, and the total
  over the in-scope set with every uncovered operation named.
- A spec that declares an operation it does not call **fails**, with the operation
  named — asserted by `tests/fixtures/api-coverage-gate.spec.ts`, not by a comment.
- An unreadable baseline, a malformed one, a failed extraction and a `200` carrying
  no routes each report `UNKNOWN` with the cause named.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL` (auto-login or a
  superuser), for the schema half and the liveness probe.
- **Container access for the baseline refresh only.** The hidden half of the route
  table is not reachable over HTTP, so `npm run api:baseline` reads it out of the
  instance's own process (`docker exec … python`), which is why the baseline is
  committed and the *run-time* verdict never needs the container. A refresh that
  cannot reach it refuses rather than writing a schema-only baseline — that would
  silently shrink the denominator by 90 operations.
- Upstream router assembly: `src/backend/base/langflow/api/router.py`.
- Upstream route definitions for the pilot family:
  `src/backend/base/langflow/api/v1/files.py`,
  `src/backend/base/langflow/api/v2/files.py`.
