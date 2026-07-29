import type { Page } from "@playwright/test";

/**
 * Radix trigger for the canvas-controls menu.
 *
 * Doubles as the repo's canvas-is-mounted gate — `setup-blank-flow`,
 * `setup-playground` and `load-template-by-name` all wait on this testid without
 * ever clicking it, which is why they are not sites of the defect below.
 */
export const CANVAS_CONTROLS = "canvas_controls_dropdown";

/**
 * Mirror of `use.actionTimeout` in `playwright.config.ts` (20 s).
 *
 * Not imported from there on purpose: the config reads the environment and runs
 * `dotenv`, and these helpers are exercised by `npm run test:units` outside the
 * Playwright runner. Kept as a named constant so the coupling is visible — the
 * reachability check below must not be stricter than the implicit budget the
 * callers used to get from `click()`'s own auto-wait.
 */
const ACTION_TIMEOUT_MS = 20_000;

/**
 * Makes `controlTestId` reachable, returning whether THIS call opened the menu.
 *
 * On the build this was written against (Nightly 1.12.0.dev7) every canvas
 * control — `fit_view`, `zoom_in`, `zoom_out`, `reset_zoom` — is rendered inside
 * the dropdown's `DropdownMenuContent`, so a control is present **iff** the menu
 * is open. That is a property of the current UI, not a contract: the day Langflow
 * surfaces these controls directly on the canvas, the probe below finds the
 * control already there and this function correctly does nothing.
 *
 * Probing the CONTROL rather than the trigger is the whole point. The trigger is
 * present whenever the canvas is up, so `if (trigger.count() > 0)` is a condition
 * that is always true — the shape `FlowEditorPage.adjustView()` carried (#1053).
 *
 * The return value answers exactly one question — "did this call open it?" — and
 * is only a *fallback* input to `closeCanvasControls`. It is deliberately not the
 * primary one; see that function.
 */
export async function openCanvasControls(
  page: Page,
  controlTestId: string,
): Promise<boolean> {
  if ((await page.getByTestId(controlTestId).count()) > 0) {
    return false;
  }

  await page.getByTestId(CANVAS_CONTROLS).click();

  // `waitFor`, not `count()`. Radix mounts the menu content asynchronously, so a
  // bare count immediately after the click can read 0 on a menu that is opening
  // normally — which would turn this guard into a flake on every dependent spec.
  // Callers used to absorb that latency by accident, because the next thing they
  // did was `click()` the control and Playwright's auto-wait covered it.
  //
  // The budget matches that accidental one — `actionTimeout` in
  // `playwright.config.ts`. A shorter one would be a NARROWER window than the
  // code this replaced, on ~140 dependent specs: a menu whose mount is merely
  // slow (a loaded worker, a template canvas re-rendering) would stop being
  // absorbed and start hard-failing with the message below, which names a
  // Langflow layout change. Keep the two in step.
  try {
    await page
      .getByTestId(controlTestId)
      .waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
  } catch {
    throw new Error(
      `[canvas-controls] "${controlTestId}" is still not rendered ` +
        `${ACTION_TIMEOUT_MS} ms after opening "${CANVAS_CONTROLS}". On the ` +
        `build these helpers were written against it lives inside that menu, so ` +
        `either the control was renamed, the layout changed (#997), or the menu ` +
        `never finished mounting. Check which before teaching the caller a new ` +
        `layout — and do not reintroduce a blind toggle.`,
    );
  }

  return true;
}

/**
 * Leaves the canvas-controls menu CLOSED — whoever opened it.
 *
 * The postcondition is what the callers need, and it is deliberately not
 * expressed as a toggle. An open canvas-controls menu is a documented click
 * interceptor for the next canvas action (#576), so "close it if it is open"
 * is correct on every path; "click the trigger again" is only correct while
 * the menu happens to be open, and silently *opens* one otherwise. That was the
 * same defect in all four call sites — #997 for `adjustScreenView`, #1053 for
 * `zoomOut`, `uploadFile` and the (now deleted) `FlowEditorPage` copies.
 *
 * Radix renders the trigger with `data-state="open" | "closed"` (verified on
 * Nightly 1.12.0.dev7), which answers the question directly. If that attribute
 * ever disappears we fall back to intent — close only what this call opened —
 * which is still safe: it can leave a pre-existing menu open, but it can never
 * open one.
 *
 * That fallback is ANNOUNCED rather than silent, and the warning is the point.
 * "Close only what this call opened" is precisely the fix #997 proposed and this
 * helper rejects, so degrading into it un-fixes the already-open case (#576's
 * leftover interceptor) — and no test can catch that, because the unit test for
 * this branch asserts the fallback as correct behaviour. If the attribute moves
 * off the element carrying the testid, the only signal will be this line, which
 * is why it names the `caller`: four helpers share this code, and a warning that
 * cannot say which one degraded costs a debugging session to attribute.
 */
export async function closeCanvasControls(
  page: Page,
  openedByThisCall: boolean,
  caller: string,
): Promise<void> {
  const controls = page.getByTestId(CANVAS_CONTROLS);
  const state = await controls
    .getAttribute("data-state", { timeout: 1000 })
    .catch(() => null);

  if (state === null) {
    console.warn(
      `⚠️  [${caller}] "${CANVAS_CONTROLS}" exposed no \`data-state\` — falling ` +
        `back to closing only what this call opened. A menu that was ALREADY ` +
        `open stays open and will intercept the next canvas click (#576). This ` +
        `is the behaviour #997 rejected: find where Radix now carries the ` +
        `open/closed state and read it there.`,
    );
  }

  const isOpen = state === null ? openedByThisCall : state === "open";

  if (isOpen) {
    await controls.click({ force: true, timeout: 1000 });
  }
}
