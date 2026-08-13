import { expect, type Page } from "@playwright/test";

const NODE_SELECTOR = '[data-testid^="rf__node-"]';

/**
 * Budget for the MCP component's server widget to render one of its two entry
 * points, and for the dropdown to leave its loading state.
 *
 * Generous relative to what it costs: measured on nightly 1.12.0.dev17 over 8
 * runs, the entry point was visible 6–15 ms after the node landed and the
 * dropdown was never observed disabled. So this budget is only ever paid on the
 * way to a failure, which is exactly where the extra seconds are worth having.
 */
export const MCP_SERVER_ENTRY_TIMEOUT_MS = 15000;

/**
 * Names the cause when neither entry point renders — issue #1335.
 *
 * The 3 s `click()` this replaced could not: its call log read only
 * `waiting for getByTestId('mcp-server-dropdown')`, which says the locator never
 * resolved and nothing about WHY. The why, on the 2026-08-05 and 2026-08-06
 * dailies, was that there was no MCP component on the canvas at all — the
 * sidebar add had been swallowed (#1304 class), and the failing attempt's
 * error-context snapshot shows an empty `application "Flow canvas"` with
 * "Minimize all" disabled. Both of the widget's branches hang off the component
 * node, so with no node there is nothing to wait for and no budget can help.
 * The node count is therefore the first fact this message carries.
 */
export function missingMcpServerEntryMessage(d: {
  waitedMs: number;
  canvasNodes: number;
}): string {
  const cause =
    d.canvasNodes === 0
      ? `There is NO node on the canvas, so the MCP component was never added ` +
        `and neither entry point could ever render — the sidebar add was ` +
        `swallowed (#1304/#1335 class, not a slow surface: no wait fixes it). ` +
        `Add the component through a helper that repairs a dropped click ` +
        `(helpers/flows/add-component-from-sidebar.ts).`
      : `${d.canvasNodes} node(s) are on the canvas, so the component is there ` +
        `but its server widget never rendered an entry point — treat this as a ` +
        `Langflow change to the MCP component's server field, not as a wait.`;

  return (
    `[openAddMcpServerModal] neither "add-mcp-server-simple-button" (no servers ` +
    `registered yet) nor "mcp-server-dropdown" (one or more registered) became ` +
    `visible within ${d.waitedMs}ms. ${cause}`
  );
}

/** Attempts the sidebar entry point makes before it reports a swallowed click. */
export const SIDEBAR_MODAL_ATTEMPTS = 3;

/** Per-attempt budget for the modal to paint after the sidebar click. */
export const SIDEBAR_MODAL_ATTEMPT_MS = 8000;

/**
 * Names the cause when the sidebar's "Add MCP Server" never opens the modal —
 * issue #1422, same defect class as #1304/#1335.
 *
 * The assertion this replaced read `element(s) not found` for
 * `add-mcp-server-button` after a 15 s wait, which says the modal is late. It is
 * not late: the sidebar click is DROPPED, and the repo has measured that class
 * on four other surfaces (14 of 14 repaired by an identical second click,
 * #1304). A budget cannot repair a click that never landed, so the caller
 * retries instead — and when even the retries fail, the message has to say
 * which of the two triggers it clicked, or the next reader re-derives it.
 */
export function sidebarModalNeverOpenedMessage(d: {
  trigger: string;
  attempts: number;
  perAttemptMs: number;
}): string {
  return (
    `[openAddMcpServerModalFromSidebar] the modal never opened after ` +
    `${d.attempts} click(s) on "${d.trigger}" (${d.perAttemptMs}ms each). ` +
    `A dropped sidebar click is the #1304/#1335 class and is repaired by a ` +
    `second click, so ${d.attempts} failed attempts mean the trigger no longer ` +
    `opens this modal at all — treat it as a Langflow change to the sidebar ` +
    `entry point, not as a slow modal.`
  );
}

/**
 * Opens the "Add MCP Server" modal from the **sidebar's** MCP tab, repairing a
 * swallowed click.
 *
 * Two triggers exist depending on whether any server is registered
 * (`sidebar-add-mcp-server-button` / `add-mcp-server-button-sidebar`), and they
 * cannot be told apart by a snap read: `isVisible({ timeout })` IGNORES the
 * timeout (Playwright deprecates the option), so the inline version of this in
 * `mcp-server.spec.ts` decided the branch in ~1 ms and could pick the fallback
 * before either had painted. Waiting for `.or()` first removes that.
 */
export async function openAddMcpServerModalFromSidebar(page: Page) {
  const primary = page.getByTestId("sidebar-add-mcp-server-button");
  const fallback = page.getByTestId("add-mcp-server-button-sidebar");

  await expect(primary.or(fallback)).toBeVisible({
    timeout: MCP_SERVER_ENTRY_TIMEOUT_MS,
  });

  const usePrimary = await primary.isVisible();
  const trigger = usePrimary ? primary : fallback;
  const triggerName = usePrimary
    ? "sidebar-add-mcp-server-button"
    : "add-mcp-server-button-sidebar";
  const modal = page.getByTestId("add-mcp-server-button");

  for (let attempt = 1; attempt <= SIDEBAR_MODAL_ATTEMPTS; attempt++) {
    // `evaluate(el => el.click())` on the primary keeps the gesture the spec
    // used before this helper existed: the sidebar item intercepts pointer
    // events on the row, and a plain click lands on the wrapper.
    if (usePrimary) {
      await trigger.evaluate((el) => (el as HTMLElement).click());
    } else {
      await trigger.click({ timeout: SIDEBAR_MODAL_ATTEMPT_MS });
    }

    const opened = await modal
      .waitFor({ state: "visible", timeout: SIDEBAR_MODAL_ATTEMPT_MS })
      .then(() => true)
      .catch(() => false);
    if (opened) return;

    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  sidebar "Add MCP Server" click swallowed — retrying ` +
        `(${attempt}/${SIDEBAR_MODAL_ATTEMPTS}, #1422/#1304 class)`,
    );
  }

  throw new Error(
    sidebarModalNeverOpenedMessage({
      trigger: triggerName,
      attempts: SIDEBAR_MODAL_ATTEMPTS,
      perAttemptMs: SIDEBAR_MODAL_ATTEMPT_MS,
    }),
  );
}

/**
 * Opens the "Add MCP Server" modal from an MCP component on the canvas.
 *
 * The component renders exactly ONE of two mutually exclusive entry points
 * (verified in the 1.12.0.dev17 frontend bundle, a single ternary): the plain
 * `add-mcp-server-simple-button` once the servers query has resolved to an empty
 * list, and `mcp-server-dropdown` otherwise — including while that query is in
 * flight, where it renders DISABLED with a "Loading servers…" label.
 *
 * So the branch cannot be decided from a snap read of the DOM, which is what the
 * previous version did: `isVisible({ timeout: 1000 })` looks like a 1 s wait but
 * Playwright IGNORES that option (`@deprecated This option is ignored`), so the
 * probe returned in ~1 ms and committed to the dropdown branch whenever the
 * widget had not painted yet — then spent its whole 3 s budget on a locator that
 * in the empty-list case would never appear at all. Waiting for either entry
 * point FIRST and branching on the settled state removes both halves of that.
 */
export async function openAddMcpServerModal(page: Page) {
  const simpleButton = page.getByTestId("add-mcp-server-simple-button");
  const dropdown = page.getByTestId("mcp-server-dropdown");

  // No `.first()`: the two are mutually exclusive branches, so `.or()` matches
  // exactly one and the #599 caveat (a hidden earlier-in-DOM match pinning the
  // wait to the full timeout) cannot apply. A build that ever rendered both
  // would fail here as a strict-mode violation — loudly, which is correct.
  try {
    await expect(simpleButton.or(dropdown)).toBeVisible({
      timeout: MCP_SERVER_ENTRY_TIMEOUT_MS,
    });
  } catch {
    throw new Error(
      missingMcpServerEntryMessage({
        waitedMs: MCP_SERVER_ENTRY_TIMEOUT_MS,
        canvasNodes: await page.locator(NODE_SELECTOR).count(),
      }),
    );
  }

  if (await simpleButton.isVisible()) {
    await simpleButton.click();
  } else {
    // The dropdown is rendered disabled until GET /api/v2/mcp/servers answers.
    // Asserted separately from the click so an unclearing loading state reports
    // itself as "still disabled" instead of a bare click timeout.
    await expect(dropdown).toBeEnabled({
      timeout: MCP_SERVER_ENTRY_TIMEOUT_MS,
    });
    await dropdown.click();
    await page.getByText("Add MCP Server", { exact: true }).last().click({
      timeout: 5000,
    });
  }

  await page.waitForSelector('[data-testid="add-mcp-server-button"]', {
    state: "visible",
    timeout: 30000,
  });
}
