import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";

// §2.2 Tool Mode — edit a tool action and prove the edits persist. Exercised on
// the URL component, whose current single tool action is "Fetch Content".
//
// Rewrite (#664): the legacy spec targeted an older Tool Mode UI that exposed
// multiple URL actions and edited them through a now-removed sidebar form. On the
// current nightly the URL component exposes a SINGLE action ("Fetch Content") and
// editing happens in a redesigned grid + side panel. The multi-row checkbox
// choreography is no longer expressible (one action) and is dropped; the durable
// behaviour — edit a tool action and it persists in the editor — is kept and
// hardened (id-scoped cleanup, no arbitrary waitForTimeout, condition waits).
//
// Persistence is asserted by closing and reopening the actions editor: the edited
// slug, description and the flipped "Requires Approval" toggle are retained. The
// node's tool handle stays `tool_fetch_content` (derived from the fixed display
// name, not the editable slug — the UI exposes no editable display-name field).
//
// The Requires Approval flip commits to the frontend store on a debounce with no
// network/DOM signal to await, so the toggle is flipped LAST and given a short
// settle before the editor is closed — otherwise a rushed close races the commit
// and the flag is dropped on reopen (a real user, at human speed, never hits it).

// The slug field upper-cases its value (shown in the grid `name_1` column).
const SLUG_INPUT = "web_fetch";
const SLUG_SHOWN = "WEB_FETCH";
const SLUG_DEFAULT = "FETCH_CONTENT";
const DESC_EDIT = "custom tool description for e2e";

// Ids of flows created by the test — deleted id-scoped in afterEach (repo
// convention #490/#681; the legacy spec leaked its flow — fixed here).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Create a blank flow via the API (parallel-safe unique name), open it, and add
// the URL component from the sidebar. Returns the flow id.
async function openFlowWithUrlComponent(
  page: Page,
  request: APIRequestContext,
  bearer: string,
): Promise<string> {
  const flowId = await createFlow(
    request,
    {
      name: `Edit Tools ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      data: { nodes: [], edges: [] },
      is_component: false,
    },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });
  await addComponentFromSidebar(page, "URL", "add-component-button-url");
  await expect(
    page.getByTestId("generic-node-title-arrangement"),
  ).toBeVisible({ timeout: 15000 });
  return flowId;
}

test.describe("Edit tools (Tool Mode)", () => {
  test(
    "user can edit a URL tool action in Tool Mode and the edits persist",
    { tag: ["@stable", "@release", "@components"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);

      await test.step("open a flow with the URL component", async () => {
        await openFlowWithUrlComponent(page, request, bearer);
      });

      await test.step("switch the URL component to Tool Mode", async () => {
        await page.getByTestId("generic-node-title-arrangement").click();
        await page
          .getByTestId("tool-mode-button")
          .click({ timeout: 15000 });
        // Tool Mode exposes the component's actions as tool handles on the node.
        await expect(page.getByTestId("tool_fetch_content")).toBeVisible({
          timeout: 15000,
        });
      });

      // The action grid rows render in the ag-Grid center container.
      const gridRows = page.locator(".ag-center-cols-container [row-index]");
      const nameCell = page.locator('.ag-center-cols-container [col-id="name"]');
      const slugCell = page.locator(
        '.ag-center-cols-container [col-id="name_1"]',
      );
      const descCell = page.locator(
        '.ag-center-cols-container [col-id="description"]',
      );

      await test.step("open the actions editor — single Fetch Content action", async () => {
        await page.getByTestId("button_open_actions").click();
        await expect(gridRows).toHaveCount(1, { timeout: 15000 });
        await expect(slugCell).toHaveText(SLUG_DEFAULT);
      });

      await test.step("edit the action slug and description", async () => {
        // Open the side edit panel (double-click the name cell, offset past the
        // row selection checkbox on the cell's left edge) and edit slug +
        // description. The grid reflects each edit live, so assert the grid cells
        // update: this proves the edit committed AND settles the editor before it
        // is closed (a rushed close races the async commit and drops edits).
        await nameCell.dblclick({ position: { x: 120, y: 12 } });
        await page.getByTestId("input_update_name").fill(SLUG_INPUT);
        await expect(slugCell).toHaveText(SLUG_SHOWN, { timeout: 15000 });
        await page.getByTestId("input_update_description").fill(DESC_EDIT);
        await expect(descCell).toHaveText(DESC_EDIT, { timeout: 15000 });
        // Blur the description field before continuing: pressing Escape while a
        // panel input holds focus fires the input's own Escape handler (revert)
        // instead of closing the editor, which drops the just-made edits.
        await page.getByTestId("input_update_description").blur();
      });

      await test.step("flip Requires Approval (last, then let it settle)", async () => {
        // Flip after the slug/description edits have committed, so the two edit
        // paths do not race. Its commit is a debounced frontend write with no
        // network/DOM signal to await, so give it a fixed settle before closing —
        // a rushed close drops the flag (human-speed use never hits this).
        const approval = page.getByTestId("requires-approval-toggle").first();
        await approval.click();
        await expect(approval).toHaveAttribute("aria-checked", "true");
        await page.waitForTimeout(2500);
      });

      await test.step("close and reopen the editor — edits are retained", async () => {
        await page.keyboard.press("Escape");
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
          timeout: 5000,
        });
        await page.getByTestId("button_open_actions").click();
        await expect(slugCell).toHaveText(SLUG_SHOWN, { timeout: 15000 });
        await expect(descCell).toHaveText(DESC_EDIT);
        await expect(
          page.getByTestId("requires-approval-toggle").first(),
        ).toHaveAttribute("aria-checked", "true");
      });

      await test.step("clearing the slug reverts it to the default", async () => {
        await nameCell.dblclick({ position: { x: 120, y: 12 } });
        await page.getByTestId("input_update_name").fill("");
        await expect(slugCell).toHaveText(SLUG_DEFAULT, { timeout: 15000 });
      });
    },
  );
});
