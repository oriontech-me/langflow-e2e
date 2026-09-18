import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";

// While a node is selected the editor arms its node shortcuts (copy `mod+c`, paste
// `mod+v`, delete `Backspace`, …): each handler calls preventDefault() and acts on
// the SELECTION. Keystrokes typed into the node's own text field must reach the
// field instead. See docs/flow-functionality/generalBugs-shard-7.md.
//
// Split Text's `separator` renders through the same single-line InputComponent
// (`popover-anchor-input-<field>`) as every text field on a node, and Split Text is
// core — the inherited version used Ollama Embeddings, which comes from the vendor
// `ollama` distribution and is incidental to what is checked here.
const FIELD_TESTID = "popover-anchor-input-separator";

// The one flow each test creates, deleted id-scoped in afterEach. The inherited
// version went through `awaitBootstrapTest` + `blank-flow` and deleted nothing:
// 3 flows leaked per run on an empty project (#1908).
let createdFlow: { id: string; bearer: string } | undefined;

test.afterEach(async ({ page, request }) => {
  // Null out BEFORE awaiting, so a later test can never inherit this binding.
  const flow = createdFlow;
  createdFlow = undefined;
  if (!flow) return;
  // Leave the editor first: an editor mounted over a deleted flow keeps polling
  // `GET /flows/{id}/events` and 404s into the backend-error log (#1288).
  await unmountEditorForCleanup(page);
  await deleteFlow(request, flow.id, {
    headers: { Authorization: flow.bearer },
  }).catch((error: unknown) => {
    console.warn(
      `generalBugs-shard-7: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

// Renamed from "…on advanced modal": that modal no longer exists — measured on
// 1.13.0.dev16, ControlOrMeta+Shift+A on a selected node opens no dialog, and the
// field the inherited test typed into was the node's own. Upstream renamed its copy
// the same way (LE-1810).
test(
  "should be able to select all with ctrl + A on a node input",
  { tag: ["@stable", "@release", "@regression", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const sentinel = `e2e_ctrl_a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const node = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Split Text") });
    const field = node.getByTestId(FIELD_TESTID);

    await test.step("Open a blank flow created over the API", async () => {
      const bearer = await getAuthToken(request);
      const id = await createFlow(
        request,
        {
          name: `Node Input Keys ${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 7)}`,
          description: "",
          data: { nodes: [], edges: [] },
          is_component: false,
        },
        { headers: { Authorization: bearer } },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
    });

    await test.step("Add Split Text and select it, arming the node shortcuts", async () => {
      await addComponentFromSidebar(
        page,
        "split text",
        "add-component-button-split-text",
      );
      await expect(page.getByTestId("title-Split Text")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await node.getByTestId("div-generic-node").click();
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    });

    await test.step("Type into the node's own text field", async () => {
      await field.fill(sentinel);
      await expect(field).toHaveValue(sentinel);
      // Still selected while the focus is in the field: the node shortcuts are live.
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    });

    await test.step("Select all, copy and Backspace clear the field, not the node", async () => {
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("ControlOrMeta+c");
      await page.keyboard.press("Backspace");
      await expect(field).toHaveValue("");
    });

    await test.step("Paste restores the text, not a node", async () => {
      await page.keyboard.press("ControlOrMeta+v");
      await expect(field).toHaveValue(sentinel);
    });

    await test.step("The canvas still holds exactly that one node", async () => {
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await expect(node).toHaveCount(1);
    });
  },
);
