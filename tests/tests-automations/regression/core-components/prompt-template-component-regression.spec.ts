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
//   modal textarea:  "modal-promptarea_prompt_template"  (unique to the prompt modal — use as anchor)
//   modal save btn:  "genericModalBtnSave"
//   modal preview:   "edit-prompt-sanitized"  (shown after save; click to re-edit)
//   output handle:   "handle-prompt template-shownode-prompt-right"
//   dynamic handles: "handle-prompt template-shownode-{varname}-left"

// Locator matching only the dynamic (left-side) input handles created from
// {variable} placeholders. The output `-right` handle is excluded by the suffix
// filter so counts reflect dynamic-handle-only deltas.
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

// Open the prompt modal and replace its current value with `value`.
// Handles the post-save preview state by clicking it to re-enter edit mode.
// The function returns after the save dialog closes; downstream assertions
// must wait on their specific expected handle state (auto-retry via expect()),
// because the canvas re-render is asynchronous to the modal close.
async function setPromptTemplate(page: Page, value: string) {
  await page.getByTestId("button_open_prompt_modal").click();

  const textarea = page.getByTestId("modal-promptarea_prompt_template");

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
  // The textarea testid is scoped to the prompt modal, so its disappearance
  // is a reliable signal that the modal closed and the save round-trip began.
  await expect(textarea).toBeHidden({ timeout: 10000 });
}

test(
  "Prompt Template component — renders on canvas with output handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step("Node title is visible on the canvas", async () => {
      await expect(page.getByTestId("title-Prompt Template")).toBeVisible({
        timeout: 10000,
      });
    });

    await test.step(
      "Right-side output handle for the `prompt` port is visible",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-prompt-right"),
        ).toBeVisible({ timeout: 5000 });
      },
    );

    await test.step("Exactly one node is rendered on the canvas", async () => {
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
    });
  },
);

test(
  "Prompt Template component — variables in curly braces generate dynamic input handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save template with two {variable} placeholders",
      async () => {
        await setPromptTemplate(page, "Hello {name}, your job is {profession}.");
      },
    );

    await test.step(
      "Both variable handles are rendered on the left side of the node",
      async () => {
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-profession-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Exactly 2 dynamic handles exist — no extras leaked in",
      async () => {
        await expect(dynamicHandlesLocator(page)).toHaveCount(2);
      },
    );
  },
);

test(
  "Prompt Template component — removing a variable removes its input handle",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    const nameHandle = page.getByTestId(
      "handle-prompt template-shownode-name-left",
    );

    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save template `Hello {name}!` — expect 1 dynamic handle for {name}",
      async () => {
        await setPromptTemplate(page, "Hello {name}!");
        await expect(nameHandle).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );

    await test.step(
      "Save template without variables — expect 0 dynamic handles",
      async () => {
        await setPromptTemplate(page, "Hello world!");
        await expect(nameHandle).toHaveCount(0, { timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(0);
      },
    );
  },
);

test(
  "Prompt Template component — replacing a variable updates handles accordingly",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save template `Hello {name}, you are {role}.` — both handles render",
      async () => {
        await setPromptTemplate(page, "Hello {name}, you are {role}.");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-role-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Replace {role} with {title} — old handle is gone, new one appears, {name} stays",
      async () => {
        await setPromptTemplate(page, "Hello {name}, you are {title}.");
        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-role-left"),
        ).toHaveCount(0, { timeout: 10000 });
        await expect(
          page.getByTestId("handle-prompt template-shownode-title-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );
  },
);

test(
  "Prompt Template component — clearing the template removes all dynamic handles",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save template with 3 variables — expect 3 dynamic handles",
      async () => {
        await setPromptTemplate(page, "{a} and {b} and {c}");
        await expect(dynamicHandlesLocator(page)).toHaveCount(3, {
          timeout: 10000,
        });
      },
    );

    await test.step(
      "Save plain-text template — all dynamic handles disappear",
      async () => {
        await setPromptTemplate(page, "No variables here.");
        await expect(dynamicHandlesLocator(page)).toHaveCount(0, {
          timeout: 10000,
        });
      },
    );
  },
);

test(
  "Prompt Template component — modal edits persist in UI and in saved flow",
  { tag: ["@stable", "@release", "@regression", "@components"] },
  async ({ page }) => {
    const expected = "Persisted prompt text {topic}.";
    let flowId = "";

    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
      flowId = page.url().split("/").slice(-1)[0];
      expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step(
      "Save template — the {topic} handle confirms save was applied",
      async () => {
        await setPromptTemplate(page, expected);
        await expect(
          page.getByTestId("handle-prompt template-shownode-topic-left"),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    await test.step(
      "Reopen the modal — sanitized preview shows the saved value",
      async () => {
        await page.getByTestId("button_open_prompt_modal").click();
        const preview = page.getByTestId("edit-prompt-sanitized");
        await expect(preview).toBeVisible({ timeout: 10000 });
        await expect(preview).toContainText("Persisted prompt text");
        await expect(preview).toContainText("topic");
      },
    );

    await test.step(
      "Re-enter edit mode — textarea holds the exact saved value",
      async () => {
        await page.getByTestId("edit-prompt-sanitized").click();
        const textarea = page.getByTestId("modal-promptarea_prompt_template");
        await expect(textarea).toBeVisible({ timeout: 5000 });
        await expect(textarea).toHaveValue(expected);
        await page.keyboard.press("Escape");
      },
    );

    await test.step(
      "Backend persistence — autosaved flow contains the template string",
      async () => {
        // `page.request` inherits session cookies — `GET /api/v1/flows/{id}`
        // requires session auth in Langflow's auto-login mode.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`/api/v1/flows/${flowId}`);
              if (!res.ok()) return null;
              const flow = await res.json();
              // The frontend sets `node.data.type` to the human-readable name
              // ("Prompt Template"), which is the `display_name` of the
              // PromptComponent on the upstream Langflow source.
              const promptNode = (flow?.data?.nodes ?? []).find(
                (n: { data?: { type?: string } }) =>
                  n?.data?.type === "Prompt Template",
              );
              return promptNode?.data?.node?.template?.template?.value ?? null;
            },
            { timeout: 15000, intervals: [500, 1000, 2000] },
          )
          .toBe(expected);
      },
    );
  },
);
