import dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";

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
    // Load the Simple Agent template via the canonical helper, which clears
    // existing flows, opens the templates modal through the correct entry point,
    // and waits for the canvas to actually load. The previous manual
    // side-nav + heading click landed on the projects list (no canvas) on
    // Langflow 1.11.0, so the provider entry point never appeared.
    //
    // load() also runs setupOpenAI; with no explicit model it selects a resilient
    // default (gpt-4o-mini, vision-capable on the Agent component), so the
    // multimodal assertion below holds. OpenAI is used (not Anthropic) so the test
    // runs in the weekly workflow, which provides OPENAI_API_KEY.
    await new SimpleAgentTemplatePage(page).load({ provider: "openai" });

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

    // Wait for the streamed response to actually describe the image instead of
    // sleeping a fixed interval: toContainText retries until the markdown
    // renders, adapting to however long the model takes. This regex is the real
    // signal that the model saw and described the image.
    const llmResponse = page.locator(".markdown.prose").last();
    await expect(llmResponse).toContainText(/chain|inkscape|logo/i, {
      timeout: 60000,
    });

    // Secondary guard against a one-word answer; kept modest since gpt-4o-mini
    // replies are terser than the Anthropic model this test was first calibrated for.
    const textFromLlm = await llmResponse.textContent();
    expect(textFromLlm?.length).toBeGreaterThan(50);
  },
);
