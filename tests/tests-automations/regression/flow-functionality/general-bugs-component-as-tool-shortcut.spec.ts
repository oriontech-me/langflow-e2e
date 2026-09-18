import type { Page, Request } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createCatalogFlow,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import {
  COMPONENT_REFRESH_PATH,
  watchNodeRefresh,
} from "../../../helpers/ui/watch-node-refresh";

// Tool Mode — the toolbar button and the Ctrl/Cmd+Shift+M shortcut — is offered only
// while the component declares a `tool_mode=True` input (`checkHasToolMode`). The
// Prompt Template declares exactly one; after its code is saved with that input set to
// `tool_mode=False`, the toolbar shows Freeze instead and the shortcut is inert.
// See docs/flow-functionality/general-bugs-component-as-tool-shortcut.md.
//
// Sibling coverage, not repeated here: repeated toggling and the Tool Mode outputs of
// a running component in core-components/tool-mode.spec.ts.

const PROMPT_ID = "PromptTemplate-shortcut";

// How long a key press may take to send the refresh an effective Tool Mode toggle
// sends. The same key press on the same node shows the request does leave while Tool
// Mode is offered; the absence at the end is read against this window.
const REFRESH_WINDOW_MS = 5000;

// The one flow this file creates, deleted id-scoped in afterEach. The inherited
// version reached the canvas through `awaitBootstrapTest` + `blank-flow` and deleted
// nothing: 3 flows leaked per run on an empty project (#1911).
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
      `general-bugs-component-as-tool-shortcut: flow cleanup failed — ${String(error).split("\n")[0]}`,
    );
  });
});

/** The request an effective Tool Mode toggle sends, matched on the pathname (#1644). */
function isComponentRefresh(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === COMPONENT_REFRESH_PATH
  );
}

/** Presses the Tool Mode shortcut and reports whether a refresh left within the window. */
async function pressToolModeShortcut(page: Page): Promise<boolean> {
  const sent = page
    .waitForRequest(isComponentRefresh, { timeout: REFRESH_WINDOW_MS })
    .then(
      () => true,
      () => false,
    );
  await page.keyboard.press("ControlOrMeta+Shift+m");
  return sent;
}

test(
  "user must be able to use component as tool shortcut only if has tool mode is True",
  { tag: ["@stable", "@release", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const title = page.getByTestId("title-Prompt Template");
    const toolModeButton = page.getByTestId("tool-mode-button");
    const toolset = page.getByText("Toolset", { exact: true });
    let catalogCode = "";

    await test.step("Open a flow holding one Prompt Template built from the live catalog", async () => {
      const bearer = await getAuthToken(request);
      const headers = { Authorization: bearer };
      const catalog = await fetchComponentCatalog(request, headers);
      catalogCode = String(
        findCatalogComponent(catalog, "Prompt Template").template.code?.value ?? "",
      );
      const id = await createCatalogFlow(
        request,
        catalog,
        { nodes: [{ id: PROMPT_ID, type: "Prompt Template" }], edges: [] },
        {
          name: `Tool Mode Shortcut ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          headers,
        },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
      await expect(title).toBeVisible({ timeout: 15000 });
    });

    await test.step("The stock component offers Tool Mode", async () => {
      await expect(toolset).toHaveCount(0);
      await title.click();
      await expect(toolModeButton).toBeVisible({ timeout: 10000 });
    });

    await test.step("The shortcut toggles Tool Mode on and back off", async () => {
      const on = watchNodeRefresh(page);
      expect(
        await pressToolModeShortcut(page),
        "the shortcut sent no component refresh on a component that offers Tool Mode — " +
          "the absence asserted at the end would then prove nothing",
      ).toBe(true);
      await on.untilQuiet();
      await expect(toolset).toBeVisible({ timeout: 10000 });

      // Back out, so the final check starts from a node NOT in Tool Mode and cannot
      // pass by toggling it off.
      await title.click();
      const off = watchNodeRefresh(page);
      expect(await pressToolModeShortcut(page)).toBe(true);
      await off.untilQuiet();
      await expect(toolset).toHaveCount(0, { timeout: 10000 });
    });

    await test.step("Save the component's code with its tool_mode input set to False", async () => {
      // The node was built from the catalog, so this is the code the editor holds.
      expect(
        catalogCode.split("tool_mode=True").length - 1,
        "the Prompt Template is expected to declare exactly one tool_mode=True input",
      ).toBe(1);
      const updatedCode = catalogCode.replace("tool_mode=True", "tool_mode=False");

      await title.click();
      await page.getByTestId("code-button-modal").last().click();
      const codeDialog = page
        .getByRole("dialog")
        .filter({ has: page.getByTestId("checkAndSaveBtn") });
      await expect(codeDialog).toBeVisible({ timeout: 15000 });
      await codeDialog.locator(".ace_content").click();
      await page.keyboard.press("ControlOrMeta+A");
      await codeDialog.locator("textarea").fill(updatedCode);

      // Matched on the pathname: the frontend sends `?flow_id=<id>`, which a
      // `**/custom_component` glob never matches — the inherited test's 20 s timeout.
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/custom_component",
        { timeout: 30000 },
      );
      await page.getByTestId("checkAndSaveBtn").click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByTestId("checkAndSaveBtn")).toBeHidden({
        timeout: 30000,
      });
    });

    await test.step("Tool Mode is withdrawn: the toolbar shows Freeze in its place", async () => {
      await title.click();
      // The Freeze button renders exactly where tool-mode-button would: seeing it
      // proves the toolbar rendered, so the absence below is a real branch choice.
      await expect(page.getByTestId("freeze-all-button-modal")).toBeVisible({
        timeout: 10000,
      });
      await expect(toolModeButton).toHaveCount(0);
    });

    await test.step("The shortcut is inert", async () => {
      expect(
        await pressToolModeShortcut(page),
        "the Tool Mode shortcut sent a component refresh on a component that declares no " +
          "tool_mode input",
      ).toBe(false);
      await expect(toolset).toHaveCount(0);
    });
  },
);
