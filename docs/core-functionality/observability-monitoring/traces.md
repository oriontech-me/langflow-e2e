# Traces — Empty State When Flow Has Not Run

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the Traces panel renders its empty state ("No Data Available") when the Basic Prompting template is opened from scratch and no flow execution has been triggered yet. Acts as a UI smoke for the Traces entry point — confirms the button is reachable from the canvas, opens the Traces panel, and the panel correctly distinguishes "no data" from a hard failure.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@observability`

---

## Step by step *(required)*

1. Bootstrap the app via `awaitBootstrapTest(page)`
2. Open the "All Templates" side-nav option (`side_nav_options_all-templates`)
3. Click the **Basic Prompting** template heading to open the flow in the editor
4. Wait for the first canvas node (`/.*rf__node.*/`) to be visible (3 s timeout)
5. Loop-click `update-button` until none remain (clears outdated-component markers; bounded to 20 iterations)
6. Loop-click `remove-icon-badge` until none remain (clears any pre-filled API key badges; bounded to 20 iterations)
7. Click the first **Traces** button (role=button, name="Traces", `.first()`)
8. Assert the text **"No Data Available"** (exact) is visible

---

## Validation criterion *(required)*

The Traces panel reaches its `noDataTitle` empty state (`table.noDataTitle` → "No Data Available", defined in `FlowInsightsContent.tsx`) when no flow execution has produced trace data yet. Anything else — a hard error, a missing button, a populated grid for a freshly-opened template — surfaces a regression in the Traces entry point or empty-state contract.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx` — renders the Traces panel and the `table.noDataTitle` / `table.noDataMessage` empty state
- `src/frontend/src/pages/FlowPage/components/TraceComponent/SpanTree.tsx` and `TraceDetailView.tsx` — Trace Details modal (not exercised by this spec; covered by `traces-latency-tokens.spec.ts`)

References in this repository:

- `tests/helpers/other/await-bootstrap-test.ts` — boots the app and ensures the home page is ready

---

## What this test does not cover *(optional)*

- Running the flow and observing populated trace rows — covered by `traces-latency-tokens.spec.ts`
- Trace Details modal, span tree, per-span latency — covered by `traces-latency-tokens.spec.ts`
- Trace API endpoints (`/api/v1/monitor/transactions`, `/api/v1/monitor/traces`) — covered by `traces-detail.spec.ts` and `traces-latency-tokens.spec.ts`

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No provider key required — the flow is never executed; the test only opens the template and inspects the Traces panel.

---

## Notes *(optional)*

- The Basic Prompting template may load with API key badges pre-filled via Langflow's global variables. The `remove-icon-badge` loop strips those badges so the canvas is in a clean "no run yet" state before the Traces panel is opened. The loop is defensive — on environments without pre-filled keys it executes zero iterations.
- A previous second test in this file (`should able to see traces after running a flow`) was removed: it was permanently `test.skip`-ed, depended on a 50-second hard wait, and the same scenario is fully covered by `traces-latency-tokens.spec.ts` with API-driven setup and proper polling against `/api/v1/monitor/traces`.
