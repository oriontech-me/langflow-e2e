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

/**
 * How long the flows list may take to render before the exit is called broken.
 *
 * Deliberately LONGER than `BLOCKER_GRACE_MS` and tracked as its own deadline:
 * the two windows answer different questions and collapsing them costs a real
 * budget. `BLOCKER_GRACE_MS` bounds "the dialog is up and not clearing" — the
 * one thing the blocker being on screen already tells us. This bounds "nothing
 * is on screen yet", which is the ordinary in-flight navigation: a client-side
 * route change plus the listing's own `GET /api/v1/flows/`, and on a saturated
 * single-backend daily that request is exactly what runs long (#790 measured
 * 45 s for a single save). The 30 s is inherited, not invented — it is what
 * `duplicate-flow` and `export-import-flow` already allowed this assertion
 * before the helper existed.
 *
 * Charging the blocker's 15 s to a healthy-but-slow navigation would fail it as
 * `stuck`, i.e. report the swallowed-click class (#420 / LE-2019) on a run where
 * the click landed fine — the same mis-attribution this helper exists to end,
 * only with a confident label instead of a silent timeout.
 */
export const HOME_TIMEOUT_MS = 30000;

/** What the exit did, once the click has been made. */
export type EditorExitVerdict =
  /** Nothing has resolved yet and its own window is still open — keep polling. */
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
 *
 * The two terminal failures are gated on SEPARATE deadlines, and they must stay
 * separate. `graceExpired` (`BLOCKER_GRACE_MS`) only ever promotes a dialog that
 * is already up; `homeBudgetExpired` (`HOME_TIMEOUT_MS`) is the only thing that
 * may call an empty screen `stuck`. Sharing one deadline would charge the
 * blocker's short grace window to an ordinary slow navigation and report it as a
 * dead click.
 */
export function classifyEditorExit(observed: {
  homeVisible: boolean;
  blockerVisible: boolean;
  graceExpired: boolean;
  homeBudgetExpired: boolean;
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
  // Nothing on screen is the in-flight navigation, so it gets the full home
  // budget — NOT the blocker's grace window.
  return observed.homeBudgetExpired ? "stuck" : "pending";
}

/**
 * The line a triager reads when the deadlock fires. It has to name the defect,
 * not just the symptom — an unattributed `home-dropdown-menu` timeout is exactly
 * what #1005 spent a 24-run burst re-deriving.
 *
 * The window DEFAULTS to the constant this verdict is actually gated on, so the
 * call sites pass nothing and the unit lane can pin the pairing. Passing it in
 * left the "which budget does this message quote" wiring as an untested
 * one-liner — the very drift the test asserting against the real constant was
 * written to prevent.
 */
export function formatEditorExitWarning(
  graceMs: number = BLOCKER_GRACE_MS,
): string {
  return (
    `[leaveFlowEditor] the editor exit is deadlocked behind SaveChangesModal ` +
    `("${BLOCKER_TITLE}") — it did not clear in ${graceMs}ms, and in autosave ` +
    `mode that dialog renders no confirm and no cancel, so nothing but ` +
    `FlowPage.handleSave can complete the navigation. Upstream defect: ` +
    `handleSave calls saveFlow() with no .catch(), so a save that fails or ` +
    `never settles leaves the blocker up indefinitely (issue #1153).`
  );
}

/**
 * Same, for the swallowed-click case — a different cause and a different fix.
 *
 * Defaults to the HOME budget, not the blocker's grace window: that is the
 * window this verdict actually waited out, and quoting the shorter one would
 * understate the evidence behind a claim as specific as "the click never
 * registered".
 */
export function formatEditorExitStuckFailure(
  homeBudgetMs: number = HOME_TIMEOUT_MS,
): string {
  return (
    `[leaveFlowEditor] the chevron click did not navigate and nothing is ` +
    `blocking it: no flows list and no SaveChangesModal after ` +
    `${homeBudgetMs}ms. This is the swallowed-click class (#420 / LE-2019), ` +
    `NOT the #1153 exit deadlock — the editor is simply still on screen.`
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
 * It never shortens the budget the call sites had before it: an exit that is
 * simply slow keeps the full `HOME_TIMEOUT_MS`, and only a dialog that is
 * demonstrably on screen is judged on the shorter `BLOCKER_GRACE_MS`.
 *
 * Every path either throws with the cause named or ends on the closing
 * assertion, so a navigation that never happened cannot be reported as an exit.
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
  //
  // Two deadlines, not one. The blocker's grace window is short because a dialog
  // that is already up is evidence in itself; an empty screen is just an
  // in-flight navigation and gets the full home budget. Sharing one deadline
  // would fail a slow-but-healthy exit as a dead click.
  const blockerDeadline = Date.now() + BLOCKER_GRACE_MS;
  const homeDeadline = Date.now() + HOME_TIMEOUT_MS;
  let verdict: EditorExitVerdict;
  for (;;) {
    verdict = classifyEditorExit({
      homeVisible: await home.isVisible().catch(() => false),
      blockerVisible: await blocker.isVisible().catch(() => false),
      graceExpired: Date.now() >= blockerDeadline,
      homeBudgetExpired: Date.now() >= homeDeadline,
    });
    if (verdict !== "pending") break;
    await page.waitForTimeout(200);
  }

  if (verdict === "blocked-deadlocked") {
    if (!escapeDeadlock) {
      // Thrown, not warned: console output is not attached to the Playwright
      // failure, and the whole point is that the reason reaches the report.
      throw new Error(formatEditorExitWarning());
    }
    // Loud on purpose — a silent recovery would hide how often #1153 fires,
    // which is the only signal the suite has on it.
    console.warn(
      `${formatEditorExitWarning()} Escaping with a full page load; anything ` +
        `this flow had unsaved is discarded.`,
    );
    // Load-bearing Playwright default: `FlowPage` registers a `beforeunload`
    // that calls `preventDefault()` whenever `changesNotSaved || isBuilding` —
    // i.e. always, on this path. The load only completes because Playwright
    // ACCEPTS beforeunload dialogs when no `page.on("dialog")` handler is
    // registered (`dialog.close()` → `accept()` for that type, `dismiss()` for
    // every other). No spec in this repo registers one; the first that does
    // would silently turn this escape into a cancelled navigation.
    await page.goto("/");
  }

  if (verdict === "stuck") {
    throw new Error(formatEditorExitStuckFailure());
  }

  // Reached only with home already visible (`left` / `blocked-settled`) or right
  // after the escape's page load, so this never stacks a second full budget on
  // top of the poll above. Kept unconditional so the helper cannot return a
  // verdict it did not actually observe.
  await expect(home).toBeVisible({ timeout: HOME_TIMEOUT_MS });
  return verdict;
}
