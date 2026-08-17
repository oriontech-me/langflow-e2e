import { expect, type Page } from "@playwright/test";

/**
 * Clicks `blank-flow` in the new-flow templates modal and does not return until
 * the modal is actually **gone** (issue #1468, second failure mode).
 *
 * The click is a flow creation, and it can be refused. Measured on nightly
 * 1.12.0.dev30 with four harnesses driving one backend: in every reproduction of
 * this mode the page load carried `400 POST /api/v1/flows/` — the "flow must be
 * unique" collision this repo already knows (it is why
 * `chat-input-output-component-regression.spec.ts` runs `mode: "serial"`) — and
 * the modal stayed **open over the editor**. The caller then typed into a sidebar
 * the modal was covering and `fill()` timed out at 20 s, or its row wait died as
 * `element(s) not found`. `role="dialog"` was **1** in every such failure and
 * **0** in all 16 measured successes, so the modal's presence is the observable
 * that separates them.
 *
 * The serial mode in that file cannot prevent this: it serialises tests within
 * one file, while the collision is across the daily's four shards, which each
 * create a flow named "New Flow" of their own.
 *
 * The repair is to re-issue the click, not to wait: a refused creation is not
 * slow, there is nothing in flight, and the modal will sit there for as long as
 * the caller is willing to wait. One retry, then a named failure — the same
 * doctrine as `add-component-from-sidebar.ts` (#1304).
 *
 * The retry is only ever issued while the modal is still up, and `blank-flow`
 * lives inside it, so a dismissed modal is never clicked again. In the measured
 * mode the first click created nothing (the 400), but a first click that DID
 * create a flow and left the modal open would create a second one — which the
 * caller's `trackCreatedFlows` deletes with the first, since it captures every
 * `POST /api/v1/flows` → 201 rather than a single id (#1108).
 */
export const MODAL_DISMISSED_TIMEOUT_MS = 8000;

export const BLANK_FLOW_TESTID = "blank-flow";

/** The templates modal, addressed the way the repo's other modal helpers do. */
const DIALOG_SELECTOR = '[role="dialog"]';

export function refusedBlankFlowMessage(d: {
  attempts: number;
  perAttemptMs: number;
  dialogCount: number;
}): string {
  return (
    `the new-flow templates modal did not close after ${d.attempts} click(s) of ` +
    `getByTestId("${BLANK_FLOW_TESTID}"), ${d.perAttemptMs}ms apart ` +
    `(role="dialog" still present: ${d.dialogCount}). Issue #1468 — the click ` +
    `creates a flow and the backend can refuse it with ` +
    `400 POST /api/v1/flows/ ("flow must be unique") when parallel shards create ` +
    `"New Flow" at the same time; the modal then stays open over the editor and ` +
    `anything the spec types goes to a covered sidebar. Check the run's HTTP log ` +
    `for that 400. This is NOT a slow modal — waiting longer cannot close it.`
  );
}

const dialogCount = async (page: Page): Promise<number> =>
  page
    .locator(DIALOG_SELECTOR)
    .count()
    .catch(() => -1);

const clickAndAwaitDismissal = async (page: Page): Promise<boolean> => {
  await page.getByTestId(BLANK_FLOW_TESTID).click();
  return expect(page.locator(DIALOG_SELECTOR))
    .toHaveCount(0, { timeout: MODAL_DISMISSED_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
};

/**
 * Opens a blank flow from the templates modal. The caller must already have the
 * modal open — `awaitBootstrapTest(page)` leaves it that way.
 */
export const openBlankFlowFromModal = async (page: Page) => {
  if (await clickAndAwaitDismissal(page)) return;
  if (await clickAndAwaitDismissal(page)) return;

  throw new Error(
    refusedBlankFlowMessage({
      attempts: 2,
      perAttemptMs: MODAL_DISMISSED_TIMEOUT_MS,
      dialogCount: await dialogCount(page),
    }),
  );
};
