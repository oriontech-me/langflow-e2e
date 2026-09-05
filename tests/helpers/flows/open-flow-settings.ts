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
import { PERMISSIONS_GATE_TIMEOUT_MS } from "./permissions-gate";

/**
 * How long the editor may take to put the header on screen at all.
 *
 * Kept at 15 s and kept LOCAL, which is the half of #1222 that is easy to miss:
 * this budget and the permissions gate below were one constant doing two jobs,
 * and they answer different questions. An absent `flow_name` means the editor
 * never mounted — the caller has not landed on the canvas. A header that is
 * present but disabled is the OTHER question, and it has two answers, not one:
 * the permissions query is still in flight, or it has answered and the map
 * genuinely denies `write` (the note on `openFlowSettings` below keeps them
 * distinct, because they send a reader to opposite places). That budget is now
 * `PERMISSIONS_GATE_TIMEOUT_MS`, shared with the four other places that wait on
 * the same button; this one has no siblings to converge with, and changing it
 * would be a behaviour change #1222 did not ask for.
 *
 * Still not measured, and still not pretending to be: 15 s comes from
 * `rename-flow.ts`'s `MODAL_TIMEOUT` (#357, sized for the modal's inputs). What
 * changed is that it no longer stands in for a wait that HAS been measured.
 */
export const HEADER_PRESENT_TIMEOUT_MS = 15000;

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
    timeout: HEADER_PRESENT_TIMEOUT_MS,
  });

  const headerButton = page.getByTestId("menu_bar_display");
  await expect(headerButton).toBeEnabled({
    timeout: PERMISSIONS_GATE_TIMEOUT_MS,
  });
  await headerButton.hover();
  await headerButton.click();
}
