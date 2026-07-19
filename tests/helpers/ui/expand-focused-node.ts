import { type Page, expect } from "@playwright/test";
import { dismissOnboardingIfPresent } from "./dismiss-onboarding";

// Expand the currently focused node from minimized to full view. Chat Input,
// Chat Output and If-Else all default to `minimized = True` (see their component
// Python sources); while minimized, the run button and the body-rendered input
// handles are not present in the DOM. Idempotent: if the node is already expanded
// (no `hide-node-content` in the DOM) this is a no-op, which future-proofs callers
// against an upstream change to the `minimized` default.
//
// The `more-options-modal` menu can fail to render on the first click when the
// single Langflow backend is under load — many flow-builds in one session degrade
// it (issue #816/#817), so the menu-open is retried before failing instead of
// timing out on `expand-button-modal`.
export async function expandFocusedNode(page: Page): Promise<void> {
  // The dev46 assistant-onboarding dialog opens over the flow editor on entry and
  // its overlay steals node selection / intercepts canvas clicks, so the node
  // toolbar (`more-options-modal`) never mounts. Dismiss it before interacting.
  await dismissOnboardingIfPresent(page);

  if ((await page.getByTestId("hide-node-content").count()) === 0) return;

  // Drive open-menu → expand → settle as ONE retried unit. Under backend load the
  // menu can fail to open OR the expand click can be dropped mid-transition; when
  // that happens the node stays minimized (`hide-node-content` lingers), so we
  // re-drive the whole sequence rather than retrying only the menu-open. `toPass`
  // re-runs the body until the node has actually left the minimized state,
  // replacing the manual attempt loop + fixed `waitForTimeout` (Playwright
  // anti-patterns) with a web-first assertion. The onboarding dialog can reappear
  // a beat after mount, so it is re-dismissed inside the retry.
  await expect(async () => {
    await dismissOnboardingIfPresent(page);
    await page.getByTestId("more-options-modal").click({ timeout: 5000 });
    await page.getByTestId("expand-button-modal").click({ timeout: 5000 });
    await expect(page.getByTestId("hide-node-content")).toHaveCount(0, {
      timeout: 5000,
    });
  }).toPass({ timeout: 30000 });
}
