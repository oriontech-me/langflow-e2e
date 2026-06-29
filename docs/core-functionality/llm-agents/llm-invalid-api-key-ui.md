# LLM Invalid API Key UI Error Display

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that the Langflow Playground surfaces a visible error to the user when the execution endpoint returns HTTP 500 (simulating an invalid API key), and that the chat input remains fully usable after the error — no stuck loading state, no disabled input. Both scenarios are covered using `page.route` to mock `POST /api/v2/workflows` (the endpoint the Playground uses for execution on 1.11.x+), so no real LLM call or API key is required.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@agents` `@playground`

---

## Step-by-step *(required)*

**Test 1 — playground shows error when LLM run endpoint returns 500**

1. `setupPlayground(page)` — creates a blank flow with Chat Input and Chat Output connected, and navigates to the flow editor
2. Click `playground-btn-flow-io` and wait for `input-chat-playground` (playground fully loaded)
3. Register a `page.route` intercept for `**/api/v2/workflows**` that fulfills the `POST` with status 500 and body `{ detail: "Invalid API key…" }`, and lets non-POST calls pass through
4. Fill input with "trigger error" and click `button-send`
5. Poll up to 10 s for any of: text matching `/error|invalid|api key|failed/i`, an element with `class*="error"` / `role="alert"`, or a `data-testid*="error"` element
6. Assert `errorVisible === true`

**Test 2 — playground input remains usable after API error**

1. Same setup as Test 1 (separate flow, same mock)
2. Register `page.waitForResponse` for a `POST` response whose URL contains `/api/v2/workflows` before triggering the request
3. Send "trigger error" and click `button-send`
4. Await the `waitForResponse` promise — confirms the full mocked 500 cycle completed
5. Assert `input-chat-playground` is visible (timeout 5 s) and enabled (timeout 5 s)
6. Fill input with "follow-up message" and assert `toHaveValue("follow-up message")` — confirms the input is fully interactive

Both tests call `page.allowFlowErrors()` because they intentionally inject a 500 on the run endpoint.

---

## Validation criteria *(required)*

- The Playground displays at least one visible error indicator (text, toast, or `role="alert"`) within 10 s of the mocked 500 response
- After the error, `input-chat-playground` is visible and enabled without a manual page refresh
- The input can be filled with a follow-up message, confirming no stuck state

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/` — renders `input-chat-playground`, `button-send`, and the error/toast UI; renaming or removing these `data-testid` attributes breaks both tests
- `src/frontend/src/components/core/flowToolbarComponent/` — `playground-btn-flow-io` button; changes break the Playground open step
- `src/backend/base/langflow/api/v2/` — the `POST /api/v2/workflows` execution endpoint being mocked; structural URL changes would require updating the route pattern (this endpoint replaced `/api/v1/build/{flow_id}/flow` in 1.11.x)

---

## What this test does not cover *(optional)*

- Real LLM API key validation (no actual network request is made)
- Error messages for other failure modes (4xx codes, network timeouts)
- Retry logic or automatic recovery after the error

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No real API key needed — both tests rely entirely on `page.route` mocking

---

## Notes *(optional)*

- `page.route` intercepts before the request leaves the browser, so no real HTTP call reaches the Langflow backend. The 500 response is synthesized entirely in the browser process.
- The mock targets `**/api/v2/workflows**` and only fulfills the `POST` (the run call); other methods are passed through with `route.continue()` so the playground initializes normally.
- The mock is registered AFTER the playground is fully open (`input-chat-playground` visible) to avoid intercepting initialization calls.
- Test 1 uses a flexible multi-locator check (`errorIndicators`) to be resilient to different error-surface implementations (text node, toast, alert element, or CSS class).
- Test 2 uses `page.waitForResponse` on the `POST /api/v2/workflows` URL to confirm the full 500 cycle completed before asserting input recovery, making the assertion deterministic.
- History: the Playground execution path migrated from `POST /api/v1/build/{flow_id}/flow` to `POST /api/v2/workflows` in Langflow 1.11.x; the mock + waiter were updated accordingly (issue #444).
