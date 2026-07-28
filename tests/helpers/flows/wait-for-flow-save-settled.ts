import type { Page, Request } from "@playwright/test";

/**
 * Block until the flow's debounced autosave has settled.
 *
 * Many editor actions mutate the flow and schedule a debounced (300 ms)
 * `PATCH /api/v1/flows/{id}` autosave (upstream `use-autosave-flow.ts` /
 * `SAVE_DEBOUNCE_TIME`): adding a node, fitting/zooming the canvas viewport,
 * or simply opening a flow (the editor fits the view on mount). If such an
 * autosave is still in flight when the next flow-mutating action fires its own
 * PATCH — e.g. saving the prompt modal, or saving the flow-settings modal — the
 * two requests race. The endpoint has no version check and the frontend applies
 * whichever response lands LAST (`use-save-flow.ts` → `setCurrentFlow(updatedFlow)`
 * in the mutation's `onSuccess`), so the loser silently overwrites the winner in
 * both the store and the database.
 *
 * This surfaces as cross-test flake: a spurious error toast (issue #358), a
 * detached `input-flow-name` / never-enabled `save-flow-settings` (issue #357),
 * or a rename that is reverted to the pre-rename name (issue #995).
 *
 * Resolves once **no flow-save PATCH is in flight** and none has completed for
 * `quietMs` (chosen comfortably above the 300 ms autosave debounce), or after
 * `timeout` as a safety cap so a quiet flow never hangs the caller.
 *
 * Tracking requests — not just responses — is what makes this a barrier rather
 * than a silence probe (issue #995). The response-only version armed its quiet
 * timer immediately, so a PATCH that had already been *issued* but whose
 * response was slow under load (>`quietMs`) left the helper returning while the
 * autosave was still in flight — exactly the window in which the caller's own
 * PATCH races it.
 */
export async function waitForFlowSaveSettled(
  page: Page,
  { quietMs = 700, timeout = 10000 }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const isFlowSave = (req: Request) =>
    req.url().includes("/api/v1/flows/") && req.method() === "PATCH";

  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = 0;

    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(cap);
      page.off("request", onRequest);
      page.off("requestfinished", onSettled);
      page.off("requestfailed", onSettled);
      resolve();
    };

    // Only start counting silence when nothing is in flight; a pending PATCH
    // keeps the barrier closed no matter how long its response takes.
    const arm = () => {
      clearTimeout(quietTimer);
      if (inFlight === 0) quietTimer = setTimeout(finish, quietMs);
    };

    const onRequest = (req: Request) => {
      if (!isFlowSave(req)) return;
      inFlight++;
      clearTimeout(quietTimer);
    };

    // A PATCH that was already in flight before this helper attached decrements
    // below zero; clamping keeps the counter honest and still re-arms the quiet
    // window, preserving the original response-driven behaviour for that case.
    const onSettled = (req: Request) => {
      if (!isFlowSave(req)) return;
      inFlight = Math.max(0, inFlight - 1);
      arm();
    };

    const cap = setTimeout(finish, timeout);
    page.on("request", onRequest);
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);
    arm();
  });
}
