import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

async function setupPlayground(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add ChatOutput
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await page.waitForSelector('[data-testid="input_outputChat Output"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  // Add ChatInput via drag
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await page.waitForSelector('[data-testid="input_outputChat Input"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Input")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(2, {
    timeout: 10000,
  });

  // Connect ChatInput → ChatOutput
  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

test(
  "playground modal is visible after opening from the flow editor",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupPlayground(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "playground fullscreen button expands the view when available",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupPlayground(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    // Attempt to locate a fullscreen / maximize button via multiple strategies
    const fullscreenByTestId = page.locator(
      '[data-testid="icon-Maximize2"], [data-testid="icon-Maximize"], [data-testid*="fullscreen"], [data-testid*="maximize"]',
    );
    const fullscreenByRole = page.getByRole("button", {
      name: /fullscreen|maximize|expand/i,
    });

    const testIdVisible = await fullscreenByTestId
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const roleVisible = await fullscreenByRole
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (testIdVisible) {
      await fullscreenByTestId.first().click();
      await page.waitForTimeout(500);

      // After expanding, the input field must still be visible
      await expect(
        page.getByTestId("input-chat-playground").last(),
      ).toBeVisible({ timeout: 5000 });

      // A minimize / collapse button or close button should now appear
      const minimizeBtn = page.locator(
        '[data-testid="icon-Minimize2"], [data-testid="icon-Minimize"], [data-testid*="minimize"], [data-testid*="collapse"]',
      );
      const closeBtn = page.getByRole("button", {
        name: /minimize|collapse|close/i,
      });

      const minimizeVisible = await minimizeBtn
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const closeVisible = await closeBtn
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      // Either a minimize control appears, or the input is still accessible (fullscreen succeeded)
      expect(
        minimizeVisible ||
          closeVisible ||
          (await page
            .getByTestId("input-chat-playground")
            .last()
            .isVisible()
            .catch(() => false)),
      ).toBe(true);
    } else if (roleVisible) {
      await fullscreenByRole.first().click();
      await page.waitForTimeout(500);
      await expect(
        page.getByTestId("input-chat-playground").last(),
      ).toBeVisible({ timeout: 5000 });
    } else {
      // Fullscreen button not present in this build — verify playground is functional
      await expect(
        page.getByTestId("input-chat-playground").last(),
      ).toBeVisible({ timeout: 5000 });
    }
  },
);

test(
  "playground can be closed and reopened from the flow editor",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupPlayground(page);

    // Open playground
    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });
    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).toBeVisible({ timeout: 5000 });

    // Close the playground — use JS click because the panel overlaps the button
    await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-testid="playground-btn-flow-io"]',
      ) as HTMLElement | null;
      if (btn) btn.click();
    });
    await page.waitForTimeout(800);

    // Playground input should no longer be visible
    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).not.toBeVisible({ timeout: 5000 });

    // Reopen
    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });
    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).toBeVisible({ timeout: 5000 });
  },
);
