// Opening the flow-settings popover from the editor header (issue #1215).
//
// Every caller used to do this:
//
//   await page.getByTestId("flow_name").click();
//
// and that is a swallowed-click defect, not a style preference. Upstream renders
// the header as
//
//   <Button data-testid="menu_bar_display" disabled={isReadOnly}
//           title={isReadOnly ? t("version.readOnly") : …}>
//     <span aria-hidden data-testid="flow_name">{currentFlowName}</span>
//   </Button>
//
// with `useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId,"write"))`
// (`contexts/permissionsContext.tsx`), i.e. it fails **closed** for the whole time
// `POST /api/v1/authz/me/permissions` is in flight — deliberately, per its own
// docstring, so a denied user cannot briefly mutate the in-memory canvas. The
// provider really is mounted above the header (`DashboardWrapperPage` wraps
// `AppHeader` in `PermissionsProvider` keyed on `[currentFlow.id]`), so the window
// is real, not theoretical. It arrived upstream on 2026-07-15 (`887f2a552d`,
// langflow-ai/langflow#14068) and is therefore live on the nightly the daily runs.
//
// A `<span>` is not a form control, so Playwright's actionability check never
// covers the disabled state: a click landed in that window is swallowed by the
// browser with **no error at all**, and the failure surfaces later and elsewhere —
// a `save-flow-settings` that never enables, a `lock-flow-switch` that never
// appears. Two of the four signatures #1005 spent a 36-run burst classifying were
// exactly that.
//
// Driving the BUTTON puts the disabled check back AND makes the wait explicit.
// #1152 fixed it inside `renameFlow`; this is that fix as one implementation, for
// the callers that bypass `renameFlow` — the #1108 principle, applied before the
// copies diverge rather than after.

import { type Page, expect } from "@playwright/test";

/**
 * How long the header may stay disabled before the open is called broken.
 *
 * 15 s, which is what `renameFlow` used for this gate when it was inline — so no
 * caller's failure latency changes here. Stated without pretending it is measured:
 * the number comes from `MODAL_TIMEOUT`, sized in #357 for the flow-settings
 * modal's INPUTS, not for the effective-permissions query this waits on. Nobody
 * has measured that query under the daily's parallel load.
 *
 * There is a second gate on the SAME button in `open-flow-by-id.ts` (#1214) at
 * 30 s. Two constants for one wait is exactly the divergence both changes exist to
 * end; converging them is tracked separately rather than resolved by whichever of
 * the two PRs merges second, and deliberately not pinned by a test here — that
 * would make the convergence fail the unit lane.
 */
export const HEADER_ENABLED_TIMEOUT_MS = 15000;

/**
 * Open the flow-settings popover from the editor header.
 *
 * Deliberately does NOT wait for any particular control inside the dialog: the
 * callers want different ones (`input-flow-name`, `lock-flow-switch`), and a
 * helper that picked one would make the other caller's wait implicit. It returns
 * once the click has been made against an enabled button.
 *
 * Two failures, kept distinct because they send a reader to opposite places:
 *  - `flow_name` absent → the editor never mounted (the header renders only under
 *    `onFlowPage`), i.e. the caller has not landed on the canvas;
 *  - `menu_bar_display` never enabled → the flow is not writable, either because
 *    the permissions query is still in flight or because the map genuinely denies
 *    `write`.
 */
export async function openFlowSettings(page: Page): Promise<void> {
  // Assert the header first: its absence means the editor never mounted, which is
  // a very different failure from a header that is present but disabled.
  await expect(page.getByTestId("flow_name")).toBeVisible({
    timeout: HEADER_ENABLED_TIMEOUT_MS,
  });

  const headerButton = page.getByTestId("menu_bar_display");
  await expect(headerButton).toBeEnabled({
    timeout: HEADER_ENABLED_TIMEOUT_MS,
  });
  await headerButton.hover();
  await headerButton.click();
}
