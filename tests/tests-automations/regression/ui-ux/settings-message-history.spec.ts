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
 * - Messages are displayed oldest first (chronological): 1.12 replaced the
 *   hardcoded .desc() in monitor.py get_messages with order_by/order query
 *   params defaulting to timestamp/ASC, so the grid — which renders the API
 *   order — now starts with the oldest message (the 1.11 newest-first premise
 *   from #616 is dead by design)
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
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { FlowEditorPage, PlaygroundPage } from "../../../pages";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

const FIRST_MESSAGE = "Hello, how are you?";
const SECOND_MESSAGE = "What is 2+2?";

// The columns the message-history feature promises. Asserted as a REQUIRED
// SUBSET of the rendered set — upstream adding columns (1.11 added
// context_id, edit, duration, session_metadata) must not fail the test;
// removing one of these must (#616).
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

// The test creates one flow (Simple Agent template); track every
// POST /api/v1/flows → 201 id and delete them in afterEach (id-scoped —
// deleting the flow also cascades its messages, leaving the shared
// instance clean).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
  }
});

test(
  "Settings > Messages displays sent messages in correct order with working filters",
  { tag: ["@stable", "@release", "@workspace", "@api", "@settings"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // Two real OpenAI completions run below, so gate on provider HEALTH, not on
    // the env var alone — a drained key would otherwise block the backend past
    // gunicorn's 300s timeout and kill the shard's Langflow worker (#1029).
    const openaiGate = providerSkipGate("openai");
    test.skip(openaiGate.skip, openaiGate.reason);

    const flowEditor = new FlowEditorPage(page);
    const playground = new PlaygroundPage(page);

    // Track the flow the template click creates so afterEach can delete it.
    page.on("response", (resp) => {
      if (
        resp.url().includes("/api/v1/flows") &&
        resp.request().method() === "POST" &&
        resp.status() === 201
      ) {
        resp
          .json()
          .then((body: { id?: string }) => {
            if (body?.id) createdFlowIds.push(body.id);
          })
          .catch(() => {}); // non-JSON / batch payloads
      }
    });

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

    // Step 10: Verify the messages table has all required columns.
    // AG Grid VIRTUALIZES columns horizontally — header cells outside the
    // scrolled-into-view region are not in the DOM, so per-column
    // toBeVisible() breaks as soon as upstream adds enough columns to push
    // one past the viewport (#616: `id` was never removed; four new 1.11
    // columns pushed it off-screen). Sweep the horizontal scroll collecting
    // every col-id, then assert the promised set is contained.
    await expect(page.locator(".ag-header-cell").first()).toBeVisible({
      timeout: 10000,
    });
    const renderedColumnIds = await page.evaluate(async () => {
      const viewport = document.querySelector(".ag-center-cols-viewport");
      const seen = new Set<string>();
      const collect = () => {
        document.querySelectorAll(".ag-header-cell").forEach((h) => {
          const id = h.getAttribute("col-id");
          if (id) seen.add(id);
        });
      };
      collect();
      const maxScroll = viewport?.scrollWidth ?? 0;
      for (let x = 0; x <= maxScroll; x += 300) {
        if (viewport) viewport.scrollLeft = x;
        await new Promise((r) => setTimeout(r, 100));
        collect();
      }
      if (viewport) viewport.scrollLeft = 0;
      return [...seen];
    });
    for (const column of EXPECTED_COLUMNS) {
      expect(renderedColumnIds, `column "${column}" missing from the messages grid`).toContain(column);
    }

    // Steps 11-13: Verify display order — OLDEST first (chronological). The
    // grid renders the API order, and 1.12 flipped that order on purpose:
    // `monitor.py` `get_messages` no longer hardcodes `.desc()` — it now takes
    // `order_by` (default `timestamp`) and `order` (default **ASC**), validated
    // against ALLOWED_MESSAGE_ORDER_FIELDS / {ASC,DESC}, and applies
    // `order_col.desc()` only when `order == DESC` (verified in the shipped
    // 1.12.0.dev5 source; the newest-first premise #616 encoded for 1.11 is
    // dead by design, not by regression).
    const timestampCells = page.locator('.ag-cell[col-id="timestamp"]');
    await expect(timestampCells.first()).toBeVisible({ timeout: 10000 });

    const rowCount = await timestampCells.count();
    expect(rowCount).toBeGreaterThanOrEqual(4); // at least: 2 user msgs + 2 agent responses

    // Collect timestamps and verify ascending (oldest-first) order
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
    expect(
      timestamps.length,
      "timestamp cells must be parseable, otherwise the order check is vacuous",
    ).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < timestamps.length; i++) {
      expect(
        timestamps[i],
        `row ${i} is older than row ${i - 1} — the grid is not in chronological order`,
      ).toBeGreaterThanOrEqual(timestamps[i - 1]);
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

    // Direction-sensitive companion to the timestamp check: monotonic
    // timestamps alone also hold for a reversed grid, so pin the two prompts to
    // their chronological positions — the first message sent must render above
    // the second one.
    const firstMessageRow = allTexts.findIndex((t) => t === FIRST_MESSAGE);
    const secondMessageRow = allTexts.findIndex((t) => t === SECOND_MESSAGE);
    expect(firstMessageRow, `"${FIRST_MESSAGE}" row not found`).toBeGreaterThanOrEqual(0);
    expect(secondMessageRow, `"${SECOND_MESSAGE}" row not found`).toBeGreaterThanOrEqual(0);
    expect(
      firstMessageRow,
      "the first message sent must render above the second one (oldest-first)",
    ).toBeLessThan(secondMessageRow);

    // Steps 16-18: Filter by sender "Equals User"
    // The header renders a dedicated filter button (.ag-header-cell-filter-button)
    // that opens the filter popup directly — the old .ag-icon-menu +
    // "Filter" tab flow no longer exists on the 1.11 nightly (#616).
    await page.hover('.ag-header-cell[col-id="sender"]');
    await page
      .locator('.ag-header-cell[col-id="sender"] .ag-header-cell-filter-button')
      .click({ timeout: 5000 });
    await expect(page.locator(".ag-filter").first()).toBeVisible({
      timeout: 5000,
    });

    // Select "Equals" in the filter type dropdown
    const filterTypeSelect = page.locator(
      '.ag-filter .ag-picker-field-wrapper',
    ).first();
    await filterTypeSelect.click();
    await page.getByRole("option", { name: "Equals" }).click();

    // Type "User" in the filter input
    const filterInput = page.locator('.ag-filter input[type="text"]').first();
    await filterInput.fill("User");

    // Step 18: Verify only User messages are displayed. AG Grid applies the
    // filter after a debounce and re-renders asynchronously — poll until the
    // row set settles instead of sleeping a fixed amount (a fixed 500ms read
    // the grid mid-transition and caught a leftover Machine row).
    const senderCellLocator = page.locator('.ag-cell[col-id="sender"]');
    await expect
      .poll(
        async () => {
          const texts = await senderCellLocator.allTextContents();
          return texts.length > 0 && texts.every((t) => t.trim() === "User");
        },
        { timeout: 10000 },
      )
      .toBe(true);
    const filteredCount = await senderCellLocator.count();
    expect(filteredCount).toBeGreaterThan(0);

    // Steps 19-20: Remove filter value → all messages restored
    await filterInput.clear();
    await expect
      .poll(async () => senderCellLocator.count(), { timeout: 10000 })
      .toBeGreaterThan(filteredCount); // more rows than the filtered set
    const restoredCount = await senderCellLocator.count();
    expect(restoredCount).toBeGreaterThanOrEqual(4); // back to at least 4 rows
  },
);
