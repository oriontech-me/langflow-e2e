# LLM Invalid API Key UI Error Display

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that the Langflow Playground surfaces a visible error to the user when the LLM run endpoint returns HTTP 500 (simulating an invalid API key), and that the chat input remains fully usable after the error — no stuck loading state, no disabled input. Both scenarios are covered using `page.route` to mock `/api/v1/run/**`, so no real LLM call or API key is required.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@agents` `@playground`

---

## Step-by-step *(required)*

**Test 1 — playground shows error when LLM run endpoint returns 500**

1. `setupPlayground(page)` — creates a Simple Agent flow and navigates to the flow editor
2. Register a `page.route` intercept for `**/api/v1/run/**` that fulfills with status 500 and body `{ detail: "Invalid API key…" }`
3. Click `playground-btn-flow-io` and wait for `input-chat-playground`
4. Fill input with "trigger error" and click `button-send`
5. Poll up to 10 s for any of: text matching `/error|invalid|api key|failed/i`, an element with `class*="error"` / `role="alert"`, or a `data-testid*="error"` element
6. Assert `errorVisible === true`

**Test 2 — playground input remains usable after API error**

1. Same setup as Test 1 (separate flow, same mock)
2. Send "trigger error" and click `button-send`
3. Assert `input-chat-playground` is visible (timeout 5 s) and enabled (timeout 5 s) — the assertions absorb the brief post-error processing delay
4. Fill input with "follow-up message" and assert `toHaveValue("follow-up message")` — confirms the input is fully interactive

---

## Validation criteria *(required)*

- The Playground displays at least one visible error indicator (text, toast, or `role="alert"`) within 10 s of the mocked 500 response
- After the error, `input-chat-playground` is visible and enabled without a manual page refresh
- The input can be filled with a follow-up message, confirming no stuck state

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/` — renders `input-chat-playground`, `button-send`, and the error/toast UI; renaming or removing these `data-testid` attributes breaks both tests
- `src/frontend/src/components/core/flowToolbarComponent/` — `playground-btn-flow-io` button; changes break the Playground open step
- `src/backend/base/langflow/api/v1/endpoints.py` — the `/api/v1/run/{flow_id}` endpoint being mocked; structural URL changes would require updating the route pattern

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
- Test 1 uses a flexible multi-locator check (`errorIndicators`) to be resilient to different error-surface implementations (text node, toast, alert element, or CSS class).
- The `waitForTimeout(3000)` that was present in Test 2 was removed during validation; the `toBeEnabled({ timeout: 5000 })` assertion already absorbs the post-error state transition.
