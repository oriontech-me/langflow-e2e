import type { Page } from "@playwright/test";

/**
 * Dismiss the getting-started assistant onboarding popup if it is present.
 *
 * On a fresh instance the assistant onboarding tooltip
 * (`assistant-onboarding-tooltip`, `role="dialog"`) opens over the flow editor
 * and its overlay intercepts clicks on the canvas and the Flow Settings modal —
 * an intermittent source of flakes for click-heavy specs (it appears on flow
 * entry, sometimes a beat after the canvas mounts). This dismisses it when
 * shown and is a no-op otherwise, so callers can invoke it after every flow
 * entry without guarding.
 */
export async function dismissOnboardingIfPresent(page: Page): Promise<void> {
  const dismiss = page.getByTestId("assistant-onboarding-dismiss");
  const visible = await dismiss
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (visible) {
    await dismiss.click().catch(() => {});
    await dismiss.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
}
