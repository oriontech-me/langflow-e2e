import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

// Single source of truth for each component under test. Keeping the search
// term and the testids together here is what prevents the copy/paste class of
// bug (e.g. a Webhook test accidentally using the Chat Input testid).
type ComponentDescriptor = {
  name: string;
  addButton: string;
  title: string;
};

const CHAT_INPUT: ComponentDescriptor = {
  name: "Chat Input",
  addButton: "add-component-button-chat-input",
  title: "title-Chat Input",
};

const WEBHOOK: ComponentDescriptor = {
  name: "Webhook",
  addButton: "add-component-button-webhook",
  title: "title-Webhook",
};

// Substring of the i18n toast shown when a singleton/mutually-exclusive
// component cannot be duplicated or pasted (en.json: duplicateComponentsNotPasted).
const NOT_PASTED_TOAST = "components were not pasted";

// Low-level: search the sidebar and click a component's "+" button.
async function addComponent(
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) {
  await page.getByTestId("sidebar-search-input").fill(searchTerm);
  await page.getByTestId(addButtonTestId).click();
}

// Add a component via the sidebar and confirm it landed on the canvas.
async function addToCanvas(page: Page, component: ComponentDescriptor) {
  await addComponent(page, component.name, component.addButton);
  await expect(page.getByTestId(component.title)).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
}

// Search for a component and assert whether its "+" button is present (1) or
// gone (0). The search term must match the component being checked, otherwise
// the sidebar filter hides it and the assertion becomes a false positive.
async function expectAddButtonCount(
  page: Page,
  component: ComponentDescriptor,
  count: number,
) {
  await page.getByTestId("sidebar-search-input").fill(component.name);
  await expect(page.getByTestId(component.addButton)).toHaveCount(count);
}

// Select the single canvas node and trigger the duplicate shortcut.
async function duplicateSelectedNode(page: Page) {
  await page.locator(".react-flow__node").click();
  await page.keyboard.press("ControlOrMeta+d");
}

// Select the single canvas node and trigger the copy + paste shortcuts.
async function copyPasteSelectedNode(page: Page) {
  await page.locator(".react-flow__node").click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
}

async function expectNotPastedToast(page: Page) {
  await expect(page.getByText(NOT_PASTED_TOAST)).toBeVisible();
}

test.describe("Singleton and mutually-exclusive components (Chat Input ↔ Webhook)", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // setupBlankFlow creates the flow via API (avoids the UI-creation 500 race)
    // and returns its id so afterEach can clean it up.
    createdFlowId = await setupBlankFlow(page);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Leave the editor first: staying on it while the flow is deleted makes
      // background polling 404, which the fixture's error monitor would flag.
      await page.goto("/").catch(() => {});
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  // --- Chat Input ---

  test(
    "should allow only one Chat Input on the canvas",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Chat Input to the canvas", async () => {
        await expectAddButtonCount(page, CHAT_INPUT, 1);
        await addToCanvas(page, CHAT_INPUT);
      });

      await test.step("The Chat Input add button is no longer available", async () => {
        await expectAddButtonCount(page, CHAT_INPUT, 0);
      });
    },
  );

  test(
    "should not allow adding a Webhook while a Chat Input is on the canvas",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("A Webhook can be added to an empty canvas", async () => {
        await expectAddButtonCount(page, WEBHOOK, 1);
      });

      await test.step("Add a Chat Input to the canvas", async () => {
        await addToCanvas(page, CHAT_INPUT);
      });

      await test.step("The Webhook add button is no longer available", async () => {
        await expectAddButtonCount(page, WEBHOOK, 0);
      });
    },
  );

  test(
    "should not allow duplicating a Chat Input",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Chat Input to the canvas", async () => {
        await addToCanvas(page, CHAT_INPUT);
      });

      await test.step("Duplicating the Chat Input is blocked", async () => {
        await duplicateSelectedNode(page);
        await expectNotPastedToast(page);
      });
    },
  );

  test(
    "should not allow copying and pasting a Chat Input",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Chat Input to the canvas", async () => {
        await addToCanvas(page, CHAT_INPUT);
      });

      await test.step("Copying and pasting the Chat Input is blocked", async () => {
        await copyPasteSelectedNode(page);
        await expectNotPastedToast(page);
      });
    },
  );

  // --- Webhook ---

  test(
    "should allow only one Webhook on the canvas",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Webhook to the canvas", async () => {
        await expectAddButtonCount(page, WEBHOOK, 1);
        await addToCanvas(page, WEBHOOK);
      });

      await test.step("The Webhook add button is no longer available", async () => {
        await expectAddButtonCount(page, WEBHOOK, 0);
      });
    },
  );

  test(
    "should not allow adding a Chat Input while a Webhook is on the canvas",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("A Chat Input can be added to an empty canvas", async () => {
        await expectAddButtonCount(page, CHAT_INPUT, 1);
      });

      await test.step("Add a Webhook to the canvas", async () => {
        await addToCanvas(page, WEBHOOK);
      });

      await test.step("The Chat Input add button is no longer available", async () => {
        await expectAddButtonCount(page, CHAT_INPUT, 0);
      });
    },
  );

  test(
    "should not allow duplicating a Webhook",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Webhook to the canvas", async () => {
        await addToCanvas(page, WEBHOOK);
      });

      await test.step("Duplicating the Webhook is blocked", async () => {
        await duplicateSelectedNode(page);
        await expectNotPastedToast(page);
      });
    },
  );

  test(
    "should not allow copying and pasting a Webhook",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Add a Webhook to the canvas", async () => {
        await addToCanvas(page, WEBHOOK);
      });

      await test.step("Copying and pasting the Webhook is blocked", async () => {
        await copyPasteSelectedNode(page);
        await expectNotPastedToast(page);
      });
    },
  );
});
