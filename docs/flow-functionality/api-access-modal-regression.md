# Flow Functionality — API Access Modal

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev25`, #2415) · first validated on 1.11.x (`1.11.0.dev12`)

---

## What this test validates *(required)*

Validates the **API access modal** itself — the surface that exposes a flow's integration snippets — rather than the contents of any single generated snippet (those are covered by `curlApiGeneration.spec.ts` and `pythonApiGeneration.spec.ts`). Five `test()` cases, all opening the **Basic Prompting** template and the modal from the Publish dropdown, and each selecting the API version it asserts **explicitly** (see Notes — the default differs by release line):

1. **Opens and renders** — the modal opens from `publish-button` → `api-access-item`, shows the `API access` title, the Endpoint Name (`endpoint-name-button`) header entry point (dev49 — replaces the removed Input Schema / `tweaks-button`), the API version selector offering both `v1` and `v2` (`api_version_v1`, `api_version_v2`), all three language tabs (`api_tab_python`, `api_tab_javascript`, `api_tab_curl`), and — on v1 — a copyable snippet (`btn-copy-code`).
2. **Tab switching** — clicking each language tab swaps the rendered snippet (Python `import requests` vs. cURL `curl --request POST`), and the two snippets differ — proving `setSelectedTab` re-renders the code block.
3. **Flow ID coherence** — the generated cURL command targets `/api/v1/run/{currentFlowId}` where `currentFlowId` is the ID parsed from the editor URL. This is stricter than the sibling specs, which only match any `[0-9a-f-]{36}` UUID; it proves the modal reflects *the open flow*, not a stale or hard-coded ID.
4. **Close behavior** — the modal dismisses cleanly via `Escape` and via the `Close` (X) button.
5. **v2 snippets** (#2415) — on the `v2` version the Python tab renders **two** copyable steps, a full-result run and a streaming run, both on `POST /api/v2/workflows` and both carrying **this** flow's id as `flow_id`; only the second asks for `"mode": "stream"`. Since `1.14.0.dev23` (upstream #13508) this is what the modal shows by default on the 1.14 line, and nothing else in the suite covered it.

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
5. Click the requested API version tab (`api_version_v1` or `api_version_v2`) and assert it is the selected one (`aria-selected="true"`), so a click that does not take fails here, named, rather than as a wrong snippet later
6. Capture `flowId` from `page.url()` (matches `/flow/{flowId}`) **only now** — `awaitBootstrapTest` already leaves the page on a flow, and opening the template creates and navigates to a *new* flow; reading the URL before the modal renders races that navigation and can capture the stale bootstrap flow

A second helper `selectUnixCurlTab(page)` clicks `api_tab_curl` then the `macOS/Linux` platform sub-tab, so the generated cURL is deterministic (the default platform follows `getOS()`, which can resolve to Windows/PowerShell on some runners).

Cleanup tracks the ids returned by this page's own flow-creating responses (`POST` under `/api/v1/flows`) and deletes exactly those in `afterEach` (same pattern as `export-import-flow.spec.ts` post-#561). The previous snapshot/diff cleanup deleted any flow a PARALLEL worker created during the test window — the cross-worker destructive-cleanup class from #553; in the daily it was the wiper that killed `edit-flow-name`'s in-flight flows (#519). The tracker also runs for tests that fail mid-way, so a flow created before an assertion failure is still swept.

### Test 1 — `API access modal opens from the Publish dropdown exposing the Python, JavaScript and cURL tabs`

Opened on **v1**.

7. Assert `API access` title (scoped to the open `dialog`, since the Publish dropdown's force-mounted menu item carries the same exact text) and `endpoint-name-button` are visible
8. Assert the version selector offers both `api_version_v1` and `api_version_v2` — which one is the *default* is deliberately not asserted
9. Assert `api_tab_python`, `api_tab_javascript`, `api_tab_curl` are visible
10. Assert `btn-copy-code` is visible

### Test 2 — `API access modal switches the displayed snippet when changing language tabs`

Opened on **v1**.

7. Click `api_tab_python`, copy via `btn-copy-code`, read clipboard — assert it starts with `import requests`
8. `selectUnixCurlTab` (cURL tab + macOS/Linux), copy, read clipboard — assert it starts with `curl --request POST`
9. Assert the cURL snippet differs from the Python snippet

### Test 3 — `API access modal embeds the current flow ID in the generated run endpoint URL`

Opened on **v1**.

7. `selectUnixCurlTab` (cURL tab + macOS/Linux), copy, read clipboard
8. Assert the snippet starts with `curl --request POST` (proves we read the cURL snippet, not a stale Python one — both embed the run URL, so without this guard the tab selection would be cosmetic)
9. Assert the snippet contains `/api/v1/run/{flowId}` (the captured flow ID)

### Test 4 — `API access modal closes cleanly via Escape and via the close button`

Opened on **v1**; the close paths do not depend on the version.

7. Assert `api_tab_curl` is visible, press `Escape`, assert `api_tab_curl` is hidden
8. Reopen the modal (`publish-button` → `api-access-item`), assert `api_tab_curl` visible
9. Click the `Close` (X) button, assert `api_tab_curl` is hidden

### Test 5 — `API access modal v2 offers a full-result and a streaming snippet bound to the open flow`

Opened on **v2**.

7. Click `api_tab_python`
8. Assert exactly two steps render: `api-step-1` and `api-step-2` visible, `api-step-3` absent
9. Copy step 1 (`btn-copy-step1`), read clipboard — assert it posts to `<base>/api/v2/workflows`, carries `"flow_id": "{flowId}"` and `"input_value": "Hello"`, and does **not** contain `"mode": "stream"`
10. Copy step 2 (`btn-copy-step2`), read clipboard — assert the same URL and `"flow_id": "{flowId}"`, and that it **does** contain `"mode": "stream"`

---

## Validation criterion *(required)*

- The modal is detected by the **language tabs** (`api_tab_*`) and the `API access` title — i18n-tolerant on the testids, exact-text on the title
- Tab switching is proven by reading the clipboard after each tab's Copy click (the visible code is a tokenized `SyntaxHighlighter` tree, not a plain string) and asserting the snippets differ AND each matches its language signature
- The endpoint URL assertion uses the **specific** captured `flowId` (`/api/v1/run/{flowId}`), not a generic UUID match — coherence with the open flow is the distinct concern of this spec
- The v2 test binds both steps to the same captured `flowId` (`"flow_id": "{flowId}"`), and tells them apart by `"mode": "stream"` — present in the streaming step, absent from the full-result one; reading both from one copy button would fail one of the two
- Both close paths (`Escape`, `Close` button) drive `api_tab_curl` to hidden — a partial close (overlay lingering) would fail
- A shared tracked-ids `afterEach` deletes exactly the flows this page created, so repeated runs do not accumulate workspace artifacts without ever touching parallel workers' flows (#519)

---

## External dependencies *(required)*

- `tests/helpers/other/await-bootstrap-test.ts` — app bootstrap
- `tests/helpers/auth/get-auth-token.ts` — Bearer token for the cleanup `DELETE`
- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` — registers `publish-button` and `api-access-item`; mounts `ApiModal`
- `src/frontend/src/modals/apiModal/codeTabs/code-tabs.tsx` — renders the API version selector (`api_version_v1` / `api_version_v2`; its default is `v2` on `release-1.14.0` since #13508 and `v1` elsewhere), the `api_tab_${title}` language tabs, `btn-copy-code` for a single snippet and `api-step-N` / `btn-copy-stepN` for a multi-step one; owns the `setSelectedTab` switch
- `src/frontend/src/modals/apiModal/utils/get-v2-workflows-code.tsx` — builds the v2 two-step snippets (full result, then `"mode": "stream"`) on `POST /api/v2/workflows`
- `src/frontend/src/modals/apiModal/index.tsx` — modal shell; renders the `API access` title (`modal.api.title`) and the `endpoint-name-button` header entry point
- `src/frontend/src/components/ui/dialog.tsx` — the `Close` (X) button with the `Close` accessible name
- `src/frontend/src/modals/apiModal/utils/get-curl-code.tsx` / `src/frontend/src/modals/apiModal/utils/get-python-api-code.tsx` — build the snippets whose `/api/v1/run/{flowId}` URL the flow-ID test asserts
- `src/backend/base/langflow/api/v1/endpoints.py` — owns `/api/v1/run/{flow_id}`; the URL shape encoded in the snippet must keep matching this route

---

## What this test does not cover *(optional)*

- The full structural shape of each snippet (headers, payload, session_id) — owned by `curlApiGeneration.spec.ts` and `pythonApiGeneration.spec.ts`
- The macOS/Linux ↔ Windows cURL platform sub-tabs (covered by `curlApiGeneration.spec.ts`)
- **Which API version the modal opens on.** It is `v2` on `release-1.14.0` (`1.14.0.dev23`+, upstream #13508) and still `v1` on `main` and the 1.13 lines, so asserting the default would encode one branch's state; every test selects its version instead
- The v2 JavaScript and cURL snippets — Test 5 asserts the v2 contract on the Python tab only
- The behavior behind the `endpoint-name-button` header entry point — only its presence is asserted, not its editing flow
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
- The v1 API version is removed from the modal (Tests 1–4 select it), or v2 changes its step layout (`api-step-N`) or drops the streaming step
- The `/api/v1/run/{flow_id}` route is renamed or namespaced — the flow-ID assertion must update
- The modal's close affordances change (e.g., the X button loses its `Close` accessible name)
- The default flow that opens from the Basic Prompting template stops embedding the flow ID in the run URL (e.g., it starts using `endpoint_name` instead)

---

## Notes *(optional)*

- The modal exposes **Python, JavaScript and cURL** tabs only. The issue's mention of separate "API endpoint URL" and "Bearer key" tabs does not match the current modal — those concepts live *inside* the generated snippets (the run URL and the `x-api-key` header), so the spec asserts them there rather than as standalone tabs.
- The endpoint URL uses `endpoint_name || flowId`. The Basic Prompting template carries no `endpoint_name`, so the flow ID appears verbatim — which is what Test 3 asserts. If a future template default sets an `endpoint_name`, that test must change.
- The file runs in **serial mode** (`test.describe.configure({ mode: "serial" })`). All four tests open the same Basic Prompting template and each creates a fresh flow; running them in parallel made the backend receive near-identical concurrent `POST /api/v1/flows/` requests, which intermittently returned `500 — An internal error occurred while creating the flow`. Serializing the file removes that self-collision so the run stays free of backend errors.
- **Every test selects its API version (#2415).** Upstream #13508 (`ba88fe1767`, first nightly `1.14.0.dev23`) made the modal open on **v2** and dropped its *beta* badge. The v2 tabs render two steps (`btn-copy-step1/2`) and no `btn-copy-code` or platform sub-tab, so Tests 1–4 — written against the v1 default — failed or timed out on `1.14.0.dev23`, and the daily triage read that as "the modal does not open" (it opens fine). The selector exists on every line (`1.13.1`, `1.13.3`, `1.14.0.dev22`, `dev25`, `main`) while the default does not (`v2` on `release-1.14.0`, `v1` on `main` and 1.13), so selecting explicitly is what makes the spec deterministic across lines.
