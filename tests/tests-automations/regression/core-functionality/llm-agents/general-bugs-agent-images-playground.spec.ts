import dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupAnthropic } from "../../../../helpers/provider-setup/setup-anthropic";

test(
  "user must be able to send images in the playground with the agent component",
  { tag: ["@release", "@components", "@agents"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Simple Agent" }).first().click();

    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    await setupAnthropic(page);

    await page.getByTestId("playground-btn-flow-io").click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // Langflow 1.10.x: chat file upload uses a hidden <input type="file"> wired
    // to a React onChange handler. dispatchEvent("drop") is no longer processed.
    await page
      .locator('div[class*="chat-panel"] input[type="file"]')
      .setInputFiles(path.resolve(__dirname, "../../../../assets/media/chain.png"));

    // Filename renders inside <img alt={file.name}>, not as visible text.
    await expect(page.getByAltText("chain.png").first()).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("input-chat-playground").fill("what is this image?");

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.waitForTimeout(5000);

    const textFromLlm = await page
      .locator(".markdown.prose")
      .last()
      .textContent();

    expect(textFromLlm?.toLowerCase()).toMatch(/(chain|inkscape|logo)/);
    const lengthOfTextFromLlm = textFromLlm?.length;
    expect(lengthOfTextFromLlm).toBeGreaterThan(100);
  },
);
