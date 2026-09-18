import type { Page, Request } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createCatalogFlow,
  fetchComponentCatalog,
} from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import {
  COMPONENT_REFRESH_PATH,
  watchNodeRefresh,
} from "../../../helpers/ui/watch-node-refresh";

// Tool Mode is never offered on a Group node, even when the group contains a
// component that offers it. Upstream computes
// `hasToolMode = checkHasToolMode(template) && !isGroup`, and a GroupNode's template
// merges its inner nodes' fields — so a group holding a Prompt Template carries a
// `tool_mode: true` field and `checkHasToolMode` alone would answer true. This test
// proves that premise from the persisted flow and then asserts the exclusion.
// See docs/core-components/toolModeGroup.md.
//
// Sibling coverage, not repeated here: grouping/ungrouping in
// nested-grouping-regression.spec.ts, grouping a component already in Tool Mode in
// tool-mode-group.spec.ts, toggling Tool Mode on one component in tool-mode.spec.ts.

const PROMPT_ID = "PromptTemplate-grouped";
const CONVERT_ID = "TypeConverter-grouped";
const CONTROL_ID = "PromptTemplate-control";
const CONTROL_NAME = "Tool Mode Control";

// How long a key press may take to send the refresh an effective Tool Mode toggle
// sends. The control node shows, with the same key press, that the request does
// leave while Tool Mode is offered; the absence at the end is read against this
// window.
const REFRESH_WINDOW_MS = 5000;

// The one flow this file creates, deleted id-scoped in afterEach. The inherited
// version opened Basic Prompting through `awaitBootstrapTest` and deleted nothing:
// 3 flows leaked per run on an empty project (#1911).
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
    console.warn(`toolModeGroup: flow cleanup failed — ${String(error).split("\n")[0]}`);
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

/**
 * Box-selects exactly the nodes carrying the given titles with `Shift` + drag — the
 * gesture that works on every host. Click-with-modifier does not: the suite's
 * `devices["Desktop Chrome"]` user agent makes React Flow expect `Control`, and
 * Chromium on macOS turns `Control` + click into a context-menu click (#1911).
 */
async function boxSelect(page: Page, titles: string[]): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0, {
    timeout: 2000,
  });

  const boxes = [];
  for (const title of titles) {
    const box = await page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId(`title-${title}`) })
      .boundingBox();
    if (!box) throw new Error(`no bounding box for the "${title}" node`);
    boxes.push(box);
  }
  const pad = 20;
  const startX = Math.min(...boxes.map((b) => b.x)) - pad;
  const startY = Math.min(...boxes.map((b) => b.y)) - pad;
  const endX = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const endY = Math.max(...boxes.map((b) => b.y + b.height)) + pad;

  await page.keyboard.down("Shift");
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await expect(page.locator(".react-flow__node.selected")).toHaveCount(
    titles.length,
    { timeout: 5000 },
  );
}

test(
  "a Group node offers no Tool Mode even when it contains a component that does",
  { tag: ["@stable", "@release", "@workspace", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const toolModeButton = page.getByTestId("tool-mode-button");
    const toolset = page.getByText("Toolset", { exact: true });

    await test.step("Open a Prompt Template -> Type Convert pair and a control node, built from the live catalog", async () => {
      const bearer = await getAuthToken(request);
      const headers = { Authorization: bearer };
      const catalog = await fetchComponentCatalog(request, headers);
      const id = await createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            { id: PROMPT_ID, type: "Prompt Template" },
            { id: CONVERT_ID, type: "TypeConverterComponent" },
            { id: CONTROL_ID, type: "Prompt Template", displayName: CONTROL_NAME },
          ],
          edges: [
            { source: PROMPT_ID, output: "prompt", target: CONVERT_ID, field: "input_data" },
          ],
        },
        {
          name: `toolModeGroup ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          headers,
        },
      );
      createdFlow = { id, bearer };
      await openFlowById(page, id);
      await expect(page.locator(".react-flow__node")).toHaveCount(3, {
        timeout: 15000,
      });
      await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    });

    await test.step("The Prompt Template on its own offers Tool Mode", async () => {
      await page.getByTestId("title-Prompt Template").click();
      await expect(toolModeButton).toBeVisible({ timeout: 10000 });
    });

    await test.step("On the control node, the shortcut toggles Tool Mode and sends a component refresh", async () => {
      // A separate node, because Tool Mode swaps a component's outputs and the canvas
      // then removes the pair's edge as invalid — leaving it ungroupable.
      await page.getByTestId(`title-${CONTROL_NAME}`).click();
      await expect(toolModeButton).toBeVisible({ timeout: 10000 });
      await expect(toolset).toHaveCount(0);

      const on = watchNodeRefresh(page);
      expect(
        await pressToolModeShortcut(page),
        "the shortcut sent no component refresh on a component that offers Tool Mode — " +
          "the absence asserted on the Group below would then prove nothing",
      ).toBe(true);
      await on.untilQuiet();
      await expect(toolset).toBeVisible({ timeout: 10000 });

      await page.getByTestId(`title-${CONTROL_NAME}`).click();
      const off = watchNodeRefresh(page);
      expect(await pressToolModeShortcut(page)).toBe(true);
      await off.untilQuiet();
      await expect(toolset).toHaveCount(0, { timeout: 10000 });
    });

    await test.step("Box-select the pair and group it", async () => {
      await adjustScreenView(page);
      await boxSelect(page, ["Prompt Template", "Type Convert"]);
      const groupButton = page.getByTestId("group-node");
      await expect(groupButton).toBeVisible({ timeout: 5000 });
      await groupButton.click();

      await expect(page.getByTestId("title-Group")).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId("title-Prompt Template")).toHaveCount(0);
      await expect(page.getByTestId(`title-${CONTROL_NAME}`)).toBeVisible();
    });

    await test.step("The persisted Group carries the inner tool_mode field — the exclusion is load-bearing", async () => {
      // Polled: canvas mutations reach the backend through a debounced autosave.
      await expect
        .poll(
          async () => {
            const res = await request.get(`/api/v1/flows/${createdFlow!.id}`, {
              headers: { Authorization: createdFlow!.bearer },
            });
            if (!res.ok()) return `GET /api/v1/flows/{id} -> ${res.status()}`;
            const flow = (await res.json()) as {
              data?: {
                nodes?: Array<{
                  data?: { type?: string; node?: { template?: Record<string, unknown> } };
                }>;
              };
            };
            return (flow.data?.nodes ?? [])
              .map((n) => ({
                type: n.data?.type,
                declaresToolMode: Object.values(n.data?.node?.template ?? {}).some(
                  (field) =>
                    !!field &&
                    typeof field === "object" &&
                    (field as { tool_mode?: unknown }).tool_mode === true,
                ),
              }))
              .sort((a, b) => String(a.type).localeCompare(String(b.type)));
          },
          {
            timeout: 20000,
            message:
              "the saved flow should hold one GroupNode whose template still declares the " +
              "Prompt Template's tool_mode input; without it this test would pass vacuously",
          },
        )
        .toEqual([
          { type: "GroupNode", declaresToolMode: true },
          { type: "Prompt Template", declaresToolMode: true },
        ]);
    });

    await test.step("The Group's toolbar takes the no-Tool-Mode branch", async () => {
      await page.getByTestId("title-Group").click();
      // The Freeze button renders exactly where tool-mode-button would: seeing it
      // proves the toolbar rendered, so the absence below is a real branch choice.
      await expect(page.getByTestId("freeze-all-button-modal")).toBeVisible({
        timeout: 10000,
      });
      await expect(toolModeButton).toHaveCount(0);
    });

    await test.step("The shortcut is inert on the selected Group", async () => {
      expect(
        await pressToolModeShortcut(page),
        "pressing the Tool Mode shortcut on a Group sent a component refresh",
      ).toBe(false);
      await expect(toolset).toHaveCount(0);
      await expect(toolModeButton).toHaveCount(0);
    });
  },
);
