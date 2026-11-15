import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type CatalogFlowSpec,
  createCatalogFlow,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

// One trigger per flow on the canvas: the palette, paste, duplicate and grouping (#2450).
// Spec doc: docs/core-functionality/integrations/trigger-placement.md
//
// Every trigger answers to the placement key `@trigger` besides its own type, and
// `@trigger` is a singleton (`componentConstraints.ts`). So with one trigger on the
// canvas the sidebar disables every other trigger row and paste drops a copied
// trigger. The server half of the rule is `api/triggers/api-triggers-one-per-flow.spec.ts`.
//
// A row also reads as unavailable — `cursor-not-allowed`, no add button,
// `draggable="false"` — while the permissions request is in flight (#2197). So a
// blocked row is only the rule's when the palette has settled, which each test
// waits for on a non-trigger row first, and the tooltip's exact sentence is what
// names the reason.
//
// Flows are created through the API with spaced nodes: nodes added one after the
// other from the sidebar land on the same spot and cover each other's titles.
test.describe("Triggers on the canvas — one per flow", () => {
  // First tag carrying the sidebar trigger mark (upstream #16278); the placement
  // rule itself is older. The 1.13.x lines ship ENABLE_TRIGGERS = false.
  const CANVAS_SINCE = "1.14.0.dev23";
  const ONE_TRIGGER = "This flow already has a trigger. A flow has one trigger.";
  const PASTE_NOTICE = "A flow has one trigger, so the pasted trigger was left out.";

  const SCHEDULE_ROW = "triggers_schedule_draggable";
  const INBOUND_ROW = "triggers_inbound webhook_draggable";
  const GMAIL_ROW = "google_gmail: on message_draggable";
  const LEGACY_WEBHOOK_ROW = "input_output_webhook_draggable";
  const CHAT_OUTPUT_ROW = "input_output_chat output_draggable";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let headers: Record<string, string> = {};

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, CANVAS_SINCE)),
      `the trigger palette ships in ${CANVAS_SINCE} (upstream #16278); this build does not carry it`,
    );
    headers = { Authorization: await getAuthToken(request) };
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor first, so a pending autosave does not 404 into the log.
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  async function createFlow(request: APIRequestContext, label: string, spec: CatalogFlowSpec): Promise<string> {
    const catalog = await fetchComponentCatalog(request, headers);
    const id = await createCatalogFlow(request, catalog, spec, {
      name: `E2E trigger placement ${label} ${run}`,
      headers,
    });
    flowIds.push(id);
    return id;
  }

  const nodes = (page: Page) => page.locator(".react-flow__node");
  const nodesOf = (page: Page, prefix: string) => page.locator(`.react-flow__node[data-id^="${prefix}-"]`);
  const row = (page: Page, testId: string) => page.getByTestId(testId);
  /** The row's own add target: `role=button`, keyboard-focusable, and the drag source. */
  const rowButton = (page: Page, testId: string) => row(page, testId).locator('div[role="button"]');
  const addButton = (page: Page, testId: string) => row(page, testId).locator('[data-testid^="add-component-button-"]');
  const notice = (page: Page) => page.getByRole("status").getByText(PASTE_NOTICE, { exact: true });

  async function search(page: Page, term: string): Promise<void> {
    await page.getByTestId("sidebar-search-input").fill(term);
  }

  /** Opens the flow, fits it to the screen and waits until the palette has settled. */
  async function openFlow(page: Page, flowId: string, nodeCount: number): Promise<void> {
    await openFlowById(page, flowId);
    await expect(nodes(page)).toHaveCount(nodeCount);
    // A box selection only commits on a fitted canvas (#2182's auto-pan trap).
    await adjustScreenView(page);
    await search(page, "chat output");
    await expect(
      rowButton(page, CHAT_OUTPUT_ROW),
      "the palette has settled: a non-trigger row is draggable (#2197)",
    ).toHaveAttribute("draggable", "true");
  }

  /** A point on the pane, as a fraction of its box — used to paste and drop away from the nodes. */
  async function panePoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
    const box = await page.locator(".react-flow__pane").boundingBox();
    expect(box, "the pane is laid out").not.toBeNull();
    const pane = box as { x: number; y: number; width: number; height: number };
    return { x: pane.x + pane.width * fx, y: pane.y + pane.height * fy };
  }

  /** Shift-drag a box around every node (Ctrl/Meta-click selection fails on a macOS host). */
  async function boxSelectAll(page: Page): Promise<void> {
    const count = await nodes(page).count();
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    const boxes = [];
    for (const node of await nodes(page).all()) {
      const box = await node.boundingBox();
      if (box) boxes.push(box);
    }
    const margin = 40;
    const left = Math.min(...boxes.map((b) => b.x)) - margin;
    const top = Math.min(...boxes.map((b) => b.y)) - margin;
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + margin;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + margin;
    await page.keyboard.down("Shift");
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.locator(".react-flow__node.selected"), "the box selected every node").toHaveCount(count);
  }

  /** The row is the rule's to block: no add button, not-allowed, and not draggable. */
  async function expectBlocked(page: Page, term: string, testId: string): Promise<void> {
    await search(page, term);
    await expect(row(page, testId)).toBeVisible();
    await expect(addButton(page, testId), `${testId} offers no add button`).toHaveCount(0);
    await expect(row(page, testId)).toHaveClass(/cursor-not-allowed/);
    await expect(rowButton(page, testId)).toHaveAttribute("draggable", "false");
  }

  /**
   * The tooltip a blocked row shows on hover, closed again in steps (the content is
   * hoverable). The row's name has a tooltip of its own that opens alongside, so the
   * reason is matched by its exact text rather than as the only tooltip.
   */
  async function expectBlockedTooltip(page: Page, testId: string): Promise<void> {
    const reason = page.getByRole("tooltip", { name: ONE_TRIGGER, exact: true });
    await row(page, testId).hover();
    await expect(reason, "hovering the blocked row explains why").toHaveCount(1);
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(reason).toHaveCount(0);
  }

  async function expectNoGrip(page: Page): Promise<void> {
    const visibleRows = page.locator('[data-testid$="_draggable"]:visible');
    expect(await visibleRows.count(), "the search shows rows to inspect").toBeGreaterThan(0);
    await expect(visibleRows.locator('[data-testid="icon-GripVertical"]'), "no row carries a drag grip").toHaveCount(0);
  }

  async function expectMarkedTrigger(page: Page, term: string, testId: string, inTriggers: boolean): Promise<void> {
    await search(page, term);
    await expect(row(page, testId)).toBeVisible();
    await expect(row(page, testId).getByTestId("sidebar-trigger-icon"), `${testId} carries the trigger mark`).toHaveCount(1);
    if (inTriggers) {
      const triggersCategory = page
        .locator('[data-sidebar="menu-item"]')
        .filter({ has: page.getByTestId("disclosure-triggers") });
      await expect(triggersCategory.getByTestId(testId), `${testId} sits in the Triggers category`).toBeVisible();
    }
    await expectNoGrip(page);
  }

  test(
    "the Triggers category holds Schedule and Inbound Webhook, and every trigger row is marked apart from the actions",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "marks", {
        nodes: [{ id: "ChatOutput-tp01", type: "ChatOutput" }],
        edges: [],
      });
      await openFlow(page, flowId, 1);

      await test.step("Schedule is in Triggers and carries the trigger mark", async () => {
        await expectMarkedTrigger(page, "schedule", SCHEDULE_ROW, true);
      });

      await test.step("Inbound Webhook is in Triggers and carries the trigger mark", async () => {
        await expectMarkedTrigger(page, "inbound webhook", INBOUND_ROW, true);
      });

      await test.step("a provider trigger (Gmail: On message) carries the trigger mark", async () => {
        await expectMarkedTrigger(page, "gmail on", GMAIL_ROW, false);
      });

      await test.step("an action row (Chat Output) carries no trigger mark", async () => {
        await search(page, "chat output");
        await expect(row(page, CHAT_OUTPUT_ROW)).toBeVisible();
        await expect(row(page, CHAT_OUTPUT_ROW).getByTestId("sidebar-trigger-icon")).toHaveCount(0);
        await expectNoGrip(page);
      });
    },
  );

  test(
    "with a trigger on the canvas every other trigger is blocked in the palette, and removing it unblocks them",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "blocked", {
        nodes: [{ id: "ScheduleTrigger-tp02", type: "ScheduleTrigger" }],
        edges: [],
      });
      await openFlow(page, flowId, 1);

      await test.step("core and provider trigger rows are blocked", async () => {
        await expectBlocked(page, "inbound webhook", INBOUND_ROW);
        await expectBlocked(page, "schedule", SCHEDULE_ROW);
        await expectBlocked(page, "gmail on", GMAIL_ROW);
      });

      await test.step("hovering a blocked row says why", async () => {
        await search(page, "inbound webhook");
        await expectBlockedTooltip(page, INBOUND_ROW);
      });

      await test.step("neither a drag nor the keyboard adds a blocked trigger", async () => {
        const drop = await panePoint(page, 0.2, 0.8);
        await rowButton(page, INBOUND_ROW).dragTo(page.locator(".react-flow__pane"), {
          targetPosition: await relativeToPane(page, drop),
        });
        await rowButton(page, INBOUND_ROW).focus();
        await page.keyboard.press("Enter");
        await expect(nodes(page)).toHaveCount(1);
      });

      await test.step("the legacy Webhook is not a trigger: it stays addable, and a drag adds it", async () => {
        await search(page, "webhook");
        await expect(addButton(page, LEGACY_WEBHOOK_ROW)).toHaveCount(1);
        const drop = await panePoint(page, 0.2, 0.8);
        await rowButton(page, LEGACY_WEBHOOK_ROW).dragTo(page.locator(".react-flow__pane"), {
          targetPosition: await relativeToPane(page, drop),
        });
        // Exactly two: the drag works on this palette, and the blocked attempts above
        // added nothing, however late.
        await expect(nodes(page)).toHaveCount(2);
        await expect(nodesOf(page, "Webhook")).toHaveCount(1);
      });

      await test.step("deleting the trigger unblocks the rows, and the keyboard then adds one", async () => {
        await page.getByTestId("title-Schedule").click();
        await page.keyboard.press("Delete");
        await expect(nodesOf(page, "ScheduleTrigger")).toHaveCount(0);
        await expect(nodes(page)).toHaveCount(1);
        await search(page, "inbound webhook");
        await expect(addButton(page, INBOUND_ROW), "the Inbound Webhook row has its add button back").toHaveCount(1);
        await rowButton(page, INBOUND_ROW).focus();
        await page.keyboard.press("Enter");
        await expect(nodesOf(page, "InboundWebhookTrigger")).toHaveCount(1);
        await expect(nodes(page)).toHaveCount(2);
      });
    },
  );

  test(
    "pasting or duplicating a trigger leaves it out with a notice, and keeps the rest of the selection",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "paste", {
        nodes: [
          { id: "ScheduleTrigger-tp03", type: "ScheduleTrigger" },
          { id: "ChatOutput-tp03", type: "ChatOutput" },
        ],
        edges: [],
      });
      await openFlow(page, flowId, 2);

      await test.step("a copied trigger pasted alone adds nothing, and says so", async () => {
        await page.getByTestId("title-Schedule").click();
        await page.keyboard.press("ControlOrMeta+c");
        const spot = await panePoint(page, 0.25, 0.8);
        await page.mouse.move(spot.x, spot.y);
        await page.keyboard.press("ControlOrMeta+v");
        // The notice is raised by the same paste that drops the trigger, so once it
        // shows, the node set is final.
        await expect(notice(page)).toBeVisible();
        await expect(nodes(page)).toHaveCount(2);
        await expect(nodesOf(page, "ScheduleTrigger")).toHaveCount(1);
      });

      await test.step("a selection with a trigger and another node pastes the other node only", async () => {
        await expect(notice(page), "the previous notice has left").toHaveCount(0, { timeout: 20_000 });
        await boxSelectAll(page);
        await page.keyboard.press("ControlOrMeta+c");
        const spot = await panePoint(page, 0.75, 0.8);
        await page.mouse.move(spot.x, spot.y);
        await page.keyboard.press("ControlOrMeta+v");
        await expect(notice(page)).toBeVisible();
        await expect(nodesOf(page, "ChatOutput"), "the Chat Output is pasted").toHaveCount(2);
        await expect(nodesOf(page, "ScheduleTrigger"), "the trigger is not").toHaveCount(1);
        await expect(nodes(page)).toHaveCount(3);
      });

      await test.step("duplicating the trigger adds nothing, and says so", async () => {
        await expect(notice(page), "the previous notice has left").toHaveCount(0, { timeout: 20_000 });
        await page.getByTestId("title-Schedule").click();
        await page.keyboard.press("ControlOrMeta+d");
        await expect(notice(page)).toBeVisible();
        await expect(nodesOf(page, "ScheduleTrigger")).toHaveCount(1);
        await expect(nodes(page)).toHaveCount(3);
      });
    },
  );

  test(
    "grouping a trigger keeps it under the one-trigger rule",
    { tag: ["@regression", "@components", "@integrations"] },
    async ({ page, request }) => {
      const SCHEDULE = "ScheduleTrigger-tp04";
      const flowId = await createFlow(request, "group", {
        nodes: [
          { id: SCHEDULE, type: "ScheduleTrigger" },
          { id: "ParserComponent-tp04", type: "ParserComponent" },
        ],
        edges: [{ source: SCHEDULE, output: "trigger_event", target: "ParserComponent-tp04", field: "input_data" }],
      });

      const triggerRow = async () => {
        const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const rows = JSON.parse(text) as Array<{ id: string; state: string; reason: string | null }>;
        expect(rows, `the flow has one trigger row: ${text}`).toHaveLength(1);
        return rows[0];
      };

      await test.step("the schedule is enabled and reads active", async () => {
        const { id } = await triggerRow();
        const res = await request.post(`/api/v1/triggers/${id}/enable`, { headers });
        expect(res.status(), await res.text()).toBe(200);
        expect((await triggerRow()).state).toBe("active");
      });

      await openFlow(page, flowId, 2);

      await test.step("both nodes are selected and grouped — or the grouping is refused", async () => {
        await boxSelectAll(page);
        const group = page.getByTestId("group-node");
        const refused = page.getByTestId("error-group-node");
        await expect(group.or(refused)).toBeVisible();
        if (await refused.isVisible()) return;
        await group.click({ force: true });
        await expect(page.getByTestId("title-Group")).toBeVisible();
        // The autosave carries the group to the server, which reconciles the
        // trigger rows inside that same request (`flows_helpers.py`).
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
              const flow = (await res.json()) as { data: { nodes: Array<{ data: { node?: { flow?: unknown } } }> } };
              return flow.data.nodes.some((node) => Boolean(node.data.node?.flow));
            },
            { message: "the stored flow holds the Group node", timeout: 30_000 },
          )
          .toBe(true);
      });

      // DECLARED FAILING from here on: LE-3453. Grouping hides the trigger from
      // both counters (the palette's and `find_trigger_nodes`, top-level only), so
      // the row is paused as `node_removed` and a second trigger becomes addable.
      // Everything above runs undeclared, so a broken setup still reddens the test.
      // The day the fix ships this body passes, Playwright reports "expected to
      // fail, but passed", and that is the signal to delete this line.
      test.fail(true, "LE-3453: grouping a trigger pauses it and lifts the one-trigger rule");

      await test.step("the trigger is still active", async () => {
        const after = await triggerRow();
        expect(after.reason, "the grouped trigger is not taken for a removed node").not.toBe("node_removed");
        expect(after.state).toBe("active");
      });

      await test.step("the palette still blocks a second trigger", async () => {
        await expectBlocked(page, "inbound webhook", INBOUND_ROW);
        await expectBlockedTooltip(page, INBOUND_ROW);
      });
    },
  );

  /** `dragTo`'s `targetPosition` is relative to the target's box. */
  async function relativeToPane(page: Page, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
    const box = (await page.locator(".react-flow__pane").boundingBox()) as { x: number; y: number };
    return { x: point.x - box.x, y: point.y - box.y };
  }
});
