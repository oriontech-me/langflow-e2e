# API Request Component — Rendering, Inspector, HTTP Methods, cURL Mode and Error Paths

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **API Request** component end-to-end via 15 scenarios grouped into five categories:

1. **Canvas rendering and inspector fields** — the node renders with the correct URL/API Response handles, and the inspector accepts URL + HTTP method input.
2. **Execution per HTTP verb** — GET, POST, PUT, PATCH, DELETE each round-trip to a `httpbin.org` endpoint that **only** accepts that verb (any other verb returns 405). The output Data is asserted to contain `200`, the echoed URL, and the expected structural keys (`source`, `status_code`, `response_headers`, `result`).
3. **Error and edge paths** — invalid URL shows the build-error notification, non-2xx responses (404) propagate as `status_code` without raising, query parameters embedded in the URL are sent and echoed back.
4. **Inspector tables and cURL mode** — the headers key-value table accepts both key and value cell entries via the View Text editor; the body key-value table is accessed through the Controls modal (the body field is `advanced=True`) and accepts both key and value cell entries via the same editor; the cURL tab switches mode and the cURL parser auto-populates the URL field with the URL extracted from the cURL command, after which the run executes the GET successfully.
5. **Persistence to flow JSON** — configuring URL, method and a headers row triggers an autosave that persists into the flow's saved state (verified by polling `GET /api/v1/flows/{id}`), and a full page reload rehydrates the inspector with the same values.

If any of these tests fails, the API Request component is broken in the product — either in canvas rendering, inspector input, execution per verb, error propagation, table-input editing, cURL parsing, or autosave persistence.

---

## Tags *(required)*

All 15 tests: `@stable` `@regression` `@components`
8 of them additionally carry `@release` (the canvas/inspector/GET/POST/PUT/PATCH/DELETE happy paths).

---

## Step by step *(required)*

Every test starts with `addApiRequestComponent(page)` which:
1. Bootstraps the app (`awaitBootstrapTest`)
2. Clicks `blank-flow` and waits for the API Request sidebar item to be attached
3. Hovers the sidebar card (the add button reveals on hover) and clicks `add-component-button-api-request`
4. Calls `adjustScreenView(page)` to fit the canvas
5. Asserts `title-API Request` is visible

### 1. `renders on canvas with correct output and URL handles`
- Asserts `title-API Request`, the right-side `handle-apirequest-shownode-api response-right`, and the left-side `handle-apirequest-shownode-url-left` are all visible.
- Asserts exactly one node on the canvas (`react-flow__node` count === 1).

### 2. `inspector fields accept configured values`
- Fills `popover-anchor-input-url_input` with `https://httpbin.org/get` and asserts the value.
- Opens the method dropdown, selects "POST" and asserts the displayed value matches.

### 3. `invalid URL is accepted by field and run shows error notification`
- Calls `(page as any).allowFlowErrors()` (the run is expected to fail).
- Fills `not-a-url`, asserts canvas integrity, runs, then asserts both `Error building Component API Request:` and `Invalid URL provided:` toasts are visible.

### 4–8. `<METHOD> method executes <METHOD> verb and returns 200`
For each of GET, POST, PUT, PATCH, DELETE:
- Fills the URL with `https://httpbin.org/<verb>` (an endpoint that **only** accepts that verb)
- Selects the matching method in the dropdown
- Runs the component and asserts the output Data contains `200`, the echoed URL, and the structural keys.

### 9. `non-2xx HTTP response propagates status_code without crashing`
- Fills `https://httpbin.org/status/404`, runs, asserts the output Data contains `404` (not `200`, not `500`) and **does not** contain an `"error"` field (which only appears on httpx transport exceptions).

### 10. `query parameters embedded in URL are sent and echoed`
- Fills `https://httpbin.org/get?e2e_param=functional_test_value`, runs, asserts the parameter key/value appear in the parsed response and the response status is `200`.

### 11. `inspector headers table accepts key + value cell entries`
- Opens `div-table_headers` → `Open table` button → table dialog opens.
- Adds a row, then fills BOTH the `[col-id="key"]` cell with `X-E2E-Header` and the `[col-id="value"]` cell with `test-header-value` via the `fillViewTextCell` helper. The helper asserts each cell value renders as a button inside the table dialog after Save (this is the in-session validation; the test does not assert table-modal-level persistence — see "What this test does not cover").
- Closes the dialog with `btn-cancel-modal` and asserts canvas integrity.

### 12. `cURL tab switches mode and field accepts a cURL command`
- Asserts `tab_0_url` and `tab_1_curl` are visible.
- Switches to the cURL tab, asserts `textarea_str_curl_input` is visible, fills a valid cURL string, asserts the value, and asserts `handle-apirequest-shownode-curl-left` is present.

### 13. `cURL mode parses command, auto-fills URL, executes GET and returns 200`
- Switches to the cURL tab **before** touching the URL field (pre-filling `url_input` would mask a regression in the cURL parser by letting the run fall back to the URL-tab path).
- Fills the cURL command and waits for the parser to auto-populate `url_input` with `https://httpbin.org/get`. The `waitForFunction` directly proves the parser ran.
- Runs the component and asserts the output Data contains `200`, the echoed URL, and the structural keys.

### 14. `body table accepts key + value cell entries via Controls modal`
- The body field is marked `advanced=True` on `APIRequestComponent`, so it does not render directly in the canvas view (unlike headers). Clicks the canvas node and opens the Controls modal via `edit-button-modal` to expose the advanced fields.
- Inside the modal, finds `div-table_body`, clicks `Open table`, adds a row, then fills BOTH the `[col-id="key"]` cell with `payload` and the `[col-id="value"]` cell with `e2e-body-value` via the `fillViewTextCell` helper. The helper asserts each cell value renders as a button inside the table dialog after Save.
- Closes the dialog with `btn-cancel-modal` and asserts canvas integrity.

### 15. `flow state persists in database after autosave (URL, method, headers)`
- Configures URL (`https://httpbin.org/get?persist=true`), method (`POST`) and a headers row (`X-Persist-Header` / `persisted-value`) on a freshly created flow; captures the `flowId` from the URL.
- Polls `GET /api/v1/flows/{id}` (using `page.request` which inherits the session cookie) until the autosave has written the URL, method and matching header row into the saved flow JSON. Polling the API directly proves the autosave reached the database — not just in-memory React state.
- Reloads the page and asserts the inspector rehydrates with the same URL, method dropdown value, and that reopening the headers table shows the saved row as a button.

---

## Validation criterion *(required)*

The suite must:

- Use `getByTestId("popover-anchor-input-url_input")`, `getByTestId("dropdown_str_method")`, `getByTestId("button_run_api request")` and the `output-inspection-api response-apirequest` testid — i18n-proof.
- Run **serially** (`test.describe.configure({ mode: "serial" })`) — parallel autosaves on flow create cause `400 "flow must be unique"` errors that flag as backend errors in the fixture.
- For each verb test, hit a `httpbin.org` endpoint that returns 405 for any other verb — this guarantees the test fails if the wrong verb is sent (e.g. POST sent as GET).
- For the cURL execution test, switch to the cURL tab *before* configuring the URL — and assert the parser auto-populates `url_input`. Asserting only the run output would let the test pass even if cURL parsing was broken.
- For the headers and body table tests, fill both KEY and VALUE cells (not key only) — filling only the key cell would still pass even if the value column was non-functional or rejected entries.
- For the body table test, open the Controls modal (`edit-button-modal`) before searching for `div-table_body` — the body field is `advanced=True` and does not render in the canvas view (unlike headers).
- For the persistence test, poll `GET /api/v1/flows/{id}` directly through `page.request` and *also* reload the page to verify the UI rehydrates. Verifying only the in-memory state would let the test pass even if autosave was broken.
- For the invalid URL test, call `allowFlowErrors()` so the fixture's `🚨 Backend Error` monitor does not flag the expected `400`/`422`.

---

## External dependencies *(required)*

- `tests/helpers/other/await-bootstrap-test.ts` — bootstraps the app
- `tests/helpers/ui/adjust-screen-view.ts` — fits the canvas after adding the component
- `tests/fixtures/fixtures.ts` — provides `(page as any).allowFlowErrors()` (the cast is required because the helper is injected via the fixture without a typed augmentation; see "Notes")
- `src/lfx/src/lfx/components/data_source/api_request.py` — owns the field schema (URL, method, headers/body table inputs, cURL textarea); the test would need updating if a field is renamed, removed, or its `advanced` flag changes
- `src/frontend/src/CustomNodes/GenericNode/index.tsx` — owns the inspector layout that exposes `popover-anchor-input-url_input`, `dropdown_str_method`, `div-table_headers`, `tab_0_url`, `tab_1_curl`, etc.
- `httpbin.org` — external test target; if it is unreachable from CI, the 5 verb tests, the 404 test, and the query-parameter test all fail by external reason rather than by Langflow regression (see "Notes")

---

## What this test does not cover *(optional)*

- **`include_httpx_metadata=true`** — this advanced toggle adds outgoing request headers to output. Covered by `tests/tests-automations/regression/api/flows/api-component-regression.spec.ts` (legacy spec scheduled for retirement; see "Notes").
- **Timeout error path** — covered by the same legacy spec.
- **cURL with POST + JSON body and parser-driven body fill** — covered by the legacy spec; not yet migrated to this consolidated suite.
- **Body persistence through reload** — the persistence test exercises URL, method and headers but not the body table. The body and headers tables share the same `TableInput` widget and persistence path, so headers coverage is treated as representative for table autosave.
- **Anonymous / multi-tenant access** — runs as `LANGFLOW_SUPERUSER`.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- Outbound HTTPS to `httpbin.org` reachable from the runner
- No LLM required

---

## When to review this test *(optional)*

- The API Request field schema changes in `api_request.py` (URL, method, headers, body, curl_input field names)
- The inspector layout changes such that `popover-anchor-input-url_input`, `dropdown_str_method`, or `tab_0_url`/`tab_1_curl` testids are renamed or restructured
- The cURL parser changes its auto-fill behavior (e.g., it stops auto-populating `url_input` from the cURL command, or moves to a different field)
- `httpbin.org` becomes unavailable — switch the verb tests to a stable equivalent (e.g., a self-hosted echo server or `postman-echo.com`)
- The body field's `advanced=True` flag is removed — at that point the body table test can drop the `edit-button-modal` step and mirror the headers test directly
- The autosave debounce interval is increased substantially — bump the persistence test's polling timeout (currently 20s) to match
- The fixture is refactored to type `allowFlowErrors` properly — the `(page as any)` cast can be dropped

---

## Notes *(optional)*

- **Duplicate coverage with legacy specs.** `tests/tests-automations/regression/api/flows/api-request-component-ui.spec.ts` (4 tests: canvas render, URL field, method dropdown, headers field) is fully superseded by tests 1, 2, and 11 of this spec — its 4th test uses anti-patterns (`.catch(() => false)`, conditional advanced-button click) that this consolidated spec replaces with deterministic locators. `tests/tests-automations/regression/api/flows/api-component-regression.spec.ts` (5 tests: GET, cURL POST + JSON body with auto-fill URL, `include_httpx_metadata`, timeout 500, URL-mode POST via dropdown) is partially duplicated by tests 4, 5, and 13 here, but contains 3 unique tests (`include_httpx_metadata`, timeout, cURL POST + body). A follow-up PR should migrate those 3 unique tests here and retire both legacy specs.
- **`(page as any).allowFlowErrors()` cast.** The fixture injects `allowFlowErrors` onto the page object via `(page as any).allowFlowErrors = () => {...}`, without extending the `Page` type. Removing the cast at the call site requires extending the type signature in `fixtures.ts`. The pattern is project-wide (`loop-component-regression.spec.ts` uses the same cast).
- **Why one verb per `httpbin.org` endpoint.** `httpbin.org/get`, `/post`, `/put`, `/patch`, `/delete` each return 405 if hit with any other verb. This means the test fails if the component sends the wrong method — there's no way to silently pass with a misconfigured verb.
- **cURL pre-fill anti-pattern (fixed).** The previous version of test 13 pre-populated `url_input` before switching to the cURL tab. The run would then succeed via the URL-tab path even if the cURL parser was broken. The current test switches to the cURL tab first and waits for the parser to auto-populate `url_input` — the run is genuinely driven by the cURL command.
- **Headers table value-cell gap (fixed).** The previous version of test 11 only filled the key cell and closed the dialog with Cancel. It would have passed even if the value column was non-functional. The current version fills both key and value cells via `fillViewTextCell`, which asserts each cell renders as a button after Save inside the table dialog — closing the gap.
