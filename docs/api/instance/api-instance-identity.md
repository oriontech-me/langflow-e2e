# API Instance — identity, configuration and health (`/health*`, `version`, `config`, `all`, `starter-projects`, `logs*`)

**File:** `tests/tests-automations/regression/api/instance/api-instance-identity.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev2`)

Owning issue: #1710 (Wave 7 — OSS API coverage, the single-operation tail). Gauge,
definitions and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Nine operations that are each their own route group — the reason #1710 batches them
instead of filing nine issues. Two of them (`GET /api/v1/version`, `GET /health_check`)
are already driven by `api/flows/api-version.spec.ts` and `api/flows/api-health-check.spec.ts`
and are covered there by adoption; this file owns the other seven and the properties
that only show when they are compared with each other.

Measured on `1.13.0.dev2`:

| Operation | Answer |
|---|---|
| `GET /health` | `200 {"status": …}` — one key |
| `GET /health_check` | `200 {"chat", "db", "status"}` |
| `GET /healthz` | `200` and **byte-identical to `/health_check`** — the two are the same probe, `/health` is a shallower one |
| `GET /api/v1/version` | `200 {"main_version", "package", "version"}`, **no credential needed** |
| `GET /api/v1/config` **unauthenticated** | `200`, `type: "public"`, **12 keys** — feature flags only |
| `GET /api/v1/config` **with a credential** | `200`, `type: "full"`, **35 keys** — adds `blocked_component_types`, `custom_component_admin_only`, `webhook_auth_enable`, the `hide_*` flags, `public_flow_*`, `auto_saving*`, … |
| `GET /api/v1/all` | `403` unauthenticated; `200` with a token — ~515 KB, **gzipped**, 30 top-level keys |
| `GET /api/v1/starter-projects/` | `403` unauthenticated; `200` with a token — a list of starter flows (5 on this image) |
| `GET /logs` | **`501 {"detail":"Log retrieval is disabled"}`** with a valid token; `403` without one |
| `GET /logs-stream` | **`501`, the same body** — so the SSE hazard #1710 raised does not arise on a default instance |

**Three properties worth the test, none of which a single-endpoint check would show.**

1. **`/healthz` and `/health_check` are twins, `/health` is not.** A change that made
   `/healthz` shallow would silently weaken every CI health gate that polls it
   (`.github/actions/wait-for-backend` polls `/api/v1/version`, but the container
   healthcheck and several docs use `/health_check`).
2. **`version` and `config` answer unauthenticated — but `config` answers a DIFFERENT
   BODY, and says which one it gave you.** Measured: anonymous gets `type: "public"`
   with 12 keys, a credential gets `type: "full"` with 35. That variant is the
   contract: a regression serving the full body anonymously would leak operational
   settings (`blocked_component_types`, `webhook_auth_enable`, `mcp_base_url`, the
   `hide_*` flags). The spec asserts the public key set is a **strict subset** of the
   full one and **names** five keys that must stay withheld — named rather than
   counted, since a count passes the day one key leaks and another is dropped. The
   flag **values** are never asserted: `allow_custom_components` and the governance
   flags differ per lane by design (#668, #1240). `version`, by contrast, is
   credential-blind — asserted by comparing both answers, which is the contrast that
   gives the `config` assertion meaning.
3. **Log retrieval is off by default, and that is a flag, not a defect.**
   `LANGFLOW_LOG_RETRIEVER_BUFFER_SIZE` defaults to `0` and the buffer reports itself
   disabled (`max > 0` is the whole test), so both log routes answer `501`. The
   assertion is the `501` **plus** the `403` for the credential-less call, which is the
   pair that says "not public, and not enabled".

Two traps encoded from the catalog side: `/api/v1/all` is keyed by **display name**
(`models_and_agents["Prompt Template"]`, not `Prompt`), and `component_display_names`
is a **metadata map, not a category** — the same trap `component-catalog-drift.ts`
documents (#1040). This file asserts the operation's contract, never the catalog's
content: the drift guard in `globalSetup` already owns that.

---

## Tags *(required)*

`@api` `@settings` `@stable`

`@stable`: read-only, keyless, no run, and no assertion depends on a lane's flag values.

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`. Nothing is
created, so there is nothing to clean up. The unauthenticated calls use a **separate
request context with no `Authorization` header** rather than the shared token.

**Test 1 — `the three health routes are not synonyms`**
1. `GET /health` → `200`, its key set is exactly `["status"]`.
2. `GET /health_check` → `200 {chat, db, status}`.
3. `GET /healthz` → `200` and **deep-equal** to `/health_check`'s body.

**Test 2 — `version and config answer unauthenticated, all and starter-projects do not`**
1. `GET /api/v1/version` **without** a credential → `200`, exactly
   `{main_version, package, version}`, `package` a non-empty string; the same call
   **with** a credential answers a deep-equal body.
2. `GET /api/v1/config` without a credential → `200`, `type: "public"`; with a
   credential → `200`, `type: "full"`; every public key is present in the full body,
   the full body is strictly larger, and `blocked_component_types`,
   `custom_component_admin_only`, `webhook_auth_enable`, `hide_logout_button` and
   `auto_saving` are present in the full body and **absent** from the public one. No
   flag value is asserted.
3. `GET /api/v1/all` without a credential → `403`; with the token → `200`, an object
   whose keys include a category this suite depends on, and whose
   `component_display_names` is present but treated as metadata (asserted to be an
   object, never counted as a category).
4. `GET /api/v1/starter-projects/` without a credential → `403`; with the token →
   `200`, a non-empty list whose rows carry `name` and `data` — the count is **not**
   asserted (image-dependent).

**Test 3 — `log retrieval is disabled by default, and not public either`**
1. `GET /logs` and `GET /logs-stream` **without** a credential → `403` each.
2. Both **with** the token → `501`, `detail === "Log retrieval is disabled"`.
3. The `501` is asserted with the flag named in the failure message, so an instance
   that *does* enable the buffer fails here loudly and gets the second branch written
   rather than silently asserting the wrong thing.

---

## Validation criterion *(required)*

The three tests pass three consecutive times at `--retries=0 --workers=1`, with
`/healthz` asserted as **deep-equal** to `/health_check` (not merely `200`), `config`
asserted on its key set and never on a flag's value, the two `403`s issued from a
context that carries no token, and the declared coverage — the nine operations —
matching what the fixture recorded. No `logs-stream` request is left open: both log
calls answer `501` immediately on a default instance, and the assertion is bounded by
the request's own timeout regardless.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/health_check_router.py` — `/health`, `/health_check`, `/healthz`.
- `src/backend/base/langflow/api/log_router.py` — `/logs` and `/logs-stream`, and the
  `501` when the buffer is disabled.
- `src/backend/base/langflow/api/v1/endpoints.py` — `version`, `config`, `all`.
- `src/backend/base/langflow/api/v1/starter_projects.py` — the starter list.
- No provider key, no model, no network egress.
