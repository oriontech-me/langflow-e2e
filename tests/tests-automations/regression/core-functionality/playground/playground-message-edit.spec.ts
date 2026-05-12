import type { Route } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

async function openPlaygroundWithMessage(
  page: any,
  messageText: string,
): Promise<void> {
  await page.route("**/api/v1/run/**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outputs: [
          { outputs: [{ results: { message: { text: "Bot reply" } } }] },
        ],
        session_id: "msg-edit-session",
      }),
    });
  });

  await page.getByTestId("playground-btn-flow-io").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', {
    timeout: 15000,
  });

  const input = page.getByTestId("input-chat-playground").last();
  await input.fill(messageText);
  await page.getByTestId("button-send").click();
  await page.waitForSelector('[data-testid="div-chat-message"]', {
    timeout: 15000,
  });
}

async function hoverMessageAndClickEdit(
  page: any,
  messageText: string,
): Promise<void> {
  // Scope hover and icon lookup to the message group container so the
  // CSS group-hover state is never lost when moving the mouse to the button.
  const msgContainer = page
    .locator(".group")
    .filter({ hasText: messageText })
    .first();
  await msgContainer.hover();
  const editButton = msgContainer.locator('[data-testid="icon-Pen"]');
  await editButton.waitFor({ state: "visible", timeout: 3000 });
  await editButton.click();
  await page.getByTestId("save-button").waitFor({ state: "visible" });
}

// Sets the value of the EditMessageField textarea by directly invoking React's
// onChange prop via __reactProps$, bypassing DOM event dispatch which React 19
// does not reliably detect from evaluate(). All DOM access runs in one evaluate()
// call to avoid Playwright locator instability from React height-adjustment renders.
async function setEditTextareaValue(page: any, value: string): Promise<void> {
  await page.evaluate((newValue: string) => {
    // Walk up from save-button to the EditMessageField container (h-fit class).
    let el: Element | null = document.querySelector(
      '[data-testid="save-button"]',
    );
    while (el && !/(?:^| )h-fit(?:$| )/.test(el.className)) {
      el = el.parentElement;
    }
    const textarea = el?.querySelector(
      'textarea[data-testid="textarea"]',
    ) as HTMLTextAreaElement | null;
    if (!textarea) throw new Error("edit textarea not found");

    // Set the native DOM value so e.target.value is correct inside onChange.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(textarea, newValue);

    // Call React's onChange handler directly via the props stored on the element.
    const propsKey = Object.keys(textarea).find((k) =>
      k.startsWith("__reactProps"),
    );
    if (!propsKey) throw new Error("React props not found on textarea");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (textarea as any)[propsKey]?.onChange?.({ target: textarea });
  }, value);
}

test.describe("Playground Message Edit", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "edit user message — hover reveals edit button and saved changes replace original text",
    { tag: ["@release", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow", async () => {
        createdFlowId = await setupPlayground(page);
      });

      await test.step("open playground and send initial message", async () => {
        await openPlaygroundWithMessage(page, "Original message");
      });

      await test.step("hover user message to reveal edit button and enter edit mode", async () => {
        await hoverMessageAndClickEdit(page, "Original message");
      });

      await test.step("replace text and save", async () => {
        await setEditTextareaValue(page, "Edited message");
        await page.getByTestId("save-button").click();
      });

      await test.step("verify edited text is shown and original text is gone", async () => {
        // Wait for the edit field to close (save-button unmounts on onSuccess)
        await expect(page.getByTestId("save-button")).toHaveCount(0, {
          timeout: 5000,
        });
        // User message bubble must show the edited text via its data-testid
        await expect(
          page.locator('[data-testid="chat-message-User-Edited message"]'),
        ).toBeVisible({ timeout: 3000 });
        // Old user message bubble must be gone
        await expect(
          page.locator('[data-testid="chat-message-User-Original message"]'),
        ).toHaveCount(0);
      });
    },
  );

  test(
    "cancel message edit — original text is preserved",
    { tag: ["@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow and send message", async () => {
        createdFlowId = await setupPlayground(page);
        await openPlaygroundWithMessage(page, "Original message");
      });

      await test.step("open edit mode and type replacement text", async () => {
        await hoverMessageAndClickEdit(page, "Original message");
        await setEditTextareaValue(page, "Discarded edit");
      });

      await test.step("cancel and verify original text is preserved", async () => {
        await page.getByTestId("cancel-button").click();
        await expect(page.getByText("Original message").first()).toBeVisible({
          timeout: 3000,
        });
        await expect(
          page.getByText("Discarded edit", { exact: true }),
        ).toHaveCount(0, { timeout: 3000 });
      });
    },
  );

  test(
    "message edited in playground is reflected in Session Logs",
    { tag: ["@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow and send message", async () => {
        createdFlowId = await setupPlayground(page);
        await openPlaygroundWithMessage(page, "Before edit");
      });

      await test.step("edit the sent message and confirm update in chat", async () => {
        await hoverMessageAndClickEdit(page, "Before edit");
        await setEditTextareaValue(page, "After edit");
        await page.getByTestId("save-button").click();
        await expect(page.getByText("After edit").first()).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("open Session Logs and verify edited text is present", async () => {
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .first()
          .click();
        await page.getByTestId("message-logs-option").click();
        await expect(page.getByText("Session logs").first()).toBeVisible({
          timeout: 5000,
        });
        await expect(page.getByText("After edit").first()).toBeVisible({
          timeout: 5000,
        });
      });
    },
  );
});
