/**
 * Test Scenario: Create flow using connected LLM and test if prompt returns valid response
 * Category: Core Functionality
 *
 * Objective: Verify that a basic flow with an LLM component correctly processes
 * prompts and returns valid responses.
 *
 * Expected Results:
 * - Flow executes without errors
 * - LLM component successfully connects to the API
 * - Prompt is processed correctly
 * - Valid response is returned within reasonable time
 * - Response is relevant to the input prompt
 * - Output is displayed in Chat Output component
 * - No timeout or connection errors occur
 * - Flow can be executed multiple times consecutively
 */

import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import { FlowEditorPage, PlaygroundPage } from "../../../../pages";

test(
  "LLM flow with prompt component returns valid response to user input",
  { tag: ["@release", "@workspace", "@components"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }

    const flowEditor = new FlowEditorPage(page);
    const playground = new PlaygroundPage(page);

    // Step 1-6: Create flow with LLM + Prompt + Chat Input + Chat Output
    // The "Basic Prompting" template ships exactly this topology:
    // Chat Input → Prompt → OpenAI LLM → Chat Output
    await awaitBootstrapTest(page);
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await flowEditor.waitForCanvas();

    // Step 3: Configure API credentials and select GPT model
    await initialGPTsetup(page);

    // Steps 7-9: Enter test prompt and verify response
    await playground.open();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 30000,
    });

    await playground.sendMessage("What is 2+2?");
    await playground.waitForResponse(60000);

    const firstResponse = await playground.getLastResponse();
    expect(firstResponse.trim().length).toBeGreaterThan(0);
    // A correct LLM answer to "2+2" should contain "4"
    expect(firstResponse).toMatch(/4/);

    // Step 10: Test with a different prompt variation
    // Verifies the flow can be executed multiple times consecutively
    await playground.sendMessage("What is the capital of France?");
    await playground.waitForResponse(60000);

    const secondResponse = await playground.getLastResponse();
    expect(secondResponse.trim().length).toBeGreaterThan(0);
    expect(secondResponse).toMatch(/Paris/i);
  },
);
