# Flow Functionality — Publish Flow (Shareable Playground)

**Last validated:** Langflow 1.13.x (`1.13.0.dev15`)

---

## What this test validates *(required)*

Validates the **Shareable Playground** publish/unpublish lifecycle in two complementary ways:

1. **UI test:** Creates a blank flow, adds a Chat Input (so the flow has IO and the publish toggle is enabled), opens the deploy dropdown, toggles the `publish-switch` ON, reads the `href` from the rendered shareable `<a>` (the stable contract — i18n-proof and identical to the locator used by `playground-shareable-url.spec.ts`), and opens that URL in a **fresh `browser.newContext()`** so the access check does not piggyback on the editor's cookies. The fresh context sends a message and asserts the `Stop` button appears. The editor then toggles publish OFF; the same shared page re-navigates to the URL and must redirect to the home page. At each toggle the test asserts the backend's `access_type` field via API to confirm the UI switch is wired to a real backend write — not just a local state flip. The flow is deleted in `finally` so repeated runs do not accumulate workspace artifacts.

2. **API test:** Mirrors the publish hook (`handlePublishedSwitch` → `usePatchUpdateFlow` → `PATCH /api/v1/flows/{id}`) by directly toggling `access_type` between `PUBLIC` and `PRIVATE`. Asserts each PATCH echoes the new value AND a follow-up GET round-trip persists the change.

Together the pair guarantees the publish dropdown action wires up to the real backend behavior — including the `access_type` field that gates the public `/playground/{flowId}` route.

---

## Known product defect — `LE-2598` (#1760, in the nightly from `1.13.0.dev14`)

The UI test reads `access_type` back over the API after each toggle. On the 2026-09-07
and 2026-09-08 dailies the read after the **unpublish** answered `PUBLIC`, byte-identical
on both days, failing on attempt 0 and passing on attempt 1 — which cost the test
`@stable` **and** a `test.fixme` at triage.

The cause is not this route and not the read: **every write route taking `DbSession`
answered its 2xx before the transaction committed.** `PATCH /api/v1/flows/{id}` never
commits (`grep -n commit` is empty for `api/v1/flows.py` and for `flows_helpers.py`); the
commit belongs to `session_scope`'s `yield`-dependency teardown, and FastAPI runs that
teardown **after** the response has been written. So the `200` echoing `PRIVATE` does not
attest that the row says `PRIVATE`, and the very next `GET` — issued by Playwright's
request context, a different client from the browser that sent the `PATCH` — can correctly
read the pre-commit row.

### Proven causally, on the image that failed

Same method as the sibling symptoms (#1759, #1777, #1807): an isolated container whose
`session_scope` sleeps 300 ms between the `yield` and the `commit`, gated on a marker file
so control and mutation run in the **same process**. Replaying this test's own sequence
(`PATCH {access_type: "PRIVATE"}` then `GET /api/v1/flows/{id}`), 10 iterations each:

| | `1.13.0.dev6` — the 2026-09-08 daily's image | `1.13.0.dev14` |
|---|---|---|
| read-back answers `PRIVATE`, **un-forced** | 10/10 | 10/10 |
| read-back answers `PRIVATE`, **under the delay** | **0/10** — every one answered `PUBLIC` | **10/10** |
| `PATCH` latency under the delay | 9-19 ms — the client is not waiting for the commit | **319-345 ms** — it is |
| the row became `PRIVATE` after | 301-524 ms | n/a |
| marker removed again, same process | 10/10 | n/a |
| **this spec itself** under the delay | **fails** | passes (11.6 s) |
| **this spec itself**, un-forced | passes (8.9 s) | passes |

`langflow#15078` (`Depends(injectable_session_scope, scope="function")` on `DbSession` and
on the five auth dependencies) is the fix; it back-merged into the 1.13 line between
`1.13.0.dev12` and `1.13.0.dev14`. The delay moved from *after* the response to *inside*
it — which is the ordering, measured rather than inferred. A green run was never the
evidence: un-forced, both images pass.

### The second route into this test, and why the `accessTypePatches` trail exists

The same pre-commit response reaches this test a second way, through the editor rather
than through the read-back. `usePatchUpdateFlow`'s `onSettled` invalidates
`useGetRefreshFlowsQuery`, so a `GET /flows/?get_all=true&header_flows=true` is fired
immediately after the `PATCH` **response** — i.e. potentially before its commit. That row
carries `access_type`, `setFlows` merges it over `currentFlow`, and the switch is
`checked={currentFlow?.access_type === "PUBLIC"}`: a pre-commit row therefore flips the
toggle back to its old position and **leaves it there**, with the flow still public. The
next click then reads its direction from that stale store and sends
`access_type: "PUBLIC"` — a user trying to revoke public access re-publishes instead, with
no error shown. Measured under the same toggle on `dev6`: the switch stays `unchecked`
while `GET /api/v1/flows/{id}` answers `PUBLIC`, and the spec fails at the publish step
rather than at the read-back; on `dev14`, under the same toggle, it does not happen.

Both routes produce the *same* failed assertion, so the run's artifacts cannot tell them
apart — which is what `patchTrail()` is for. It records the `access_type` of every `PATCH`
the **editor** issued and prints it in the failure message:

- `[PUBLIC, PRIVATE]` — the editor asked for `PRIVATE`; the read-back raced the commit.
- `[PUBLIC, PUBLIC]` — the editor asked for `PUBLIC`; the store it reads was stale and the
  toggle re-published.
- `[PUBLIC]` — no second `PATCH` was sent at all (the click never landed).

Never soften either read-back with a retry, a sleep or a poll: `access_type` being correct
on the read immediately after the write **is** the contract, and a bounded wait around it
would have hidden this defect on both routes.

---

## Tags *(required)*

UI test: `@stable` `@release` `@workspace` `@playground`
API test: `@stable` `@release` `@workspace` `@api`

**`@stable` is back on the UI test, and the `test.fixme` quarantine from #1762 is
lifted.** The daily's triage took both on 2026-09-08; they are restored on the upstream
fix being in `langflowai/langflow-nightly:latest` and re-validated there — never on a
test-side change, which is what #1760's *Deliverables* forbid. The evidence is the
ordering measurement above, not the burst: un-forced, `dev6` and `dev14` both pass.

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
12. Read the `href` from `[data-testid="shareable-playground"] a`; assert it matches `/playground/{flowId}`
13. Open `browser.newContext()` and navigate the fresh page to the captured URL
14. Assert `sharedPage.url()` matches `/playground/{flowId}` and the chat input placeholder is visible — proves the public URL renders the playground
15. Send a message in the public playground; assert the `Stop` button becomes visible (build started, so the public URL accepts input)
16. Bring the editor page to the front, click `publish-button`, then click `publish-switch` again to unpublish; assert it becomes **unchecked**
17. `GET /api/v1/flows/{flowId}` — assert `access_type === "PRIVATE"`
18. Re-navigate the same fresh `sharedPage` to the previously-public URL; assert `mainpage_title` is visible (the SPA redirected because the flow is no longer public)
19. `finally` blocks: close the shared context, then `DELETE /api/v1/flows/{flowId}` to clean up

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

- Use `getByTestId("publish-switch")` and the inner `[data-testid="shareable-playground"] a` — i18n-proof and aligned with the sibling `playground-shareable-url.spec.ts` so a wrapper-vs-anchor regression is caught the same way in both specs
- Assert `publish-switch` is **unchecked** before clicking, then **checked** after — proves the click landed *and* changed state, not just hit the DOM
- Assert `access_type === "PUBLIC"` via API after publish toggle — UI switch state alone does not prove the backend stored `PUBLIC` (could be local-state-only with a silent failed PATCH)
- Read the `href` from the shareable `<a>` and assert it matches `/playground/{flowId}` — proves the contract consumers rely on without depending on the wrapper element delegating clicks to its child anchor
- Open the public URL in `browser.newContext()` and assert the playground renders — does not piggyback on the editor's cookies, so a regression that makes `/playground/{id}` require an existing editor session would fail here
- After unpublish, re-navigate the same fresh page to the URL and assert `mainpage_title` is visible — proves the route is gated by `access_type` and not by stale cached state on the original tab
- `finally` blocks delete the flow via API — repeated runs do not accumulate workspace artifacts
- Carry the `patchTrail()` message on **both** `access_type` read-backs — on failure it names which of `LE-2598`'s two routes was taken (see the section above); without it the daily triage gets `Expected "PRIVATE" / Received "PUBLIC"` and nothing else, which is what cost this issue two dailies of investigation

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
- `src/lfx/src/lfx/services/deps.py` — `session_scope`, where the `PATCH`'s commit actually happens (`LE-2598`)
- `src/backend/base/langflow/api/utils/core.py` — `DbSession`, the commit-at-teardown session dependency; `scope="function"` here is the fix
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_patch_flow`, which applies the update without committing
- `src/frontend/src/controllers/API/queries/flows/use-patch-update-flow.ts` — the `onSettled` invalidation that refetches the flows list right after the `PATCH` response
- `src/frontend/src/components/core/appHeaderComponent/components/FlowMenu/index.tsx` — mounts `useGetRefreshFlowsQuery`, whose response `setFlows` merges into `currentFlow` and therefore into the switch's position

---

## What this test does not cover *(optional)*

- Truly anonymous access to the public URL — the test opens a fresh `browser.newContext()` (no inherited cookies), but `LANGFLOW_AUTO_LOGIN=true` (the default) auto-authenticates the new context as well. Verifying access with auth disabled requires `LANGFLOW_AUTO_LOGIN=false`, which is not exercised here
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
- The shareable URL is read via `getAttribute("href")` rather than clicking the wrapper and waiting for `context.waitForEvent("page")`. Two reasons: (1) Copilot review on PR #143 flagged that clicking the wrapper depends on click delegation to the child `<a>` — a regression where the wrapper stops delegating would hang the wait silently; (2) the `href` value is the contract Langflow exposes to consumers, so asserting it directly is the cleanest expression of the test's intent.
- The test creates a new flow each run and deletes it in `finally`. Without this, repeated runs accumulated workspace artifacts (flagged by Copilot review on PR #143).
- Weekly triage #364: the UI test failed once on the weekly run (`publish-switch` clicked but stayed `unchecked` at step 10). Root cause was a transient backend overload — the run logged a storm of `500`s on `/api/v1/flows/`, `/api/v1/validate/prompt`, and `/api/v1/build/.../flow`. The `publish-switch` is a controlled Radix switch that only flips after a successful `PATCH access_type=PUBLIC`, so the failed PATCH left it unchecked. Not a UI/build regression: re-validated green (21/21) against the exact failing image digest `sha256:55a586…`. `@stable` restored. Retry-on-500 was deliberately **not** added — a genuine `500` should fail (the fixture's backend-error monitor flags it), so masking it would hide regressions.
- Teardown hardening (#364): the `finally` now navigates the editor off the flow (`page.goto("/")`) **before** deleting it. The open flow editor keeps an events subscription (`GET /api/v1/flows/{id}/events`) polling for build state; deleting the flow while that poll was in flight produced an intermittent benign `404 Flow not found` (~1 in 17 runs — logged by the fixture but non-failing, since it is an `http_error` not a `flow_error`). Unmounting the editor first stops the subscription, making teardown race-free. Verified: 15/15 runs clean post-fix.
