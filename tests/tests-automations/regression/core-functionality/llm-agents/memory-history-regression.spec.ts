import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { loadSimpleAgentWithOpenAI } from "../../../../helpers/flows/load-simple-agent-with-openai";
import { selectGptModel } from "../../../../helpers/mcp/select-gpt-model";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Opens Playground, sends a message and waits for execution to finish.
 * Returns the count of bot messages BEFORE sending (for assertion after).
 */
async function sendMessage(
  page: import("@playwright/test").Page,
  message: string,
): Promise<number> {
  const messageCountBefore = await page
    .getByTestId("div-chat-message")
    .count();

  const chatInput = page.getByTestId("input-chat-playground").last();
  await chatInput.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await chatInput.fill(message);
  await page.getByTestId("button-send").last().click();

  // Wait for execution to finish: Stop button appears then disappears
  const stopButton = page.getByRole("button", { name: "Stop" });
  try {
    await stopButton.waitFor({ state: "visible", timeout: 30000 });
    await stopButton.waitFor({ state: "hidden", timeout: 120000 });
  } catch {
    // Stop button may appear and disappear too fast to catch both transitions
  }

  return messageCountBefore;
}

// ─── Smoke ─────────────────────────────────────────────────────────────────────

test(
  "Memory Chatbot template loads with correct node and edge structure",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Memory Chatbot" }).first().click();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(3);

    const edgeCount = await page.locator(".react-flow__edge").count();
    expect(edgeCount).toBeGreaterThanOrEqual(2);

    await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible({
      timeout: 5000,
    });
  },
);

// ─── Memory persistence + Session isolation (serial — both use loadSimpleAgentWithOpenAI) ────────
//
// Serial to prevent parallel flow deletion conflicts in loadSimpleAgentWithOpenAI.

test.describe.serial("Agent memory and session isolation", () => {
  test(
    "Agent retains context between messages in same Playground session",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // Start a fresh session so prior test runs don't pollute the history
      await page
        .getByTestId("new-chat")
        .waitFor({ state: "visible", timeout: 15000 });
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 10000,
      });

      // First message: establish a unique fact the model cannot know from training
      await sendMessage(
        page,
        "Remember this for our conversation: my secret code is MEMORY7491.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(1, {
        timeout: 60000,
      });

      // Second message: ask the agent to recall the fact
      await sendMessage(page, "What is my secret code?");

      await expect(page.getByTestId("div-chat-message")).toHaveCount(2, {
        timeout: 60000,
      });

      // The agent must recall the value from earlier in the same session
      const lastMessage = page.getByTestId("div-chat-message").last();
      await expect(lastMessage).toContainText("MEMORY7491", {
        timeout: 30000,
      });
    },
  );

  // ─── Session isolation ───────────────────────────────────────────────────────
  //
  // Scenario: "Trocar context_id reseta histórico do agente"
  //
  // Verifies that creating a new Playground session (via new-chat) starts with
  // an empty message history, proving sessions are isolated from each other.

  test(
    "New Playground session starts with empty message history",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // Session A: start a clean session
      await page
        .getByTestId("new-chat")
        .waitFor({ state: "visible", timeout: 15000 });
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 10000,
      });

      // Send one message in Session A so it has history
      await sendMessage(
        page,
        "Remember this: my secret code is SESSION_A_9876.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(1, {
        timeout: 60000,
      });

      // Session B: new-chat creates a new isolated session in the IOModal sidebar
      await page
        .getByTestId("new-chat")
        .waitFor({ state: "visible", timeout: 10000 });
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 10000,
      });

      // Session B must have no messages — history is isolated per session
      await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
        timeout: 5000,
      });

      // Verify Session B responds without knowledge of Session A's secret code
      await sendMessage(
        page,
        "What is my secret code? Answer only from our current conversation.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(1, {
        timeout: 60000,
      });

      const response = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();

      // The agent must NOT recall the secret from Session A
      expect(response).not.toContain("SESSION_A_9876");
    },
  );

  // ─── Message History disconnected ─────────────────────────────────────────
  //
  // Scenario: "LLM sem Message History conectado não retém contexto na sessão"
  //
  // The Memory Chatbot template wires: Message History → Prompt → Language Model.
  // When that edge is removed, the Prompt's {memory} variable is empty, so the
  // Language Model never receives conversation history and cannot recall earlier
  // messages — even within the same session.

  test(
    "LLM without Message History connected has no memory within same session",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      // Load the Memory Chatbot template — it has Message History wired by default
      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page
        .getByRole("heading", { name: "Memory Chatbot" })
        .first()
        .click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      // Fit the canvas view before interacting with nodes
      await adjustScreenView(page);

      // Deselect any selected node to close the right-side detail panel.
      // When the Memory Chatbot template loads, a node may be auto-selected,
      // causing `model_model` to render inside a `pointer-events-none` panel
      // that blocks clicks. Clicking empty canvas space dismisses it.
      await page
        .locator('//*[@id="react-flow-id"]')
        .click({ position: { x: 50, y: 50 } });

      // Configure the OpenAI provider (Language Model node in this template)
      await selectGptModel(page);

      // Disconnect Message History from Prompt by deleting its edge.
      //
      // Node IDs (e.g. "Memory-MKGtC") are generated at runtime and change with
      // every new flow — they cannot be hardcoded. Instead:
      //  1. Find the Message History node by its title testid.
      //  2. Read its runtime data-id from the DOM.
      //  3. Use that ID to locate the edge where this node is the source.
      const edgeCountBefore = await page.locator(".react-flow__edge").count();

      const memoryNode = page.locator(".react-flow__node").filter({
        has: page.getByTestId("title-Message History"),
      });
      await expect(memoryNode).toBeVisible({ timeout: 10000 });

      const memoryNodeId = await memoryNode.getAttribute("data-id");
      if (!memoryNodeId) throw new Error("Could not find Message History node data-id");

      // Scope to .react-flow__edge to avoid strict mode violation:
      // the node ID substring appears in the edge, the node itself, and its handles.
      await page
        .locator(`.react-flow__edge[data-id*="${memoryNodeId}"]`)
        .click({ force: true });
      await page.keyboard.press("Delete");

      await expect(page.locator(".react-flow__edge")).toHaveCount(
        edgeCountBefore - 1,
        { timeout: 5000 },
      );

      // Open Playground and start a fresh session
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });
      await page
        .getByTestId("new-chat")
        .waitFor({ state: "visible", timeout: 15000 });
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 10000,
      });

      // First message: establish a unique fact
      await sendMessage(
        page,
        "Remember this: my secret code is NOMEM5678.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(1, {
        timeout: 60000,
      });

      // Second message: ask the LLM to recall — it must NOT know
      await sendMessage(page, "What is my secret code?");

      await expect(page.getByTestId("div-chat-message")).toHaveCount(2, {
        timeout: 60000,
      });

      // Without Message History, the LLM has no conversation history to draw from
      const response = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();

      expect(response).not.toContain("NOMEM5678");
    },
  );

});
