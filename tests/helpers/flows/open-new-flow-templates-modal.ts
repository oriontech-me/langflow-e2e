import { expect, type Page } from "@playwright/test";

const WELCOME_PANEL = '[data-testid="flow-builder-welcome-panel"]';
const MODAL_TITLE = '[data-testid="modal-title"]';

/**
 * Manual, assertion-free probe: resolves `true` as soon as the templates modal
 * OR the welcome overlay becomes visible, `false` if neither shows within
 * `timeoutMs`. Deliberately NOT `expect.poll` — a caught poll timeout survives
 * as a spurious red ✗ step in the trace (#599), and here the "nothing opened"
 * outcome is an expected, recoverable branch (the retry in
 * `openNewFlowTemplatesModal`), not a failure. A `timeoutMs` of 0 performs a
 * single immediate check. Single source of truth for the "did anything open?"
 * predicate — `dismissWelcomeOverlayAndWaitForModal` polls it too.
 */
const overlayOrModalAppeared = async (
  page: Page,
  timeoutMs: number,
): Promise<boolean> => {
  const welcomePanel = page.locator(WELCOME_PANEL);
  const modalTitle = page.locator(MODAL_TITLE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await modalTitle.isVisible().catch(() => false)) return true;
    if (await welcomePanel.isVisible().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(200);
  }
};

/**
 * After an action that should open the templates modal (the header "New Flow"
 * button or the empty-page CTA), reconcile the Langflow 1.10.0
 * `FlowBuilderWelcome` overlay: those entry points may navigate to a
 * freshly-created flow and surface the welcome overlay instead of the modal.
 *
 * Race the overlay against the modal; if the overlay surfaces, dismiss it via
 * "Browse more templates", then wait for the modal. When the modal opens
 * directly (older builds, or the empty-page CTA) the overlay branch is skipped
 * — so this is backward-compatible. Shared between the two entry points so the
 * selector/timeout logic can't drift.
 */
export const dismissWelcomeOverlayAndWaitForModal = async (page: Page) => {
  // expect.poll instead of Promise.race(waitForSelector×2): the race's losing
  // wait survives as a spurious red ✗ step in every trace that goes through
  // the overlay branch, reading like a recurring failure (#599). Not
  // locator.or().first() either — .first() picks by DOM order, so an
  // attached-but-hidden welcome panel sitting before the modal in the DOM
  // pins the visibility wait to the full timeout.
  const welcomePanel = page.locator(WELCOME_PANEL);
  await expect
    .poll(() => overlayOrModalAppeared(page, 0), { timeout: 30000 })
    .toBe(true);

  // isVisible, not count() — an attached-but-hidden panel must not trigger a
  // click on the (equally hidden) "Browse more templates" button.
  if (await welcomePanel.isVisible().catch(() => false)) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
  }

  await page.waitForSelector(MODAL_TITLE, { timeout: 30000 });
};

/**
 * Clicks whichever "New Flow" entry point the home page exposes and lands on
 * the templates modal, handling the 1.10.0 welcome overlay (see
 * `dismissWelcomeOverlayAndWaitForModal`).
 *
 * Both the header button (`new-project-btn`, present when flows exist) and the
 * empty-page CTA (`new_project_btn_empty_page`, shown on a flowless home) open
 * the same modal — `.or().first()` picks whichever is in the DOM (the header is
 * DOM-first when both render, which is harmless since both trigger the same
 * action). The auto-waiting click also absorbs the brief window where a
 * just-closed confirmation modal's backdrop is still fading.
 *
 * Single source of truth for the "New Flow → templates modal" flow, used by
 * `awaitBootstrapTest`, `loadTemplateByName`, and any spec that opens the modal
 * mid-test.
 */
export const openNewFlowTemplatesModal = async (page: Page) => {
  const newProjectBtn = page.getByTestId("new-project-btn");
  const emptyBtn = page.getByTestId("new_project_btn_empty_page");
  const entryPoint = newProjectBtn.or(emptyBtn).first();

  // Retry the open under `fullyParallel` CI load (#420): the entry point is in
  // the DOM and actionable, but its React handler may not be wired yet, so the
  // click registers without opening anything ("swallowed click", the dominant
  // flake mode — the page stays on home). Click, probe for the overlay/modal on
  // a short budget, and re-click ONLY while still on the home page.
  //
  // Two guards keep the retry from misfiring:
  //  - Leading `overlayOrModalAppeared(page, 0)`: skip re-clicking when a prior
  //    attempt's open just landed as the probe expired (clicking through a
  //    just-opened modal's backdrop would deadlock on actionability).
  //  - Entry-point visibility (retries only): on 1.10 the click navigates to a
  //    freshly-created flow, so a slow-but-successful welcome overlay leaves the
  //    home entry point gone. Re-clicking there would hit a page without the
  //    button and time out (15s). Bail instead and let the authoritative 30s
  //    wait below reconcile the overlay — exactly the pre-#420 behavior for that
  //    path. The check is guarded to attempts > 1 so the first click keeps its
  //    15s auto-wait, which covers a home page still rendering the button.
  //
  // Backward-compatible: when the first click opens the modal directly (the
  // common case for every other caller), the loop breaks on attempt 1 with no
  // extra clicks.
  const PROBE_TIMEOUT = 8000;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (await overlayOrModalAppeared(page, 0)) break;
    if (attempt > 1 && !(await entryPoint.isVisible().catch(() => false))) break;
    await entryPoint.click({ timeout: 15000 });
    if (await overlayOrModalAppeared(page, PROBE_TIMEOUT)) break;
  }

  // Authoritative wait: reconciles the overlay and raises the real error with a
  // meaningful message if, after the retries, nothing opened.
  await dismissWelcomeOverlayAndWaitForModal(page);
};
