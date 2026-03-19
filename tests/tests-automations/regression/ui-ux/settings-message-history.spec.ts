/**
 * Test Scenario: Confirm message history (Settings > Messages) contains right messages in proper order
 * Category: Core Functionality
 *
 * Objective: Verify that the message history in Settings displays all messages correctly,
 * maintains proper chronological order, and filter functionality works.
 *
 * Precondition: An API key must be configured to use the Simple Agent template.
 *
 * Expected Results:
 * - All sent and received messages appear in the message history
 * - Messages are displayed in chronological order (oldest first)
 * - All columns display correct information: timestamp, text, sender, sender_name,
 *   session_id, files, id, flow_id, properties, category, content_blocks
 * - Message content matches what was sent/received in Playground
 * - Timestamps are accurate and correspond to when messages were sent
 * - No duplicate messages appear
 * - Filtering by sender "Equals User" shows only User messages
 * - Removing filter value restores all messages
 * - No messages are missing or lost
 */

import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { navigateSettingsPages } from "../../../helpers/ui/go-to-settings";
import { FlowEditorPage, PlaygroundPage } from "../../../pages";

const FIRST_MESSAGE = "Hello, how are you?";
const SECOND_MESSAGE = "What is 2+2?";

const EXPECTED_COLUMNS = [
  "timestamp",
  "text",
  "sender",
  "sender_name",
  "session_id",
  "files",
  "id",
  "flow_id",
  "properties",
  "category",
  "content_blocks",
];

test(
  "Settings > Messages displays sent messages in correct order with working filters",
  { tag: ["@release", "@workspace", "@api", "@settings"] },
  async ({ page }) => {
    test.skip(
      !process?.env?.OPENAI_API_KEY,
      "OPENAI_API_KEY required to run this test",
    );

    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    const flowEditor = new FlowEditorPage(page);
    const playground = new PlaygroundPage(page);

    // Steps 1-2: Create flow from "Simple Agent" template and open Playground
    await awaitBootstrapTest(page);
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Simple Agent" }).first().click();
    await flowEditor.waitForCanvas();
    // Wait for the model selector to be ready before setup (options load async from backend)
    await page.waitForSelector('[data-testid="model_model"]', {
      timeout: 60000,
    });
    await initialGPTsetup(page);

    await playground.open();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 30000,
    });

    // Steps 3-4: Send first message and wait for Agent response
    await playground.sendMessage(FIRST_MESSAGE);

    const stopButton = page.getByRole("button", { name: "Stop" });
    await stopButton.waitFor({ state: "visible", timeout: 30000 });
    await expect(stopButton).toBeHidden({ timeout: 120000 });

    await playground.waitForResponse(120000);
    const firstResponse = await playground.getLastResponse();
    expect(firstResponse.trim().length).toBeGreaterThan(0);

    // Steps 5-6: Send second message and wait for Agent response
    await playground.sendMessage(SECOND_MESSAGE);

    await stopButton.waitFor({ state: "visible", timeout: 30000 });
    await expect(stopButton).toBeHidden({ timeout: 120000 });

    await playground.waitForResponse(120000);
    const secondResponse = await playground.getLastResponse();
    expect(secondResponse.trim().length).toBeGreaterThan(0);

    // Close playground before navigating to settings
    await playground.close();

    // Steps 7-9: Navigate to Settings > Messages
    await navigateSettingsPages(page, "Settings", "Messages");
    await expect(
      page.getByTestId("settings_menu_header"),
    ).toContainText("Messages");

    // Step 10: Verify the messages table has all required columns
    for (const column of EXPECTED_COLUMNS) {
      await expect(
        page.locator(`.ag-header-cell[col-id="${column}"]`),
      ).toBeVisible({ timeout: 10000 });
    }

    // Steps 11-13: Verify chronological order — find user messages and check timestamps
    // AG Grid rows are rendered as .ag-row elements; timestamp column contains the time values
    const timestampCells = page.locator('.ag-cell[col-id="timestamp"]');
    await expect(timestampCells.first()).toBeVisible({ timeout: 10000 });

    const rowCount = await timestampCells.count();
    expect(rowCount).toBeGreaterThanOrEqual(4); // at least: 2 user msgs + 2 agent responses

    // Collect timestamps and verify ascending (chronological) order
    const timestamps: number[] = [];
    for (let i = 0; i < rowCount; i++) {
      const rawTimestamp = await timestampCells.nth(i).textContent();
      if (rawTimestamp) {
        const parsed = Date.parse(rawTimestamp.trim());
        if (!isNaN(parsed)) {
          timestamps.push(parsed);
        }
      }
    }
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // Step 14: Verify sender values — "User" rows and "Machine"/"AI" rows exist
    const senderCells = page.locator('.ag-cell[col-id="sender"]');
    const allSenderTexts: string[] = [];
    const senderCount = await senderCells.count();
    for (let i = 0; i < senderCount; i++) {
      const text = await senderCells.nth(i).textContent();
      if (text) allSenderTexts.push(text.trim());
    }

    expect(allSenderTexts).toContain("User");
    // Agent responses show sender as "Machine" in Langflow
    const hasAgentSender = allSenderTexts.some(
      (s) => s === "Machine" || s === "Agent" || s === "AI",
    );
    expect(hasAgentSender).toBeTruthy();

    // Step 15: Verify text content matches what was sent
    const textCells = page.locator('.ag-cell[col-id="text"]');
    const allTexts: string[] = [];
    const textCount = await textCells.count();
    for (let i = 0; i < textCount; i++) {
      const text = await textCells.nth(i).textContent();
      if (text) allTexts.push(text.trim());
    }
    const joinedTexts = allTexts.join(" ");
    expect(joinedTexts).toContain(FIRST_MESSAGE);
    expect(joinedTexts).toContain(SECOND_MESSAGE);

    // Steps 16-18: Filter by sender "Equals User"
    // Hover over the sender column header to reveal the menu icon, then open filter
    await page.hover('.ag-header-cell[col-id="sender"]');
    await page
      .locator('.ag-header-cell[col-id="sender"] .ag-icon-menu')
      .click({ timeout: 5000 });

    // Click the "Filter" tab in the column menu popup
    await page.getByRole("tab", { name: "Filter" }).click({ timeout: 5000 });

    // Select "Equals" in the filter type dropdown
    const filterTypeSelect = page.locator(
      '.ag-filter .ag-picker-field-wrapper',
    ).first();
    await filterTypeSelect.click();
    await page.getByRole("option", { name: "Equals" }).click();

    // Type "User" in the filter input
    const filterInput = page.locator('.ag-filter input[type="text"]').first();
    await filterInput.fill("User");
    await page.waitForTimeout(500); // allow AG Grid to apply debounced filter

    // Step 18: Verify only User messages are displayed
    const filteredSenderCells = page.locator('.ag-cell[col-id="sender"]');
    const filteredCount = await filteredSenderCells.count();
    expect(filteredCount).toBeGreaterThan(0);

    for (let i = 0; i < filteredCount; i++) {
      const senderText = await filteredSenderCells.nth(i).textContent();
      expect(senderText?.trim()).toBe("User");
    }

    // Steps 19-20: Remove filter value → all messages restored
    await filterInput.clear();
    await page.waitForTimeout(500); // allow AG Grid to clear the filter

    const restoredSenderCells = page.locator('.ag-cell[col-id="sender"]');
    const restoredCount = await restoredSenderCells.count();
    expect(restoredCount).toBeGreaterThan(filteredCount); // should have more rows than filtered
    expect(restoredCount).toBeGreaterThanOrEqual(4); // back to at least 4 rows
  },
);
