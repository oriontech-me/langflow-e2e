import {
  type Locator,
  type Page,
  type Response,
  expect,
} from "@playwright/test";
import { awaitBootstrapTest } from "../other/await-bootstrap-test";
import { adjustScreenView } from "./adjust-screen-view";

// Shared testids and selectors for the Prompt Template component, sourced
// from live UI inspection and the upstream Langflow frontend source:
//   add button:               "add-component-button-prompt-template"
//   node title:               "title-Prompt Template"
//   toggle (InspectionPanel): "toggle_bool_use_double_brackets"
//   f-string modal open:      "button_open_prompt_modal"
//   f-string textarea:        "modal-promptarea_prompt_template"
//   mustache modal open:      "button_open_mustache_prompt_modal"
//   mustache textarea:        "modal-mustachepromptarea_mustache_template"
//   modal save btn:           "genericModalBtnSave"
//   modal preview:            "edit-prompt-sanitized"  (shared between modes)
//   output handle:            "handle-prompt template-shownode-prompt-right"
//   dynamic handles:          "handle-prompt template-shownode-{varname}-left"
//   error toast:              CSS class ".error-build-message" (no data-testid;
//                             sourced from src/frontend/src/alerts/error/index.tsx)

const FSTRING_OPEN_BUTTON = "button_open_prompt_modal";
const FSTRING_TEXTAREA = "modal-promptarea_prompt_template";
const MUSTACHE_OPEN_BUTTON = "button_open_mustache_prompt_modal";
const MUSTACHE_TEXTAREA = "modal-mustachepromptarea_mustache_template";

/**
 * Block until the flow's debounced autosave has settled.
 *
 * Adding a node and fitting/zooming the canvas viewport each mutate the flow
 * and schedule a debounced (300 ms) `PATCH /api/v1/flows/{id}` autosave
 * (upstream `use-autosave-flow.ts` / `SAVE_DEBOUNCE_TIME`). If such an autosave
 * is still in flight when the next flow-mutating action fires its own PATCH —
 * e.g. saving the prompt modal — the two requests race, and with no retry or
 * version check on that endpoint the backend can return a transient failure
 * that the frontend renders as a "Failed to save flow" toast. That toast uses
 * the same `.error-build-message` class the rejection assertions key on, so the
 * race surfaces as cross-case flake (see issue #358).
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

/**
 * Bootstraps a fresh blank flow, drops a Prompt Template node onto it via the
 * sidebar search/add path, and waits for exactly one node to render on the
 * canvas.
 *
 * Before returning, it waits for the node-add / viewport autosaves to settle
 * (`waitForFlowSaveSettled`) so the next flow-save the caller triggers — e.g.
 * saving the prompt modal — runs on its own and cannot race a still-in-flight
 * autosave into a spurious "Failed to save flow" toast (issue #358).
 */
export async function addPromptComponent(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeAttached({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("prompt");
  await expect(
    page.getByTestId("add-component-button-prompt-template"),
  ).toBeAttached({ timeout: 30000 });
  await page.getByTestId("add-component-button-prompt-template").click();

  await adjustScreenView(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(1, {
    timeout: 10000,
  });

  await waitForFlowSaveSettled(page);
}

/**
 * Locator for the dynamic (left-side) input handles created from variable
 * placeholders on the Prompt Template node. The output `-right` handle is
 * excluded by the suffix filter so counts reflect dynamic-handle-only deltas.
 */
export function dynamicHandlesLocator(page: Page): Locator {
  return page.locator(
    '[data-testid^="handle-prompt template-shownode-"][data-testid$="-left"]',
  );
}

/**
 * Locator for the error toast rendered by `ErrorAlert` when the prompt modal's
 * `onError` callback fires (no `data-testid` is exposed by the upstream alert
 * component, so the CSS class is the stable anchor).
 */
export function errorToastLocator(page: Page): Locator {
  return page.locator(".error-build-message");
}

/**
 * Drive the `use_double_brackets` toggle to the given state. Idempotent — if
 * the UI is already in the requested mode the toggle is left alone; otherwise
 * the toggle is clicked once. Either way, the post-condition is that the
 * matching modal-open button is visible.
 *
 * The probe uses the modal-open button itself (not the toggle's ARIA/data
 * state) as the canonical mode indicator: with `real_time_refresh=True`,
 * `update_build_config` swaps `template.type` between PROMPT and
 * MUSTACHE_PROMPT, which re-renders the modal-open button under
 * `button_open_prompt_modal` or `button_open_mustache_prompt_modal`. That
 * re-render is the reliable signal we already rely on downstream.
 *
 * @param enabled `true` enables mustache mode; `false` reverts to f-string.
 */
export async function setUseDoubleBrackets(
  page: Page,
  enabled: boolean,
): Promise<void> {
  const expectedOpenButton = enabled
    ? MUSTACHE_OPEN_BUTTON
    : FSTRING_OPEN_BUTTON;
  const alreadyInDesiredState = await page
    .getByTestId(expectedOpenButton)
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (!alreadyInDesiredState) {
    await page.getByTestId("toggle_bool_use_double_brackets").click();
  }
  await expect(page.getByTestId(expectedOpenButton)).toBeVisible({
    timeout: 10000,
  });
}

export interface FillPromptTemplateOptions {
  /** Which modal to drive. Defaults to `"fstring"`. */
  mode?: "fstring" | "mustache";
  /**
   * Whether to wait for the textarea to hide after clicking save. Defaults to
   * `true` (success path). Set to `false` when submitting input that the
   * backend is expected to reject — the modal stays in edit mode (the
   * frontend sets `isEdit=true`) and the textarea remains visible.
   */
  waitForHide?: boolean;
}

/**
 * Open the active prompt modal (f-string or mustache, depending on
 * `opts.mode`), replace its current value with `value`, and click save.
 *
 * The save round-trip can end in one of two states:
 *   - success: textarea hides, sanitized preview appears
 *   - error:   `setIsEdit(true)` keeps the textarea visible and a toast
 *              with class `.error-build-message` is rendered
 *
 * After a previous successful save, the modal initially shows the sanitized
 * preview (read-only) instead of the textarea — this helper clicks the preview
 * to re-enter edit mode before filling. With `waitForHide=true` (default),
 * waits for the textarea to disappear as the close signal; callers asserting
 * on the error path should pass `waitForHide: false` and assert on the
 * post-save state themselves.
 */
export async function fillPromptTemplate(
  page: Page,
  value: string,
  opts: FillPromptTemplateOptions = {},
): Promise<void> {
  const { mode = "fstring", waitForHide = true } = opts;
  const openButtonTestId =
    mode === "mustache" ? MUSTACHE_OPEN_BUTTON : FSTRING_OPEN_BUTTON;
  const textareaTestId =
    mode === "mustache" ? MUSTACHE_TEXTAREA : FSTRING_TEXTAREA;

  await page.getByTestId(openButtonTestId).click();

  const textarea = page.getByTestId(textareaTestId);

  // On a fresh component (first save) or after an error path that left the
  // modal in edit mode, the preview never mounts — keep the probe short so
  // those callers don't each pay a 2s tax just to learn there is nothing to
  // click. The post-save preview mounts well within 500ms in practice; the
  // downstream `expect(textarea).toBeVisible(...)` is the real correctness
  // gate.
  const preview = page.getByTestId("edit-prompt-sanitized");
  if (await preview.isVisible({ timeout: 500 }).catch(() => false)) {
    await preview.click();
  }

  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.click();
  await textarea.fill(value);

  await page.getByTestId("genericModalBtnSave").click();

  if (waitForHide) {
    // The textarea testid is scoped to the active prompt modal, so its
    // disappearance is a reliable signal that the modal closed and the save
    // round-trip began.
    await expect(textarea).toBeHidden({ timeout: 10000 });
  }
}
