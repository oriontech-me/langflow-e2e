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
    // default — a fast, vision-capable chat model (preferring gpt-4o-mini and
    // similar "-mini" variants over slow "pro"/reasoning models), so the
    // multimodal assertion below holds even as model families change on
    // nightlies. OpenAI is used (not Anthropic) so the test runs in the weekly
    // workflow, which provides OPENAI_API_KEY.
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
    // (the model then never sees our question). Type with real keystrokes so the
    // component's onChange runs.
    //
    // The pre-fill lands asynchronously, so a single clear-then-type can be
    // clobbered by a late pre-fill that overwrites our prompt — the source of
    // this spec's flakiness (issue #411). Retry the whole clear+type until the
    // value sticks: once the pre-fill has settled, our keystrokes win and hold.
    // This replaces the previous silent `.catch(() => {})` wait, which masked
    // the timing rather than guarding against the clobber.
    const chatInput = page.getByTestId("input-chat-playground");
    await expect(async () => {
      await chatInput.click();
      await chatInput.press("ControlOrMeta+a");
      await chatInput.press("Delete");
      await chatInput.pressSequentially("what is this image?");
      await expect(chatInput).toHaveValue("what is this image?", {
        timeout: 2000,
      });
      // Stability window: the value can pass instantly on a fast attempt while a
      // late pre-fill is still pending, which would then clobber the prompt
      // between here and the send click. Wait a beat and re-assert so the block
      // only succeeds once the value has proven it stays put — if a late pre-fill
      // lands in the window, this re-assert fails and toPass re-types.
      await page.waitForTimeout(500);
      await expect(chatInput).toHaveValue("what is this image?", {
        timeout: 1000,
      });
    }).toPass({ timeout: 15000 });

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").click();

    // Wait for the streamed response to actually describe the image instead of
    // sleeping a fixed interval: toContainText retries until the markdown
    // renders, adapting to however long the model takes. This regex is the real
    // signal that the model saw and described the image. The fixture is a flat
    // illustration of two chains, so it widens the previous `chain|inkscape|logo`
    // set to the descriptors a vision model reliably uses for it — "chain",
    // "link(s)", "icon" — while keeping the historical terms as harmless extras.
    // Word boundaries (with optional plurals) keep the intent while avoiding
    // accidental substring matches like "blinking" or "linking".
    const llmResponse = page.locator(".markdown.prose").last();
    await expect(llmResponse).toContainText(
      /\b(chains?|links?|inkscape|logos?|icons?)\b/i,
      { timeout: 60000 },
    );

    // Secondary guard against a one-word answer; kept modest since gpt-4o-mini
    // replies are terser than the Anthropic model this test was first calibrated for.
    const textFromLlm = await llmResponse.textContent();
    expect(textFromLlm?.length).toBeGreaterThan(50);
  },
);
