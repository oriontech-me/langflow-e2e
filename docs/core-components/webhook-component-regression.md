# Webhook Component — Regression

**Last validated:** Langflow 1.12.x (`1.12.0.dev8`)

---

## What this test validates *(required)*

Validates the full surface of the Webhook component: rendering on the canvas, HTTP endpoint behavior, payload handling, inspector UI fields, and the monitor messages API.

The 10 tests cover:

1. **HTTP POST — JSON and plain-text bodies** — the endpoint accepts both `application/json` and `text/plain` bodies, returning 202 with `{"status": "in progress"}` in both cases.
2. **Flow persistence** — after autosave, the flow is retrievable via `GET /api/v1/flows/{id}` (read with an authenticated `request.get`, see the note below) and contains a Webhook node whose `endpoint.value` stores the `"BACKEND_URL"` placeholder (substituted by the frontend at render time).
3. **cURL inspector field** — the inspector panel shows a pre-filled cURL command with `-X POST`, the correct `/api/v1/webhook/{flowId}` URL, `Content-Type: application/json`, and `-d`.
4. **Empty data field** — running the component with no payload produces `{}` in the output inspection modal (`build_data()` short-circuit path).
5. **Endpoint field renders real URL** — the `str_endpoint` field shows the actual webhook URL (protocol + host + `/api/v1/webhook/`), confirming the `BACKEND_URL` placeholder was resolved by the frontend.
6. **Copy button** — clicking `btn_copy_str_endpoint` shows the "Endpoint URL copied" toast and writes the correct URL to the clipboard.
7. **404 for non-existent flow** — `POST /api/v1/webhook/non-existent-flow-e2e-regression-test` returns 404.
8. **Valid JSON payload propagated** — injecting `{"event": "regression-test", "value": 42}` into the `data` field and running produces the same object in the output inspection modal.
9. **Invalid JSON payload fallback** — injecting a non-JSON string produces `{"payload": "<raw string>"}` in the output inspection modal (`json.JSONDecodeError` fallback path in `build_data()`).
10. **Monitor messages API** — `GET /api/v1/monitor/messages` returns 200 with an array body.

If any of these tests fails, the Webhook component is broken in one of its core contracts: HTTP acceptance, payload parsing, UI rendering, or the monitor API.

---

## Tags *(required)*

`@stable` `@release` `@regression`

All 10 tests carry `@stable`. There are no exceptions.

**Test 2 was quarantined and is no longer** (#990). Between 2026-05-11 and
2026-07-28 test 2 ran as `test.fixme` without `@stable`: it read the persisted
flow with `page.evaluate(fetch)`, and the Langflow frontend bundle's `fetch`
wrapper throws `TypeError: Cannot set properties of undefined (setting
'Accept-Language')` on that call. The quarantine was hung on an upstream fix that
was **never requested** — #180 was closed with all four of its own criteria
unchecked, the first being "upstream issue filed", so the test waited 2½ months
for an event nobody triggered. The frontend defect is real and still present on
`1.12.0.dev8` (see *The frontend `fetch` wrapper defect* below), but it is not
this test's subject: test 2 asserts flow persistence and the `BACKEND_URL`
placeholder, and reads the flow through an authenticated `request.get` instead —
which never enters the buggy wrapper.

---

## Step by step *(required)*

**Setup helper — `addWebhookComponent`** (shared by tests 1–9)
1. Call `awaitBootstrapTest`, then wait for the network to go idle (lets the home page's own transient-flow sweep finish before we create a flow — see Notes)
2. Click `blank-flow`, then capture the created flow id from the `POST /api/v1/flows/` response so `afterEach` can delete only that flow (scoped teardown, #515 — never a global `cleanAllFlows`, which races concurrent workers). The canvas `/flow/{id}` URL id is a transient client-side handle here and 404s on delete; the tests still read it for their own webhook-endpoint assertions, which resolve fine by that id
3. Search "webhook" in the sidebar and wait for `input_outputWebhook` to appear
4. Hover over the result and click `add-component-button-webhook`
5. Call `adjustScreenView`
6. Wait for `input_output_webhook_draggable` to confirm the node is on the canvas

**Cleanup — `test.afterEach`** (all tests)
1. Navigate off the editor (`page.goto("/")`) so the unmounted flow page stops polling, then delete only the captured flow id via `deleteFlow` (authenticated with `getAuthToken`), so each test removes exactly the flow it created and nothing else (#515)

**Test 1 — HTTP POST accepts JSON and plain-text bodies returning 202**
1. Run `addWebhookComponent`
2. Extract `flowId` from the URL and assert it matches UUID pattern
3. Wait 4 s for autosave to persist the flow
4. Create a temporary API key via `POST /api/v1/api_key/` (Langflow's `WEBHOOK_AUTH_ENABLE` defaults to `True` since 1.9.2+ via PR langflow-ai/langflow#12845, so unauthenticated webhook POSTs return 403)
5. POST `{"event": "regression-test", "value": 42}` to `/api/v1/webhook/{flowId}` with `x-api-key`; assert 202, `status === "in progress"`, `message === "Task started in the background"`
6. POST `"regression-plain-text"` with `x-api-key` and `Content-Type: text/plain`; assert 202 and `status === "in progress"`
7. In `finally`, delete the temporary API key so failures don't leak credentials

**Test 2 — flow is saved to database and contains the Webhook node**
1. Run `addWebhookComponent`
2. Wait 4 s for autosave
3. `GET /api/v1/flows/{flowId}` through the `request` fixture with an explicit
   `Authorization` header from `getAuthToken(request)`; treat a non-ok response
   as `null` so the assertion in step 4 reports "flow not persisted" rather than
   a raw HTTP failure. The read runs **outside** the browser context on purpose —
   see the note on the frontend `fetch` wrapper below
4. Assert the response is not null and contains a node with `data.type === "Webhook"`
5. Assert `webhookNode.data.node.template.endpoint.value === "BACKEND_URL"`

**Test 3 — cURL command in inspector shows valid POST URL with flow ID**
1. Run `addWebhookComponent`
2. Extract `flowId` from the URL
3. dev49: the generated cURL command is an advanced field. Select the node
   (`title-Webhook`), expose it on the body via the inspector
   (`openAdvancedOptions` → `inspector-add-curl` → `closeAdvancedOptions`),
   open its text-area modal (`button_open_text_area_modal_str_curl`) and read
   `text-area-modal`'s value (same path as `general-bugs-component-webhook-api-key-display`)
4. Assert the value contains `-X POST`, `/api/v1/webhook/{flowId}`, `Content-Type: application/json`, and `-d`

**Test 4 — empty data field returns empty Data object**
1. Run `addWebhookComponent`
2. Click `button_run_webhook` and wait for "built successfully"
3. Click `output-inspection-json-webhook`
4. Wait for `[role="dialog"]` and read the editor textbox content
5. Parse as JSON and assert it equals `{}`
6. Press Escape to close

**Test 5 — endpoint field renders the actual webhook URL**
1. Run `addWebhookComponent`
2. Wait for `str_endpoint` and read its value
3. Assert value matches `/^https?:\/\//` and contains `/api/v1/webhook/`

**Test 6 — copy button copies the endpoint URL to clipboard**
1. Run `addWebhookComponent`
2. Read the expected URL from `str_endpoint`
3. Click `btn_copy_str_endpoint`
4. Assert the "Endpoint URL copied" toast is visible
5. Read `navigator.clipboard.readText()` via `page.evaluate` and assert it equals the expected URL

**Test 7 — POST to non-existent flow name returns 404**
1. Create a temporary API key via `POST /api/v1/api_key/` (Langflow's `WEBHOOK_AUTH_ENABLE` defaults to `True` since 1.9.2+ via PR langflow-ai/langflow#12845, so the auth dependency runs before the flow lookup; without `x-api-key` the endpoint short-circuits to 403 and never reaches the 404 path)
2. POST to `/api/v1/webhook/non-existent-flow-e2e-regression-test` with the `x-api-key` header
3. Assert the response status is 404 (no browser navigation needed)
4. In `finally`, delete the temporary API key so failures don't leak credentials

**Setup helper — `loadFlowWithDataField`** (shared by tests 8–9)
1. Register a `page.route` intercept on `GET /api/v1/flows/{flowId}`
2. Fetch the real response, find the Webhook node, and set `template.data.value` to the provided string
3. Navigate to `/flow/{flowId}` and wait for `canvas_controls_dropdown` and `button_run_webhook`
4. Call `adjustScreenView` and `page.unroute` to clean up

**Test 8 — valid JSON payload is propagated as structured Data output**
1. Run `addWebhookComponent`, extract `flowId`, wait 4 s for autosave
2. Call `loadFlowWithDataField` with `'{"event": "regression-test", "value": 42}'`
3. Click `button_run_webhook` and wait for "built successfully"
4. Click `output-inspection-json-webhook`, wait for dialog, read editor content
5. Parse as JSON and assert it equals `{"event": "regression-test", "value": 42}`
6. Press Escape

**Test 9 — invalid JSON payload is encapsulated in `{payload: ...}`**
1. Run `addWebhookComponent`, extract `flowId`, wait 4 s for autosave
2. Call `loadFlowWithDataField` with `"not valid json {{broken"`
3. Click `button_run_webhook` and wait for "built successfully"
4. Click `output-inspection-json-webhook`, wait for dialog, read editor content
5. Parse as JSON and assert it equals `{"payload": "not valid json {{broken"}`
6. Press Escape

**Test 10 — GET /api/v1/monitor/messages returns 200 with array response**
1. Call `getAuthToken(request)` to obtain a bearer token
2. GET `/api/v1/monitor/messages` with `Authorization` header
3. Assert status 200 and that the response body is an array

---

## Validation criterion *(required)*

- `POST /api/v1/webhook/{flowId}` returns 202 for both JSON and plain-text bodies
- The autosaved flow is retrievable via the flows API and contains a Webhook node with `endpoint.value === "BACKEND_URL"`
- The cURL inspector field shows a command with correct method, URL, Content-Type header, and body flag
- Running with empty `data` produces `{}` in the output inspection modal
- The `str_endpoint` field displays a fully resolved URL beginning with `http://` or `https://`
- The copy button shows a toast and writes the endpoint URL to the clipboard exactly
- `POST` to a non-existent flow name returns 404
- A valid JSON string in `data` produces the parsed object in the output inspection modal
- An invalid JSON string in `data` is wrapped as `{"payload": "<raw string>"}` in the output inspection modal
- `GET /api/v1/monitor/messages` returns 200 with an array body

**Concrete gate for lifting test 2's quarantine (#990)** — the quarantine is not
lifted by "it passed once". All four hold:

1. The whole file passes 3× in a row at `--workers=1 --retries=0` — 10 tests,
   0 skipped (a `test.fixme` still left in place would report `9 passed, 1 skipped`,
   so the count itself proves the quarantine is gone).
2. The file passes at `--workers=2 --repeat-each=2` — the concurrency re-check
   applied in PR #986. The file is `test.describe.configure({ mode: "serial" })`
   and every test creates a flow, so a cross-worker collision would show up as
   `400 flow must be unique` or a 404 on a sibling's flow id.
3. `GET /api/v1/flows/` reports the **same flow count before and after** the run
   (scoped teardown, #515) — 0 orphans. Not "a DELETE was issued": the observable
   is the count.
4. Test 2 fails for the right reason when mutated — forcing the expected
   placeholder to a wrong value, or pointing the read at a non-existent flow id,
   must produce a failed assertion, never a silent pass.

---

## The frontend `fetch` wrapper defect (`Accept-Language` TypeError)

Recorded here because it is a **real Langflow frontend defect that this suite
deliberately stopped exercising** — and because leaving that implicit is what
turned #180 into 2½ months of orphaned debt.

Langflow's frontend patches `window.fetch` with `fetch-intercept` and registers a
request interceptor that injects the i18n language header:

```js
// assets/index-DA5lq9QP.js (1.12.0.dev8), inside the auth-interceptor effect
const h = { "Accept-Language": i18n.language || "en" };
vHr.register({
  request: (_, R) => {
    if (!x(_)) for (const [k, D] of Object.entries(h)) R.headers[k] = D;
    return [_, R];
  },
});
// x = url => ["https://raw.githubusercontent.com","https://api.github.com",
//             "https://api.segment.io","https://cdn.sprig.com"]
//            .some(o => new URL(url).origin === o)   // throws on a relative URL -> false
```

`R` is `fetch`'s second argument and `R.headers` its header init. The interceptor
assumes both exist and that `headers` is a plain mutable object. So a call to a
**relative** URL (`x` returns `false` because `new URL()` throws on it) crashes
whenever the init omits `headers`:

Measured live on `1.12.0.dev8` against `/api/v1/version` from the page context.
Reproduce it in ~10 seconds from the devtools console on any Langflow page:

```js
await fetch("/api/v1/version");                             // TypeError
await fetch("/api/v1/version", { credentials: "include" }); // TypeError
await fetch("/api/v1/version", { headers: {} });            // 200, header sent
await fetch("/api/v1/version", { headers: new Headers() }); // 200, header LOST
```


| Call from the page context | Result |
|---|---|
| `fetch(url)` | `TypeError: Cannot read properties of undefined (reading 'headers')` |
| `fetch(url, { credentials: "include" })` | `TypeError: Cannot set properties of undefined (setting 'Accept-Language')` |
| `fetch(url, { headers: {} })` | `200`, and `accept-language: en` arrives on the wire |
| `fetch(url, { headers: new Headers() })` | `200`, but `accept-language` is **absent** on the wire |

Row 2 is exactly what test 2 used to do. Row 4 is a **second, independent
defect** in the same three lines: `R.headers[k] = D` on a `Headers` instance sets
a plain JS property instead of a header, so the injection silently no-ops for the
standard Web-API idiom — the user's language is dropped without any error.

**Why we stop being exposed to it.** The only reason the test ran a `fetch` inside
the page was the claim in its own comment that "the `request` fixture is
unauthenticated and would get a 403 from the flows endpoint even in auto-login
mode". That is half-true and no longer a constraint: `GET /api/v1/flows/` does
answer `403` unauthenticated, but `getAuthToken()` mints a bearer from
`/api/v1/auto_login` and the same endpoint then answers `200`. The helper is
already imported in this very spec file, and used by tests 1, 7, and 10.

**What is lost.** The browser-context `fetch` incidentally exercised the
frontend's own HTTP path, so it would trip on this bundle defect. That was never
this test's purpose, and a webhook-persistence test is a poor place to catch a
bundle regression — if we want that covered it belongs in a deliberate UI test.
Note also that the app's own API traffic goes through its axios instance (XHR
adapter), which does **not** route through the patched `window.fetch` — which is
why normal use never surfaces this, and why the incidental coverage was weak.

**Decision on filing it upstream: NO — decided 2026-07-28, and recorded here on
purpose.** Not "we forgot", not "someone should look at it": we deliberately do
not report it. The reason is the paragraph above — Langflow's own API traffic goes
through axios's XHR adapter and never enters the patched `window.fetch`, so no
user-facing behaviour is broken by either defect. The only consumers that reach
those three lines are page-level scripts, which is what our test used to be and
no longer is. That makes this a **non-user-facing gap**, and by the rule in
`CLAUDE.md` → *REGRESSIONS.md* a finding that downgrades to a non-user-facing gap
is listed nowhere: no ledger row, no candidate row, no upstream ticket.

Recording it as a decision rather than a silence is the whole point. #180 was
closed with "upstream issue filed" unchecked and no explanation, and a test sat
quarantined for 2½ months waiting on a ticket nobody had opened. The failure mode
was the implicitness, not the verdict — so if this ever needs revisiting (an
`accept-language` bug report from a user, axios migrating to the fetch adapter,
or a component adopting native `fetch`), the mechanism, the four measured cases,
and the reason we walked away are all in this section.

---

## External dependencies *(required)*

- `src/backend/base/langflow/components/inputs/webhook.py` — `WebhookComponent.build_data()`: JSON parsing, fallback wrapping, and empty-data short-circuit; changes here break tests 4, 8, and 9
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/webhook/{flow_id_or_name}` and `GET /api/v1/monitor/messages` endpoints; status codes and response shape affect tests 1, 7, and 10
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputParameter/` — renders `output-inspection-{name}-{component}` buttons; the `output-inspection-json-webhook` testid depends on the output `display_name` being `"JSON"` (updated in langflow-ai/langflow#11554); breaks tests 4, 8, and 9
- `src/frontend/src/components/core/parameterRenderComponent/components/webhookFieldComponent/` — renders the cURL field (an advanced field on dev49, exposed via the inspector and read from its `text-area-modal`); changes to the rendering break test 3
- `src/frontend/src/components/core/parameterRenderComponent/components/copyFieldAreaComponent/` — renders `btn_copy_{id}` and the "Endpoint URL copied" toast; breaks test 6
- `src/frontend/src/CustomNodes/GenericNode/` — resolves the `BACKEND_URL` placeholder for `str_endpoint` and `curl_webhook` fields; breaks tests 2, 3, and 5

---

## What this test does not cover *(optional)*

- Webhook with authentication (API key in the request header)
- Concurrent or high-frequency POST requests to the same flow
- Binary or multipart payloads
- Webhook connected to downstream components and producing a chained output
- Webhook endpoint_name customization (using a slug instead of UUID in the URL)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The Webhook component is a pure HTTP input with no LLM calls, but the webhook POST endpoint requires an API key whenever `WEBHOOK_AUTH_ENABLE=True` (Langflow's default since 1.9.2+ via PR langflow-ai/langflow#12845); tests 1 and 7 create a temporary key via `POST /api/v1/api_key/` and delete it in `finally`
- Tests 1, 8, and 9 require autosave to flush within 4 s of creating the flow; environments with very high DB latency may need a longer wait
- The `output-inspection-json-webhook` testid requires Langflow version including langflow-ai/langflow#11554, which renamed the output display name from `"Data"` to `"JSON"`

---

## When to review this test *(optional)*

- If the Webhook component output display name changes again (away from `"JSON"`), the `output-inspection-json-webhook` selector in tests 4, 8, and 9 will break
- If the `BACKEND_URL` or `CURL_WEBHOOK` placeholder strings are renamed in the frontend substitution logic
- If the `/api/v1/webhook/` route path changes in the backend router
- If `CopyFieldAreaComponent` changes its testid pattern (`btn_copy_{id}`)

---

## Notes *(optional)*

- **Cleanup is scoped to the test's own flow — never a pre-test wipe.** `addWebhookComponent` used to call `cleanAllFlows` before each test "to avoid 400 'flow must be unique' under parallelism". That wipe deleted flows other parallel workers were actively driving — it was the collider behind the recurring `tool-mode.spec.ts` daily flake (#464: the victim's build request started 404ing `"Flow not found"` on its own flow id). It was replaced by scoped teardown (#515): each test captures the id from its blank-flow `POST /api/v1/flows/` 201 and `test.afterEach` deletes exactly that id. The uniqueness justification for the wipe no longer holds either — the backend auto-suffixes duplicate names (`Untitled document (1)`).
- **Post-bootstrap network-idle wait.** When transient "New Flow" flows exist at home-page mount, the Langflow frontend sweeps them with a batch `DELETE /api/v1/flows/` of its own. If our blank-flow `POST` lands mid-sweep, SQLite raises `database is locked` and the sweep 500s (`Unable to cascade delete flow`, upstream weakness in `delete_multiple_flows` — log-only via the fixture, no test impact, no flow leak since afterEach still deletes the captured id; observed 2× in 5 file runs). Waiting for network idle after `awaitBootstrapTest` serializes the sweep before our flow creation, removing the contention window (#464). The old pre-test wipe masked this by emptying transients first — the wait replaces that side-effect without the destructive wipe.

- Tests 8 and 9 use `page.route` to inject a value into the Webhook's `data` field (Payload, `advanced=True`), which has no editable UI in the inspector. The intercept patches the `GET /api/v1/flows/{id}` response before the page navigates to the flow, simulating what the real webhook POST would write to that field. The intercept is removed via `page.unroute` after navigation to avoid side-effects.
- The `request` fixture used in tests 1 and 7 is unauthenticated by default; both tests now create a temporary `x-api-key` because Langflow's `WEBHOOK_AUTH_ENABLE` defaults to `True` since 1.9.2+ (PR langflow-ai/langflow#12845). The auth dependency `get_webhook_user` runs before `get_flow_by_id_or_endpoint_name` inside `get_webhook_auth`, so without an API key the endpoint returns 403 before any flow resolution — that is why test 7 also needs to authenticate to reach the 404 path.
- **`GET /api/v1/flows/{id}` does not require session cookies** — a bearer token from `getAuthToken()` is enough (verified on `1.12.0.dev8`: `403` with no auth, `200` with the `Authorization` header). The opposite claim used to justify test 2's `page.evaluate(fetch)`, which is what exposed it to the frontend `fetch`-wrapper defect and got it quarantined for 2½ months (#990). Test 2 now uses the authenticated `request.get`.
- The `output-inspection-json-webhook` testid is generated dynamically by the frontend as `output-inspection-{display_name.toLowerCase()}-{component_type}`; if the output display name reverts to `"Data"`, the testid becomes `output-inspection-data-webhook`.
