import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { expandFocusedNode } from "../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Every test here clicks `blank-flow`, which creates a real flow
// (`POST /api/v1/flows` → 201). This spec had NO cleanup at all and leaked one flow
// per test on the shared instance — measured while validating #1220: two full runs
// plus four force-fail runs of this file and its sibling left 24 orphan `New Flow`
// rows behind. Tracked and deleted id-scoped via the shared tracker (#1108), never a
// delete-all sweep, which would wipe flows other parallel workers are driving (#553).
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(async ({ page }) => {
  flows = trackCreatedFlows(page);
  // Before the first document load — the only point at which the assistant
  // onboarding tooltip can be suppressed, because upstream reads its flag once at
  // mount of the canvas-controls bar and then arms a 10 s timer. `expandFocusedNode`
  // asserts this ran; the probe it used to make instead fired ~2 s after that mount
  // and never saw the tooltip in 39 measured executions (#1220). This spec also
  // clicks the bar itself (`zoomOut`, `adjustScreenView`), which the tooltip covers.
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
  flows.dispose();
});

// Helper: create a blank flow and add the Chat Input component to the canvas
// in expanded (non-minimized) state.
async function addChatInputComponent(page: Page) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  // Wait for the sidebar to settle before typing — filling the search input
  // immediately after the blank-flow transition can time out while the canvas
  // is still mounting (same guard as if-else-component-regression).
  await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
    timeout: 15000,
  });
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
    timeout: 30000,
  });
  await page.getByTestId("input_outputChat Input").hover();
  await page.getByTestId("add-component-button-chat-input").click();
  await adjustScreenView(page);
  await expect(page.getByTestId("title-Chat Input")).toBeVisible({
    timeout: 15000,
  });
  // Focus the node and expand it so run button / inspector fields are exposed
  await page.getByTestId("title-Chat Input").click();
  await expandFocusedNode(page);
}

// Helper: drag the Chat Output component onto the canvas and expand it.
// Requires that a flow is already open and that at least one node is present.
async function addChatOutputToCanvas(page: Page) {
  // Zoom out so the drag target does not overlap the existing node
  await zoomOut(page, 2);
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });
  await adjustScreenView(page);
  await expect(page.getByTestId("title-Chat Output")).toBeVisible({
    timeout: 15000,
  });
  await page.getByTestId("title-Chat Output").click();
  await expandFocusedNode(page);
}

// Helper: connect ChatInput "Chat Message" output → ChatOutput "Inputs" input
// by clicking the source handle then the target handle. The shownode variant
// is targeted because both components were expanded by the add helpers above.
async function connectChatInputToChatOutput(page: Page) {
  await page
    .getByTestId("handle-chatinput-shownode-chat message-right")
    .click();
  await page
    .getByTestId("handle-chatoutput-shownode-inputs-left")
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

// Helper: run the connected flow from the Chat Output run button and open the
// output-inspection dialog for the Chat Output. Returns the dialog text content
// (the whole modal — Message outputs render as a structured view that may mix
// labeled sections and a JSON-style preview, so reading the full dialog body
// avoids depending on a single inner element).
async function runFlowAndOpenChatOutputInspection(page: Page): Promise<string> {
  await page.getByTestId("button_run_chat output").click();
  await expect(page.getByText("built successfully").last()).toBeVisible({
    timeout: 45000,
  });
  await expect(
    page.getByTestId("output-inspection-output message-chatoutput"),
  ).toBeAttached({ timeout: 10000 });
  await page.getByTestId("output-inspection-output message-chatoutput").click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  return (await dialog.evaluate((el: HTMLElement) => el.textContent ?? "")) ?? "";
}

// =============================================================================
// Test 1 — Chat Input rendering on canvas
// =============================================================================

test(
  "Chat Input component — renders on canvas with Message output handle and Input Text field",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addChatInputComponent(page);

    // Title must be visible in the node header
    await expect(page.getByTestId("title-Chat Input")).toBeVisible();

    // Run button must be present
    await expect(page.getByTestId("button_run_chat input")).toBeVisible();

    // Output handle: "Chat Message" port on the right side
    await expect(
      page.getByTestId("handle-chatinput-shownode-chat message-right"),
    ).toBeVisible();

    // Default visible inspector field: "Input Text" (MultilineInput name="input_value")
    await expect(page.getByTestId("textarea_str_input_value")).toBeVisible({
      timeout: 10000,
    });

    // Output inspection button for the "Chat Message" port
    await expect(
      page.getByTestId("output-inspection-chat message-chatinput"),
    ).toBeVisible();

    // Exactly one node on the canvas — no spurious duplicates
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

// =============================================================================
// Test 2 — Chat Output rendering on canvas
// =============================================================================

test(
  "Chat Output component — renders on canvas with Inputs handle and run button",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Output").hover();
    await page.getByTestId("add-component-button-chat-output").click();
    await adjustScreenView(page);

    await expect(page.getByTestId("title-Chat Output")).toBeVisible({
      timeout: 15000,
    });

    // Expand the node so the run button and inspector contents are exposed
    await page.getByTestId("title-Chat Output").click();
    await expandFocusedNode(page);

    // Run button must be present
    await expect(page.getByTestId("button_run_chat output")).toBeVisible();

    // Input handle: "Inputs" port on the left side
    await expect(
      page.getByTestId("handle-chatoutput-shownode-inputs-left"),
    ).toBeVisible();

    // Output inspection button for the "Output Message" port
    await expect(
      page.getByTestId("output-inspection-output message-chatoutput"),
    ).toBeVisible();

    // Exactly one node on the canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

// =============================================================================
// Test 3 — connection accepted between Chat Input and Chat Output
// =============================================================================

test(
  "Chat Input → Chat Output connection is accepted on canvas (Message ↔ Message)",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await addChatInputComponent(page);
    await addChatOutputToCanvas(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(2);

    await connectChatInputToChatOutput(page);

    // After connecting, both nodes must remain on canvas with exactly one edge
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.getByTestId("title-Chat Input")).toBeVisible();
    await expect(page.getByTestId("title-Chat Output")).toBeVisible();
  },
);

// =============================================================================
// Test 4 — Input Text propagates from ChatInput to ChatOutput on run
// =============================================================================

test(
  "Chat Input → Chat Output — Input Text value propagates to ChatOutput on run",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const inputText = "regression-chat-passthrough-42";

    await addChatInputComponent(page);

    // Configure the Input Text on the Chat Input
    await page.getByTestId("textarea_str_input_value").fill(inputText);
    await expect(page.getByTestId("textarea_str_input_value")).toHaveValue(
      inputText,
    );

    await addChatOutputToCanvas(page);
    await connectChatInputToChatOutput(page);

    // The helper waits for the "built successfully" toast before opening the
    // dialog, so a green path here means: build ran, ChatInput emitted the
    // Message, and the propagated text is visible in ChatOutput's inspection.
    const output = await runFlowAndOpenChatOutputInspection(page);

    expect(output).toContain(inputText);

    await page.keyboard.press("Escape");
  },
);

// =============================================================================
// Test 5 — sender_name override is reflected in output
// =============================================================================

test(
  "Chat Input — sender_name override is reflected in the Playground chat message",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const senderOverride = "QA";
    // Doubles as a `chat-message-QA-{value}` testid suffix — keep it free of
    // characters that would invalidate that selector.
    const playgroundMessage = "sender-override-regression";

    await addChatInputComponent(page);

    // sender_name is advanced=True — toggle it visible via the inspector controls
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-sender_name").click();
    await closeAdvancedOptions(page);

    // Scope the sender_name field to the Chat Input node container so the
    // assertion does not depend on DOM ordering once Chat Output is added.
    const chatInputNode = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Chat Input") });
    await chatInputNode
      .getByTestId("popover-anchor-input-sender_name")
      .fill(senderOverride);
    await expect(
      chatInputNode.getByTestId("popover-anchor-input-sender_name"),
    ).toHaveValue(senderOverride);

    await addChatOutputToCanvas(page);
    await connectChatInputToChatOutput(page);

    // Drive the flow through the Playground — that is the surface where the
    // override is actually rendered (chat-message testid is built from the
    // user-side sender_name returned by ChatInput).
    await page.getByTestId("playground-btn-flow-io").click();
    await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("input-chat-playground").last().fill(playgroundMessage);
    await page.getByTestId("button-send").last().click();

    // The user-side message must render with the QA override as sender_name —
    // the testid pattern is `chat-message-{sender_name}-{text}` (see
    // chat-message.tsx).
    await expect(
      page.getByTestId(`chat-message-${senderOverride}-${playgroundMessage}`),
    ).toBeVisible({ timeout: 30000 });
  },
);

// =============================================================================
// Test 6 — default sender_name values are the literal constants
// =============================================================================

test(
  "Chat Input/Output — default sender_name is 'User' on input and 'AI' on output",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // The defaults are constants in lfx/utils/constants.py:
    //   MESSAGE_SENDER_NAME_USER = "User"
    //   MESSAGE_SENDER_NAME_AI   = "AI"
    // There is no fallback to the authenticated username — the field is
    // pre-filled with the literal string. Validate the defaults at the
    // inspector level because the field controls what every Message will
    // carry; this is the upstream of the runtime behaviour.
    await addChatInputComponent(page);

    // Toggle the advanced "sender_name" field visible on Chat Input and
    // assert it contains the default "User"
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-sender_name").click();
    await closeAdvancedOptions(page);

    // Scope the field to the Chat Input node container so the assertion
    // does not depend on DOM ordering once the second node is added.
    const chatInputNode = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Chat Input") });
    await expect(
      chatInputNode.getByTestId("popover-anchor-input-sender_name"),
    ).toHaveValue("User", { timeout: 10000 });

    // Now do the same for Chat Output — its default sender_name must be "AI"
    await addChatOutputToCanvas(page);

    // Focus the Chat Output node so the inspector targets it
    await page.getByTestId("title-Chat Output").click();
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-sender_name").click();
    await closeAdvancedOptions(page);

    // Scope each assertion to its node container — using the React Flow
    // wrapper as the boundary keeps the test resilient to DOM ordering
    // changes between Chat Input and Chat Output.
    const chatOutputNode = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Chat Output") });
    await expect(
      chatInputNode.getByTestId("popover-anchor-input-sender_name"),
    ).toHaveValue("User");
    await expect(
      chatOutputNode.getByTestId("popover-anchor-input-sender_name"),
    ).toHaveValue("AI");
  },
);
