import type { APIRequestContext, Page, Response } from "@playwright/test";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  buildCatalogFlow,
  type CatalogNodeSpec,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";

// Multi-edit safety (upstream #14903 / #15824): when another session saved first, the
// open editor raises a banner and a "Review Version Changes" dialog.
// Spec doc: docs/flow-functionality/multi-edit/multi-edit-conflict-review.md
//
// The other session is an API write through the test's own request context, as in
// upstream's own specs: an in-page fetch would be THIS session, and a second canvas
// would only add a 5 s debounce in front of the same PATCH.
test.describe("Multi-edit safety — conflict banner and review dialog", () => {
  const CHAT_INPUT = "ChatInput-ci001";
  const CHAT_OUTPUT = "ChatOutput-co001";
  const DOOMED = "PromptTemplate-rm001";
  const MINE = "PromptTemplate-aa001";
  const ARRIVED = "PromptTemplate-ad001";
  const THEIR_TEXT = "from the other session";

  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  function baseNodes(chatText: string): CatalogNodeSpec[] {
    return [
      { id: CHAT_INPUT, type: "ChatInput", values: { input_value: chatText } },
      { id: CHAT_OUTPUT, type: "ChatOutput" },
      { id: DOOMED, type: "Prompt Template", displayName: "Doomed Prompt" },
      { id: MINE, type: "Prompt Template", displayName: "Mine Prompt" },
    ];
  }

  async function setup(request: APIRequestContext) {
    const headers = { Authorization: await getAuthToken(request) };
    const catalog = await fetchComponentCatalog(request, headers);
    const flowId = await createFlow(
      request,
      {
        name: `multi-edit-conflict-review ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        data: buildCatalogFlow(catalog, { nodes: baseNodes("hello"), edges: [] }),
        is_component: false,
      },
      { headers },
    );
    createdFlowIds.push(flowId);
    return { headers, catalog, flowId };
  }

  /**
   * Another session saves the flow: rebuilds the graph from the catalog, keeps every
   * surviving node where the server has it unless `moved` says otherwise, and PATCHes
   * it with no If-Match.
   */
  async function writeFromAnotherSession(
    request: APIRequestContext,
    ctx: { headers: Record<string, string>; catalog: Record<string, unknown>; flowId: string },
    change: {
      nodes: CatalogNodeSpec[];
      edges?: Parameters<typeof buildCatalogFlow>[1]["edges"];
      moved?: string[];
    },
  ) {
    const current = await (
      await request.get(`/api/v1/flows/${ctx.flowId}`, { headers: ctx.headers })
    ).json();
    const positions = new Map<string, { x: number; y: number }>(
      current.data.nodes.map((n: { id: string; position: { x: number; y: number } }) => [
        n.id,
        n.position,
      ]),
    );
    const next = buildCatalogFlow(ctx.catalog, { nodes: change.nodes, edges: change.edges ?? [] });
    for (const node of next.nodes) {
      const at = positions.get(node.id) ?? { x: 1400, y: 900 };
      node.position = change.moved?.includes(node.id) ? { x: at.x + 220, y: at.y + 160 } : at;
    }
    const res = await request.patch(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
      data: { data: next },
    });
    expect(res.status(), "the other session's save must succeed").toBe(200);
    return next;
  }

  function isFlowPatch(flowId: string) {
    return (r: Response) =>
      r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/flows/${flowId}`;
  }

  function recordFlowPatches(page: Page, flowId: string): number[] {
    const statuses: number[] = [];
    const match = isFlowPatch(flowId);
    page.on("response", (r) => {
      if (match(r)) statuses.push(r.status());
    });
    return statuses;
  }

  async function dragNode(page: Page, nodeId: string, dx: number, dy: number) {
    const node = page.locator(`[data-id="${nodeId}"]`);
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    expect(box, `node ${nodeId} has no bounding box`).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + 10 + dy, { steps: 10 });
    await page.mouse.up();
  }

  /** Drags a node and waits for the autosave it causes; returns that save's status. */
  async function dragAndAutosave(page: Page, flowId: string, nodeId: string, dx: number) {
    const saved = page.waitForResponse(isFlowPatch(flowId), { timeout: 30_000 });
    await dragNode(page, nodeId, dx, 60);
    return (await saved).status();
  }

  async function browseVersionHistory(page: Page, flowId: string) {
    const listed = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        new URL(r.url()).pathname === `/api/v1/flows/${flowId}/versions/`,
    );
    await page.getByTestId("sidebar-nav-versions").click();
    expect((await listed).status()).toBe(200);
    await page.getByTestId("sidebar-nav-components").click();
  }

  test(
    "a refused save raises the banner and the dialog lists every kind of incoming change",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      (page as PageWithErrorHooks).expectKnownHttpError({
        pathname: `/api/v1/flows/${ctx.flowId}`,
        status: 409,
        reason:
          "#2342: the editor's own autosave is refused because another session saved first — " +
          "the mechanism this spec exists to observe",
      });
      await openFlowById(page, ctx.flowId);

      const theirs = await test.step("another session adds, removes, edits, moves and links", async () =>
        writeFromAnotherSession(request, ctx, {
          nodes: [
            { id: CHAT_INPUT, type: "ChatInput", values: { input_value: THEIR_TEXT } },
            { id: CHAT_OUTPUT, type: "ChatOutput" },
            { id: ARRIVED, type: "Prompt Template", displayName: "Arrived Prompt" },
            { id: MINE, type: "Prompt Template", displayName: "Mine Prompt" },
          ],
          edges: [
            { source: CHAT_INPUT, output: "message", target: CHAT_OUTPUT, field: "input_value" },
          ],
          moved: [CHAT_INPUT, CHAT_OUTPUT],
        }),
      );

      await test.step("the viewer moves its own node and that autosave is refused with 409", async () => {
        expect(await dragAndAutosave(page, ctx.flowId, MINE, 40)).toBe(409);
      });

      await test.step("the banner says a newer version exists", async () => {
        const banner = page.getByTestId("flow-conflict-banner");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText("A newer version of this flow is available");
        await expect(banner).toContainText("Review changes before saving.");
        await expect(page.getByTestId("flow-conflict-frame")).toBeAttached();
      });

      const dialog = page.getByRole("dialog");

      await test.step("Review changes opens Review Version Changes", async () => {
        await page.getByTestId("flow-conflict-review-button").click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Review Version Changes");
        await expect(dialog).toContainText("Available changes");
      });

      const row = (side: "mine" | "theirs", key: string) =>
        dialog.getByTestId(`conflict-change-${side}-${key}`);

      await test.step("each incoming change is listed with its badge and sentence", async () => {
        await expect(row("theirs", `node:${ARRIVED}`)).toContainText("Arrived Prompt");
        await expect(row("theirs", `node:${ARRIVED}`)).toContainText("Added");
        await expect(row("theirs", `node:${ARRIVED}`).getByRole("listitem")).toHaveText([
          "New node added to the flow.",
        ]);

        await expect(row("theirs", `node:${DOOMED}`)).toContainText("Doomed Prompt");
        await expect(row("theirs", `node:${DOOMED}`)).toContainText("Removed");
        await expect(row("theirs", `node:${DOOMED}`).getByRole("listitem")).toHaveText([
          "Node removed from the flow.",
        ]);

        // A move and a field change on one component share one row.
        await expect(row("theirs", `node:${CHAT_INPUT}`)).toContainText("Modified");
        await expect(row("theirs", `node:${CHAT_INPUT}`).getByRole("listitem")).toHaveText([
          "Moved on the canvas.",
          `Input Text updated from hello to ${THEIR_TEXT}.`,
        ]);

        await expect(row("theirs", `node:${CHAT_OUTPUT}`)).toContainText("Modified");
        await expect(row("theirs", `node:${CHAT_OUTPUT}`).getByRole("listitem")).toHaveText([
          "Moved on the canvas.",
        ]);

        const edgeRow = row("theirs", `edge:${theirs.edges[0].id}`);
        await expect(edgeRow).toContainText("Added");
        await expect(edgeRow.getByRole("listitem")).toHaveText([
          "Chat Input to Chat Output link added.",
        ]);
      });

      await test.step("nothing else is listed, and the viewer's own move is under Your changes", async () => {
        await expect(dialog.locator('[data-testid^="conflict-change-theirs-"]')).toHaveCount(5);
        await expect(dialog.locator('[data-testid^="conflict-change-mine-"]')).toHaveCount(1);
        await expect(row("mine", `node:${MINE}`).getByRole("listitem")).toHaveText([
          "Moved on the canvas.",
        ]);
      });
    },
  );

  test(
    "a flow only the viewer edits never shows the banner across autosaves and version history",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const { flowId } = await setup(request);
      await openFlowById(page, flowId);
      const statuses = recordFlowPatches(page, flowId);

      await test.step("three edits, each autosaved with 200", async () => {
        for (const dx of [40, 80, 120]) {
          expect(await dragAndAutosave(page, flowId, MINE, dx)).toBe(200);
        }
      });

      await test.step("open version history and return to the components panel", async () => {
        await browseVersionHistory(page, flowId);
      });

      await test.step("one more edit still saves with 200 and no banner ever appeared", async () => {
        expect(await dragAndAutosave(page, flowId, MINE, 160)).toBe(200);
        expect(statuses.length).toBeGreaterThanOrEqual(4);
        expect(statuses.filter((s) => s !== 200), `PATCH statuses: ${statuses}`).toEqual([]);
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
        await expect(page.getByTestId("flow-conflict-frame")).toHaveCount(0);
      });
    },
  );

  test(
    "browsing version history is not an edit: a newer version is adopted on run, without a banner",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      const me = await (await request.get("/api/v1/users/whoami", { headers: ctx.headers })).json();
      await openFlowById(page, ctx.flowId);
      const statuses = recordFlowPatches(page, ctx.flowId);

      await test.step("open version history and return, without editing", async () => {
        await browseVersionHistory(page, ctx.flowId);
      });

      await test.step("another session changes Chat Input's text", async () => {
        await writeFromAnotherSession(request, ctx, {
          nodes: baseNodes(THEIR_TEXT),
        });
      });

      await test.step("running adopts the newer version with a notice and raises no banner", async () => {
        const checked = page.waitForResponse(
          (r) => new URL(r.url()).pathname === `/api/v1/flows/${ctx.flowId}/version-state`,
        );
        await page.getByTestId("button_run_chat output").click();
        expect((await checked).status()).toBe(200);
        await expect(
          page.getByText(
            `${me.username} updated this flow. The canvas now shows the latest version — run again to execute it.`,
          ),
        ).toBeVisible();
        await expect(
          page.locator(`[data-id="${CHAT_INPUT}"]`).getByTestId("textarea_str_input_value"),
        ).toHaveValue(THEIR_TEXT);
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
      });

      await test.step("the viewer never saved: browsing history wrote nothing", async () => {
        expect(statuses, `PATCH statuses: ${statuses}`).toEqual([]);
      });
    },
  );

  test(
    "reloading with no change on the server shows no banner",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const { flowId } = await setup(request);
      await openFlowById(page, flowId);

      await test.step("reload the editor", async () => {
        await page.reload();
        await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({ timeout: 100_000 });
      });

      await test.step("an edit after the reload saves with 200 and no banner appears", async () => {
        expect(await dragAndAutosave(page, flowId, MINE, 40)).toBe(200);
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
        await expect(page.getByTestId("flow-conflict-frame")).toHaveCount(0);
      });
    },
  );
});
