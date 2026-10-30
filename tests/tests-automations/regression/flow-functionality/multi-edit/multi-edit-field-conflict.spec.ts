import type { APIRequestContext, Locator, Page } from "@playwright/test";
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

// Multi-edit safety (upstream #14903 / #15824): a component both people changed cannot be
// merged automatically, so Update stays blocked until a version is chosen for it, and the
// saved flow holds exactly the versions chosen.
// Spec doc: docs/flow-functionality/multi-edit/multi-edit-field-conflict.md
test.describe("Multi-edit safety — a component changed on both sides", () => {
  const ONE = "ChatInput-one01";
  const TWO = "ChatInput-two02";
  const THREE = "ChatInput-thr03";
  const OUT = "ChatOutput-out01";
  const BASE = { [ONE]: "base one", [TWO]: "base two", [THREE]: "base three" };
  // Past the dialog's 800-character clip, so a merge that saved what it displays is caught.
  const LONG_VALUE = `${"their long value ".repeat(58)}— end of their value`;
  const AUTHOR = "langflow";

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

  type Values = Record<string, string>;
  type FlowNode = {
    id: string;
    position: { x: number; y: number };
    data: { node: { template: Record<string, { value?: unknown }> } };
  };
  type Ctx = { headers: Record<string, string>; catalog: Record<string, unknown>; flowId: string };

  function nodes(values: Values): CatalogNodeSpec[] {
    return [
      { id: ONE, type: "ChatInput", displayName: "First Input", values: { input_value: values[ONE] } },
      { id: TWO, type: "ChatInput", displayName: "Second Input", values: { input_value: values[TWO] } },
      { id: THREE, type: "ChatInput", displayName: "Third Input", values: { input_value: values[THREE] } },
      { id: OUT, type: "ChatOutput" },
    ];
  }

  async function serverNodes(request: APIRequestContext, ctx: Ctx): Promise<FlowNode[]> {
    const res = await request.get(`/api/v1/flows/${ctx.flowId}`, { headers: ctx.headers });
    expect(res.status()).toBe(200);
    return (await res.json()).data.nodes as FlowNode[];
  }

  async function serverValues(request: APIRequestContext, ctx: Ctx): Promise<Values> {
    const values: Values = {};
    for (const node of await serverNodes(request, ctx)) {
      if (node.id !== OUT) values[node.id] = node.data.node.template.input_value.value as string;
    }
    return values;
  }

  /** Another session saves `values`, keeping every node where the server has it. */
  async function writeFromAnotherSession(request: APIRequestContext, ctx: Ctx, values: Values) {
    const positions = new Map((await serverNodes(request, ctx)).map((n) => [n.id, n.position]));
    const next = buildCatalogFlow(ctx.catalog, { nodes: nodes(values), edges: [] });
    for (const node of next.nodes) node.position = positions.get(node.id) ?? node.position;
    const res = await request.patch(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
      data: { data: next },
    });
    expect(res.status(), "the other session's save must succeed").toBe(200);
  }

  const field = (page: Page, nodeId: string) =>
    page.locator(`[data-id="${nodeId}"] [data-testid="textarea_str_input_value"]`);

  /**
   * Builds the flow, opens it, has another session save `theirs`, types `mine` into the same
   * fields so the viewer's autosave is refused with 409, and opens the review dialog.
   */
  async function raiseConflict(
    page: Page,
    request: APIRequestContext,
    theirs: Values,
    mine: Values,
  ): Promise<{ ctx: Ctx; dialog: Locator }> {
    const headers = { Authorization: await getAuthToken(request) };
    const catalog = await fetchComponentCatalog(request, headers);
    const name = `multi-edit-field-conflict ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const flowId = await createFlow(
      request,
      { name, data: buildCatalogFlow(catalog, { nodes: nodes(BASE), edges: [] }), is_component: false },
      { headers },
    );
    createdFlowIds.push(flowId);
    const ctx = { headers, catalog, flowId };

    (page as PageWithErrorHooks).expectKnownHttpError({
      pathname: `/api/v1/flows/${flowId}`,
      status: 409,
      reason:
        "#2344: the viewer's autosave is refused because another session saved the same component first — " +
        "the conflict this spec exists to resolve",
    });
    await openFlowById(page, flowId);

    await test.step("another session saves the same components first", async () => {
      await writeFromAnotherSession(request, ctx, { ...BASE, ...theirs });
    });

    await test.step("the viewer edits them too, and its autosave is refused with 409", async () => {
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/flows/${flowId}`,
        { timeout: 30_000 },
      );
      for (const [nodeId, value] of Object.entries(mine)) {
        await field(page, nodeId).fill(value);
      }
      await field(page, Object.keys(mine).at(-1)!).blur();
      expect((await saved).status()).toBe(409);
    });

    const dialog = page.getByRole("dialog");

    await test.step("Review changes opens Review Version Changes", async () => {
      await page.getByTestId("flow-conflict-review-button").click();
      await expect(dialog).toContainText("Review Version Changes");
    });

    return { ctx, dialog };
  }

  const conflictRow = (dialog: Locator, nodeId: string) =>
    dialog.getByTestId(`conflict-resolve-node:${nodeId}`);

  async function choose(dialog: Locator, nodeId: string, option: string) {
    await dialog.getByTestId(`conflict-toggle-node:${nodeId}`).click();
    await conflictRow(dialog, nodeId).getByRole("radio", { name: new RegExp(`^${option}`) }).click();
  }

  async function updateCurrentFlow(page: Page, ctx: Ctx) {
    const overwritten = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === `/api/v1/flows/${ctx.flowId}/overwrite`,
    );
    await page.getByTestId("confirm-overwrite-flow").click();
    expect((await overwritten).status()).toBe(200);
    await expect(page.getByText("Flow updated. The version it replaced is in the history.")).toBeVisible();
  }

  test(
    "a component changed on both sides blocks Update until a version is chosen, and Keep my version saves mine",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const { ctx, dialog } = await raiseConflict(page, request, { [ONE]: "their one" }, { [ONE]: "my one" });
      const row = conflictRow(dialog, ONE);
      const update = page.getByTestId("confirm-overwrite-flow");
      const hint = page.getByTestId("conflict-blocked-hint");

      await test.step("the row asks for a choice and Update is blocked", async () => {
        await expect(row).toContainText("First Input");
        await expect(row).toContainText("— Changes made by multiple people.");
        await expect(row).toContainText("Select which version to keep.");
        await expect(row).toContainText("Action required");
        await expect(update).toBeDisabled();
        await expect(hint).toHaveText("Resolve 1 conflict before updating this flow.");
      });

      await test.step("Keep my version resolves the row and unblocks Update", async () => {
        await choose(dialog, ONE, "Keep my version");
        await expect(row).toContainText("Keeping my version");
        await expect(row).not.toContainText("Action required");
        await expect(
          row.getByRole("checkbox", { name: "First Input is resolved and included" }),
        ).toBeChecked();
        await expect(hint).toHaveCount(0);
        await expect(update).toBeEnabled();
      });

      await test.step("the server and the canvas hold the viewer's value", async () => {
        await updateCurrentFlow(page, ctx);
        expect((await serverValues(request, ctx))[ONE]).toBe("my one");
        await expect(field(page, ONE)).toHaveValue("my one");
      });
    },
  );

  test(
    "Keep the other person's version saves theirs whole, even past what the dialog shows",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const { ctx, dialog } = await raiseConflict(page, request, { [TWO]: LONG_VALUE }, { [TWO]: "my two" });
      const row = conflictRow(dialog, TWO);

      await test.step("a long value is summarised, and its diff is shown in part", async () => {
        await dialog.getByTestId(`conflict-toggle-node:${TWO}`).click();
        const theirsOption = row.getByRole("radio", { name: new RegExp(`^Keep ${AUTHOR}'s version`) });
        await expect(theirsOption).toBeVisible();
        await expect(row.getByText("Input Text updated.", { exact: true })).toHaveCount(2);
        await row.getByRole("button", { name: "Show changes" }).last().click();
        await expect(row.getByText("Shown in part. Open the component to see the whole value.")).toBeVisible();
        await theirsOption.click();
        await expect(row).toContainText(`Keeping ${AUTHOR}'s version`);
      });

      await test.step("the server holds the whole value, not the part the dialog showed", async () => {
        await updateCurrentFlow(page, ctx);
        const saved = (await serverValues(request, ctx))[TWO];
        expect(saved).toHaveLength(LONG_VALUE.length);
        expect(saved).toBe(LONG_VALUE);
      });
    },
  );

  test(
    "two conflicts resolved opposite ways, plus an uncontested change, save exactly what was chosen",
    { tag: ["@workspace", "@database", "@ui-ux"] },
    async ({ page, request }) => {
      const { ctx, dialog } = await raiseConflict(
        page,
        request,
        { [ONE]: "their one", [TWO]: "their two", [THREE]: "their three" },
        { [ONE]: "my one", [TWO]: "my two" },
      );
      const hint = page.getByTestId("conflict-blocked-hint");
      const uncontested = dialog.getByTestId(`conflict-change-theirs-node:${THREE}`);

      await test.step("both conflicts block Update", async () => {
        await expect(hint).toHaveText("Resolve 2 conflicts before updating this flow.");
        await expect(page.getByTestId("confirm-overwrite-flow")).toBeDisabled();
      });

      await test.step("one conflict each way, and the uncontested change is checked in", async () => {
        await choose(dialog, ONE, "Keep my version");
        await expect(hint).toHaveText("Resolve 1 conflict before updating this flow.");
        await choose(dialog, TWO, `Keep ${AUTHOR}'s version`);
        await expect(hint).toHaveCount(0);

        await expect(uncontested).toContainText("Input Text updated from base three to their three.");
        const include = uncontested.getByRole("checkbox");
        await expect(include).not.toBeChecked();
        await include.click();
        await expect(include).toBeChecked();
      });

      await test.step("the server and the canvas hold exactly the chosen values", async () => {
        await updateCurrentFlow(page, ctx);
        expect(await serverValues(request, ctx)).toEqual({
          [ONE]: "my one",
          [TWO]: "their two",
          [THREE]: "their three",
        });
        expect((await serverNodes(request, ctx)).map((n) => n.id).sort()).toEqual(
          [ONE, TWO, THREE, OUT].sort(),
        );
        await expect(field(page, ONE)).toHaveValue("my one");
        await expect(field(page, TWO)).toHaveValue("their two");
        await expect(field(page, THREE)).toHaveValue("their three");
      });
    },
  );
});
