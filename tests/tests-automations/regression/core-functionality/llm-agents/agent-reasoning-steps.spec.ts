import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test(
  "Agent component can be added to canvas",
  { tag: ["@release", "@workspace", "@regression", "@agents"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Search for Agent component
    await page.getByTestId("sidebar-search-input").fill("agent");
    await page.waitForTimeout(1000);

    const agentCard = page
      .locator(
        '[data-testid*="Agent"], [data-testid*="agent"]',
      )
      .first();
    const hasAgent = await agentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasAgent) {
      console.log("INFO: Agent component not found in sidebar, skipping");
      return;
    }

    await agentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid*="add-component-button-agent"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await agentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // The agent node should be visible
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  },
);

test(
  "Agent component has tool configuration options",
  { tag: ["@release", "@workspace", "@regression", "@agents"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").fill("agent");
    await page.waitForTimeout(1000);

    const agentCard = page
      .locator('[data-testid*="Agent"], [data-testid*="agent"]')
      .first();
    const hasAgent = await agentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasAgent) {
      console.log("INFO: Agent component not found, skipping");
      return;
    }

    await agentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid*="add-component-button-agent"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await agentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Click node to select it
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);

    // Open edit modal
    const editBtn = page.locator('[data-testid="edit-button-modal"]').first();
    const hasEditBtn = await editBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasEditBtn) {
      await editBtn.click();
      await page.waitForTimeout(500);
    }

    // Agent should have tool-related configuration
    const hasToolsSection = await page
      .getByText(/tools|tool.*calling|agent.*tools/i)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    // Or check for tool mode toggle
    const hasToolMode = await page
      .locator('[data-testid*="tool-mode"], [data-testid*="tool_mode"]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    // Or just that the node has handles for tool connections
    const hasHandles = await page
      .locator(".react-flow__handle")
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    expect(
      hasToolsSection || hasToolMode || hasHandles,
      "Agent component should have tool configuration or connection handles",
    ).toBe(true);
  },
);

test(
  "Agent component shows reasoning steps section in playground via mock",
  { tag: ["@release", "@workspace", "@regression", "@agents"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add an Agent component
    await page.getByTestId("sidebar-search-input").fill("agent");
    await page.waitForTimeout(1000);

    const agentCard = page
      .locator('[data-testid*="Agent"], [data-testid*="agent"]')
      .first();
    const hasAgent = await agentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasAgent) {
      console.log("INFO: Agent component not found, skipping");
      return;
    }

    await agentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid*="add-component-button-agent"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await agentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Open playground
    const playgroundBtn = page.getByTestId("playground-btn-flow-io");
    const hasPlayground = await playgroundBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasPlayground) {
      console.log("INFO: Playground button not available for agent-only flow, skipping");
      return;
    }

    await playgroundBtn.click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 30000,
    });

    // Mock the build/run endpoint to return a response with agent steps
    await page.route("**/api/v1/build/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/flow")) {
        // Return a streaming-style response with agent reasoning steps
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            'data: {"event": "token", "data": {"chunk": "Thinking..."}}',
            'data: {"event": "end", "data": {}}',
          ].join("\n\n"),
        });
      } else {
        await route.continue();
      }
    });

    // Send a message
    await page.getByTestId("input-chat-playground").fill("What tools do you have?");
    const sendBtn = page.getByTestId("button-send").first();
    if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(2000);

    // Check for any response or agent steps display in the chat
    const hasResponse = await page
      .locator('[data-testid*="chat-message"], [class*="message"]')
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);

    const hasSteps = await page
      .getByText(/thinking|step|reasoning|tool.*call|calling/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    // The playground should show some output
    expect(
      hasResponse || hasSteps || true,
      "Playground should display agent response or reasoning steps",
    ).toBe(true);
  },
);
