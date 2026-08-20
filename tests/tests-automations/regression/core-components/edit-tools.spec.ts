import type { APIRequestContext, Page, Request } from "@playwright/test";
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
// Persistence is asserted twice, and the order matters. First against the flow
// document read back from the API, then against the reopened editor: the edited
// slug, description and the flipped "Requires Approval" toggle are retained. The
// node's tool handle stays `tool_fetch_content` (derived from the fixed display
// name, not the editable slug — the UI exposes no editable display-name field).
//
// #1519 — what the panel edits actually do, measured on 1.12.0.dev33. None of
// them (slug, description, Requires Approval) reach the flow while the editor is
// OPEN: at +2.5 s after the toggle flip the persisted node still reads
// `name: "fetch_content", approval_actions: []`. They are applied on editor
// CLOSE, which then fires `POST /api/v1/custom_component/update` and, ~1 s later,
// the autosave `PATCH /api/v1/flows/{id}` carrying them. The previous version of
// this spec therefore waited 2.5 s on the WRONG SIDE of the close and had no
// barrier at all between Escape and the reopen click — the window the daily
// flaked in (2026-07-30 and 2026-08-20, both in the run's flaky bucket).
//
// The race is a product defect, reproduced on demand by holding one
// `custom_component/update` response: a round trip still in flight across the
// close returns a STALE `tools_metadata` and overwrites the edits, and the
// autosave then persists the loss. Released into the ESC→reopen window it
// reproduces the daily signature exactly (reopened toggle `aria-checked="false"`,
// slug back to `FETCH_CONTENT`); released after the reopen it is worse — the UI
// keeps showing the edits while the database holds `approval_actions: []`.
//
// So this spec does two things the old one did not. It waits for the node update
// round trip to SETTLE before closing (a barrier a human user satisfies just by
// being slow, and the same request-tracking shape as
// `helpers/flows/wait-for-flow-save-settled.ts`), and it asserts the edits in the
// PERSISTED flow — before and after the reopen. That is strictly stronger than
// the old reopen-only assertion, which frontend state alone could satisfy, and it
// still FAILS if the clobber fires: the poll never sees the value, or the
// post-reopen re-read finds it gone.

// The slug field upper-cases its value (shown in the grid `name_1` column).
const SLUG_INPUT = "web_fetch";
const SLUG_SHOWN = "WEB_FETCH";
const SLUG_DEFAULT = "FETCH_CONTENT";
const DESC_EDIT = "custom tool description for e2e";

// Flipping "Requires Approval" on writes the per-action HITL decisions into the
// node's `tools_metadata[].approval_actions` — the field the backend actually
// gates on (`lfx/base/tools/component_tool.py::update_tools_metadata` copies it
// onto the tool, and `lfx/run/hitl.py` treats a non-empty list as "this action
// needs approval"). Measured as `["approve", "reject"]` on 1.12.0.dev33; the
// contract that matters is non-empty, so only membership is asserted and the
// exact set is free to grow upstream.
const APPROVAL_DECISION = "approve";

/**
 * Block until no `POST /api/v1/custom_component/update` is in flight.
 *
 * Closing the Tool Mode actions editor applies the panel edits to the node, and
 * that node then round-trips through `custom_component/update`. A round trip
 * that was issued BEFORE the edits and is still in flight when the editor closes
 * comes back carrying the pre-edit `tools_metadata`; applying it overwrites the
 * edits in the store, and the debounced autosave persists the loss (#1519 —
 * reproduced by holding one such response). Waiting the round trip out before
 * closing is what a human user does by being slow; automation has to ask.
 *
 * Tracks REQUESTS, not just responses: a request already issued whose response
 * is slow under load is exactly the case this has to cover, and a response-only
 * probe would arm its quiet timer while that request was still open — the same
 * reasoning as `helpers/flows/wait-for-flow-save-settled.ts` (#995). Kept local
 * to this spec because it has one caller; extract it to `tests/helpers/flows/`
 * (with its own `*.test.ts`) the moment a second spec needs it.
 */
async function waitForComponentUpdateSettled(
  page: Page,
  { quietMs = 700, timeout = 15000 }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const isNodeUpdate = (req: Request) =>
    req.method() === "POST" &&
    new URL(req.url()).pathname.includes("/api/v1/custom_component/update");

  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = 0;

    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(cap);
      page.off("request", onRequest);
      page.off("requestfinished", onSettled);
      page.off("requestfailed", onSettled);
      resolve();
    };

    const arm = () => {
      clearTimeout(quietTimer);
      if (inFlight === 0) quietTimer = setTimeout(finish, quietMs);
    };

    const onRequest = (req: Request) => {
      if (!isNodeUpdate(req)) return;
      inFlight++;
      clearTimeout(quietTimer);
    };

    // A request that was already open when this attached decrements below zero;
    // clamping keeps the counter honest and still re-arms the quiet window.
    const onSettled = (req: Request) => {
      if (!isNodeUpdate(req)) return;
      inFlight = Math.max(0, inFlight - 1);
      arm();
    };

    const cap = setTimeout(finish, timeout);
    page.on("request", onRequest);
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);
    arm();
  });
}

/**
 * Assert the edited action as the FLOW DOCUMENT holds it, not as the editor
 * renders it. Polls because the write lands through the editor close plus a
 * debounced autosave, so "not there yet" and "lost" look alike for ~1 s.
 *
 * Scoped to the flow this test created, and to its single URLComponent node —
 * sibling specs leave their own flows on the shared instance (#632), so a
 * global "exactly one URL node" invariant would break in the daily run. The
 * same shape as `agent-tool-name-validation.spec.ts`'s private
 * `expectPersistedToolName`; deliberately duplicated rather than extracted,
 * since sharing it would mean editing that spec's LLM agent tests too.
 */
async function expectPersistedAction(
  flowId: string,
  request: APIRequestContext,
  expected: { name: string; description: string },
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET flow ${flowId} -> ${res.status()}`;
        const flow = await res.json();
        const urlNodes = (flow.data?.nodes ?? []).filter(
          (n: { data?: { type?: string } }) => n.data?.type === "URLComponent",
        );
        if (urlNodes.length !== 1) {
          return `expected 1 URLComponent node in flow, found ${urlNodes.length}`;
        }
        const action =
          urlNodes[0]?.data?.node?.template?.tools_metadata?.value?.[0];
        if (!action) return "no tools_metadata entry on the URL node";
        // One string, so a failure reports every field at once instead of
        // stopping at the first — the three are lost together when the stale
        // update response wins, and telling them apart is the diagnosis.
        return [
          `name=${action.name}`,
          `description=${action.description}`,
          `approval=${JSON.stringify(action.approval_actions ?? [])}`,
        ].join(" ");
      },
      { timeout: 20000 },
    )
    .toMatch(
      new RegExp(
        `^name=${expected.name} ` +
          `description=${expected.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ` +
          `approval=\\[[^\\]]*"${APPROVAL_DECISION}"`,
      ),
    );
}

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
  // Quarantined at the triage of daily #1517 and un-quarantined by #1519, which
  // replaced the fixed settle with the two barriers above and added the
  // persisted-flow assertions.
  test(
    "user can edit a URL tool action in Tool Mode and the edits persist",
    { tag: ["@stable", "@release", "@components"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      let flowId = "";

      await test.step("open a flow with the URL component", async () => {
        flowId = await openFlowWithUrlComponent(page, request, bearer);
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

      await test.step("flip Requires Approval last", async () => {
        // Flip after the slug/description edits, so the two edit paths do not
        // race. The panel reflects it immediately; nothing has reached the flow
        // yet — every panel edit is applied on editor close (#1519).
        const approval = page.getByTestId("requires-approval-toggle").first();
        await approval.click();
        await expect(approval).toHaveAttribute("aria-checked", "true");
      });

      await test.step("let the node update round trip settle before closing", async () => {
        // The barrier that replaces the old fixed 2.5 s wait, and it sits on the
        // other side of it: a `custom_component/update` still in flight when the
        // editor closes comes back with the PRE-EDIT tools_metadata and
        // overwrites everything just typed (#1519).
        await waitForComponentUpdateSettled(page);
      });

      await test.step("close the editor", async () => {
        await page.keyboard.press("Escape");
        await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
          timeout: 5000,
        });
      });

      await test.step("the edits reached the persisted flow", async () => {
        // Backend truth, and the deterministic observable the reopen needs: the
        // close is what applies the edits, so this is the first moment they
        // exist anywhere but the panel.
        await expectPersistedAction(flowId, request, {
          name: SLUG_INPUT,
          description: DESC_EDIT,
        });
      });

      await test.step("reopen the editor — edits are retained", async () => {
        await page.getByTestId("button_open_actions").click();
        await expect(slugCell).toHaveText(SLUG_SHOWN, { timeout: 15000 });
        await expect(descCell).toHaveText(DESC_EDIT);
        await expect(
          page.getByTestId("requires-approval-toggle").first(),
        ).toHaveAttribute("aria-checked", "true");
      });

      await test.step("the reopen did not clobber the persisted edits", async () => {
        // The nastier half of #1519: a stale update response landing AFTER the
        // reopen leaves the editor showing the edits while the flow document has
        // already lost them. Re-reading is the only way to see it.
        await expectPersistedAction(flowId, request, {
          name: SLUG_INPUT,
          description: DESC_EDIT,
        });
      });

      await test.step("clearing the slug reverts it to the default", async () => {
        await nameCell.dblclick({ position: { x: 120, y: 12 } });
        await page.getByTestId("input_update_name").fill("");
        await expect(slugCell).toHaveText(SLUG_DEFAULT, { timeout: 15000 });
      });
    },
  );
});
