import dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupOpenAI } from "../../../../helpers/provider-setup/setup-openai";

test(
  "user must be able to send images in the playground with the agent component",
  { tag: ["@stable", "@release", "@components", "@agents"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Simple Agent" }).first().click();

    // Wait for the agent node's provider entry point to render before
    // configuring the provider — otherwise setupOpenAI runs against a
    // still-loading canvas, finds neither entry point, and silently no-ops.
    // Unconfigured instance → "Setup Provider" button; configured → model_model.
    await expect(
      page
        .getByTestId("model_model")
        .or(page.getByRole("button", { name: "Setup Provider" })),
    ).toBeVisible({ timeout: 30000 });

    // OpenAI gpt-4o-mini (setupOpenAI's default) is vision-capable, so the
    // multimodal assertion below holds. OpenAI is used (not Anthropic) so the
    // test actually runs in the weekly workflow, which provides OPENAI_API_KEY.
    await setupOpenAI(page);

    await page.getByTestId("playground-btn-flow-io").click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // Attach the image via the Playground file input. The manual DataTransfer
    // drop the test used before no longer renders the attachment on Langflow
    // 1.10.0; setInputFiles matches the working playground attachment specs.
    await page
      .locator('[data-testid="input-wrapper"] input[type="file"]')
      .setInputFiles("tests/assets/media/chain.png");

    // Confirm the image attached before sending. The attachment renders as an
    // <img alt="chain.png"> preview, not as literal "chain.png" text.
    await expect(page.locator('img[alt="chain.png"]').first()).toBeVisible({
      timeout: 30000,
    });

    // Langflow 1.10.0 pre-fills a sample prompt ("Hello, how are you?") into
    // the chat input shortly after the playground mounts, and the send action
    // reads the component's internal state — not the raw textarea value — so a
    // programmatic .fill() is ignored and the default prompt is sent instead
    // (the model then never sees our question). Wait for the default to settle,
    // then clear and type with real keystrokes so the component's onChange runs.
    const chatInput = page.getByTestId("input-chat-playground");
    await chatInput.click();
    await expect(chatInput).not.toHaveValue("", { timeout: 10000 }).catch(() => {});
    await chatInput.press("ControlOrMeta+a");
    await chatInput.press("Delete");
    await chatInput.pressSequentially("what is this image?");
    await expect(chatInput).toHaveValue("what is this image?");

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    await page.waitForTimeout(5000);

    const textFromLlm = await page
      .locator(".markdown.prose")
      .last()
      .textContent();

    // The regex above is the real signal that the model saw and described the
    // image. The length check is a secondary guard against a one-word answer;
    // keep it modest since gpt-4o-mini replies are terser than the Anthropic
    // model this test was originally calibrated for.
    expect(textFromLlm?.toLowerCase()).toMatch(/(chain|inkscape|logo)/);
    const lengthOfTextFromLlm = textFromLlm?.length;
    expect(lengthOfTextFromLlm).toBeGreaterThan(50);
  },
);
