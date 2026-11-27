# Workflows v2 — the request-level variable transport

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2570)

---

## What this test validates *(required)*

Validates how a caller passes **request-level global variables** to `POST /api/v2/workflows`, now that upstream
[#16350](https://github.com/langflow-ai/langflow/pull/16350) took the v2 Workflow API to GA.

Before GA, a caller could override a stored global variable for one request with an
`X-LANGFLOW-GLOBAL-VAR-<NAME>` header. GA freezes the JSON body's `globals` as the only transport. Dropping the
header merge silently would have been dangerous: nothing on the v2 path reads the prefix any more, so a caller
who believes they are overriding a credential per request would run against the flow owner's **stored** key with
no signal. So the router now **refuses** the header instead.

Four contracts, all measured on `1.14.0.dev39`:

1. **The header is refused in every mode.** `mode: "sync"`, `"stream"` and `"background"` all answer `400` with
   `detail.code == "LEGACY_GLOBAL_VAR_HEADER"` and the exact message below. The wire spelling of the header
   name does not matter (HTTP normalises it before the guard sees it), and the guard runs **before body
   validation**: an invalid body that answers `422` without
   the header answers `400` with it. Nothing runs.
2. **Body `globals` replace the stored variable in sync mode.** A flow whose Chat Input reads a stored global
   variable returns the stored value without `globals` and the request's sentinel with them.
3. **Stream and background refuse body `globals`.** The issue assumed they would ignore them (the schema says
   "applied in sync mode"). Measured: they **refuse** with `422`, `detail.code == "MODE_UNSUPPORTED_FIELDS"`,
   `detail.fields == ["globals"]`. The same request without `globals` is accepted, so the refusal is about the
   field and not the mode.
4. **v1 is unchanged.** `POST /api/v1/run/{flow_id}` still honours the `X-LANGFLOW-GLOBAL-VAR-<NAME>` header: the
   run returns the header's sentinel, and the stored value without it. This pins the boundary between the two
   APIs, so a caller migrating from v1 knows exactly what changes.

The exact `400` body (`detail`):

```json
{
  "error": "Legacy header transport not supported",
  "code": "LEGACY_GLOBAL_VAR_HEADER",
  "message": "The X-LANGFLOW-GLOBAL-VAR-* header transport is no longer supported on the v2 workflow API. Pass request-level variables in the JSON body under \"globals\" (applied in sync mode only) instead."
}
```

---

## Tags *(required)*

`@stable` `@api` `@regression`

No **functional** tag applies, following the `api/flows/` family (`workflows-v2-job-lifecycle.spec.ts`,
`api-run-with-tweaks`, `api-run-flow`): the functional axis names product areas, and this is the transport layer
under all of them. `@regression` because every test pins a specific upstream change (#16350). Keyless and fast
(no provider), so every test is `@stable`.

---

## Step by step *(required)*

**Setup (`beforeAll`).** Mint a bearer token (`getAuthToken`) and an API key (`createApiKey`, for v1, which
answers `403` to a bearer token under `AUTO_LOGIN`). Create a uniquely named `Generic` global variable whose
stored value is a per-run `stored-…` string. Create a flow from `tests/assets/flows/chat-io-ok-trace-fixture.json`
(Chat Input → Chat Output, which echoes its input) with the Chat Input's `input_value` set to the variable's name
and `load_from_db: true`, so the run's output is whatever value the variable resolves to. No request sends
`input_value`, so nothing else can reach the output.

**Test 1 — the legacy header is refused in every mode, before the body is validated.**

1. For each of `sync`, `stream` and `background`: `POST /api/v2/workflows` with a valid body for that mode and
   `X-LANGFLOW-GLOBAL-VAR-<NAME>: <sentinel>` → `400` with exactly the `detail` above.
2. The same with the header name spelled in lower case → the same `400` and `detail.code`. This is not a
   case-sensitivity check (the server sees header names lower-cased either way); it pins that a caller's
   spelling does not slip past the guard.
3. A body with an unknown field and **no** header → `422` (`extra_forbidden`); the same body **with** the header
   → `400` `LEGACY_GLOBAL_VAR_HEADER`. This is the ordering the issue states.
4. Every refused request of steps 1–2 carried its own `session_id`; `GET /api/v1/monitor/messages?session_id=…`
   returns no message for any of them, read repeatedly for 3 s, so nothing ran. The window covers a background
   job, which writes its messages asynchronously after the submit returns (about 0.1 s measured). The
   invalid-body session of step 3 can never run, so it is not part of this check.

**Test 2 — body globals replace the stored variable in sync mode.**

1. `POST /api/v2/workflows` (`mode: "sync"`, no `globals`) → `200`, the Chat Output content is the stored value.
   This is the control: it proves the flow reads the variable, so the next step cannot pass on an echo of
   something else.
2. The same with `globals: { <NAME>: <sentinel> }` → `200`, the content is the sentinel, never the stored value.

**Test 3 — stream and background refuse body globals.**

1. For each of `stream` and `background`: the request with `globals` → `422`,
   `detail.code == "MODE_UNSUPPORTED_FIELDS"`, `detail.fields == ["globals"]`.
2. The same request without `globals` → accepted (`stream` answers `200`; `background` answers with a `job_id`,
   and the step waits for that job to report `completed`, so teardown never deletes the flow under it), so the
   refusal is about the field.

**Test 4 — v1 still honours the header.**

1. `POST /api/v1/run/{flow_id}` with the API key and `X-LANGFLOW-GLOBAL-VAR-<NAME>: <sentinel>` → `200`, the
   output message text is the sentinel.
2. The same without the header → `200`, the text is the stored value.

**Teardown (`afterAll`).** Delete the flow, the variable and the API key, id-scoped.

---

## Validation criterion *(required)*

- **Header refused:** each mode answers `400` with the exact `detail` (error, code and message compared as a
  whole), and no message appears for the refused sessions within 3 s. A build that drops the guard answers
  `200`/`422` and fails the status assertion; a build that answers `400` but still runs the flow leaves
  messages and fails the last step.
- **Sync globals:** the control returns the stored value **and** the overridden run returns the sentinel. Either
  half alone could pass on a broken flow; together they pin the override.
- **Stream/background:** the `422` and its `code`/`fields` with `globals`, and acceptance without. If upstream
  starts ignoring the field instead, the `422` assertion fails, and the doc must then say what the run used.
- **v1:** the sentinel with the header and the stored value without it. If v1 drops the header too, Test 4 fails,
  which is the signal to update this boundary.

Sentinels and the stored value are unique per run, so no other worker's variable or flow can satisfy an
assertion.

---

## Measured facts and notes

- Measured on `1.14.0.dev39` with direct API calls before the spec was written.
- **The guard also runs before authentication:** an unauthenticated request with the header answers `400`, and
  without it `403`. Not asserted (an auth-first reordering would be legitimate), only recorded.
- A `globals` entry with an empty string value overrides the stored value with `""` (measured, not asserted).
- **Key case differs between the APIs** (measured, not asserted): v2 `globals` keys match the variable name
  exactly, so a lower-cased key does not override an upper-case variable; v1 upper-cases what follows the
  header prefix. A caller migrating from the header to `globals` must send the variable's exact name. The spec
  keeps its variable name upper-case for that reason.
- `stream` and `background` are chosen by the body's `mode`; top-level `stream`/`background` booleans are
  refused as `extra_forbidden`.
- *Read from code, not measured:* the v2 run path also refuses body `globals` from a **non-owner** on a shared
  flow that holds the owner's hidden credentials (`400`, *"Cannot override variables in a shared flow using its
  owner's hidden credentials."*, `workflow_execution.py`). Not covered: it needs a second user and a shared flow.

---

## What this test does not cover *(and why)*

- The shared-flow refusal above (needs a second account and a share; a candidate for the multi-user family).
- Which components resolve request variables beyond a `load_from_db` text field: the transport is the contract
  here, not every field type.
- The job lifecycle itself: `workflows-v2-job-lifecycle.spec.ts`.

---

## Preconditions *(required)*

- A running Langflow `1.14.0.dev27` or later (the guard ships with #16350, first in `v1.14.0.dev27`). No provider
  key is needed.
- The default superuser under `AUTO_LOGIN` (bearer token for v2, an API key minted by the spec for v1).

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v2/workflow.py` — `reject_legacy_global_var_headers`, the `400` guard and its body
- `src/backend/base/langflow/api/router.py` — injects the guard on the shared v2 run router, so every mode rejects
- `src/backend/base/langflow/api/v2/workflow_execution.py` — turns body `globals` into the run's `request_variables` (sync)
- `src/backend/base/langflow/api/v2/workflow_validation.py` — the `422` `MODE_UNSUPPORTED_FIELDS` refusal of `globals` outside sync
- `src/lfx/src/lfx/schema/workflow.py` — the request schema: `globals`, `mode`, `extra="forbid"`
- `src/backend/base/langflow/utils/constants.py` — `LANGFLOW_GLOBAL_VAR_HEADER_PREFIX`, matched case-insensitively
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — the Chat Input → Chat Output echo flow
- `tests/helpers/auth/create-api-key.ts` — the API key v1 needs under `AUTO_LOGIN`
- `GET /api/v1/monitor/messages` — proves a refused request ran nothing
