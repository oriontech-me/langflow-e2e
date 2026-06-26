# Flow Functionality — API Access Modal

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev12`)

---

## What this test validates *(required)*

Validates the **API access modal** itself — the surface that exposes a flow's integration snippets — rather than the contents of any single generated snippet (those are covered by `curlApiGeneration.spec.ts` and `pythonApiGeneration.spec.ts`). Four `test()` cases, all opening the **Basic Prompting** template and the modal from the Publish dropdown:

1. **Opens and renders** — the modal opens from `publish-button` → `api-access-item`, shows the `API access` title, the Input Schema (`tweaks-button`) entry point, all three language tabs (`api_tab_python`, `api_tab_javascript`, `api_tab_curl`), and a copyable snippet (`btn-copy-code`).
2. **Tab switching** — clicking each language tab swaps the rendered snippet (Python `import requests` vs. cURL `curl --request POST`), and the two snippets differ — proving `setSelectedTab` re-renders the code block.
3. **Flow ID coherence** — the generated cURL command targets `/api/v1/run/{currentFlowId}` where `currentFlowId` is the ID parsed from the editor URL. This is stricter than the sibling specs, which only match any `[0-9a-f-]{36}` UUID; it proves the modal reflects *the open flow*, not a stale or hard-coded ID.
4. **Close behavior** — the modal dismisses cleanly via `Escape` and via the `Close` (X) button.

If this breaks, users lose the documented entry point to a flow's API — the modal could fail to open, render the wrong flow's endpoint, or trap the user (no clean close).

---

## Tags *(required)*

`@stable` `@regression` `@api` `@workspace`

---

## Step by step *(required)*

A shared `openApiAccessModal(page)` helper performs the common opening sequence and returns the `flowId`:

1. Bootstrap the app (`awaitBootstrapTest`)
2. Open the Templates page (`side_nav_options_all-templates`)
3. Open the `Basic Prompting` template
4. Click `publish-button`, then `api-access-item`; wait for `api_tab_curl` to be visible
5. Capture `flowId` from `page.url()` (matches `/flow/{flowId}`) **only now** — `awaitBootstrapTest` already leaves the page on a flow, and opening the template creates and navigates to a *new* flow; reading the URL before the modal renders races that navigation and can capture the stale bootstrap flow

A second helper `selectUnixCurlTab(page)` clicks `api_tab_curl` then the `macOS/Linux` platform sub-tab, so the generated cURL is deterministic (the default platform follows `getOS()`, which can resolve to Windows/PowerShell on some runners).

Cleanup is handled by a shared **snapshot/diff `afterEach`** (same pattern as the validated sibling `export-import-flow.spec.ts`), not by per-test `finally` blocks: `beforeEach` records the flow IDs that exist before the test, `afterEach` deletes any that appeared after it. A `null` sentinel means "snapshot failed — skip cleanup" so a list-endpoint hiccup never wipes the workspace; it also runs for tests that fail mid-way, so a flow created before an assertion failure is still swept.

### Test 1 — `API access modal opens from the Publish dropdown exposing the Python, JavaScript and cURL tabs`

6. Assert `API access` title (scoped to the open `dialog`, since the Publish dropdown's force-mounted menu item carries the same exact text) and `tweaks-button` are visible
7. Assert `api_tab_python`, `api_tab_javascript`, `api_tab_curl` are visible
8. Assert `btn-copy-code` is visible

### Test 2 — `API access modal switches the displayed snippet when changing language tabs`

6. Click `api_tab_python`, copy via `btn-copy-code`, read clipboard — assert it starts with `import requests`
7. `selectUnixCurlTab` (cURL tab + macOS/Linux), copy, read clipboard — assert it starts with `curl --request POST`
8. Assert the cURL snippet differs from the Python snippet

### Test 3 — `API access modal embeds the current flow ID in the generated run endpoint URL`

6. `selectUnixCurlTab` (cURL tab + macOS/Linux), copy, read clipboard
7. Assert the snippet starts with `curl --request POST` (proves we read the cURL snippet, not a stale Python one — both embed the run URL, so without this guard the tab selection would be cosmetic)
8. Assert the snippet contains `/api/v1/run/{flowId}` (the captured flow ID)

### Test 4 — `API access modal closes cleanly via Escape and via the close button`

6. Assert `api_tab_curl` is visible, press `Escape`, assert `api_tab_curl` is hidden
7. Reopen the modal (`publish-button` → `api-access-item`), assert `api_tab_curl` visible
8. Click the `Close` (X) button, assert `api_tab_curl` is hidden

---

## Validation criterion *(required)*

- The modal is detected by the **language tabs** (`api_tab_*`) and the `API access` title — i18n-tolerant on the testids, exact-text on the title
- Tab switching is proven by reading the clipboard after each tab's Copy click (the visible code is a tokenized `SyntaxHighlighter` tree, not a plain string) and asserting the snippets differ AND each matches its language signature
- The endpoint URL assertion uses the **specific** captured `flowId` (`/api/v1/run/{flowId}`), not a generic UUID match — coherence with the open flow is the distinct concern of this spec
- Both close paths (`Escape`, `Close` button) drive `api_tab_curl` to hidden — a partial close (overlay lingering) would fail
- A shared snapshot/diff `afterEach` deletes any flow created during the test so repeated runs do not accumulate workspace artifacts; the `null` sentinel keeps a failed snapshot from wiping the workspace

---

## External dependencies *(required)*

- `tests/helpers/other/await-bootstrap-test.ts` — app bootstrap
- `tests/helpers/auth/get-auth-token.ts` — Bearer token for the cleanup `DELETE`
- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` — registers `publish-button` and `api-access-item`; mounts `ApiModal`
- `src/frontend/src/modals/apiModal/codeTabs/code-tabs.tsx` — renders the `api_tab_${title}` language tabs and `btn-copy-code`; owns the `setSelectedTab` switch
- `src/frontend/src/modals/apiModal/index.tsx` — modal shell; renders the `API access` title (`modal.api.title`) and the `tweaks-button`
- `src/frontend/src/components/ui/dialog.tsx` — the `Close` (X) button with the `Close` accessible name
- `src/frontend/src/modals/apiModal/utils/get-curl-code.tsx` / `get-python-api-code.tsx` — build the snippets whose `/api/v1/run/{flowId}` URL the flow-ID test asserts
- `src/backend/base/langflow/api/v1/endpoints.py` — owns `/api/v1/run/{flow_id}`; the URL shape encoded in the snippet must keep matching this route

---

## What this test does not cover *(optional)*

- The full structural shape of each snippet (headers, payload, session_id) — owned by `curlApiGeneration.spec.ts` and `pythonApiGeneration.spec.ts`
- The macOS/Linux ↔ Windows cURL platform sub-tabs (covered by `curlApiGeneration.spec.ts`)
- The Input Schema (tweaks) modal behind `tweaks-button` — only its presence is asserted, not its tweak-editing flow
- Outside-click dismissal — `Escape` and the `Close` button are the two close paths exercised
- Actually executing the generated snippet against the backend (covered by API tests under `api/flows/`)
- The JavaScript snippet's structural shape — only that selecting its tab produces a snippet distinct from Python/cURL

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD` configured for the cleanup token
- No LLM credentials required — only the snippet generator and modal are exercised
- `clipboard-read` permission is granted globally in `playwright.config.ts`

---

## When to review this test *(optional)*

- A language tab is added/removed or `api_tab_${title}` testid scheme changes
- The `API access` title text (`modal.api.title`) changes — the exact-text assertion must track it
- `btn-copy-code` is renamed or the simple (no-files) snippet gains an upload-steps layout (`btn-copy-step1`)
- The `/api/v1/run/{flow_id}` route is renamed or namespaced — the flow-ID assertion must update
- The modal's close affordances change (e.g., the X button loses its `Close` accessible name)
- The default flow that opens from the Basic Prompting template stops embedding the flow ID in the run URL (e.g., it starts using `endpoint_name` instead)

---

## Notes *(optional)*

- The modal exposes **Python, JavaScript and cURL** tabs only. The issue's mention of separate "API endpoint URL" and "Bearer key" tabs does not match the current modal — those concepts live *inside* the generated snippets (the run URL and the `x-api-key` header), so the spec asserts them there rather than as standalone tabs.
- The endpoint URL uses `endpoint_name || flowId`. The Basic Prompting template carries no `endpoint_name`, so the flow ID appears verbatim — which is what Test 3 asserts. If a future template default sets an `endpoint_name`, that test must change.
- The file runs in **serial mode** (`test.describe.configure({ mode: "serial" })`). All four tests open the same Basic Prompting template and each creates a fresh flow; running them in parallel made the backend receive near-identical concurrent `POST /api/v1/flows/` requests, which intermittently returned `500 — An internal error occurred while creating the flow`. Serializing the file removes that self-collision so the run stays free of backend errors.
