# Flow Functionality — Flow Rename via Header

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that a flow can be renamed via the **editor header** in two complementary ways:

1. **UI test:** Opens a blank flow, clicks the `flow_name` header, types a new name in the rename modal, saves, and asserts the header DOM commits the new name.
2. **API test:** Creates a flow via `POST /api/v1/flows/`, renames via `PATCH /api/v1/flows/{id}`, and confirms via `GET /api/v1/flows/{id}` that the new name persisted server-side, with cleanup via `DELETE`.

The pair gives us both **interaction-level** coverage (the rename modal commits to React state and DOM) and **persistence-level** coverage (the PATCH round-trip is durable in the database). If either breaks, users either lose the ability to rename a flow from the editor or the rename silently fails to persist after refresh.

---

## Tags *(required)*

UI test: `@release` `@workspace` `@stable`
API test: `@release` `@workspace` `@api` `@stable`

---

## Step by step *(required)*

### UI test — `flow can be renamed via the header edit`

0. Capture every flow this test creates — the bootstrap flow and the blank flow —
   by id from their `POST /api/v1/flows` → 201 responses (`trackCreatedFlows`),
   and delete them id-scoped in `afterEach`. Id-scoped, never a name or wipe
   sweep, which would kill flows other parallel workers are driving (#553).
   Added in #1154: this test leaked one flow per run, and accumulated flows are
   what make another worker's residual card overlap a target's absolute-inset
   `list-card-open-button` and swallow a hit-tested click (#580/#588).
1. Bootstrap the app and wait for the `blank-flow` card
2. Click `blank-flow` to enter the editor; wait for `sidebar-search-input` to confirm the canvas loaded
3. Generate a unique name `My Renamed Flow ${Date.now()}` and call `renameFlow(page, { flowName })` (helper opens the modal, fills the input, clicks save, dismisses the toast, and waits for the header DOM to update via `waitForFunction`)
4. Assert `flow_name` header text equals the new name

### API test — `flow name persists after rename via API PATCH and GET`

1. Acquire a Bearer token via `getAuthToken(request)`
2. `POST /api/v1/flows/` with `{ name: originalName, ...FLOW_BASE }` → expect `201` and capture `id`
3. `PATCH /api/v1/flows/{id}` with `{ name: updatedName }` → expect `200` and `body.name === updatedName`
4. `GET /api/v1/flows/{id}` → expect `200`, `body.name === updatedName`, and `body.name !== originalName`
5. Cleanup: `DELETE /api/v1/flows/{id}` in a `finally` block

---

## Validation criterion *(required)*

The UI test must:

- Emit at least one explicit `expect()` (`flow_name` `toHaveText(newName)`) — the helper's internal `waitForFunction` is defensive but is not visible to the test runner, so the explicit `expect` is the framework-visible guard
- Use a unique name per run (`Date.now()` suffix) to avoid colliding with persisted flows from prior runs
- Leave no flow behind: the `afterEach` discards every id the tracker captured, so the instance's flow count returns to its pre-run value even when the test fails

The API test must assert **all** of:

- POST returns `201`
- PATCH returns `200` and the response body's `name` equals `updatedName`
- GET returns `200` and the response body's `name` equals `updatedName`
- The original name is no longer returned (`name !== originalName`)
- Cleanup `DELETE` runs in `finally` to avoid leaking flows on test failure

---

## External dependencies *(required)*

- `tests/helpers/flows/rename-flow.ts` — opens the rename modal, fills `input-flow-name`, clicks `save-flow-settings`, dismisses the "Changes saved successfully" toast, and waits for the `flow_name` DOM to commit via `waitForFunction`
- `tests/helpers/auth/get-auth-token.ts` — issues a Bearer token from the configured superuser credentials
- `tests/helpers/flows/track-created-flows.ts` — captures the UI test's created flow ids from the page's `POST /api/v1/flows` → 201 responses and deletes them id-scoped in `afterEach`. It does **not** see the API test's flow: that one is created through the `request` fixture, which emits no page-level response events (#1147), so the API test keeps its own `finally` `DELETE`
- `src/frontend/src/components/headerComponent/` — renders the `flow_name` header that opens the rename modal
- `src/backend/base/langflow/api/v1/flows.py` — owns `POST/PATCH/GET/DELETE /api/v1/flows`; the round-trip in the API test exercises this endpoint directly

---

## What this test does not cover *(optional)*

- Renaming via the **flows list page** context menu (different code path)
- Description editing (the helper supports `flowDescription` but this spec only exercises `flowName`)
- Concurrent rename conflicts (two clients renaming the same flow)
- Rename with names containing special characters or exceeding length limits
- Cancel-rename flow (clicking `cancel-flow-settings` instead of save)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `LANGFLOW_SUPERUSER` and `LANGFLOW_SUPERUSER_PASSWORD` configured for the API test's auth token
- No LLM required

---

## When to review this test *(optional)*

- `tests/helpers/flows/rename-flow.ts` is refactored (e.g., changes to which testids it interacts with, removal of the toast click, or the `waitForFunction` guard)
- The `flow_name` testid is renamed or split between editor and main-page contexts
- `POST/PATCH/GET /api/v1/flows/{id}` is namespaced (e.g., to `/api/v2/flows`) — the API test would need updating
- The Bearer-token auth scheme changes (e.g., to cookie-based or x-api-key)

---

## Notes *(optional)*

- The UI test runs against the editor's React state, but the rename helper's internal `waitForFunction` already polls until the DOM `flow_name` text matches. The explicit `expect.toHaveText` after the helper return is intentional: ESLint's `playwright/expect-expect` rule requires every `test()` to have a visible expect, and the explicit assertion is what shows up in the test report.
- Persistence is verified by the API test, not by reloading the editor in the UI test. An earlier draft used `page.reload()` after rename, but it was flaky — on some runs the post-reload URL routed to the flows list page (not the editor), causing the `flow_name` testid to be absent and the assertion to time out. Splitting interaction (UI) and persistence (API) into two tests removed that flakiness.
- Stress-validated under the CI worker configuration (`CI=true` → `workers: 2` per `playwright.config.ts`) with `--repeat-each=5` (10 invocations interleaved with the UI test). No `500` responses on `POST /api/v1/flows/` and no flakiness observed. The custom backend-error monitor in `tests/fixtures/fixtures.ts` extends only the `page` fixture, so a `500` on this API test would surface as a hard failure on the explicit `expect(createRes.status()).toBe(201)`, not as a downgraded warning.
