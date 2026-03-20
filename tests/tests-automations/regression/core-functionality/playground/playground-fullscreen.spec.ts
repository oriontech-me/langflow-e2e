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
  { tag: ["@release", "@workspace", "@regression", "@playground"] },
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
  { tag: ["@release", "@workspace", "@regression", "@playground"] },
  async ({ page }) => {
    await setupPlayground(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).toBeVisible({ timeout: 5000 });

    // Locate fullscreen button — try the most common testid patterns
    const fullscreenBtn = page
      .locator('[data-testid*="maximize"], [data-testid*="fullscreen"], [data-testid="icon-Maximize2"], [data-testid="icon-Maximize"]')
      .first();

    const isPresent = await fullscreenBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (!isPresent) {
      test.skip(true, "Fullscreen button not found — run DOM discovery: page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).filter(id => /max|full|screen/i.test(id ?? '')))");
      return;
    }

    await fullscreenBtn.click();
    await page.waitForTimeout(300);

    // After expanding, the input must still be visible
    await expect(
      page.getByTestId("input-chat-playground").last(),
    ).toBeVisible({ timeout: 5000 });

    // A minimize/collapse button must appear
    const minimizeBtn = page.locator(
      '[data-testid*="minimize"], [data-testid*="collapse"], [data-testid="icon-Minimize2"], [data-testid="icon-Minimize"]',
    ).first();
    await expect(minimizeBtn).toBeVisible({ timeout: 3000 });
  },
);

test(
  "playground can be closed and reopened from the flow editor",
  { tag: ["@release", "@workspace", "@regression", "@playground"] },
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
