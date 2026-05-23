import dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { setupAnthropic } from "../../../../helpers/provider-setup/setup-anthropic";

test(
  "user must be able to send images in the playground with the agent component",
  { tag: ["@release", "@components", "@agents", "@playground"] },
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

    // Patch the ChatInput template default to our question via the API.
    //
    // flow-page-sliding-container.tsx has a useEffect that resets
    // chatValueStore to `chatInputNode.template.input_value.value`
    // whenever its inputs/nodes/chatHistory deps fire. flowStore.setNodes
    // creates a new `inputs` reference on every call, and autoSaveFlow
    // responses keep firing setNodes for a while after each canvas
    // edit. Filling the playground input races against this reset
    // (~50% flake observed) and Send ends up submitting the template
    // default ("Hello, how are you?") instead of what we typed.
    //
    // Making our question the persisted default sidesteps the race:
    // even if the reset effect fires after the playground opens, it
    // sets the store to our text, and Send always submits it.
    await page.waitForLoadState("networkidle");
    const flowId = page.url().match(/\/flow\/([0-9a-f-]+)/i)?.[1];
    expect(flowId, `Expected /flow/{id} in URL, got: ${page.url()}`).toBeTruthy();
    const flowResp = await page.request.get(`/api/v1/flows/${flowId}`);
    expect(flowResp.ok()).toBeTruthy();
    const flowData = await flowResp.json();
    const chatInputNode = flowData.data.nodes.find(
      (n: any) => n.data?.type === "ChatInput",
    );
    chatInputNode.data.node.template.input_value.value = "what is this image?";
    const patchRes = await page.request.patch(`/api/v1/flows/${flowId}`, {
      data: { data: flowData.data },
    });
    expect(patchRes.status()).toBe(200);

    await page.reload();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    await page.getByTestId("playground-btn-flow-io").click();

    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 100000,
    });

    // `input-chat-playground` is rendered in two places (IOModal + new
    // playground component); use .last() to target the playground copy.
    const chatInput = page.getByTestId("input-chat-playground").last();
    await expect(chatInput).toHaveValue("what is this image?", {
      timeout: 15000,
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

    await page.waitForSelector('[data-testid="button-send"]', {
      timeout: 100000,
    });

    await page.getByTestId("button-send").last().click();

    // Defensive: catch the race directly. Backend substitutes the
    // ChatInput template default if inputValue is empty, so a failure
    // here means the bug is back.
    await expect(
      page.getByTestId("chat-message-User-what is this image?"),
    ).toBeVisible({ timeout: 10000 });

    // Wait for streaming to finish. Stop button is visible while the model
    // generates and disappears when the response is complete.
    const stopButton = page.getByRole("button", { name: "Stop" });
    if (await stopButton.isVisible({ timeout: 10000 }).catch(() => false)) {
      await expect(stopButton).toBeHidden({ timeout: 120000 });
    }

    // Scope to the chat bubble — `.markdown.prose` also matches markdown
    // rendered on the canvas (README, tool descriptions) and would otherwise
    // capture e.g. the URL tool description instead of the agent reply.
    const botMessage = page.getByTestId("div-chat-message").last();
    await expect(botMessage).toBeVisible({ timeout: 30000 });
    const textFromLlm = (await botMessage.innerText()).toLowerCase();

    expect(textFromLlm).toMatch(/(chain|inkscape|logo)/);
    expect(textFromLlm.length).toBeGreaterThan(100);
  },
);
