import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Run serially to avoid 500 errors from concurrent POST /api/v1/flows/
// when several workers create a blank flow at the same time.
test.describe.configure({ mode: "serial" });

// Verified testids from live UI inspection:
//   add button:      "add-component-button-prompt-template"
//   node title:      "title-Prompt Template"
//   modal open btn:  "button_open_prompt_modal"
//   modal save btn:  "genericModalBtnSave"
//   modal preview:   "edit-prompt-sanitized"  (shown after save; click to re-edit)
//   output handle:   "handle-prompt template-shownode-prompt-right"
//   dynamic handles: "handle-prompt template-shownode-{varname}-left"

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

// Open the prompt modal, replacing whatever value is currently there with `value`.
// Handles the post-save preview state by clicking it to re-enter edit mode.
async function setPromptTemplate(page: Page, value: string) {
  await page.getByTestId("button_open_prompt_modal").click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10000 });

  const preview = page.getByTestId("edit-prompt-sanitized");
  if (await preview.isVisible({ timeout: 2000 }).catch(() => false)) {
    await preview.click();
  }

  const textarea = dialog.locator("textarea").first();
  await expect(textarea).toBeVisible({ timeout: 5000 });
  await textarea.click();
  await page.keyboard.press("Control+a");
  await textarea.fill(value);

  await page.getByTestId("genericModalBtnSave").click();
  await expect(dialog).toBeHidden({ timeout: 5000 });
  // Wait for the canvas re-render that follows handle creation/removal —
  // dynamic handles are added/removed asynchronously after the modal closes.
  await page.waitForTimeout(1500);
}

test(
  "Prompt Template component — renders on canvas with output handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    await expect(page.getByTestId("title-Prompt Template")).toBeVisible({
      timeout: 10000,
    });

    // Output handle: "prompt" port on the right side
    await expect(
      page.getByTestId("handle-prompt template-shownode-prompt-right"),
    ).toBeVisible({ timeout: 5000 });

    // Exactly one node on the canvas — no spurious duplicates
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "Prompt Template component — variables in curly braces generate dynamic input handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    const initialHandleCount = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();

    await setPromptTemplate(page, "Hello {name}, your job is {profession}.");

    const newHandleCount = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();
    expect(newHandleCount).toBeGreaterThan(initialHandleCount);

    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-profession-left"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "Prompt Template component — removing a variable removes its input handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    await setPromptTemplate(page, "Hello {name}!");

    const nameHandle = page.getByTestId(
      "handle-prompt template-shownode-name-left",
    );
    await expect(nameHandle).toBeVisible({ timeout: 5000 });

    const handleCountBefore = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();

    await setPromptTemplate(page, "Hello world!");

    await expect(nameHandle).toHaveCount(0, { timeout: 5000 });

    const handleCountAfter = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();
    expect(handleCountAfter).toBeLessThan(handleCountBefore);
  },
);

test(
  "Prompt Template component — replacing a variable updates handles accordingly",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    await setPromptTemplate(page, "Hello {name}, you are {role}.");

    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-role-left"),
    ).toBeVisible({ timeout: 5000 });

    await setPromptTemplate(page, "Hello {name}, you are {title}.");

    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-role-left"),
    ).toHaveCount(0, { timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-title-left"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "Prompt Template component — clearing the template removes all dynamic handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    await setPromptTemplate(page, "{a} and {b} and {c}");

    const handlesBefore = await page
      .locator(
        '[data-testid*="handle-prompt template-shownode"][data-testid$="-left"]',
      )
      .count();
    expect(handlesBefore).toBeGreaterThan(0);

    await setPromptTemplate(page, "No variables here.");

    await expect(
      page.locator(
        '[data-testid*="handle-prompt template-shownode"][data-testid$="-left"]',
      ),
    ).toHaveCount(0);
  },
);

test(
  "Prompt Template component — modal edits persist after closing and reopening",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await addPromptComponent(page);

    const expected = "Persisted prompt text {topic}.";
    await setPromptTemplate(page, expected);

    // Dynamic handle for {topic} must appear, confirming the template was applied
    await expect(
      page.getByTestId("handle-prompt template-shownode-topic-left"),
    ).toBeVisible({ timeout: 5000 });

    // Reopen the modal — after saving the modal shows a sanitized preview
    // containing the same text. This is the persistence assertion: opening the
    // editor a second time must surface the value saved on the first pass.
    await page.getByTestId("button_open_prompt_modal").click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const preview = page.getByTestId("edit-prompt-sanitized");
    await expect(preview).toBeVisible({ timeout: 5000 });
    await expect(preview).toContainText("Persisted prompt text");
    await expect(preview).toContainText("topic");

    // Click into edit mode and verify the textarea also holds the saved value
    await preview.click();
    const textarea = dialog.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await expect(textarea).toHaveValue(expected);

    await page.keyboard.press("Escape");
  },
);
