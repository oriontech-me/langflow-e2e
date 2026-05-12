import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Run serially to avoid 500 errors from concurrent POST /api/v1/flows/
// when several workers create a blank flow at the same time.
test.describe.configure({ mode: "serial" });

// Verified testids from live UI / frontend source inspection:
//   add button:               "add-component-button-prompt-template"
//   node title:               "title-Prompt Template"
//   toggle (InspectionPanel): "toggle_bool_use_double_brackets"
//   f-string modal open:      "button_open_prompt_modal"
//   f-string textarea:        "modal-promptarea_prompt_template"
//   mustache modal open:      "button_open_mustache_prompt_modal"
//   mustache textarea:        "modal-mustachepromptarea_mustache_template"
//   modal save btn:           "genericModalBtnSave"
//   modal preview:            "edit-prompt-sanitized"  (shared between both modes)
//   dynamic handles:          "handle-prompt template-shownode-{varname}-left"
//
// `use_double_brackets` carries `advanced=True` upstream, which only filters the
// field from the on-canvas node body via `isCanvasVisible()`. The right-hand
// InspectionPanel still renders advanced fields directly (no gating modal),
// so the bool toggle is interactable as soon as the node is selected — which
// happens automatically when it is added to a blank flow.

const dynamicHandlesLocator = (page: Page) =>
  page.locator(
    '[data-testid^="handle-prompt template-shownode-"][data-testid$="-left"]',
  );

async function addPromptComponent(page: Page) {
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
}

// Flip the `use_double_brackets` toggle in the InspectionPanel and wait for the
// field-type switch to take effect. With `real_time_refresh=True`, toggling the
// bool causes `update_build_config` to swap `template.type` between PROMPT and
// MUSTACHE_PROMPT, which re-renders the modal-open button under a different
// testid — that re-render is the reliable signal that the switch has landed.
async function flipDoubleBrackets(page: Page, expectMustache: boolean) {
  await page.getByTestId("toggle_bool_use_double_brackets").click();
  const expectedOpenButton = expectMustache
    ? "button_open_mustache_prompt_modal"
    : "button_open_prompt_modal";
  await expect(page.getByTestId(expectedOpenButton)).toBeVisible({
    timeout: 10000,
  });
}

// Open the active prompt modal (f-string or mustache, depending on `mode`), replace
// its current value with `value`, and save. Mirrors the helper in
// prompt-template-component-regression.spec.ts but parameterises the testid pair
// because the modal-open button and textarea both change when mustache mode is on.
async function setPromptTemplate(
  page: Page,
  value: string,
  mode: "fstring" | "mustache" = "fstring",
) {
  const openButtonTestId =
    mode === "mustache"
      ? "button_open_mustache_prompt_modal"
      : "button_open_prompt_modal";
  const textareaTestId =
    mode === "mustache"
      ? "modal-mustachepromptarea_mustache_template"
      : "modal-promptarea_prompt_template";

  await page.getByTestId(openButtonTestId).click();

  const textarea = page.getByTestId(textareaTestId);

  // After a previous save, the modal initially shows the sanitized preview
  // (read-only) instead of the textarea. Clicking the preview re-enters edit
  // mode and mounts the textarea.
  const preview = page.getByTestId("edit-prompt-sanitized");
  if (await preview.isVisible({ timeout: 2000 }).catch(() => false)) {
    await preview.click();
  }

  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.click();
  await page.keyboard.press("Control+a");
  await textarea.fill(value);

  await page.getByTestId("genericModalBtnSave").click();
  await expect(textarea).toBeHidden({ timeout: 10000 });
}

test(
  "Prompt Template — use_double_brackets toggle is exposed in the InspectionPanel with its upstream display name",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Toggle is visible in the InspectionPanel by default",
      async () => {
        await expect(
          page.getByTestId("toggle_bool_use_double_brackets"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Field surfaces its upstream display name — wiring of BoolInput is intact",
      async () => {
        // The literal "Use Double Brackets" comes from the upstream
        // `BoolInput(..., display_name="Use Double Brackets", ...)` declaration —
        // asserting it catches an accidental rename at the source.
        //
        // The assertion is anchored on the toggle: XPath climbs the ancestor
        // axis from the toggle and picks the closest ancestor whose subtree
        // contains the label string. If the label is renamed and no ancestor
        // of the toggle has the text anymore, the locator resolves to zero
        // elements and `toBeVisible()` fails — proving the label-toggle
        // wiring regressed. A bare `getByText(...).first()` would match the
        // string anywhere on the page and could be satisfied by an unrelated
        // tooltip elsewhere, masking the same regression.
        //
        // The `info` text ("Use {{variable}} syntax …") is intentionally not
        // asserted — the InspectionPanel collapses it into a hover-tooltip
        // icon when the panel is narrow.
        const labelOwner = page
          .getByTestId("toggle_bool_use_double_brackets")
          .locator(
            "xpath=ancestor::*[contains(., 'Use Double Brackets')][1]",
          );
        await expect(labelOwner).toBeVisible();
      },
    );
  },
);

test(
  "Prompt Template — default toggle state is OFF; f-string mode extracts {var} and treats {{var}} as literal",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save template `Hello {single} and {{double}}!` in default (f-string) mode",
      async () => {
        await setPromptTemplate(
          page,
          "Hello {single} and {{double}}!",
          "fstring",
        );
      },
    );

    await test.step(
      "Only `single` is extracted — `{{double}}` is a literal `{double}` in f-string mode",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-single-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-double-left"),
        ).toHaveCount(0);
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );
  },
);

test(
  "Prompt Template — enabling toggle switches parser to mustache mode; {{var}} creates handle and {var} is ignored",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step("Enable double brackets — switches to mustache mode", async () => {
      await flipDoubleBrackets(page, true);
    });

    await test.step(
      "Save template `Hello {single} and {{double}}!` in mustache mode",
      async () => {
        await setPromptTemplate(
          page,
          "Hello {single} and {{double}}!",
          "mustache",
        );
      },
    );

    await test.step(
      "Only `double` is extracted — `{single}` is ignored in mustache mode",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-double-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-single-left"),
        ).toHaveCount(0);
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );
  },
);

test(
  "Prompt Template — disabling toggle reverts to f-string mode and variables are re-extracted under the new parser",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Enable mustache mode and save `Hello {{name}}!` — `name` handle appears",
      async () => {
        await flipDoubleBrackets(page, true);
        await setPromptTemplate(page, "Hello {{name}}!", "mustache");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );

    await test.step(
      "Disable mustache mode — modal-open button swaps back to the f-string variant",
      async () => {
        await flipDoubleBrackets(page, false);
        // Explicit assertion at the test level so the HTML report shows a real
        // `expect()` in this step, even though `flipDoubleBrackets` already
        // waited on the same testid internally.
        await expect(
          page.getByTestId("button_open_prompt_modal"),
        ).toBeVisible();
        await expect(
          page.getByTestId("button_open_mustache_prompt_modal"),
        ).toHaveCount(0);
        // Note: an existing `name` handle may persist past the toggle alone —
        // the upstream cleanup-and-re-extraction runs inside `update_build_config`,
        // but the rendered handles are only fully reconciled after the next save
        // in the active mode. The re-extraction contract is verified by the
        // following step.
      },
    );

    await test.step(
      "Re-saving the same template in f-string mode drops the now-literal `{{name}}` handle",
      async () => {
        await setPromptTemplate(page, "Hello {{name}}!", "fstring");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toHaveCount(0, { timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(0);
      },
    );

    await test.step(
      "Saving `{var}` in f-string mode recreates a dynamic handle",
      async () => {
        await setPromptTemplate(page, "Just one {var} here.", "fstring");
        await expect(
          page.getByTestId("handle-prompt template-shownode-var-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );
  },
);

// Reads `template.use_double_brackets.value` for the Prompt Template node in
// the autosaved flow. Returns `null` when the flow is not yet fetchable or the
// node is missing — `expect.poll` retries until a definite boolean comes back.
// Hoisted out of the test body so the `if (!res.ok())` guard does not trip the
// `playwright/no-conditional-in-test` ESLint rule.
async function readUseDoubleBrackets(page: Page, flowId: string) {
  const res = await page.request.get(`/api/v1/flows/${flowId}`);
  if (!res.ok()) return null;
  const flow = await res.json();
  const promptNode = (flow?.data?.nodes ?? []).find(
    (n: { data?: { type?: string } }) =>
      n?.data?.type === "Prompt Template",
  );
  return promptNode?.data?.node?.template?.use_double_brackets?.value ?? null;
}

test(
  "Prompt Template — use_double_brackets value persists in the autosaved flow",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    let flowId = "";

    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
      flowId = page.url().split("/").slice(-1)[0];
      expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step(
      "Baseline — `template.use_double_brackets.value` starts as `false`",
      async () => {
        await expect
          .poll(() => readUseDoubleBrackets(page, flowId), {
            timeout: 15000,
            intervals: [500, 1000, 2000],
          })
          .toBe(false);
      },
    );

    await test.step("Enable double brackets", async () => {
      await flipDoubleBrackets(page, true);
    });

    await test.step(
      "Backend persistence — toggling flips the saved value to `true`",
      async () => {
        await expect
          .poll(() => readUseDoubleBrackets(page, flowId), {
            timeout: 15000,
            intervals: [500, 1000, 2000],
          })
          .toBe(true);
      },
    );
  },
);
