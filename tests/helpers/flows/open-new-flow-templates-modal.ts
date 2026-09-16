import { expect, type Page, type Response } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { deleteFlow } from "./delete-flow";
import { waitForPageEntry } from "../other/page-entry-barrier";

const WELCOME_PANEL = '[data-testid="flow-builder-welcome-panel"]';
const MODAL_TITLE = '[data-testid="modal-title"]';

/** Short probe after each New Flow click that decides whether to re-click (#420). */
const PROBE_TIMEOUT = 8000;

/** The authoritative wait for the welcome overlay or the modal. */
const OPEN_TIMEOUT = 30000;

/**
 * Budget for the flow-list readiness gate below. Generous because it is a
 * best-effort wait that costs nothing once the list has rendered (it resolves on
 * the first probe), and it must survive a slow list fetch under CI load.
 */
const FLOW_LIST_SETTLE_TIMEOUT = 15000;

/**
 * Resolves once the flows list has finished rendering — or immediately when the
 * caller is not on the flows list at all. Returns `false` only if the budget
 * expires; callers proceed either way (see `openNewFlowTemplatesModal`).
 *
 * Why this exists (#966): after an SPA route change back to the list (e.g. the
 * canvas `icon-ChevronLeft`), `new-project-btn` becomes visible **while the list
 * is still loading**, and a click landed in that window is a **no-op** — measured
 * on nightly 1.12.0.dev6, the "New Flow" entry point opened nothing at all in 3
 * of 5 back-navigation attempts, while it opened 5/5 straight after a page load
 * and 4/4 when the click waited for one `list-card`. The swallow is invisible to
 * Playwright's actionability checks: in that window the button reports
 * `disabled=false`, no `aria-disabled`, `pointer-events: auto` and a wired
 * `__reactProps.onClick`, with `list-card` count 0 under a present
 * `cards-wrapper`. It is also unrecoverable by the #420 re-click retry — once the
 * list renders mid-click the button turns unactionable and the re-clicks time out.
 *
 * That no-op is a PRODUCT defect, filed upstream as **LE-2019**
 * (https://datastax.jira.com/browse/LE-2019; full evidence in
 * `docs/upstream-bugs/UPSTREAM-BUG-new-flow-dead-click.md`). It is not new in 1.12
 * — the nightly frontend is byte-identical to the 1.11.x releases and the path was
 * introduced in 1.10.1 by upstream PR #12575. This gate only keeps the suite out
 * of the broken window; it does not fix the defect, which is why `run-flow.spec.ts`
 * stays off `@stable` until LE-2019 lands.
 *
 * Terminal states, any of which means "safe to click":
 *  - a `list-card` is visible — the list rendered;
 *  - the empty-page CTA is visible — a flowless instance never renders a card;
 *  - `cards-wrapper` is gone — not a flows-list page (a canvas, say), so the gate
 *    does not apply and must not burn the budget.
 */
const flowListSettled = async (
  page: Page,
  now: () => number,
  timeoutMs = FLOW_LIST_SETTLE_TIMEOUT,
): Promise<boolean> => {
  const firstCard = page.getByTestId("list-card").first();
  const emptyCta = page.getByTestId("new_project_btn_empty_page");
  const cardsWrapper = page.getByTestId("cards-wrapper");
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await firstCard.isVisible().catch(() => false)) return true;
    if (await emptyCta.isVisible().catch(() => false)) return true;
    if (!(await cardsWrapper.isVisible().catch(() => false))) return true;
    if (now() >= deadline) return false;
    await page.waitForTimeout(200);
  }
};

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
  now: () => number = Date.now,
): Promise<boolean> => {
  const welcomePanel = page.locator(WELCOME_PANEL);
  const modalTitle = page.locator(MODAL_TITLE);
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await modalTitle.isVisible().catch(() => false)) return true;
    if (await welcomePanel.isVisible().catch(() => false)) return true;
    if (now() >= deadline) return false;
    await page.waitForTimeout(200);
  }
};

/** With the overlay or the modal already showing, gets past the overlay to the modal. */
const browsePastWelcomeOverlay = async (page: Page) => {
  // isVisible, not count() — an attached-but-hidden panel must not trigger a
  // click on the (equally hidden) "Browse more templates" button.
  if (await page.locator(WELCOME_PANEL).isVisible().catch(() => false)) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
  }

  await page.waitForSelector(MODAL_TITLE, { timeout: 30000 });
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
 *
 * It has no #1865 recovery (see `openNewFlowTemplatesModal`): that needs a
 * response watcher attached before the click, and this runs after it.
 */
export const dismissWelcomeOverlayAndWaitForModal = async (page: Page) => {
  // expect.poll instead of Promise.race(waitForSelector×2): the race's losing
  // wait survives as a spurious red ✗ step in every trace that goes through
  // the overlay branch, reading like a recurring failure (#599). Not
  // locator.or().first() either — .first() picks by DOM order, so an
  // attached-but-hidden welcome panel sitting before the modal in the DOM
  // pins the visibility wait to the full timeout.
  await expect
    .poll(() => overlayOrModalAppeared(page, 0), { timeout: OPEN_TIMEOUT })
    .toBe(true);

  await browsePastWelcomeOverlay(page);
};

/**
 * Clicks whichever New Flow entry point the home page exposes until the welcome
 * overlay or the modal shows, or the page has left the home page.
 */
const clickNewFlow = async (page: Page, now: () => number) => {
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
  //    wait reconcile the overlay — exactly the pre-#420 behavior for that
  //    path. The check is guarded to attempts > 1 so the first click keeps its
  //    15s auto-wait, which covers a home page still rendering the button.
  //
  // Backward-compatible: when the first click opens the modal directly (the
  // common case for every other caller), the loop breaks on attempt 1 with no
  // extra clicks.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (await overlayOrModalAppeared(page, 0, now)) break;
    // Readiness gate (#966): never click into the window where the list is still
    // loading — that click is swallowed and no retry recovers it. Best-effort by
    // design: if the budget expires we still click, and the authoritative wait
    // that follows remains the only thing that decides pass/fail.
    await flowListSettled(page, now);
    if (attempt > 1 && !(await entryPoint.isVisible().catch(() => false))) break;
    await entryPoint.click({ timeout: 15000 });
    if (await overlayOrModalAppeared(page, PROBE_TIMEOUT, now)) break;
  }
};

interface TypesWatcher {
  /** Every status the editor's types request answered for `flowId`, in arrival order. */
  answersFor: (flowId: string) => number[];
  dispose: () => void;
}

/** Records the answers to the editor's types request, `GET /api/v1/all?flow_id=`, per flow. */
const watchTypesResponses = (page: Page): TypesWatcher => {
  const answers = new Map<string, number[]>();
  const record = (resp: Response) => {
    try {
      const url = new URL(resp.url());
      if (!/^\/api\/v1\/all\/?$/.test(url.pathname)) return;
      const flowId = url.searchParams.get("flow_id");
      if (!flowId) return;
      answers.set(flowId, [...(answers.get(flowId) ?? []), resp.status()]);
    } catch {
      // A URL this cannot parse is not the types request; never let a response
      // handler throw.
    }
  };
  page.on("response", record);
  return {
    answersFor: (flowId) => answers.get(flowId) ?? [],
    dispose: () => page.off("response", record),
  };
};

/** The flow whose editor the page is on, if it is on one. */
const editorFlowId = (page: Page): string | undefined => {
  try {
    return /\/flow\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1];
  } catch {
    return undefined;
  }
};

type EntryOutcome =
  | { kind: "opened" }
  /** The #1865 signature: the open editor's latest types answer is a 404. */
  | { kind: "stuck"; flowId: string }
  | { kind: "nothing" };

/** Waits for the overlay or the modal, or for the open editor to be provably stuck. */
const waitForEntryOutcome = async (
  page: Page,
  types: TypesWatcher,
  now: () => number,
): Promise<EntryOutcome> => {
  const deadline = now() + OPEN_TIMEOUT;
  for (;;) {
    if (await overlayOrModalAppeared(page, 0, now)) return { kind: "opened" };
    const flowId = editorFlowId(page);
    if (flowId && types.answersFor(flowId).at(-1) === 404) {
      return { kind: "stuck", flowId };
    }
    if (now() >= deadline) return { kind: "nothing" };
    await page.waitForTimeout(200);
  }
};

const enterNewFlow = async (
  page: Page,
  types: TypesWatcher,
  now: () => number,
): Promise<EntryOutcome> => {
  await clickNewFlow(page, now);
  return waitForEntryOutcome(page, types, now);
};

/** Deletes a placeholder this helper abandoned; a cleanup problem never replaces the real outcome. */
const deletePlaceholder = async (page: Page, flowId: string) => {
  try {
    const authorization = await getAuthToken(page.request);
    await deleteFlow(page.request, flowId, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });
  } catch (error) {
    console.warn(
      `⚠️  openNewFlowTemplatesModal: could not delete the blank placeholder ${flowId} (${(error as Error)?.message?.split("\n")[0] ?? error}).`,
    );
  }
};

const nothingOpenedMessage = (
  page: Page,
  types: TypesWatcher,
  reenteredAfter?: string,
): string => {
  const flowId = editorFlowId(page);
  const answers = flowId ? types.answersFor(flowId) : [];
  const typesAnswer = !flowId
    ? "the page is not a flow editor"
    : answers.length > 0
      ? `GET /api/v1/all?flow_id=${flowId} answered ${answers.join(", ")}`
      : `no answer to GET /api/v1/all?flow_id=${flowId} was observed`;
  return (
    `openNewFlowTemplatesModal: neither the welcome overlay nor the templates modal opened after clicking New Flow ` +
    `(${PROBE_TIMEOUT}ms probe + ${OPEN_TIMEOUT}ms wait)` +
    `${reenteredAfter ? `, on the one re-entry after the #1865 404 for ${reenteredAfter}` : ""}. ` +
    `The page is on ${page.url()}, and ${typesAnswer}. ` +
    `That is not the #1865 signature (a 404 on that request), so the cause is unknown.`
  );
};

export interface NewFlowEntryDeps {
  /**
   * The clock every wait in this helper is measured against. **Unit tests
   * only** — a spec must not pass it. The waits are 8 s and 30 s long, so the
   * unit tests drive a simulated clock instead of sleeping through them (see
   * `open-new-flow-templates-modal.fake.ts`).
   */
  now?: () => number;
}

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
 *
 * ## A blank editor after New Flow (#1865)
 *
 * New Flow creates a flow and navigates to its editor, which at once asks for
 * the component types scoped to that flow: `GET /api/v1/all?flow_id=<id>`.
 * Langflow answers a write before its transaction commits (LE-2598; the fix,
 * langflow#15078, is on `release-1.12.2` only), so under CI shard load that read
 * can lose the race and answer **404 `Flow not found`**. The frontend treats a
 * 4xx as final — measured, one call in 20 s — and the editor stays blank for
 * good: the "/ Untitled Flow" header and nothing else, no canvas, no overlay, no
 * modal. This helper then burnt its probe and its 30 s wait and threw a bare
 * `expect(received).toBe(expected)`, on whichever spec lost the race.
 *
 * Waiting cannot fix that editor, and neither can the obvious repairs, both
 * measured on 1.13.0.dev12: `page.reload()` mounts the canvas but never the
 * welcome overlay (the overlay is an in-memory flag set before the navigation,
 * which a reload clears), and a focus or visibility event refetches nothing.
 * Starting over does. So the helper watches that request and, when the open
 * editor's latest answer is the 404, warns, deletes that placeholder (its id
 * never reaches any caller), goes home and clicks New Flow **once** more. Four
 * rules keep the recovery from hiding anything else:
 *  - only the flow the page is ON counts — a 404 for another flow (a spec's own
 *    flow, its request still in flight) must never delete that flow;
 *  - only the LATEST answer counts — an editor that got its types after all is
 *    loading, not stuck;
 *  - one re-entry, never a loop — a second 404 deletes the second placeholder
 *    too and fails naming both;
 *  - a blank editor without that 404 is not retried at all: it fails within the
 *    same budget as before, naming the page and what its types request answered,
 *    as a cause unknown.
 */
export const openNewFlowTemplatesModal = async (
  page: Page,
  { now = Date.now }: NewFlowEntryDeps = {},
) => {
  const types = watchTypesResponses(page);
  try {
    let outcome = await enterNewFlow(page, types, now);
    let reenteredAfter: string | undefined;

    if (outcome.kind === "stuck") {
      reenteredAfter = outcome.flowId;
      console.warn(
        `⚠️  openNewFlowTemplatesModal: New Flow created ${reenteredAfter}, but GET /api/v1/all?flow_id=${reenteredAfter} answered 404 — ` +
          `the editor asked for the flow before its creation had committed (LE-2598, #1865). The frontend never retries that, ` +
          `so the editor stays blank for good: deleting ${reenteredAfter} and entering New Flow once more.`,
      );
      await deletePlaceholder(page, reenteredAfter);
      await page.goto("/");
      await waitForPageEntry(page, '[data-testid="mainpage_title"]', 30000);
      outcome = await enterNewFlow(page, types, now);

      if (outcome.kind === "stuck") {
        await deletePlaceholder(page, outcome.flowId);
        throw new Error(
          `openNewFlowTemplatesModal: the editor of a new flow stayed blank twice — GET /api/v1/all?flow_id=<id> answered 404 ` +
            `for ${reenteredAfter} and, after one re-entry, for ${outcome.flowId} too (LE-2598, #1865). Both placeholders were ` +
            `deleted. New Flow is re-entered once, so a second 404 fails here instead of looping.`,
        );
      }
    }

    if (outcome.kind === "nothing") {
      throw new Error(nothingOpenedMessage(page, types, reenteredAfter));
    }

    await browsePastWelcomeOverlay(page);
  } finally {
    types.dispose();
  }
};
