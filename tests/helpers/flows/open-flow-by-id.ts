// Entering the flow editor by id, as one implementation (issue #1214).
//
// The block this replaces — "`page.goto('/flow/{id}')`, then wait for the canvas"
// — was hand-copied into three specs (`lock-flow`, `flow-lock`, `edit-flow-name`)
// and had already diverged on every axis that matters: the canvas deadline
// (100 s vs. 30 s), an arbitrary `waitForTimeout(500)` in one of them, the
// onboarding handling, and the write-permission gate. Same failure mode #1108
// documented for id-scoped cleanup: a fix to one copy reached none of the others,
// and two of the three fixes existed in exactly one caller.
//
// Addressing the flow by id — never `list-card.first()` or a name-filtered
// `list-card-open-button` click — is what makes the entry parallel-safe: `.first()`
// opens whichever card is on top of the shared home grid, i.e. another worker's
// flow, and the cards other workers leave behind overlap the target's
// absolute-inset open button and intercept a hit-tested click (#684/#580/#588). A
// full document load also leaves no SPA hop to race (#1005).
//
// A helper, deliberately opt-in per spec, rather than a fixture — including the
// onboarding seed, which a fixture could arguably own since it must run before the
// first document load. `tests/fixtures/**` is suite-wide for
// `impacted-specs-by-import.mjs`, so anything living there resolves to EVERY spec
// and demands a full `manual.yml` run on each change (#1054). The same trade
// `trackCreatedFlows` made (#1108). The seed is registered by the entry itself and
// is idempotent per page, so a caller cannot forget it and a caller that enters
// three times still pays for one registration. The seed itself now lives in
// `helpers/ui/assistant-onboarding.ts` — #1220 gave it seven more callers that
// enter the editor by other routes, and leaving it here would have coupled them to
// this module's deadlines in the impacted graph for nothing.
//
// What this does NOT do, stated so the next reader does not conclude the
// duplication is gone: three callers is the whole reach today, and roughly twenty
// other `page.goto('/flow/{id}')` sites remain across the suite
// (`core-components/edit-tools`, `parameters-panel-field-types`,
// `flow-execution-canvas`, the three `llm-agents` agent-context specs, three
// knowledge-ingestion specs, `traces-latency-tokens`,
// `webhook-component-regression`, plus `helpers/flows/setup-playground.ts` and
// `load-template-by-name.ts`). They are not copies of this — they gate readiness
// on `sidebar-search-input` rather than `canvas_controls_dropdown`, a genuinely
// different signal — but none seeds the onboarding flag and none gates on
// writability, so both hazards above are still open there. Migrating them is a
// separate change on purpose: every spec added here is selected by the impacted
// lane on every edit to this file (#1054), so reach is a cost to spend
// deliberately, with a measurement behind it, not in passing.

import { type Page, expect } from "@playwright/test";
import {
  type SeedablePage,
  seedAssistantDiscovered,
} from "../ui/assistant-onboarding";
// The header-writability budget is NOT defined here since #1222: five call sites
// wait on the same button, and two of the five diverged the moment two PRs landed
// in parallel. Imported, never re-exported — a second import path is how a
// converged constant grows a second identity again. The value, the burst it was
// measured on and the case for 30 s over 15 s live in `permissions-gate.ts`.
import { PERMISSIONS_GATE_TIMEOUT_MS } from "./permissions-gate";

// Re-exported rather than redefined: the seed moved to
// `helpers/ui/assistant-onboarding.ts` when #1220 gave it seven more callers, none
// of which enters the editor by id. Kept reachable from here because the unit lane
// and the three migrated specs already read these names off this module.
export {
  ASSISTANT_DISCOVERED_STORAGE_KEY,
  seedAssistantDiscovered,
} from "../ui/assistant-onboarding";

/**
 * How long the canvas may take to render after the document load.
 *
 * ONE deadline, replacing the 100 s / 30 s / 30 s the three copies carried, and
 * it is the **MAX** of the three on purpose. None of the three was measured —
 * they were inherited — and this wait is not a single request but a composite
 * (document load + `GET /api/v1/flows/{id}` + the editor's first render), so no
 * per-request figure bounds it. Picking the middle would have shrunk
 * `lock-flow`'s budget by 40 % on nothing but an argument, and the failure that
 * buys is a red on a saturated daily reported as "the canvas never rendered".
 *
 * Raising the other two costs only how long a doomed entry takes to say so, and
 * that cost is bounded: this gate plus the writable gate below are SERIAL, so a
 * dead entry spends at most `CANVAS_TIMEOUT_MS + PERMISSIONS_GATE_TIMEOUT_MS`
 * (130 s) before failing — comfortably inside the suite's 5-minute per-test
 * timeout, so the failure still lands on this assertion with its own message
 * rather than as an unattributed test-level timeout.
 *
 * Lowering it is a measurement, not an opinion: it wants entry durations from a
 * saturated daily, which the repo does not record today.
 */
export const CANVAS_TIMEOUT_MS = 100000;

/**
 * The `Page` surface this helper's navigation half needs. Narrow, so the unit lane
 * can drive it with a fake. Extends the seed's surface, because the ORDER of the
 * two calls is the invariant this module exists to hold.
 */
export interface NavigablePage extends SeedablePage {
  goto(url: string): Promise<unknown>;
}

/**
 * Seed, then navigate — in that order, which is the whole reason the seed works.
 *
 * `addInitScript` applies to the navigations that follow it, so registering it
 * after the `goto` would leave the very load the caller cares about unseeded.
 * Split out from `openFlowById` so the unit lane can pin that ordering with a
 * fake page instead of a browser.
 */
export async function navigateToFlow(
  page: NavigablePage,
  flowId: string,
): Promise<void> {
  await seedAssistantDiscovered(page);
  await page.goto(`/flow/${flowId}`);
}

export interface OpenFlowByIdOptions {
  /**
   * Wait for the flow header to report enabled before returning.
   *
   * On by default: upstream renders `menu_bar_display` as
   * `disabled={isReadOnly}` with
   * `useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId, "write"))`,
   * which fails CLOSED for the whole time `POST /api/v1/authz/me/permissions` is
   * in flight — so a mutation issued in that window is swallowed with no error
   * (#1005). Every current caller mutates the flow it opens.
   *
   * Turn it off only for a caller that must observe the editor in a state where
   * the header is legitimately disabled, and say why at the call site — a flow
   * the user cannot write is exactly what this would otherwise catch.
   */
  requireWritable?: boolean;
}

/**
 * Open a flow addressed by id and wait until the editor is ready to be driven.
 *
 * Three guarantees on return: the canvas is rendered, the onboarding overlay
 * cannot appear, and (unless opted out) the flow is writable. Everything else —
 * dismissing modals, adjusting the viewport, selecting nodes — belongs to the
 * caller.
 */
export async function openFlowById(
  page: Page,
  flowId: string,
  { requireWritable = true }: OpenFlowByIdOptions = {},
): Promise<void> {
  await navigateToFlow(page, flowId);

  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: CANVAS_TIMEOUT_MS,
  });

  if (requireWritable) {
    await expect(page.getByTestId("menu_bar_display")).toBeEnabled({
      timeout: PERMISSIONS_GATE_TIMEOUT_MS,
    });
  }
}
