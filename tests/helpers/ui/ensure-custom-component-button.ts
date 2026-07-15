import type { Page } from "@playwright/test";

/**
 * Ensure the flow-editor "New Custom Component" sidebar button
 * (`sidebar-custom-component-button`) is visible before a spec interacts with
 * it.
 *
 * The button lives inside the **Components** sidebar section. On flow entry the
 * sidebar can occasionally load with a different section active (the section
 * selection can persist), leaving the button present in the DOM but hidden
 * (`display:none` section wrapper) — a ~9% flake that times out any
 * `waitForSelector`/`click` waiting for it to become visible.
 *
 * Strategy: first wait for the button to appear normally (covers the sidebar
 * mount, which is the common case). Only if it is still hidden after that grace
 * period do we re-activate the Components nav (a safe, non-navigating click that
 * re-reveals the section) and wait again. Waiting FIRST is essential — an
 * immediate visibility check races the initial render and would fire the
 * recovery click mid-mount, which itself breaks the subsequent interaction.
 */
export async function ensureCustomComponentButton(page: Page): Promise<void> {
  const button = page.getByTestId("sidebar-custom-component-button");

  try {
    await button.waitFor({ state: "visible", timeout: 15000 });
    return;
  } catch {
    // Still hidden after the grace period — the Components section is likely not
    // the active one. Re-activate it, then wait again.
  }

  await page.getByTestId("sidebar-nav-components").click().catch(() => {});
  await button.waitFor({ state: "visible", timeout: 15000 });
}
