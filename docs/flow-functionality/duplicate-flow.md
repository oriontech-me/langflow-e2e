# Flow Functionality — Duplicate Flow

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates flow duplication in two complementary ways:

1. **UI test:** Opens the Basic Prompting template (creates a flow), goes back to the home page, opens the dropdown for the first flow card, clicks `btn-duplicate-flow`, and asserts (a) the success toast renders and (b) the API flow count grew by **exactly one**.
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
5. Capture the current flow count via `GET /api/v1/flows/`
6. Click the first `home-dropdown-menu`, wait for `btn-duplicate-flow` and click it
7. Assert the toast `/duplicated successfully/i` renders
8. Poll `GET /api/v1/flows/` until the count equals `countBefore + 1` (timeout 10s)

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
- Snapshot the flow count via API before duplicate and assert exactly `+1` after — `count > 1` would always be true on a populated database (the home page lists 100+ flows in development environments)
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

- Duplicating a flow with non-empty `data` (real components and edges) and verifying the duplicate's graph matches the original — this spec only validates **name** and **count** semantics, not graph cloning fidelity
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

- The previous version of this spec asserted only `count > 1` after duplicate, which is essentially always true once any flow exists in the database — a near-empty assertion that would pass even if duplicate silently failed and only the original was visible.
- The previous API test manually constructed `${originalName} (copy)` as the duplicate name, bypassing the actual collision logic the backend implements. This spec rewrites the test to POST with the **same** name twice, which is what the UI duplicate hook actually triggers, and asserts the server's auto-suffix instead.
- Empirical confirmation of the auto-suffix format (` (1)`, with a leading space) was captured by a direct `curl` round-trip against the running backend. The regex `^${originalName} \(\d+\)$` reflects that exact format.
- The UI test mixes UI action (click) with API verification (count delta). This is intentional: counting cards on the home page is unreliable when the user has 100+ flows (paginated to 12 per page), so the API is the source of truth for the count assertion.
