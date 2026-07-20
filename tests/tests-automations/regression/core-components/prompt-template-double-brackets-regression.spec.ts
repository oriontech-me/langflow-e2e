import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import {
  addPromptComponent,
  dynamicHandlesLocator,
  fillPromptTemplate,
  setUseDoubleBrackets,
} from "../../../helpers/ui/prompt-template";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";

// Flows are created via the REST API (setupBlankFlow) and deleted in afterEach
// (issue #545). Kept serial so the per-file flow lifecycle stays deterministic
// under load.
test.describe.configure({ mode: "serial" });

let createdFlowId: string | null = null;

test.beforeEach(async ({ page }) => {
  // setupBlankFlow creates the flow via API (no UI-creation 500 race) and
  // returns its id so afterEach can delete it. Capturing the id before the
  // component add means a failure in addPromptComponent still cleans up.
  createdFlowId = await setupBlankFlow(page);
  await addPromptComponent(page);
});

test.afterEach(async ({ page }) => {
  if (createdFlowId) {
    // Leave the editor first: staying on it while the flow is deleted makes
    // background polling 404, which the fixture's error monitor would flag.
    await page.goto("/").catch(() => {});
    await deleteFlow(page.request, createdFlowId);
    createdFlowId = null;
  }
});

// `use_double_brackets` carries `advanced=True` upstream, which only filters the
// field from the on-canvas node body via `isCanvasVisible()`. The right-hand
// InspectionPanel still renders advanced fields directly (no gating modal),
// so the bool toggle is interactable as soon as the node is selected — which
// happens automatically when it is added to a blank flow.

test(
  "Prompt Template — use_double_brackets toggle is exposed in the InspectionPanel with its upstream display name",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // dev49: `use_double_brackets` is an advanced field, so it no longer
    // renders on the node body by default and the auto-opening InspectionPanel
    // is gone. Open the on-demand inspector (parameters-button) where the
    // advanced field is listed as `inspector-param-use_double_brackets`.
    await page.getByTestId("title-Prompt Template").click();
    await openAdvancedOptions(page);

    await test.step(
      "Field is exposed in the InspectionPanel",
      async () => {
        await expect(
          page.getByTestId("inspector-param-use_double_brackets"),
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
        // The assertion is anchored on the field row: XPath climbs the
        // ancestor-or-self axis from `inspector-param-use_double_brackets` and
        // picks the closest node whose subtree contains the label string. If
        // the label is renamed and the field row no longer carries the text,
        // the locator resolves to zero elements and `toBeVisible()` fails —
        // proving the label-field wiring regressed. A bare `getByText(...)`
        // would match the string anywhere on the page and could be satisfied
        // by an unrelated tooltip, masking the same regression.
        const labelOwner = page
          .getByTestId("inspector-param-use_double_brackets")
          .locator(
            "xpath=ancestor-or-self::*[contains(., 'Use Double Brackets')][1]",
          );
        await expect(labelOwner).toBeVisible();
      },
    );

    await closeAdvancedOptions(page);
  },
);

test(
  "Prompt Template — default toggle state is OFF; f-string mode extracts {var} and treats {{var}} as literal",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step(
      "Save template `Hello {single} and {{double}}!` in default (f-string) mode",
      async () => {
        await fillPromptTemplate(page, "Hello {single} and {{double}}!");
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
    await test.step("Enable double brackets — switches to mustache mode", async () => {
      await setUseDoubleBrackets(page, true);
    });

    await test.step(
      "Save template `Hello {single} and {{double}}!` in mustache mode",
      async () => {
        await fillPromptTemplate(page, "Hello {single} and {{double}}!", {
          mode: "mustache",
        });
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
    await test.step(
      "Enable mustache mode and save `Hello {{name}}!` — `name` handle appears",
      async () => {
        await setUseDoubleBrackets(page, true);
        await fillPromptTemplate(page, "Hello {{name}}!", {
          mode: "mustache",
        });
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );

    await test.step(
      "Disable mustache mode — modal-open button swaps back to the f-string variant",
      async () => {
        await setUseDoubleBrackets(page, false);
        // Explicit assertion at the test level so the HTML report shows a real
        // `expect()` in this step, even though `setUseDoubleBrackets` already
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
        await fillPromptTemplate(page, "Hello {{name}}!");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toHaveCount(0, { timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(0);
      },
    );

    await test.step(
      "Saving `{var}` in f-string mode recreates a dynamic handle",
      async () => {
        await fillPromptTemplate(page, "Just one {var} here.");
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
    // The flow is created in beforeEach; `createdFlowId` is its authoritative
    // API id — assert its shape here to keep the original UUID sanity check.
    expect(createdFlowId).toMatch(/^[0-9a-f-]{36}$/);
    const flowId = createdFlowId as string;

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
      await setUseDoubleBrackets(page, true);
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
