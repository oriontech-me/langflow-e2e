import type { Page, Response } from "@playwright/test";

/**
 * Block until the flow's debounced autosave has settled.
 *
 * Many editor actions mutate the flow and schedule a debounced (300 ms)
 * `PATCH /api/v1/flows/{id}` autosave (upstream `use-autosave-flow.ts` /
 * `SAVE_DEBOUNCE_TIME`): adding a node, fitting/zooming the canvas viewport,
 * or simply opening a flow (the editor fits the view on mount). If such an
 * autosave is still in flight when the next flow-mutating action fires its own
 * PATCH — e.g. saving the prompt modal, or saving the flow-settings modal — the
 * two requests race. With no retry or version check on that endpoint the
 * backend can return a transient failure that the frontend renders as a
 * "Failed to save flow" toast, and the in-flight response can re-render the
 * open modal, detaching inputs mid-interaction.
 *
 * This surfaces as cross-test flake: a spurious error toast (issue #358) or a
 * detached `input-flow-name` / never-enabled `save-flow-settings` in the rename
 * helper (issue #357).
 *
 * Resolves once no flow-save PATCH has been observed for `quietMs` (chosen
 * comfortably above the 300 ms autosave debounce), or after `timeout` as a
 * safety cap so a quiet flow never hangs the caller.
 */
export async function waitForFlowSaveSettled(
  page: Page,
  { quietMs = 700, timeout = 10000 }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const isFlowSave = (resp: Response) =>
    resp.url().includes("/api/v1/flows/") &&
    resp.request().method() === "PATCH";

  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;

    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(cap);
      page.off("response", onResponse);
      resolve();
    };

    const arm = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };

    const onResponse = (resp: Response) => {
      if (isFlowSave(resp)) arm();
    };

    const cap = setTimeout(finish, timeout);
    page.on("response", onResponse);
    arm();
  });
}
