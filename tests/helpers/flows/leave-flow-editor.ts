// Leaving the flow editor, around an upstream exit deadlock (issue #1153).
//
// Clicking the editor's back chevron with a diverged store trips react-router's
// `useBlocker` and renders `SaveChangesModal`. In AUTOSAVE mode that dialog has
// no confirm and no cancel — upstream passes `loading` hardcoded `true` and
// leaves `confirmationText`/`cancelText`/`onConfirm` undefined, so
// `ConfirmationModal` renders no footer at all — which leaves
// `FlowPage.handleSave` as the only thing that can complete the navigation:
//
//   const handleSave = () => {
//     let saving = true; let proceed = false;
//     setTimeout(() => { saving = false; if (proceed) blocker.proceed?.() }, 1200);
//     saveFlow().then(() => {
//       if (!autoSaving || saving === false) blocker.proceed?.();
//       proceed = true;
//     });                                     // <- no .catch()
//   };
//
// When that save does not resolve, the `.then` never runs, `proceed` stays
// false, the 1200 ms timeout finds it false and does nothing, and the dialog
// spins indefinitely. Reproduced deterministically on 1.12.0.dev10 by aborting
// every flow-save PATCH: the modal appears, does not clear in 30 s, and the URL
// stays on `/flow/{id}`.
//
// The dialog DOES render `BaseModal`'s default X (and Escape works), so a human
// is not trapped on screen — but both route to `blocker.reset()`, which returns
// them to the editor. Dismissing is possible; LEAVING is not. Under natural load
// this fired twice in 24 runs at `--workers=4` (#1005's investigation), where it
// read as an unattributed `home-dropdown-menu` timeout.
//
// Shape of the workaround, following `renameFlow`'s #995 contract — PREVENTION
// first, recovery last, and loud either way:
//
//  - Prevention: drain in-flight flow saves before the click. `changesNotSaved`
//    is exactly what `useBlocker` gates on, so a settled store keeps most exits
//    out of the blocked state entirely.
//  - Recovery: only where the caller opts in. A full document load leaves the
//    SPA blocker behind — measured: `page.goto("/")` lands on `/flows` with the
//    home markers rendered and the dialog gone, the same route the chevron's own
//    handler navigates to (`appHeaderComponent` → `navigate("/")`). It also
//    DISCARDS whatever the editor had unsaved, so it is wrong for a caller whose
//    later assertions depend on that state — those get an attributed throw
//    instead, which is strictly better than the same failure 90 s downstream.

import { type Page, expect } from "@playwright/test";
import { waitForFlowSaveSettled } from "./wait-for-flow-save-settled";

/** The blocker dialog's title, `flow.unsavedChangesTitle` with `name: "Flow"`. */
const BLOCKER_TITLE = "Flow has unsaved changes";

/** Rendered on the flows list once it is interactive. */
const HOME_MARKER = "home-dropdown-menu";

/**
 * How long the blocker may legitimately stay up.
 *
 * Matched to `renameFlow`'s per-modal-step budget rather than to
 * `handleSave`'s own 1200 ms timeout: on a saturated single-backend daily a
 * single save click has needed far longer than that (45 s in #790's case), and
 * calling a slow-but-working save a deadlock would warn — and, where recovery is
 * enabled, discard state — on a healthy exit.
 */
export const BLOCKER_GRACE_MS = 15000;

/** Budget for the home list to render, on either path. */
const HOME_TIMEOUT_MS = 30000;

/** What the exit did, once the click has been made. */
export type EditorExitVerdict =
  /** Nothing has resolved yet and the grace window is still open — keep polling. */
  | "pending"
  /** Home rendered. */
  | "left"
  /** Home rendered with the dialog still painted — it came and went. */
  | "blocked-settled"
  /** The blocker is still up past the grace window: #1153. */
  | "blocked-deadlocked"
  /** Neither home nor the blocker — the click did not register at all. */
  | "stuck";

/**
 * Classify an exit attempt from what is on screen. Pure, so the `node --test`
 * lane covers the distinctions instead of a Playwright run having to produce
 * each of them.
 *
 * The `stuck` verdict is kept separate from `blocked-deadlocked` on purpose: a
 * swallowed chevron click and a blocked navigation both end with the editor
 * still on screen, and they send a reader to opposite places (the #420 /
 * LE-2019 dead-click class vs. this upstream defect). Collapsing them would
 * re-create the unattributed timeout this helper exists to replace.
 */
export function classifyEditorExit(observed: {
  homeVisible: boolean;
  blockerVisible: boolean;
  graceExpired: boolean;
}): EditorExitVerdict {
  // Home wins even with the dialog still painted: the route changed, which is
  // the only thing the caller asked for. The dialog animates out, so it is
  // routinely still in the DOM on the tick where home first renders — reporting
  // that as a deadlock would fire on healthy exits.
  if (observed.homeVisible) {
    return observed.blockerVisible ? "blocked-settled" : "left";
  }
  if (observed.blockerVisible) {
    return observed.graceExpired ? "blocked-deadlocked" : "pending";
  }
  return observed.graceExpired ? "stuck" : "pending";
}

/**
 * The line a triager reads when the deadlock fires. It has to name the defect,
 * not just the symptom — an unattributed `home-dropdown-menu` timeout is exactly
 * what #1005 spent a 24-run burst re-deriving.
 */
export function formatEditorExitWarning(graceMs: number): string {
  return (
    `[leaveFlowEditor] the editor exit is deadlocked behind SaveChangesModal ` +
    `("${BLOCKER_TITLE}") — it did not clear in ${graceMs}ms, and in autosave ` +
    `mode that dialog renders no confirm and no cancel, so nothing but ` +
    `FlowPage.handleSave can complete the navigation. Upstream defect: ` +
    `handleSave calls saveFlow() with no .catch(), so a save that fails or ` +
    `never settles leaves the blocker up indefinitely (issue #1153).`
  );
}

/** Same, for the swallowed-click case — a different cause and a different fix. */
export function formatEditorExitStuckFailure(graceMs: number): string {
  return (
    `[leaveFlowEditor] the chevron click did not navigate and nothing is ` +
    `blocking it: no flows list and no SaveChangesModal after ${graceMs}ms. ` +
    `This is the swallowed-click class (#420 / LE-2019), NOT the #1153 exit ` +
    `deadlock — the editor is simply still on screen.`
  );
}

export interface LeaveFlowEditorOptions {
  /**
   * Recover from a #1153 deadlock with a full page load instead of throwing.
   *
   * Off by default, because the reload discards whatever the editor had unsaved.
   * Opt in only where nothing the test asserts later depends on that state —
   * otherwise the recovery converts a clean, attributed failure at the exit into
   * an inscrutable one much further downstream.
   */
  escapeDeadlock?: boolean;
}

/**
 * Click the editor's back chevron and land on the flows list.
 *
 * Replaces the bare `getByTestId("icon-ChevronLeft").click()` plus a home
 * assertion. On the happy path it costs the save barrier plus one visibility
 * poll; it only pays the grace window when the blocker actually shows up.
 *
 * The closing assertion is unconditional, so a navigation that genuinely never
 * happens still fails the caller.
 *
 * Only valid for editors whose exit target is the default flows list — the
 * chevron's own handler is `navigate("/")`. A caller that exits into a specific
 * folder view needs its own assertion, not this helper.
 */
export async function leaveFlowEditor(
  page: Page,
  { escapeDeadlock = false }: LeaveFlowEditorOptions = {},
): Promise<EditorExitVerdict> {
  // Prevention. `useBlocker(changesNotSaved || isBuilding)` only fires when the
  // store has diverged from what is persisted, so draining the in-flight saves
  // first keeps most exits out of the blocked state. Request-aware, not a
  // silence probe (#995), so a PATCH already issued still holds the barrier.
  await waitForFlowSaveSettled(page);

  const home = page.getByTestId(HOME_MARKER).first();
  // Scoped to the dialog and `.first()`: an unscoped `getByText` that matched
  // two nodes would raise a strict-mode violation, which the `.catch()` below
  // swallows into "not visible" — silently downgrading every deadlock to
  // `stuck`, i.e. losing exactly the attribution this helper exists for.
  const blocker = page
    .locator('[role="dialog"]')
    .getByText(BLOCKER_TITLE)
    .first();

  await page.getByTestId("icon-ChevronLeft").first().click();

  // Poll both rather than awaiting either: a `waitFor` on the blocker would pay
  // its full timeout on every healthy exit, and a `waitFor` on home would hide
  // which of the two failure modes happened.
  const deadline = Date.now() + BLOCKER_GRACE_MS;
  let verdict: EditorExitVerdict;
  for (;;) {
    verdict = classifyEditorExit({
      homeVisible: await home.isVisible().catch(() => false),
      blockerVisible: await blocker.isVisible().catch(() => false),
      graceExpired: Date.now() >= deadline,
    });
    if (verdict !== "pending") break;
    await page.waitForTimeout(200);
  }

  if (verdict === "blocked-deadlocked") {
    if (!escapeDeadlock) {
      // Thrown, not warned: console output is not attached to the Playwright
      // failure, and the whole point is that the reason reaches the report.
      throw new Error(formatEditorExitWarning(BLOCKER_GRACE_MS));
    }
    // Loud on purpose — a silent recovery would hide how often #1153 fires,
    // which is the only signal the suite has on it.
    console.warn(
      `${formatEditorExitWarning(BLOCKER_GRACE_MS)} Escaping with a full page ` +
        `load; anything this flow had unsaved is discarded.`,
    );
    await page.goto("/");
  }

  if (verdict === "stuck") {
    throw new Error(formatEditorExitStuckFailure(BLOCKER_GRACE_MS));
  }

  await expect(home).toBeVisible({ timeout: HOME_TIMEOUT_MS });
  return verdict;
}
