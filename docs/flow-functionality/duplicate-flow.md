# Flow Functionality — Duplicate Flow

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates flow duplication in two complementary ways:

1. **UI test:** Opens the Basic Prompting template (creates a flow), goes back to the home page, opens the dropdown for the first flow card, clicks `btn-duplicate-flow`, and asserts (a) the duplicate `POST /api/v1/flows/` returns `201` with a non-empty `id`, (b) the success toast renders, and (c) that exact `id` appears in `GET /api/v1/flows/`.
2. **API test:** Mirrors the duplicate hook (`useDuplicateFlow` → `createNewFlow` → `POST /api/v1/flows/`) by `POST`ing twice with the same name. Asserts the backend auto-suffixes the second flow with ` (N)` to keep names unique, and that both flows are listed with different IDs.

Together the pair guarantees the duplicate dropdown action wires up to the real backend behavior — including the auto-suffix collision logic that the UI relies on for sane flow names.

---

## Tags *(required)*

UI test: `@release` `@workspace` `@stable`
API test: `@release` `@workspace` `@api` `@stable`

---

## Step by step *(required)*

### UI test — `user can duplicate a flow from the home page dropdown menu`

1. Bootstrap the app
2. Click `side_nav_options_all-templates`, then click the `Basic Prompting` heading to open the template (which creates a new flow)
3. Wait for `sidebar-search-input` to confirm the editor loaded; navigate back via `icon-ChevronLeft`
4. Wait for the first `home-dropdown-menu` to be visible
5. Acquire a Bearer token via `getAuthToken(request)`
6. Click the first `home-dropdown-menu`, wait for `btn-duplicate-flow`
7. Register a `page.waitForResponse` listener for `POST /api/v1/flows/` with status `201`, then click `btn-duplicate-flow`
8. Read the captured response body, extract the new flow's `id`, and assert it is truthy
9. Assert the toast `/duplicated successfully/i` renders
10. Poll `GET /api/v1/flows/` until the listing contains an entry whose `id` matches the captured `id` (timeout 10s)

### API test — `duplicate flow via API auto-suffixes the name on collision`

1. Acquire a Bearer token via `getAuthToken(request)`
2. `POST /api/v1/flows/` with `{ name: originalName, ...FLOW_BASE }` — expect `201` and `body.name === originalName`
3. `POST /api/v1/flows/` again with the **same** name — expect `201`, `body.id !== original.id`, and `body.name` matches `^${originalName} \(\d+\)$`
4. `GET /api/v1/flows/` — expect `200` and both IDs to be present in the list
5. Cleanup both flows via `DELETE` in `finally`

---

## Validation criterion *(required)*

The UI test must:

- Use `getByTestId("btn-duplicate-flow")`, **not** `getByText(/duplicate/i)` — i18n-proof
- Intercept the duplicate `POST /api/v1/flows/` response (status `201`) and assert by the returned `id`. The previous version snapshot the global flow count and polled for `countBefore + 1`, which falsely failed whenever a parallel worker created another flow during the poll window
- Assert the success toast renders, confirming the action committed (not just the click landed)

The API test must assert **all** of:

- First POST returns `201` with the original name unchanged
- Second POST with the **same** name returns `201` and the response `name` matches `^${originalName} \(\d+\)$` (the auto-suffix pattern that `flow_service.create_flow` produces on collision)
- The IDs are different
- Both flows appear in the listing
- Cleanup runs in `finally` so a mid-test failure does not leak flows

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — issues the Bearer token
- `src/frontend/src/pages/MainPage/components/dropdown/index.tsx` — registers `btn-duplicate-flow` testid; the test would need updating if it is renamed or removed
- `src/frontend/src/pages/MainPage/hooks/use-handle-duplicate.ts` — calls `createNewFlow` then `postAddFlow`; the API test mirrors this round-trip directly
- `src/frontend/src/utils/reactflowUtils.ts` (`createNewFlow`) — keeps the original `name` (no client-side suffix); the suffix originates server-side
- `src/backend/base/langflow/api/v1/flows.py` (`POST /api/v1/flows/`) — owns the auto-suffix collision logic asserted by the API test

---

## What this test does not cover *(optional)*

- Duplicating a flow with non-empty `data` (real components and edges) and verifying the duplicate's graph matches the original — this spec only validates **name** and **presence** semantics (the new flow exists in the listing), not graph cloning fidelity
- Duplicating into a different folder (the hook supports `folder_id` via `useParams`, but this spec runs in the default folder)
- Duplicating a flow the user does not own (permissions / multi-tenant scenarios)
- The `(N)` suffix increment when N >= 2 (e.g., duplicating an already-duplicated flow). Current assertion `\(\d+\)` accepts any digit count

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `LANGFLOW_SUPERUSER` and `LANGFLOW_SUPERUSER_PASSWORD` configured for the API test's auth token
- No LLM required

---

## When to review this test *(optional)*

- The auto-suffix logic in `flow_service.create_flow` changes (e.g., uses ` - copy` instead of ` (1)`, or stops auto-suffixing entirely) — the API test's regex must be updated
- `use-handle-duplicate.ts` is refactored to call a dedicated `/api/v1/flows/{id}/duplicate` endpoint instead of `POST` repetition — the API test should mirror the new contract
- `btn-duplicate-flow` testid is renamed or moved out of the home dropdown
- `i18n` key `flow.duplicatedSuccess` text changes — the toast assertion uses `/duplicated successfully/i` and would still match if the wording is preserved

---

## Notes *(optional)*

- An earlier version of this spec asserted only `count > 1` after duplicate, which is essentially always true once any flow exists in the database — a near-empty assertion that would pass even if duplicate silently failed and only the original was visible.
- A subsequent revision tightened this to a `countBefore + 1` global-count poll. That assertion was structurally racy under Playwright's parallel workers — any unrelated flow created by another worker during the 10s poll window inflated the count and failed the test (see weekly-stable run 26027495405, where it failed with `Expected 39 / Received 41`). The current version intercepts the duplicate `POST` response and asserts by the captured `id`, which is race-proof against any concurrent flow creation.
- Trade-off: the new assertion no longer implicitly catches a hypothetical "double-create" regression (UI firing the duplicate POST twice). The duplicate handler (`use-handle-duplicate.ts`) fires the API once per click and there is no historical bug in that direction; the cost of this check is worth less than the cost of false failures every parallel run.
- The previous API test manually constructed `${originalName} (copy)` as the duplicate name, bypassing the actual collision logic the backend implements. This spec rewrites the test to POST with the **same** name twice, which is what the UI duplicate hook actually triggers, and asserts the server's auto-suffix instead.
- Empirical confirmation of the auto-suffix format (` (1)`, with a leading space) was captured by a direct `curl` round-trip against the running backend. The regex `^${originalName} \(\d+\)$` reflects that exact format.
- The UI test mixes UI action (click) with API verification (identity poll). This is intentional: counting cards on the home page is unreliable when the user has 100+ flows (paginated to 12 per page), so the API is the source of truth for persistence.
