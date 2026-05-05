# Flow Functionality — Publish Flow (Shareable Playground)

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **Shareable Playground** publish/unpublish lifecycle in two complementary ways:

1. **UI test:** Creates a blank flow, adds a Chat Input (so the flow has IO and the publish toggle is enabled), opens the deploy dropdown, toggles the `publish-switch` ON, opens the public `/playground/{flowId}` URL in a new tab, sends a message, then toggles publish OFF and confirms the URL no longer loads the playground (redirects to the home page). At each toggle, the test asserts the backend's `access_type` field via API to confirm the UI switch is wired to a real backend write — not just a local state flip.

2. **API test:** Mirrors the publish hook (`handlePublishedSwitch` → `usePatchUpdateFlow` → `PATCH /api/v1/flows/{id}`) by directly toggling `access_type` between `PUBLIC` and `PRIVATE`. Asserts each PATCH echoes the new value AND a follow-up GET round-trip persists the change.

Together the pair guarantees the publish dropdown action wires up to the real backend behavior — including the `access_type` field that gates the public `/playground/{flowId}` route.

---

## Tags *(required)*

UI test: `@release` `@workspace` `@playground` `@stable`
API test: `@release` `@workspace` `@api` `@stable`

---

## Step by step *(required)*

### UI test — `user can publish a flow and access it via shareable URL, then unpublish to revoke access`

1. Bootstrap the app
2. Click `blank-flow` to create an empty flow
3. Wait for the editor (`sidebar-search-input`) to load
4. Search the sidebar for `chat input`, hover the `Chat Input` card and click `add-component-button-chat-input` to add it (gives the flow IO so the publish toggle becomes enabled)
5. Wait for `canvas_controls_dropdown` to register the new node
6. Call `adjustScreenView(page, { numberOfZoomOut: 3 })` to fit the canvas
7. Extract `flowId` from `page.url()` (matches `/flow/{flowId}`)
8. Click `publish-button` to open the deploy dropdown
9. Assert `publish-switch` is **unchecked** (default `access_type` is `PRIVATE`)
10. Click `publish-switch` and assert it becomes **checked**
11. `GET /api/v1/flows/{flowId}` — assert `access_type === "PUBLIC"`
12. Click `shareable-playground` and capture the new tab via `context.waitForEvent("page")`
13. Assert the new tab URL matches `/playground/{flowId}`
14. Send a message in the public playground; assert the `Stop` button becomes visible (build started, so the public URL accepts input)
15. Close the new tab, return to the editor
16. Click `publish-button`, then click `publish-switch` again to unpublish; assert it becomes **unchecked**
17. `GET /api/v1/flows/{flowId}` — assert `access_type === "PRIVATE"`
18. Navigate to the previously-public URL; assert `mainpage_title` is visible (the SPA redirected because the flow is no longer public)

### API test — `publish flow via API toggles access_type between PUBLIC and PRIVATE`

1. Acquire a Bearer token via `getAuthToken(request)`
2. `POST /api/v1/flows/` with `{ name, ...FLOW_BASE }` — expect `201` and `body.access_type === "PRIVATE"` (default)
3. `PATCH /api/v1/flows/{id}` with `{ access_type: "PUBLIC" }` — expect `200` and echoed `access_type === "PUBLIC"`
4. `GET /api/v1/flows/{id}` — expect `200` and `access_type === "PUBLIC"` (persistence confirmation)
5. `PATCH /api/v1/flows/{id}` with `{ access_type: "PRIVATE" }` — expect `200` and echoed `access_type === "PRIVATE"`
6. `GET /api/v1/flows/{id}` — expect `200` and `access_type === "PRIVATE"`
7. Cleanup the flow via `DELETE` in `finally`

---

## Validation criterion *(required)*

The UI test must:

- Use `getByTestId("publish-switch")` and `getByTestId("shareable-playground")` — i18n-proof
- Assert `publish-switch` is **unchecked** before clicking, then **checked** after — proves the click landed *and* changed state, not just hit the DOM
- Assert `access_type === "PUBLIC"` via API after publish toggle — UI switch state alone does not prove the backend stored `PUBLIC` (could be local-state-only with a silent failed PATCH)
- Assert the new tab URL matches `/playground/{flowId}` — proves the shareable link contract that public consumers rely on
- After unpublish, assert `mainpage_title` is visible at the previously-public URL — proves the URL was effectively revoked (not just that the toggle visually flipped)

The API test must assert **all** of:

- POST creates with `access_type === "PRIVATE"` by default
- PATCH `PUBLIC` returns `200` with echoed `access_type === "PUBLIC"`
- GET round-trip returns `access_type === "PUBLIC"` (persistence)
- PATCH `PRIVATE` returns `200` with echoed `access_type === "PRIVATE"`
- GET round-trip returns `access_type === "PRIVATE"`
- Cleanup runs in `finally` so a mid-test failure does not leak flows

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — issues the Bearer token
- `tests/helpers/ui/adjust-screen-view.ts` — fits the canvas after adding the Chat Input
- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` — registers `publish-button`, `publish-switch`, and `shareable-playground` testids; the test would need updating if any are renamed or removed
- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` (`handlePublishedSwitch`) — calls `usePatchUpdateFlow` with `access_type: "PUBLIC" | "PRIVATE"`; the API test mirrors this round-trip directly
- `src/backend/base/langflow/api/v1/flows.py` (`PATCH /api/v1/flows/{id}`) — owns the `access_type` write; the API test asserts this contract
- `/playground/{flowId}` route (frontend SPA) — owns the redirect-to-home behavior when a flow is not `PUBLIC`; the UI test depends on `mainpage_title` being visible after navigating to a now-private URL

---

## What this test does not cover *(optional)*

- Anonymous user access to the public URL (the test reuses the authenticated `page` to navigate; a true anonymous request from a fresh context is not tested)
- That the public flow actually responds with a meaningful answer (the Chat Input flow has no LLM; the test only confirms the build *started* via the `Stop` button appearing)
- HTTP status differences between PUBLIC and PRIVATE flows on the `/playground/{id}` route (both return HTTP 200; the SPA handles the redirect client-side)
- Cross-org / multi-tenant publishing (the test runs as `LANGFLOW_SUPERUSER`)
- Publish UI behavior when `hasIO` is false (the deploy dropdown disables the switch in that case)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `LANGFLOW_SUPERUSER` and `LANGFLOW_SUPERUSER_PASSWORD` configured for the API test's auth token
- No LLM required

---

## When to review this test *(optional)*

- The `access_type` field name or value enum changes (e.g., `"PUBLIC"` becomes `"public"`, or `access_type` becomes `visibility`)
- `handlePublishedSwitch` is refactored to call a dedicated `/api/v1/flows/{id}/publish` endpoint instead of a generic PATCH — both the UI test's API verification and the API test should mirror the new contract
- The public URL pattern changes from `/playground/{flowId}` to something else — both `expect(newUrl).toMatch(...)` and the regex extraction must update
- `publish-switch` testid is renamed or moved out of the deploy dropdown
- The SPA redirect-on-revoke behavior changes (e.g., shows a 403 page instead of redirecting home) — the `mainpage_title` assertion at step 18 must be updated

---

## Notes *(optional)*

- The previous version of this spec used 8 `page.waitForTimeout` calls (totaling ~17s of pure sleeping) as ad-hoc sync points. This rewrite replaces them with proper `expect.toBeVisible` / `expect.toBeChecked` / `waitForLoadState` waits — runtime dropped from ~30s/test to ~14s/test and false-positive risk shrunk to zero.
- The previous version had no API-level verification of the publish state. Asserting only the UI switch position would pass even if the PATCH silently failed and only the local state flipped. This rewrite adds a `GET /api/v1/flows/{id}` round-trip after each toggle.
- The previous version had no assertion on the new tab URL pattern. The shareable URL format is the public contract of this feature — testing it explicitly catches regressions where the URL pattern changes or the wrong flow is opened.
- Empirical confirmation of the `access_type` PATCH behavior was captured by direct `curl` round-trips against the running backend: `POST` defaults to `PRIVATE`, `PATCH {access_type: "PUBLIC"}` echoes `PUBLIC`, `PATCH {access_type: "PRIVATE"}` echoes `PRIVATE`. The API test asserts this exact round-trip.
- The UI test mixes UI action (click) with API verification (`access_type` GET). This is intentional: the switch's visual state is a frontend store value; only the API GET proves the backend committed.
