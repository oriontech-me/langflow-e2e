# API Request Component — Rendering, Inspector, HTTP Methods, cURL Mode and Error Paths

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the **API Request** component end-to-end via 15 scenarios grouped into five categories:

1. **Canvas rendering and inspector fields** — the node renders with the correct URL/API Response handles, and the inspector accepts URL + HTTP method input.
2. **Execution per HTTP verb** — GET, POST, PUT, PATCH, DELETE each round-trip to an echo endpoint that **only** accepts that verb (any other verb returns a non-2xx — `404` on postman-echo, `405` on httpbin; either way it is not `200`, which is what the verb tests assert). The output Data is asserted to contain `200`, the echoed URL host, and the expected structural keys (`source`, `status_code`, `response_headers`, `result`). The endpoint defaults to `postman-echo.com` (overridable via `ECHO_BASE_URL`); a transient upstream 5xx is absorbed by a retry in `runAndOpenOutput` so it does not fail the suite — see "Validation criterion" and issues #383, #407.
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
- Fills `popover-anchor-input-url_input` with `https://postman-echo.com/get` and asserts the value.
- Opens the method dropdown, selects "POST" and asserts the displayed value matches.

### 3. `invalid URL is accepted by field and run shows error notification`
- Calls `(page as any).allowFlowErrors()` (the run is expected to fail).
- Fills `not-a-url`, asserts canvas integrity, runs, then asserts both `Error building Component API Request:` and `Invalid URL provided:` toasts are visible.

### 4–8. `<METHOD> method executes <METHOD> verb and returns 200`
For each of GET, POST, PUT, PATCH, DELETE:
- Fills the URL with `https://postman-echo.com/<verb>` (an endpoint that **only** accepts that verb)
- Selects the matching method in the dropdown
- Runs the component and asserts the output Data contains `200`, the echoed URL, and the structural keys.

### 9. `non-2xx HTTP response propagates status_code without crashing`
- Fills `https://postman-echo.com/status/404`, runs, asserts the output Data contains `404` (not `200`, not `500`) and **does not** contain an `"error"` field (which only appears on httpx transport exceptions).

### 10. `query parameters embedded in URL are sent and echoed`
- Fills `https://postman-echo.com/get?e2e_param=functional_test_value`, runs, asserts the parameter key/value appear in the parsed response and the response status is `200`.

### 11. `inspector headers table accepts key + value cell entries`
- Opens `div-table_headers` → `Open table` button → table dialog opens.
- Adds a row, then fills BOTH the `[col-id="key"]` cell with `X-E2E-Header` and the `[col-id="value"]` cell with `test-header-value` via the `fillViewTextCell` helper. The helper asserts each cell value renders as a button inside the table dialog after Save (this is the in-session validation; the test does not assert table-modal-level persistence — see "What this test does not cover").
- Closes the dialog with `btn-cancel-modal` and asserts canvas integrity.

### 12. `cURL tab switches mode and field accepts a cURL command`
- Asserts `tab_0_url` and `tab_1_curl` are visible.
- Switches to the cURL tab, asserts `textarea_str_curl_input` is visible, fills a valid cURL string, asserts the value, and asserts `handle-apirequest-shownode-curl-left` is present.

### 13. `cURL mode parses command, auto-fills URL, executes GET and returns 200`
- Switches to the cURL tab **before** touching the URL field (pre-filling `url_input` would mask a regression in the cURL parser by letting the run fall back to the URL-tab path).
- Fills the cURL command and waits for the parser to auto-populate `url_input` with `https://postman-echo.com/get`. The `waitForFunction` directly proves the parser ran.
- Runs the component and asserts the output Data contains `200`, the echoed URL, and the structural keys.

### 14. `body table accepts key + value cell entries when method is POST`
- The body field is marked `advanced=True` AND the InspectionPanel has a hardcoded filter that hides `body` whenever `method.value === "GET"` (see `InspectionPanelFields.tsx` lines 58-60 and 92-94 — the filter is keyed off `data.type === "APIRequest"` + field name `"body"`). The test switches the method dropdown to `POST` first so the body table renders in the inspector. **Note:** there is no "Show Advanced" or `edit-button-modal` step — the inspector exposes the body table directly once method is POST.
- The method switch triggers a `real_time_refresh` round-trip (`POST /api/v1/custom_component/update`). The test waits for that response BEFORE opening the body table so the `[value]` useEffect in `TableNodeComponent` finishes resetting `tempValue`. Without this wait, a click on `add-row-button` can land during the reset window and the new row is immediately wiped.
- Finds `div-table_body`, clicks `Open table`, adds a row, then fills BOTH the `[col-id="key"]` cell with `payload` and the `[col-id="value"]` cell with `e2e-body-value` via the `fillViewTextCell` helper. The helper asserts each cell value renders as a button INSIDE that specific cell after Save (cell-scoped — not dialog-wide).
- Closes the dialog with `btn-cancel-modal` — this test asserts in-session edit behavior only. End-to-end body persistence through reload is intentionally NOT covered (see "What this test does not cover").

### 15. `flow state persists in database after autosave (URL, method, headers)`
- Configures URL (`https://postman-echo.com/get?persist=true`), method (`POST`) and a headers row (`X-Persist-Header` / `persisted-value`) on a freshly created flow; captures the `flowId` from the URL.
- Like test 14, waits for the `POST /api/v1/custom_component/update` response after the method switch so the headers `[value]` useEffect settles before adding a new row.
- Clicks the dialog-level **Save** button (not Cancel, which discards `tempValue` via `handleCancel` in `TableNodeComponent`) so the row commits before autosave fires.
- Polls `GET /api/v1/flows/{id}` (using `page.request` which inherits the session cookie) until the autosave has written the URL, method and matching header row into the saved flow JSON. Polling the API directly proves the autosave reached the database — not just in-memory React state. The match key is `node.data.type === "APIRequest"` (Python class name, not the `"API Request"` display name).
- Reloads the page and re-asserts: URL field still holds the saved URL, method dropdown still reads `POST`, and reopening the headers table (after clicking the canvas node and toggling `canvas_controls_toggle_inspector` if needed) still shows the saved key/value buttons. The reload check covers UI rehydration end-to-end.

---

## Validation criterion *(required)*

The suite must:

- Use `getByTestId("popover-anchor-input-url_input")`, `getByTestId("dropdown_str_method")`, `getByTestId("button_run_api request")`, the `output-inspection-api response-apirequest` testid and (for reading the full output) `copy-output-button` — i18n-proof.
- Read execution output via the dialog's copy button + clipboard, not the Monaco editor's `textContent`: the editor is virtualized, so `textContent` only returns lines in the viewport and silently truncates fields below the fold for a verbose response. The helper clears the clipboard first (it persists across the serial tests) and polls until the fresh output lands rather than waiting on the transient "Copied to clipboard" toast.
- Retry past transient upstream outages: `runAndOpenOutput` re-runs the component (up to 3 attempts) when its own top-level `status_code` is `5xx` or when a run produces no readable output (build error / timeout). Each attempt anchors on its build event stream closing (not on the inspect button, which stays enabled across re-runs and would re-read stale output). No test here expects a 5xx, so retrying on one never masks a real assertion; once retries are exhausted on a still-5xx output it **throws loudly** rather than returning the 5xx, so a sustained outage or a regression surfacing as a 5xx fails clearly instead of slipping past a weak substring assertion (issue #383).
- Run **serially** (`test.describe.configure({ mode: "serial" })`) — parallel autosaves on flow create cause `400 "flow must be unique"` errors that flag as backend errors in the fixture.
- For each verb test, hit an endpoint that returns a non-2xx for any other verb (postman-echo returns `404`; httpbin returned `405`) — this guarantees the test fails if the wrong verb is sent (e.g. POST sent as GET), because the assertion requires `200`.
- For the cURL execution test, switch to the cURL tab *before* configuring the URL — and assert the parser auto-populates `url_input`. Asserting only the run output would let the test pass even if cURL parsing was broken.
- For the headers and body table tests, fill both KEY and VALUE cells (not key only) — filling only the key cell would still pass even if the value column was non-functional or rejected entries.
- For the body table test, switch method to POST before searching for `div-table_body` — the `InspectionPanelFields` filter hides `body` while method is GET. (There is no Controls-modal / `edit-button-modal` step — the field renders directly in the inspector once method is POST.)
- For tests 14 and 15, wait for the `POST /api/v1/custom_component/update` response after the method switch so the `[value]` useEffect in `TableNodeComponent` settles before adding a row. Without the wait, `add-row-button` can race the refresh that re-pushes the table's `value` (the freshly-added row is wiped by the useEffect reset).
- `fillViewTextCell`'s post-Save assertion is **cell-scoped** (`cellLocator.getByRole("button", { name: value })`) — a dialog-wide match would pass even if the value landed on the wrong row.
- For the persistence test, poll `GET /api/v1/flows/{id}` directly through `page.request` and *also* reload the page to verify the UI rehydrates URL, method AND the saved header row via the reopened table. Verifying only the in-memory state would let the test pass even if autosave was broken.
- For the persistence test, click the dialog-level Save button after editing the headers table — the existing `btn-cancel-modal` pattern (used in test 11) intentionally exercises in-session state only and discards `tempValue` on close.
- For the invalid URL test, call `allowFlowErrors()` so the fixture's `🚨 Backend Error` monitor does not flag the expected `400`/`422`.

---

## External dependencies *(required)*

- `tests/helpers/other/await-bootstrap-test.ts` — bootstraps the app
- `tests/helpers/ui/adjust-screen-view.ts` — fits the canvas after adding the component
- `tests/fixtures/fixtures.ts` — provides `(page as any).allowFlowErrors()` (the cast is required because the helper is injected via the fixture without a typed augmentation; see "Notes")
- `src/lfx/src/lfx/components/data_source/api_request.py` — owns the field schema (URL, method, headers/body table inputs, cURL textarea); the test would need updating if a field is renamed, removed, or its `advanced` flag changes
- `src/frontend/src/CustomNodes/GenericNode/index.tsx` — owns the inspector layout that exposes `popover-anchor-input-url_input`, `dropdown_str_method`, `div-table_headers`, `tab_0_url`, `tab_1_curl`, etc.
- `src/frontend/src/pages/FlowPage/components/InspectionPanel/components/InspectionPanelFields.tsx` — owns the `APIRequest` + `body` + GET filter that test 14 navigates around by switching method to POST
- `src/frontend/src/components/core/parameterRenderComponent/components/TableNodeComponent/index.tsx` — owns the `[value]` useEffect that drives the `real_time_refresh` race in the body table (test 14's force+retry)
- **Echo endpoint** (`ECHO_BASE_URL`, default `https://postman-echo.com`; the legacy `HTTPBIN_BASE_URL` is still honored as a fallback) — external test target for the 5 verb tests, the 404 test, the query-parameter test and the cURL-execute test. The request is made **by the Langflow backend**, so the URL must be reachable by Langflow, not by the Playwright runner. A transient upstream 5xx no longer hard-fails the suite: `runAndOpenOutput` retries on any 5xx output (issue #383). The default moved from `httpbin.org` to `postman-echo.com` after `httpbin.org` returned `503` (AWS ELB) on all retry attempts in three separate weekly runs (#383, #407) — postman-echo is a more reliable public echo with the same path surface; its only behavioral difference is returning `404` (not `405`) for a wrong verb, which is immaterial since the verb tests assert `200`. The spec derives `ECHO_HOST` from the same base URL, so the echoed-host assertions hold for any configured endpoint. Self-hosting an echo endpoint in CI was evaluated and rejected: Langflow's SSRF protection blocks the service's private IP, and — decisively — the component's `validators.url()` check rejects the single-label service hostname (`http://httpbin:8080`) that a GitHub Actions service container is reachable by. To self-host **locally**, point `ECHO_BASE_URL` at a dotted host or IP and add it to `LANGFLOW_SSRF_ALLOWED_HOSTS` on the Langflow process.

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
- An echo endpoint reachable **by Langflow** at `ECHO_BASE_URL` (defaults to outbound HTTPS to `postman-echo.com`); transient 5xx outages are absorbed by the retry in `runAndOpenOutput`
- No LLM required

---

## When to review this test *(optional)*

- The API Request field schema changes in `api_request.py` (URL, method, headers, body, curl_input field names)
- The inspector layout changes such that `popover-anchor-input-url_input`, `dropdown_str_method`, or `tab_0_url`/`tab_1_curl` testids are renamed or restructured
- The cURL parser changes its auto-fill behavior (e.g., it stops auto-populating `url_input` from the cURL command, or moves to a different field)
- The default echo endpoint needs to change — set `ECHO_BASE_URL` (no code change; the legacy `HTTPBIN_BASE_URL` is still honored). Any httpbin-/postman-echo-compatible echo server works (the spec relies only on the `/get`, `/post`, `/put`, `/patch`, `/delete`, `/status/{code}` paths, a non-2xx on the wrong verb, and the Host-echoing behavior). A self-hosted host on a private IP must be added to `LANGFLOW_SSRF_ALLOWED_HOSTS`, and the component's URL validator rejects single-label hostnames (use a dotted host or an IP)
- `InspectionPanelFields.tsx` drops the `APIRequest` + `body` + GET filter (or makes it conditional on a different field) — at that point test 14 can drop the method-switch step and mirror the headers test directly
- The `POST /api/v1/custom_component/update` endpoint is renamed or restructured — tests 14 and 15 both use `page.waitForResponse(...)` keyed on that URL substring
- The autosave debounce interval is increased substantially — bump the persistence test's polling timeout (currently 20s) to match
- The fixture is refactored to type `allowFlowErrors` properly — the `(page as any)` cast can be dropped

---

## Notes *(optional)*

- **Duplicate coverage with legacy specs.** `tests/tests-automations/regression/api/flows/api-request-component-ui.spec.ts` (4 tests: canvas render, URL field, method dropdown, headers field) is fully superseded by tests 1, 2, and 11 of this spec — its 4th test uses anti-patterns (`.catch(() => false)`, conditional advanced-button click) that this consolidated spec replaces with deterministic locators. `tests/tests-automations/regression/api/flows/api-component-regression.spec.ts` (5 tests: GET, cURL POST + JSON body with auto-fill URL, `include_httpx_metadata`, timeout 500, URL-mode POST via dropdown) is partially duplicated by tests 4, 5, and 13 here, but contains 3 unique tests (`include_httpx_metadata`, timeout, cURL POST + body). A follow-up PR should migrate those 3 unique tests here and retire both legacy specs.
- **`(page as any).allowFlowErrors()` cast.** The fixture injects `allowFlowErrors` onto the page object via `(page as any).allowFlowErrors = () => {...}`, without extending the `Page` type. Removing the cast at the call site requires extending the type signature in `fixtures.ts`. The pattern is project-wide (`loop-component-regression.spec.ts` uses the same cast).
- **Why one verb per endpoint.** `/get`, `/post`, `/put`, `/patch`, `/delete` each reject any other verb with a non-2xx (`404` on postman-echo, `405` on httpbin/go-httpbin). Since the verb tests assert the output contains `200`, the test fails if the component sends the wrong method — there's no way to silently pass with a misconfigured verb.
- **Echo endpoint resilience (issue #383).** The verb/404/query/cURL tests originally hard-coded `https://httpbin.org/...`. A transient httpbin.org `503` (AWS ELB) hard-failed the POST test and flaked GET in the weekly run, opening #383. The fix makes the suite tolerate transient outages without masking a real regression:
  - **Retry**, not self-hosting. `runAndOpenOutput` re-runs the component (up to 3 attempts) when the output carries any `5xx` `status_code` or a run produces no readable output. Self-hosting a `mccutchen/go-httpbin` service container in the weekly workflow was implemented and tested first, but rejected after a CI run surfaced a hard blocker: the component's `validators.url()` rejects the single-label service hostname (`http://httpbin:8080`) that a GitHub Actions service container is reachable by (it also requires an SSRF allowlist for the service's private IP). `validators.url` accepts dotted hosts and IPs but not bare labels — which is why local testing via `host.containers.internal` passed and CI did not.
  - **Endpoint override kept.** URLs are built from `ECHO_BASE_URL` (default `https://postman-echo.com`; legacy `HTTPBIN_BASE_URL` still honored) and the echoed-host assertions derive `ECHO_HOST` from the same base, so a different endpoint can be configured without code changes.
  - **Full-output read.** `runAndOpenOutput` reads the COMPLETE output via the dialog's copy button + clipboard (`copy-output-button`) instead of the truncation-prone virtualized Monaco `textContent` — a robustness fix kept from the self-hosting attempt (a verbose response can push asserted fields like `url` below the editor's viewport).
  - Validated against nightly `1.11.0.dev8`, 15/15 green against public httpbin.org — no product regression behind the original failure, confirming it was purely the external outage. `@stable` was restored on the POST test in the same change.
- **Default endpoint moved to postman-echo.com (issue #407).** The retry above only survives a transient blip *within* a single test window. `httpbin.org` returned `503` (AWS ELB) on **all** retry attempts in the weekly runs of 2026-06-08, 2026-06-15 (#383) and 2026-06-22 (#407) — a sustained outage the retry cannot absorb. After the third recurrence the default echo endpoint moved from `httpbin.org` to `postman-echo.com`, empirically verified as a near drop-in: `/get`, `/post`, `/put`, `/patch`, `/delete` each 200 only for the matching verb, `/status/{code}` is a deliberate status endpoint, query params echo in `args`, and the response body echoes `host`/`url`. The one difference — a wrong verb returns `404` instead of httpbin's `405` — is immaterial to the verb tests, which assert the output contains `200` (and `404` is just as much "not 200"). The env knob was renamed `ECHO_BASE_URL` (the old `HTTPBIN_BASE_URL` is still honored as a fallback) and the constants are now `ECHO_BASE` / `ECHO_HOST`.
- **cURL pre-fill anti-pattern (fixed).** The previous version of test 13 pre-populated `url_input` before switching to the cURL tab. The run would then succeed via the URL-tab path even if the cURL parser was broken. The current test switches to the cURL tab first and waits for the parser to auto-populate `url_input` — the run is genuinely driven by the cURL command.
- **Headers table value-cell gap (fixed).** The previous version of test 11 only filled the key cell and closed the dialog with Cancel. It would have passed even if the value column was non-functional. The current version fills both key and value cells via `fillViewTextCell`, which asserts each cell renders as a button after Save inside the table dialog — closing the gap.
