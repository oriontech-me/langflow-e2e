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
import type { APIRequestContext, Locator, Page } from "@playwright/test";
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

/**
 * The session id Langflow stored for THIS test's conversation.
 *
 * Read from the API, never off the screen: the row carrying `FIRST_MESSAGE` is
 * exactly the row virtualization may not have materialized (#1778), so reading
 * the scope key from the grid would depend on the defect being absent. The
 * lookup is keyed on the flow this test created and then on the prompt it sent,
 * so it cannot pick up a sibling spec's conversation.
 */
async function resolveOwnSessionId(
  request: APIRequestContext,
  flowIds: string[],
  headers: Record<string, string>,
): Promise<string> {
  const attempted: string[] = [];
  for (const flowId of flowIds) {
    const response = await request.get(
      `/api/v1/monitor/messages?flow_id=${flowId}`,
      { headers },
    );
    if (!response.ok()) {
      attempted.push(`${flowId} -> HTTP ${response.status()}`);
      continue;
    }
    const rows = (await response.json()) as {
      text?: string;
      session_id?: string;
    }[];
    const own = rows.find((row) => (row.text ?? "").trim() === FIRST_MESSAGE);
    if (own?.session_id) return own.session_id;
    attempted.push(`${flowId} -> ${rows.length} message(s), none matching`);
  }
  throw new Error(
    `OWN_CONVERSATION_NOT_STORED: no stored message reads "${FIRST_MESSAGE}" for the ` +
      `flow(s) this test created [${attempted.join("; ")}]. The conversation whose ` +
      `history is under assertion was never persisted, so the grid cannot be scoped ` +
      `to it — assert on the Playground exchange before this point, not on the grid.`,
  );
}

/**
 * Applies AG Grid's "Equals <value>" filter to one column, through the header's
 * dedicated filter button, and returns the filter's text input so the caller can
 * clear it later.
 *
 * The popup is left OPEN — closing it is the caller's call, because the two
 * users of this want opposite things: the scoping filter is set once and must
 * get out of the way of the next header, while the `sender` filter is cleared
 * again a few lines later and would have to be reopened.
 */
async function applyEqualsFilter(
  page: Page,
  colId: string,
  value: string,
): Promise<Locator> {
  await page.hover(`.ag-header-cell[col-id="${colId}"]`);
  await page
    .locator(`.ag-header-cell[col-id="${colId}"] .ag-header-cell-filter-button`)
    .click({ timeout: 5000 });
  await expect(page.locator(".ag-filter").first()).toBeVisible({
    timeout: 5000,
  });

  // Select "Equals" in the filter type dropdown
  await page.locator(".ag-filter .ag-picker-field-wrapper").first().click();
  await page.getByRole("option", { name: "Equals" }).click();

  const filterInput = page.locator('.ag-filter input[type="text"]').first();
  await filterInput.fill(value);
  return filterInput;
}

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
  async ({ page, request }) => {
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

    // Scope the grid to THIS test's conversation before a single row is read.
    //
    // Settings > Messages is a GLOBAL audit surface: the suite runs
    // `fullyParallel` against one shared superuser on one instance, so every
    // sibling spec's messages land in this same table. And AG Grid virtualizes
    // ROWS exactly the way #616 found it virtualizing columns — only what fits
    // the viewport is in the DOM. Collecting `.ag-cell[col-id="..."]` off an
    // unscoped grid therefore reads *some other spec's* messages and asserts
    // this test's prompts are among them.
    //
    // Measured on `1.13.0.dev8` with 50 stored messages: the footer reports
    // "1 to 50 of 50", the DOM carries 18 rows, and this test's own — the
    // NEWEST, and last under the ascending default — are not among them. That
    // is #1778 reproduced: a hard 3/3 failure on the VM lane while the feature
    // was working, because the rows were one scroll away.
    //
    // REJECTED — sweeping the vertical scroll, the row-axis twin of the #616
    // column sweep. It would collect the rows, but it leaves every assertion
    // below measuring other specs' messages, and its cost grows with the
    // instance's entire history: the lane that found this serves 654 tests from
    // one instance. Scoping is O(this test's own rows) and makes the order,
    // sender and content assertions legitimate again — the same move PR #1779
    // made for #1773, where a global flow count was scoped to an owned project.
    const bearer = await getAuthToken(request);
    const ownSessionId = await resolveOwnSessionId(request, createdFlowIds, {
      Authorization: bearer,
    });
    await applyEqualsFilter(page, "session_id", ownSessionId);
    // Dismiss the popup: left open it swallows the hover that opens the next
    // column's filter button.
    await page.keyboard.press("Escape");

    // The scope is ASSERTED, not assumed. Without this, a filter that silently
    // failed to apply would hand every assertion below the global grid back —
    // the exact state this test is being fixed for, and green.
    const sessionCells = page.locator('.ag-cell[col-id="session_id"]');
    await expect
      .poll(
        async () => {
          const sessions = await sessionCells.allTextContents();
          return (
            sessions.length > 0 &&
            sessions.every((s) => s.trim() === ownSessionId)
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);

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
    expect(rowCount).toBeGreaterThanOrEqual(4); // this conversation: 2 user msgs + 2 agent responses

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
    const filterInput = await applyEqualsFilter(page, "sender", "User");

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

    // Steps 19-20: Remove filter value → this conversation's rows restored
    await filterInput.clear();
    await expect
      .poll(async () => senderCellLocator.count(), { timeout: 10000 })
      .toBeGreaterThan(filteredCount); // more rows than the filtered set
    const restoredCount = await senderCellLocator.count();
    expect(restoredCount).toBeGreaterThanOrEqual(4); // back to the scoped set: 2 user + 2 agent
  },
);
