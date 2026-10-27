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

// Multi-edit safety (upstream #14903 / #15824): each exit of the "Review Version Changes"
// dialog promises where the viewer's work ends up, and every promise is checked on the
// server, not only in the toast.
// Spec doc: docs/flow-functionality/multi-edit/multi-edit-conflict-exits.md
test.describe("Multi-edit safety — the conflict dialog's exits", () => {
  const CHAT_INPUT = "ChatInput-ci001";
  const CHAT_OUTPUT = "ChatOutput-co001";
  const MINE = "PromptTemplate-aa001";
  const THEIR_TEXT = "their text";
  const THEIR_SECOND_TEXT = "their second text";

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

  type FlowNode = {
    id: string;
    position: { x: number; y: number };
    data: { node: { template: Record<string, { value?: unknown }> } };
  };
  type FlowData = { nodes: FlowNode[] };
  type Ctx = {
    headers: Record<string, string>;
    catalog: Record<string, unknown>;
    flowId: string;
    name: string;
    mineStart: { x: number; y: number };
  };

  function nodes(chatText: string): CatalogNodeSpec[] {
    return [
      { id: CHAT_INPUT, type: "ChatInput", values: { input_value: chatText } },
      { id: CHAT_OUTPUT, type: "ChatOutput" },
      { id: MINE, type: "Prompt Template", displayName: "Mine Prompt" },
    ];
  }

  const chatText = (data: FlowData) =>
    data.nodes.find((n) => n.id === CHAT_INPUT)?.data.node.template.input_value.value;
  const minePosition = (data: FlowData) => data.nodes.find((n) => n.id === MINE)?.position;

  async function getFlow(request: APIRequestContext, ctx: Ctx, flowId = ctx.flowId) {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers: ctx.headers });
    expect(res.status()).toBe(200);
    return (await res.json()) as { name: string; version_token: string; data: FlowData };
  }

  async function listVersions(request: APIRequestContext, ctx: Ctx) {
    const res = await request.get(`/api/v1/flows/${ctx.flowId}/versions/`, {
      headers: ctx.headers,
    });
    expect(res.status()).toBe(200);
    return ((await res.json()).entries ?? []) as { id: string; description: string }[];
  }

  async function versionData(request: APIRequestContext, ctx: Ctx, versionId: string) {
    const res = await request.get(`/api/v1/flows/${ctx.flowId}/versions/${versionId}`, {
      headers: ctx.headers,
    });
    expect(res.status()).toBe(200);
    return (await res.json()).data as FlowData;
  }

  /** Another session saves Chat Input with `text`, keeping every node where the server has it. */
  async function writeFromAnotherSession(request: APIRequestContext, ctx: Ctx, text: string) {
    const current = await getFlow(request, ctx);
    const positions = new Map(current.data.nodes.map((n) => [n.id, n.position]));
    const next = buildCatalogFlow(ctx.catalog, { nodes: nodes(text), edges: [] });
    for (const node of next.nodes) node.position = positions.get(node.id) ?? node.position;
    const res = await request.patch(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
      data: { data: next },
    });
    expect(res.status(), "the other session's save must succeed").toBe(200);
  }

  function isFlowPatch(flowId: string) {
    return (r: Response) =>
      r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/flows/${flowId}`;
  }

  function isFlowPost(flowId: string, suffix: string) {
    return (r: Response) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/flows/${flowId}${suffix}`;
  }

  async function dragAndAutosave(page: Page, flowId: string, dx: number) {
    const saved = page.waitForResponse(isFlowPatch(flowId), { timeout: 30_000 });
    const node = page.locator(`[data-id="${MINE}"]`);
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    expect(box, `node ${MINE} has no bounding box`).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + 70, { steps: 10 });
    await page.mouse.up();
    return (await saved).status();
  }

  /**
   * Builds the flow, opens it, has another session change Chat Input, makes the viewer's
   * own autosave fail with 409, and opens the review dialog.
   */
  async function raiseConflict(page: Page, request: APIRequestContext): Promise<Ctx> {
    const headers = { Authorization: await getAuthToken(request) };
    const catalog = await fetchComponentCatalog(request, headers);
    const name = `multi-edit-conflict-exits ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const flowId = await createFlow(
      request,
      {
        name,
        data: buildCatalogFlow(catalog, { nodes: nodes("hello"), edges: [] }),
        is_component: false,
      },
      { headers },
    );
    createdFlowIds.push(flowId);
    const ctx: Ctx = { headers, catalog, flowId, name, mineStart: { x: 0, y: 0 } };
    ctx.mineStart = minePosition((await getFlow(request, ctx)).data)!;

    (page as PageWithErrorHooks).expectKnownHttpError({
      pathname: `/api/v1/flows/${flowId}`,
      status: 409,
      reason:
        "#2343: the editor's own autosave is refused because another session saved first — " +
        "the conflict every exit in this spec starts from",
    });

    await test.step("raise the conflict and open Review Version Changes", async () => {
      await openFlowById(page, flowId);
      await writeFromAnotherSession(request, ctx, THEIR_TEXT);
      expect(await dragAndAutosave(page, flowId, 40)).toBe(409);
      await expect(page.getByTestId("flow-conflict-banner")).toBeVisible();
      await page.getByTestId("flow-conflict-review-button").click();
      await expect(page.getByRole("dialog")).toContainText("Review Version Changes");
    });

    return ctx;
  }

  test(
    "Update Current Flow writes the viewer's work and keeps the replaced version",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await raiseConflict(page, request);

      await test.step("Update Current Flow overwrites with 200 and says so", async () => {
        const overwritten = page.waitForResponse(isFlowPost(ctx.flowId, "/overwrite"));
        await page.getByTestId("confirm-overwrite-flow").click();
        expect((await overwritten).status()).toBe(200);
        await expect(
          page.getByText("Flow updated. The version it replaced is in the history."),
        ).toBeVisible();
      });

      await test.step("the server holds the viewer's canvas", async () => {
        const flow = await getFlow(request, ctx);
        expect(minePosition(flow.data)).not.toEqual(ctx.mineStart);
        expect(chatText(flow.data)).toBe("hello");
      });

      await test.step("the replaced version is the one history entry", async () => {
        const entries = await listVersions(request, ctx);
        expect(entries.map((e) => e.description)).toEqual(["Replaced by a newer edit"]);
        expect(chatText(await versionData(request, ctx, entries[0].id))).toBe(THEIR_TEXT);
      });

      await test.step("the banner is gone", async () => {
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
      });
    },
  );

  test(
    "Duplicate Flow puts the viewer's work in a new flow and leaves the original alone",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await raiseConflict(page, request);
      const before = await getFlow(request, ctx);

      const originalPatches: number[] = [];

      const copyId = await test.step("Duplicate Flow forks with 201 and opens the copy", async () => {
        page.on("response", (r) => {
          if (isFlowPatch(ctx.flowId)(r)) originalPatches.push(r.status());
        });
        const forked = page.waitForResponse(isFlowPost(ctx.flowId, "/fork"));
        await page.getByTestId("confirm-duplicate-flow").click();
        const res = await forked;
        expect(res.status()).toBe(201);
        const id = (await res.json()).id as string;
        createdFlowIds.push(id);
        await expect(page).toHaveURL(new RegExp(`/flow/${id}`));
        await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({ timeout: 60_000 });
        return id;
      });

      await test.step("the copy holds the viewer's canvas under '<name> (copy)'", async () => {
        const copy = await getFlow(request, ctx, copyId);
        expect(copy.name).toBe(`${ctx.name} (copy)`);
        expect(minePosition(copy.data)).not.toEqual(ctx.mineStart);
        expect(chatText(copy.data)).toBe("hello");
      });

      await test.step("an edit on the copy saves to the copy, and nothing was sent to the original", async () => {
        expect(await dragAndAutosave(page, copyId, 60)).toBe(200);
        expect(originalPatches, `PATCHes to the original: ${originalPatches}`).toEqual([]);
      });

      await test.step("the original is unchanged", async () => {
        const after = await getFlow(request, ctx);
        expect(after.version_token).toBe(before.version_token);
        expect(chatText(after.data)).toBe(THEIR_TEXT);
        expect(minePosition(after.data)).toEqual(ctx.mineStart);
      });

      await test.step("reopening the original shows the other version and saves normally", async () => {
        await openFlowById(page, ctx.flowId);
        await expect(
          page.locator(`[data-id="${CHAT_INPUT}"]`).getByTestId("textarea_str_input_value"),
        ).toHaveValue(THEIR_TEXT);
        expect(await dragAndAutosave(page, ctx.flowId, 60)).toBe(200);
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
        await expect(page.getByText("This flow was duplicated")).toHaveCount(0);
      });
    },
  );

  test(
    "Load Latest asks first, archives the viewer's canvas, and that archive restores",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await raiseConflict(page, request);
      const before = await getFlow(request, ctx);

      await test.step("Load Latest asks for confirmation", async () => {
        await page.getByTestId("dialog-load-latest-button").click();
        const confirm = page.getByTestId("load-latest-confirm");
        await expect(confirm).toContainText("Load the latest version?");
        await expect(confirm).toContainText(
          "Your current selections and unsaved edits will be discarded and replaced with the latest version of this flow.",
        );
      });

      await test.step("confirming archives with 201 and says where the changes went", async () => {
        const archived = page.waitForResponse(isFlowPost(ctx.flowId, "/versions/"));
        await page.getByTestId("load-latest-confirm-button").click();
        expect((await archived).status()).toBe(201);
        await expect(
          page.getByText("Your changes are in version history. The canvas shows the latest version."),
        ).toBeVisible();
      });

      await test.step("the canvas and the server show the other version", async () => {
        await expect(
          page.locator(`[data-id="${CHAT_INPUT}"]`).getByTestId("textarea_str_input_value"),
        ).toHaveValue(THEIR_TEXT);
        const flow = await getFlow(request, ctx);
        expect(flow.version_token).toBe(before.version_token);
        expect(chatText(flow.data)).toBe(THEIR_TEXT);
        await expect(page.getByTestId("flow-conflict-banner")).toHaveCount(0);
      });

      await test.step("the viewer's canvas is the one history entry", async () => {
        const entries = await listVersions(request, ctx);
        expect(entries.map((e) => e.description)).toEqual(["Saved when discarding a conflict"]);
        expect(minePosition(await versionData(request, ctx, entries[0].id))).not.toEqual(
          ctx.mineStart,
        );
      });

      await test.step("restoring that entry brings the viewer's edit back", async () => {
        await page.getByTestId("sidebar-nav-versions").click();
        await page.getByText("Saved when discarding a conflict").click();
        await page.getByRole("button", { name: "Restore", exact: true }).click();
        const activated = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname.startsWith(`/api/v1/flows/${ctx.flowId}/versions/`) &&
            new URL(r.url()).pathname.endsWith("/activate"),
        );
        // The confirmation is not a role=dialog; its button renders after the banner's.
        await expect(
          page.getByRole("checkbox", { name: "Save current draft before restoring" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Restore", exact: true }).last().click();
        expect((await activated).status()).toBe(200);
        const flow = await getFlow(request, ctx);
        expect(minePosition(flow.data)).not.toEqual(ctx.mineStart);
        expect(chatText(flow.data)).toBe("hello");
      });
    },
  );

  test(
    "a second save while choosing is not overwritten",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const ctx = await raiseConflict(page, request);
      (page as PageWithErrorHooks).expectKnownHttpError({
        pathname: `/api/v1/flows/${ctx.flowId}/overwrite`,
        status: 409,
        reason: "#2343: the overwrite is refused because the flow moved again while the dialog was open",
      });

      await test.step("the other session saves again while the dialog is open", async () => {
        await writeFromAnotherSession(request, ctx, THEIR_SECOND_TEXT);
      });

      await test.step("Update is refused with 409 and the dialog shows the newer change", async () => {
        const overwritten = page.waitForResponse(isFlowPost(ctx.flowId, "/overwrite"));
        await page.getByTestId("confirm-overwrite-flow").click();
        expect((await overwritten).status()).toBe(409);
        await expect(
          page.getByText(
            "Someone saved again while you were choosing. The changes below are up to date.",
          ),
        ).toBeVisible();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("Review Version Changes");
        await expect(
          dialog.getByTestId(`conflict-change-theirs-node:${CHAT_INPUT}`).getByRole("listitem"),
        ).toHaveText([`Input Text updated from hello to ${THEIR_SECOND_TEXT}.`]);
      });

      await test.step("the server keeps the second save", async () => {
        expect(chatText((await getFlow(request, ctx)).data)).toBe(THEIR_SECOND_TEXT);
      });
    },
  );

  test("Cancel changes nothing", { tag: ["@workspace", "@database", "@ui-ux"] }, async ({ page, request }) => {
    const ctx = await raiseConflict(page, request);
    const before = await getFlow(request, ctx);

    await test.step("Cancel closes the dialog and keeps the banner", async () => {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("flow-conflict-banner")).toBeVisible();
    });

    await test.step("the server is as it was before the dialog opened", async () => {
      const after = await getFlow(request, ctx);
      expect(after.version_token).toBe(before.version_token);
      expect(chatText(after.data)).toBe(THEIR_TEXT);
      expect(minePosition(after.data)).toEqual(ctx.mineStart);
      expect(await listVersions(request, ctx)).toEqual([]);
    });
  });

  test("a failed archive discards nothing", { tag: ["@workspace", "@database", "@ui-ux"] }, async ({ page, request }) => {
    const ctx = await raiseConflict(page, request);
    const before = await getFlow(request, ctx);
    const versionsPath = `/api/v1/flows/${ctx.flowId}/versions/`;
    (page as PageWithErrorHooks).expectKnownHttpError({
      pathname: versionsPath,
      status: 500,
      reason: "#2343: the archive POST is forced to 500 by this test to reach the failure branch",
    });
    await page.route(`**${versionsPath}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: '{"detail":"forced by test"}',
          })
        : route.continue(),
    );

    await test.step("Load Latest is confirmed and the archive fails", async () => {
      await page.getByTestId("dialog-load-latest-button").click();
      await page.getByTestId("load-latest-confirm-button").click();
      await expect(
        page.getByText(
          "Your changes could not be saved to version history, so nothing was discarded.",
        ),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("the confirmation, the dialog and the banner are all still there", async () => {
      await expect(page.getByTestId("load-latest-confirm")).toBeVisible();
      await expect(page.getByRole("dialog")).toContainText("Review Version Changes");
      await expect(page.getByTestId("flow-conflict-banner")).toBeVisible();
    });

    await test.step("the server is unchanged and the history is empty", async () => {
      const after = await getFlow(request, ctx);
      expect(after.version_token).toBe(before.version_token);
      expect(chatText(after.data)).toBe(THEIR_TEXT);
      expect(await listVersions(request, ctx)).toEqual([]);
    });
  });
});
