import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";

test(
  "freeze must work correctly",
  { tag: ["@release", "@api", "@components"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    const promptText = "answer as you are a dog";
    const newPromptText = "answer as you are a bird";

    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 100000,
    });

    await adjustScreenView(page);

    await page.getByText("Language Model").last().click();
    await page.keyboard.press("Delete");

    //connection 1

    await page
      .getByTestId("handle-prompt-shownode-prompt-right")
      .first()
      .click();

    await adjustScreenView(page);

    await page
      .getByTestId("handle-chatoutput-shownode-inputs-left")
      .first()
      .click();

    await page.getByText("Prompt Template", { exact: true }).last().click();

    await page.getByTestId("button_open_prompt_modal").click();

    await page.getByTestId("modal-promptarea_prompt_template").fill(promptText);

    await page.getByText("Check & Save").click();

    await initialGPTsetup(page);

    await page.getByTestId("button_run_chat output").click();

    await page.waitForSelector("text=built successfully");

    await page.getByTestId("playground-btn-flow-io").click();

    // Wait for chat messages to be fully loaded/streamed
    await page.waitForSelector('[data-testid="div-chat-message"]', {
      timeout: 30000,
    });
    // Wait for streaming to complete
    await page.waitForTimeout(1000);

    const textContents = await page
      .getByTestId("div-chat-message")
      .allTextContents();

    // Get the first response
    const firstResponseText = textContents[textContents.length - 1];

    // Ensure we captured a non-empty response
    expect(firstResponseText.length).toBeGreaterThan(0);

    // await page.getByText("Close").last().click();
    await page.getByTestId("playground-close-button").click();

    // Freeze the path feeding Chat Output so the entire response is cached. The
    // freeze button runs FreezeAllVertices(stopNodeId=Chat Output), which caches
    // the outputs of Chat Output and its upstream nodes — enough that a later
    // prompt edit cannot change the re-run result.
    await page.getByText("Chat Output", { exact: true }).last().click();

    // On the 1.11 nightly the node toolbar was re-laid-out: Freeze is now a
    // DIRECT toolbar button (`freeze-all-button-modal`) inside `toolbar-wrapper`,
    // not a text item reached through the more-options dropdown. The old
    // `getByText("Freeze")` resolved to that button's label but the click was
    // swallowed by the `toolbar-wrapper` overlay that intercepts pointer events
    // (#615). Clicking the button by its testid targets the interactive element
    // directly and is layering-independent.
    const freezeButton = page.getByTestId("freeze-all-button-modal").first();
    await expect(freezeButton).toBeVisible({ timeout: 10000 });
    await freezeButton.click();

    // `.border-ring-frozen` marks the SELECTED frozen node only (NodeStatus:
    // `selected ? "border-ring-frozen" : "border-frozen"`), so the count is 1
    // even if freezing cascades up the path.
    await page.waitForSelector(".border-ring-frozen", { timeout: 5000 });

    await expect(page.locator(".border-ring-frozen")).toHaveCount(1);

    await page.getByText("Prompt Template", { exact: true }).last().click();

    // Now change the prompt (this should have no effect since Chat Output is frozen)
    await page.getByTestId("button_open_prompt_modal").click();

    await page.waitForTimeout(500);

    if ((await page.getByTestId("edit-prompt-sanitized").count()) > 0) {
      await page.getByTestId("edit-prompt-sanitized").last().click();
    }

    await page
      .getByTestId("modal-promptarea_prompt_template")
      .fill(newPromptText);

    await page.getByText("Check & Save").click();

    await page.waitForTimeout(500);

    await page.getByTestId("button_run_chat output").click();

    await page.waitForSelector("text=built successfully", { timeout: 30000 });

    await page.getByTestId("playground-btn-flow-io").click();

    // Wait for chat messages to be fully loaded/streamed
    await page.waitForSelector('[data-testid="div-chat-message"]', {
      timeout: 30000,
    });
    // Wait for streaming to complete
    await page.waitForTimeout(1000);

    const textContents2 = await page
      .getByTestId("div-chat-message")
      .allTextContents();

    // The frozen node should return the same cached output
    textContents2.forEach((text) => {
      expect(text).toBe(firstResponseText);
    });
  },
);
