# Execution Error Notifications — Network / Server Errors During Flow Execution

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that when a flow execution request fails at the network or server
layer, the Langflow playground surfaces an explicit, user-visible error — not a
silent hang. Three failure modes, each against the real execution endpoint
`POST /api/v2/workflows` (the playground's SSE run channel on 1.11):

1. **Network error (`@stable`, §8.4 "Network error during execution")** — the
   execution request is aborted at the transport layer (simulated dropped
   connection / timeout). The UI must report the run failed **and** attribute it
   to the network: the persistent notification entry reads **"Workflow run
   failed"** with detail **"Failed to fetch"** (the browser's transport-error
   message — the distinctive signal that separates a network failure from a
   server-side failure).
2. **Server error (5xx) (`@stable`, §8.2 "Execution error notification")** — the
   execution request returns an HTTP 5xx (503). The UI must report **"Workflow
   run failed"** in the persistent notification center (server-detail path,
   distinct from the transport "Failed to fetch" message). This is the §8.2
   execution-error notification: a genuine run failure produces a notification
   entry.
3. **Loading state** — while a delayed execution is in flight, the UI must show
   an in-progress affordance (stop button / disabled send / spinner) so the user
   knows work is happening.

If this breaks, an execution that dies at the network or server layer would fail
silently — the user sees no feedback and cannot tell a hung run from a broken
one.

---

## Tags *(required)*

- **Network-error test:** `@stable` `@release` `@workspace` `@observability`
- **Server-error test:** `@stable` `@release` `@workspace` `@observability`
- **Loading-state test:** `@release` `@workspace` `@observability`

Two tests are `@stable`, promoted under separate checklist bullets:
- The **network-error** test maps to §8.4 "Network error during execution"
  (promoted under #693).
- The **server-error** test maps to §8.2 Notifications → "Execution error
  notification" (promoted under #688): a genuine server-side execution failure
  (5xx) surfaces a persistent notification entry. This is the distinctive
  §8.2 observable — the error notification itself, independent of the transport
  layer.

The **loading-state** test remains `@release`: it validates the in-progress
affordance, not an error notification, so it maps to neither §8.2 nor a
promotion bullet in scope.

---

## Step by step *(required)*

Shared setup (`setupChatFlow`): bootstrap the app (`awaitBootstrapTest`), open a
blank flow, add **Chat Output** and **Chat Input**, connect ChatInput source →
ChatOutput target. Every created flow id is captured from its
`POST /api/v1/flows → 201` response and deleted id-scoped in `afterEach`.
`page.allowFlowErrors()` is set because each test intentionally fails a run.

**Network-error test (`@stable`):**
1. Run `setupChatFlow`
2. Open the playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`
3. Route `**/api/v2/workflows` to `route.abort("timedout")` (transport failure)
4. Send a message (`button-send`)
5. Open the notifications dropdown (`notification_button`)
6. Assert `notification-dropdown-content` shows **"Workflow run failed"** and
   **"Failed to fetch"**

**Server-error test:**
1–2. Same setup + open playground
3. Route `**/api/v2/workflows` to fulfill HTTP 503 with a `detail` body (503,
   not 500 — see Notes on the fixture response monitor)
4. Send a message
5. Open the notifications dropdown; assert **"Workflow run failed"** is visible

**Loading-state test:**
1–2. Same setup + open playground
3. Route `**/api/v2/workflows` to a delayed (~1.5 s) SSE `end` response
4. Send a message
5. While the response is pending, assert an in-progress indicator (stop button /
   disabled send / spinner) is visible

---

## Validation criterion *(required)*

- **Network error:** after aborting `/api/v2/workflows` and opening the
  notifications dropdown, `notification-dropdown-content` contains the exact text
  **"Workflow run failed"** AND **"Failed to fetch"**. This is asserted against
  the **persistent** dropdown entry, not the auto-dismissing slide-in toast, so
  the check is race-free.
- **Server error:** the notifications dropdown contains **"Workflow run failed"**
  after a 5xx (503).
- **Loading state:** an in-progress affordance is visible while the delayed run
  is pending.

Each assertion targets a single, distinctive observable — no fuzzy
`error|failed|network` OR-chain, no `.catch(() => false)` swallow. A mutated
assertion (e.g. asserting the wrong error text) fails deterministically.

---

## External dependencies *(required)*

- `POST /api/v2/workflows` — the playground execution channel on 1.11 (SSE,
  `text/event-stream`); the endpoint the mocks intercept. Replaced the retired
  `POST /api/v1/build/{id}/flow` path.
- `data-testid="notification_button"` — header notification bell
- `data-testid="notification-dropdown-content"` — persistent notifications list
- `data-testid="playground-btn-flow-io"` / `input-chat-playground` /
  `button-send` — playground open, chat input, send
- `data-testid="input_outputChat Input"` / `input_outputChat Output` /
  `add-component-button-chat-input` / `add-component-button-chat-output` /
  `sidebar-search-input` — component sidebar entries and add buttons
- No API key required — the run is intercepted before reaching any provider.

---

## What this test does not cover *(optional)*

- Dismissing / clearing the notification entry
- Retrying a failed run
- Real (unmocked) network failures — the transport error is simulated via
  Playwright route abort
- Error surfaces outside the notification center (inline chat error styling)

---

## Notes *(optional)*

- **Endpoint migration (root cause of the hardening).** The original file routed
  `**/api/v1/build/**`, which on 1.11 is never called by the playground —
  execution moved to `POST /api/v2/workflows` (SSE). With the stale route the
  mock never intercepted, the run actually succeeded, and the soft
  `isVisible().catch(() => false)` OR-chains "passed" on incidental page text.
  All three tests were repointed to `/api/v2/workflows` and given deterministic
  assertions. Verified live on 1.11.0.dev41 via `playwright-cli` (abort →
  "Workflow run failed" + "Failed to fetch"; the transient toast title reads
  "Flow build failed" but the persistent dropdown reads "Workflow run failed").
- **Assert the persistent dropdown, not the toast.** The slide-in build-error
  toast auto-dismisses; the notification-dropdown entry persists. Asserting the
  dropdown avoids the toast-fade race (same lesson as #695).
- **Server-error status = 503, not 500.** The fixture's global response monitor
  (`fixtures.ts`) flags any real backend `400/404/422/500` on the shared
  instance. The server-error test mocks a 5xx, so it uses **503** — outside that
  monitored set — to exercise the same "Workflow run failed" path without
  registering a false instance error. The network-error and loading-state tests
  are inherently clean (a transport abort yields no HTTP response; a held-open
  request stays pending), so only the server-error test needed this.
- **Flow cleanup.** `setupChatFlow` creates a flow per test; ids are captured
  from `POST /api/v1/flows → 201` (a bare `page.url()` races the bootstrap
  flow's stale id — #490/#681) and deleted in `afterEach`.
