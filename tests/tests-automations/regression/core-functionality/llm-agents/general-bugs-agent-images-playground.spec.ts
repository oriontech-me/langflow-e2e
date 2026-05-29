import dotenv from "dotenv";
import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupAnthropic } from "../../../../helpers/provider-setup/setup-anthropic";

test(
  "user must be able to send images in the playground with the agent component",
  { tag: ["@stable", "@release", "@components", "@agents"] },
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

    await setupAnthropic(page);

    await page.getByTestId("playground-btn-flow-io").click();

    // Read the image file as a binary string
    const filePath = "tests/assets/chain.png";
    const fileContent = readFileSync(filePath, "base64");

    // Create the DataTransfer and File objects within the browser context
    const dataTransfer = await page.evaluateHandle(
      ({ fileContent }) => {
        const dt = new DataTransfer();
        const byteCharacters = atob(fileContent);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const file = new File([byteArray], "chain.png", { type: "image/png" });
        dt.items.add(file);
        return dt;
      },
      { fileContent },
    );

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // Locate the target element
    const element = await page.getByTestId("input-chat-playground");

    // Dispatch the drop event on the target element
    await element.dispatchEvent("drop", { dataTransfer });

    await page.getByTestId("input-chat-playground").fill("what is this image?");

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.waitForSelector("text=chain.png", { timeout: 30000 });

    await page.getByText("chain.png").isVisible();

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
