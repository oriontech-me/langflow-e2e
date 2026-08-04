import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";

// Clicking `blank-flow` creates a real flow (POST /api/v1/flows → 201). Track
// the ids the run creates and delete them id-scoped in afterEach — the
// inherited version of this spec leaked one "New Flow" per run on the shared
// instance.
const createdFlowIds: string[] = [];

// The node the shortcuts operate on. Chat Output is a core component (no
// langchain extra — the nightly has dropped those before, hiding the Ollama
// component the inherited spec dragged in: #907 / LE-1987) AND, unlike Chat
// Input, its body carries no text field. That matters: a focused field inside
// the node swallows `mod+…` keydowns before the canvas hotkey handler sees them,
// so a Chat-Input-based spec silently fails to trigger Duplicate/Copy.
const NODE_TITLE_TESTID = "title-Chat Output";

// Suppress the assistant onboarding tooltip BEFORE the first document load, which
// is the only point at which it can be suppressed: upstream reads the flag once, at
// mount of the canvas-controls bar, and arms a 10 s timer when it is unset. The
// tooltip is a 282×32 opaque rectangle over that bar, and this spec clicks the bar
// (`adjustScreenView`) as well as the canvas.
//
// This replaces a `dismissOnboardingIfPresent(page)` call the spec ran right after
// the `blank-flow` click. #1220 measured it on 1.12.0.dev15: in 3 of 3 runs it fired
// BEFORE the canvas-controls bar had mounted at all — i.e. before the timer that
// creates the thing it was dismissing had even started.
test.beforeEach(async ({ page }) => {
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

test(
  "LangflowShortcuts",
  { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
  async ({ page }) => {
    const nodes = page.getByTestId(NODE_TITLE_TESTID);
    const selectedNodes = page.locator(".react-flow__node.selected");

    // The canvas applies a shortcut asynchronously (ReactFlow re-render), so the
    // count is asserted with the auto-retrying `toHaveCount` — a raw `count()`
    // read right after `keyboard.press` samples it mid-update.
    const expectNodes = (n: number, because: string) =>
      expect(nodes, because).toHaveCount(n, { timeout: 10000 });

    // Every canvas shortcut acts on the SELECTED node, so selection is gated
    // explicitly before each keypress instead of assumed: an unselected canvas
    // makes the shortcuts no-ops and the test would blame the keybind.
    const selectNode = async (which: "first" | "last" = "first") => {
      await page.getByTestId("generic-node-title-arrangement")[which]().click();
      await expect(
        selectedNodes,
        "the clicked node must be selected before pressing a shortcut",
      ).toHaveCount(1, { timeout: 10000 });
    };

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

    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 30000,
    });
    await page.getByTestId("blank-flow").click();

    await addComponentFromSidebar(
      page,
      "chat output",
      "add-component-button-chat-output",
    );
    await expectNodes(1, "the Chat Output component should be on the canvas");

    await adjustScreenView(page);
    await adjustScreenView(page, { numberOfZoomOut: 2 });

    // Selecting the node via its title arrangement also exposes the
    // name/description edit affordance. On 1.11 that was `panel-description`,
    // which has 0 occurrences in the 1.12 nightly frontend bundle; the current
    // testid for the same affordance is `node-edit-name-description-button`
    // (scouted live on 1.12.0.dev5).
    await selectNode();
    await expect(
      page.getByTestId("node-edit-name-description-button"),
    ).toBeVisible();

    // Duplicate (mod+d)
    await page.keyboard.press(`ControlOrMeta+d`);
    await expectNodes(2, "Duplicate (mod+d) should add one node");

    // Delete (backspace) removes the duplicate
    await selectNode("last");
    await page.keyboard.press("Backspace");
    await expectNodes(1, "Delete (backspace) should remove the duplicate");

    // Copy (mod+c) + Paste (mod+v)
    await selectNode();
    await page.keyboard.press(`ControlOrMeta+c`);
    await page.keyboard.press(`ControlOrMeta+v`);
    await expectNodes(2, "Copy + Paste (mod+c / mod+v) should add one node");

    await selectNode("last");
    await page.keyboard.press("Backspace");
    await expectNodes(1, "Delete (backspace) should remove the pasted node");

    // Cut (mod+x) removes the node…
    await selectNode();
    await page.keyboard.press(`ControlOrMeta+x`);
    await expectNodes(0, "Cut (mod+x) should remove the node");

    // …and Paste (mod+v) restores what Cut took
    await page.keyboard.press(`ControlOrMeta+v`);
    await expectNodes(1, "Paste (mod+v) after Cut should restore the node");

    // Undo (mod+z) — delete first, then undo the deletion
    await selectNode();
    await page.keyboard.press("Backspace");
    await expectNodes(0, "Delete (backspace) should remove the node");

    await page.keyboard.press(`ControlOrMeta+z`);
    await expectNodes(1, "Undo (mod+z) should bring the node back");

    // Redo (mod+y) re-applies the deletion
    await page.keyboard.press(`ControlOrMeta+y`);
    await expectNodes(0, "Redo (mod+y) should re-apply the deletion");
  },
);
