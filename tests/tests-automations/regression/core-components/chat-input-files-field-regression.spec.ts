import type { Page } from "@playwright/test";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { expandFocusedNode } from "../../../helpers/ui/expand-focused-node";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";
import { zoomOut } from "../../../helpers/ui/zoom-out";
import { waitForFlowSaveSettled } from "../../../helpers/flows/wait-for-flow-save-settled";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Every test here clicks `blank-flow`, which creates a real flow
// (`POST /api/v1/flows` → 201). This spec had NO cleanup at all and leaked one flow
// per test on the shared instance — measured while validating #1220, together with
// its `chat-input-output` sibling: 24 orphan `New Flow` rows across two full runs and
// four force-fail runs. Tracked and deleted id-scoped via the shared tracker (#1108),
// never a delete-all sweep, which would wipe flows other workers are driving (#553).
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

const IMAGE_NAME = "chain.png";
const IMAGE_PATH = path.resolve(
  __dirname,
  "../../../assets/media/chain.png",
);

// Helper: create a blank flow and add the Chat Input component to the canvas
// in expanded (non-minimized) state.
async function addChatInputComponent(page: Page) {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeAttached({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Gate the sidebar search before filling it. Filling without first waiting
  // for the input to be actionable raced under nightly backend load into a
  // `locator.fill: Timeout` — the flake observed in the weekly run (issue #384).
  await page.getByTestId("sidebar-search-input").click();
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
  await page.getByTestId("title-Chat Input").click();
  await expandFocusedNode(page);

  // Let the node-add / viewport autosaves settle before the caller fires its
  // next flow-mutating action (exposing Files, uploading via the inspector),
  // so that mutation cannot race a still-in-flight autosave PATCH.
  await waitForFlowSaveSettled(page);
}

// Helper: drag the Chat Output component onto the canvas and expand it.
async function addChatOutputToCanvas(page: Page) {
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

// Helper: connect ChatInput "Chat Message" output → ChatOutput "Inputs" input.
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

// Helper: toggle the advanced `Files` field visible on the focused node.
// Mirrors the `showsender_name` toggle pattern in chat-input-output-component-regression.
async function toggleFilesFieldVisible(page: Page) {
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-files").click();
  await closeAdvancedOptions(page);
}

// Helper: upload a file via the Chat Input inspector's `Files` field.
// With `temp_file=True` the FileInput renders the simple text-input + button_upload_file
// path (inputFileComponent/index.tsx) — clicking the button opens a native file picker.
// The button is scoped to the Chat Input node body to avoid the side-panel duplicate
// of the same testid.
async function uploadFileViaInspector(
  page: Page,
  filePath: string,
  scope: ReturnType<Page["locator"]> = page.locator("body"),
) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await scope.getByTestId("button_upload_file").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);
}

// Helper: returns a locator scoped to the Chat Input React Flow node container.
function chatInputNodeScope(page: Page) {
  return page
    .locator(".react-flow__node")
    .filter({ has: page.getByTestId("title-Chat Input") });
}

// =============================================================================
// Test 1 — Files field is hidden by default and exposed by toggling `showfiles`
// =============================================================================

test(
  "Chat Input — toggling `showfiles` exposes the Files inspector field",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // Scope to the Chat Input node body. The `input-file-component` testid is also
    // mounted by the advanced-options side panel even before the toggle, so an
    // unscoped assertion would always see count >= 1. The contract under test is
    // "field appears on the node body after toggle" — the React Flow node wrapper
    // is the right boundary.
    const chatInputNode = chatInputNodeScope(page);

    await test.step("Add Chat Input to a blank flow", async () => {
      await addChatInputComponent(page);
    });

    await test.step(
      "Files field is absent from the node body before the showfiles toggle",
      async () => {
        await expect(
          chatInputNode.getByTestId("input-file-component"),
        ).toHaveCount(0);
        await expect(
          chatInputNode.getByTestId("button_upload_file"),
        ).toHaveCount(0);
      },
    );

    await test.step(
      "Toggle showfiles via the advanced-options panel",
      async () => {
        await toggleFilesFieldVisible(page);
      },
    );

    await test.step(
      "Files field controls are visible on the node body after the toggle",
      async () => {
        await expect(
          chatInputNode.getByTestId("input-file-component"),
        ).toBeVisible({ timeout: 10000 });
        await expect(
          chatInputNode.getByTestId("button_upload_file"),
        ).toBeVisible();
      },
    );
  },
);

// =============================================================================
// Test 2 — Uploading a file via the inspector populates the Files field value
// =============================================================================

test(
  "Chat Input — uploading via the inspector populates the Files field",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const chatInputNode = chatInputNodeScope(page);
    const fileInput = chatInputNode.getByTestId("input-file-component");
    const uploadButton = chatInputNode.getByTestId("button_upload_file");

    await test.step(
      "Add Chat Input and expose the Files field via showfiles",
      async () => {
        await addChatInputComponent(page);
        await toggleFilesFieldVisible(page);
      },
    );

    await test.step(
      "Empty state shows the placeholder literal in the readonly input",
      async () => {
        await expect(fileInput).toHaveValue("Upload a file...");
      },
    );

    await test.step(
      "Upload chain.png via the inspector upload button",
      async () => {
        await uploadFileViaInspector(page, IMAGE_PATH, chatInputNode);
      },
    );

    await test.step(
      "Field value reflects the original file name after upload",
      async () => {
        // `is_list=True` stores the value as `[file.name]`; the <input> coerces a
        // single-element array to its element string when rendering.
        await expect(fileInput).toHaveValue(IMAGE_NAME, { timeout: 15000 });
      },
    );

    await test.step(
      "Upload button switches to dismiss mode (X icon revealed on hover)",
      async () => {
        await uploadButton.hover();
        await expect(uploadButton.getByTestId("icon-X")).toHaveCSS(
          "opacity",
          "1",
        );
      },
    );
  },
);

// =============================================================================
// Test 3 — Inspector-attached file propagates to the Playground rendering
// =============================================================================

test(
  "Chat Input → Chat Output — inspector-attached file is rendered in the Playground message",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const chatInputNode = chatInputNodeScope(page);

    await test.step(
      "Add Chat Input, expose Files, and upload chain.png via the inspector",
      async () => {
        await addChatInputComponent(page);
        await toggleFilesFieldVisible(page);
        await uploadFileViaInspector(page, IMAGE_PATH, chatInputNode);
        await expect(
          chatInputNode.getByTestId("input-file-component"),
        ).toHaveValue(IMAGE_NAME, { timeout: 15000 });
      },
    );

    await test.step(
      "Add Chat Output and connect ChatInput → ChatOutput",
      async () => {
        await addChatOutputToCanvas(page);
        await connectChatInputToChatOutput(page);
      },
    );

    await test.step(
      "Run the flow from the Chat Output run button",
      async () => {
        // Invokes ChatInput.message_response() with `self.files` populated by the
        // inspector upload, then propagates to ChatOutput.
        await page.getByTestId("button_run_chat output").click();
        await expect(page.getByText("built successfully").last()).toBeVisible({
          timeout: 45000,
        });
      },
    );

    await test.step(
      "Open the Playground and verify the inspector-attached image rendered",
      async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        // The server prefixes uploaded filenames with a timestamp (e.g.
        // `2026-05-08_..._chain.png`), so match the alt attribute by suffix.
        await expect(page.locator('img[alt$="chain.png"]')).toBeVisible({
          timeout: 30000,
        });
      },
    );
  },
);

// =============================================================================
// Test 4 — Removing the file via the inspector returns the field to empty
// =============================================================================

test(
  "Chat Input — clicking the dismiss button on the Files field clears the value",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    const chatInputNode = chatInputNodeScope(page);
    const fileInput = chatInputNode.getByTestId("input-file-component");
    const uploadButton = chatInputNode.getByTestId("button_upload_file");

    await test.step(
      "Add Chat Input, expose Files, and upload chain.png",
      async () => {
        await addChatInputComponent(page);
        await toggleFilesFieldVisible(page);
        await uploadFileViaInspector(page, IMAGE_PATH, chatInputNode);
        await expect(fileInput).toHaveValue(IMAGE_NAME, { timeout: 15000 });
      },
    );

    await test.step(
      "Click the upload button while a value is present (dismiss mode)",
      async () => {
        // Hovering must reveal the X icon — confirms the button is in
        // "value present" mode (handleDismissClick on click).
        await uploadButton.hover();
        await expect(uploadButton.getByTestId("icon-X")).toHaveCSS(
          "opacity",
          "1",
        );
        await uploadButton.click();
      },
    );

    await test.step(
      "Field value falls back to the placeholder literal after dismiss",
      async () => {
        await expect(fileInput).toHaveValue("Upload a file...", {
          timeout: 10000,
        });
      },
    );
  },
);
