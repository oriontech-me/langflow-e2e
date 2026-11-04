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

// Multi-edit safety (upstream #14903 / #15824): a run never executes a version nobody saved,
// and unsaved work survives a reload as a local draft that holds no secrets.
// Spec doc: docs/flow-functionality/multi-edit/multi-edit-run-and-draft.md
test.describe("Multi-edit safety — a run on a stale canvas, and the local draft", () => {
  const CI = "ChatInput-ci001";
  const CO = "ChatOutput-co001";
  const SA = "SearchAPI-sa001";
  const BASE_TEXT = "base text";
  const THEIR_TEXT = "their text";
  const MY_TEXT = "my text";
  const TOO_LARGE = 2_100_000;

  const RUN_BLOCKED = "This flow moved on while you were editing. Review the changes to run it.";
  const DRAFT_PROMPT = "Restore your work to pick up where you stopped.";
  const DRAFT_SECRETS = "Restore your work — secret fields need to be entered again.";
  const DRAFT_NOT_KEPT =
    "This flow is too large to keep a local copy of your unsaved changes. Resolve the conflict before reloading, or they will be lost.";

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

  type Ctx = {
    headers: Record<string, string>;
    flowId: string;
    userId: string;
    username: string;
  };
  type FlowNode = {
    id: string;
    data: { node: { template: Record<string, { value?: unknown }> } };
  };

  async function setup(
    request: APIRequestContext,
    opts: { withSecret?: boolean; text?: string } = {},
  ): Promise<Ctx> {
    const headers = { Authorization: await getAuthToken(request) };
    const catalog = await fetchComponentCatalog(request, headers);
    const nodes: CatalogNodeSpec[] = [
      {
        id: CI,
        type: "ChatInput",
        values: { input_value: opts.text ?? BASE_TEXT },
      },
      { id: CO, type: "ChatOutput" },
    ];
    if (opts.withSecret) nodes.push({ id: SA, type: "SearchAPI" });
    const data = buildCatalogFlow(catalog, {
      nodes,
      edges: [{ source: CI, output: "message", target: CO, field: "input_value" }],
    });
    const name = `multi-edit-run-and-draft ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const flowId = await createFlow(request, { name, data, is_component: false }, { headers });
    createdFlowIds.push(flowId);
    const me = await (await request.get("/api/v1/users/whoami", { headers })).json();
    return { headers, flowId, userId: me.id, username: me.username };
  }

  async function serverNodes(request: APIRequestContext, ctx: Ctx): Promise<FlowNode[]> {
    const res = await request.get(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
    });
    expect(res.status()).toBe(200);
    return (await res.json()).data.nodes as FlowNode[];
  }

  async function serverValue(request: APIRequestContext, ctx: Ctx, nodeId: string, fieldName: string) {
    const node = (await serverNodes(request, ctx)).find((n) => n.id === nodeId);
    return node?.data.node.template[fieldName]?.value;
  }

  /** Another session saves Chat Input's text over the API, keeping everything else. */
  async function writeFromAnotherSession(request: APIRequestContext, ctx: Ctx, text: string) {
    const res = await request.get(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
    });
    const flow = await res.json();
    for (const node of flow.data.nodes) {
      if (node.id === CI) node.data.node.template.input_value.value = text;
    }
    const saved = await request.patch(`/api/v1/flows/${ctx.flowId}`, {
      headers: ctx.headers,
      data: { data: flow.data },
    });
    expect(saved.status(), "the other session's save must succeed").toBe(200);
  }

  function declareRefusedAutosave(page: Page, ctx: Ctx) {
    (page as PageWithErrorHooks).expectKnownHttpError({
      pathname: `/api/v1/flows/${ctx.flowId}`,
      status: 409,
      reason:
        "#2345: the viewer's autosave is refused because another session saved first — " +
        "the conflict whose draft this spec exists to check",
    });
  }

  const isFlowPatch = (flowId: string) => (r: Response) =>
    r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/flows/${flowId}`;

  /** Records every PATCH to the flow and every run request (the pending poll is not a run). */
  function recordWrites(page: Page, flowId: string) {
    const patches: number[] = [];
    const runs: number[] = [];
    page.on("response", (r) => {
      if (isFlowPatch(flowId)(r)) patches.push(r.status());
      if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v2/workflows") {
        runs.push(r.status());
      }
    });
    return { patches, runs };
  }

  const chatInput = (page: Page) =>
    page.locator(`[data-id="${CI}"] [data-testid="textarea_str_input_value"]`);
  const apiKey = (page: Page) =>
    page.locator(`[data-id="${SA}"] [data-testid="popover-anchor-input-api_key"]`);
  const runButton = (page: Page) => page.getByTestId("button_run_chat output");
  const conflictBanner = (page: Page) => page.getByTestId("flow-conflict-banner");
  const restoreBanner = (page: Page) => page.getByTestId("restore-draft-banner");

  const draftKey = (ctx: Ctx) => `lf_draft_${ctx.userId}_${ctx.flowId}`;
  const readDraft = (page: Page, ctx: Ctx) => page.evaluate((k) => localStorage.getItem(k), draftKey(ctx));
  const draftSavedAt = async (page: Page, ctx: Ctx) => {
    const raw = await readDraft(page, ctx);
    return raw ? (JSON.parse(raw).savedAt as string) : null;
  };
  const allLocalStorage = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }));

  /**
   * Waits for the next debounced autosave while the conflict stands. It refreshes the draft
   * instead of saving, so a changed `savedAt` closes a window in which no PATCH may be sent.
   */
  async function waitForDraftRefresh(page: Page, ctx: Ctx, edit: () => Promise<void>) {
    const before = await draftSavedAt(page, ctx);
    expect(before, "a draft must exist before it can be refreshed").not.toBeNull();
    await edit();
    await expect
      .poll(() => draftSavedAt(page, ctx), {
        timeout: 20_000,
        message: "the draft was refreshed",
      })
      .not.toBe(before);
  }

  async function dragNode(page: Page, nodeId: string, dx: number, dy: number) {
    const node = page.locator(`[data-id="${nodeId}"]`);
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    expect(box, `node ${nodeId} has no bounding box`).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + 10 + dy, {
      steps: 10,
    });
    await page.mouse.up();
  }

  /** The viewer edits after another session saved; the autosave answers 409 and a draft is kept. */
  async function raiseConflictWithDraft(page: Page, ctx: Ctx, before: () => Promise<void> = async () => {}) {
    await test.step("another session saves first", async () => {
      await writeFromAnotherSession(page.request, ctx, THEIR_TEXT);
    });

    await test.step("the viewer edits, and its autosave is refused with 409", async () => {
      await before();

      const saved = page.waitForResponse(isFlowPatch(ctx.flowId), {
        timeout: 30_000,
      });
      await chatInput(page).fill(MY_TEXT);
      await chatInput(page).blur();
      expect((await saved).status()).toBe(409);
      await expect(conflictBanner(page)).toBeVisible();
      await expect.poll(() => readDraft(page, ctx), { message: "the draft is stored" }).not.toBeNull();
    });
  }

  async function reloadToDraftOffer(page: Page) {
    await page.reload();
    await expect(restoreBanner(page)).toBeVisible({ timeout: 60_000 });
  }

  test(
    "a run on a stale canvas with an unsaved edit is blocked, and no run request is sent",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      await openFlowById(page, ctx.flowId);
      const writes = recordWrites(page, ctx.flowId);

      await test.step("another session saves first", async () => {
        await writeFromAnotherSession(request, ctx, THEIR_TEXT);
      });

      await test.step("an edit followed at once by Run raises the conflict instead of running", async () => {
        const checked = page.waitForResponse(
          (r) => new URL(r.url()).pathname === `/api/v1/flows/${ctx.flowId}/version-state`,
        );
        await chatInput(page).fill(MY_TEXT);
        await runButton(page).click();
        expect((await checked).status()).toBe(200);
        await expect(conflictBanner(page)).toBeVisible();
      });

      await test.step("Run while the conflict stands is refused with a notice", async () => {
        await runButton(page).click();
        await expect(page.getByText(RUN_BLOCKED)).toBeVisible();
      });

      await test.step("through the next autosave, nothing was run and nothing was saved", async () => {
        await waitForDraftRefresh(page, ctx, async () => {
          await chatInput(page).fill(`${MY_TEXT} again`);
          await chatInput(page).blur();
        });
        expect(writes.runs, `run requests: ${writes.runs}`).toEqual([]);
        expect(writes.patches, `PATCH statuses: ${writes.patches}`).toEqual([]);
        expect(await serverValue(request, ctx, CI, "input_value")).toBe(THEIR_TEXT);
      });
    },
  );

  test(
    "a run on a stale canvas with no edit adopts the latest version, and only the next run executes it",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      await openFlowById(page, ctx.flowId);
      const writes = recordWrites(page, ctx.flowId);

      await test.step("another session saves first", async () => {
        await writeFromAnotherSession(request, ctx, THEIR_TEXT);
      });

      await test.step("Run adopts the newer version with a notice, and does not run", async () => {
        await runButton(page).click();
        await expect(
          page.getByText(
            `${ctx.username} updated this flow. The canvas now shows the latest version — run again to execute it.`,
          ),
        ).toBeVisible();
        await expect(chatInput(page)).toHaveValue(THEIR_TEXT);
        await expect(conflictBanner(page)).toHaveCount(0);
        expect(writes.runs, `run requests: ${writes.runs}`).toEqual([]);
      });

      await test.step("the next Run executes the adopted graph", async () => {
        const ran = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v2/workflows",
        );
        await runButton(page).click();
        expect((await ran).status()).toBe(200);
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/monitor/messages?flow_id=${ctx.flowId}`, {
                headers: ctx.headers,
              });
              const messages = (await res.json()) as {
                sender: string;
                text: string;
              }[];
              return messages.filter((m) => m.sender === "User").map((m) => m.text);
            },
            { timeout: 30_000, message: "the stored User message" },
          )
          .toEqual([THEIR_TEXT]);
      });
    },
  );

  test(
    "Restore brings unsaved work back after a reload, and the conflict stands again",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      declareRefusedAutosave(page, ctx);
      await openFlowById(page, ctx.flowId);
      await raiseConflictWithDraft(page, ctx);

      await test.step("a reload offers the draft and shows the server's version", async () => {
        await reloadToDraftOffer(page);
        await expect(restoreBanner(page)).toContainText(/Unsaved changes from \d{1,2}:\d{2}/);
        await expect(restoreBanner(page)).toContainText(DRAFT_PROMPT);
        await expect(conflictBanner(page)).toHaveCount(0);
        await expect(chatInput(page)).toHaveValue(THEIR_TEXT);
      });

      const writes = recordWrites(page, ctx.flowId);

      await test.step("Restore puts the work back and raises the conflict again", async () => {
        await page.getByTestId("restore-draft-button").click();
        await expect(chatInput(page)).toHaveValue(MY_TEXT);
        await expect(conflictBanner(page)).toBeVisible();
        await expect(restoreBanner(page)).toHaveCount(0);
      });

      await test.step("the draft is kept and nothing was saved", async () => {
        await waitForDraftRefresh(page, ctx, async () => {
          await chatInput(page).fill(`${MY_TEXT} again`);
          await chatInput(page).blur();
        });
        expect(writes.patches, `PATCH statuses: ${writes.patches}`).toEqual([]);
        expect(await serverValue(request, ctx, CI, "input_value")).toBe(THEIR_TEXT);
      });
    },
  );

  test(
    "Discard drops the draft, writes nothing, and the offer does not come back",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await setup(request);
      declareRefusedAutosave(page, ctx);
      await openFlowById(page, ctx.flowId);
      await raiseConflictWithDraft(page, ctx);
      await reloadToDraftOffer(page);
      const writes = recordWrites(page, ctx.flowId);

      await test.step("Discard keeps the server's version and removes the draft", async () => {
        await restoreBanner(page).getByRole("button", { name: "Discard" }).click();
        await expect(restoreBanner(page)).toHaveCount(0);
        await expect(chatInput(page)).toHaveValue(THEIR_TEXT);
        await expect.poll(() => readDraft(page, ctx), { message: "the draft is removed" }).toBeNull();
      });

      await test.step("a second reload offers nothing, and nothing was saved", async () => {
        await page.reload();
        await expect(chatInput(page)).toHaveValue(THEIR_TEXT, {
          timeout: 60_000,
        });
        await expect(restoreBanner(page)).toHaveCount(0);
        expect(writes.patches, `PATCH statuses: ${writes.patches}`).toEqual([]);
        expect(await serverValue(request, ctx, CI, "input_value")).toBe(THEIR_TEXT);
      });
    },
  );

  /** Types `secret` into SearchAPI's API key, raises the conflict, and checks the draft holds none of it. */
  async function secretIsNotKept(page: Page, request: APIRequestContext, secret: string) {
    const ctx = await setup(request, { withSecret: true });
    declareRefusedAutosave(page, ctx);
    await openFlowById(page, ctx.flowId);

    await raiseConflictWithDraft(page, ctx, async () => {
      await apiKey(page).fill(secret);
      await expect(apiKey(page)).toHaveValue(secret);
      await apiKey(page).blur();
    });

    await test.step("no localStorage value contains the secret", async () => {
      expect(await readDraft(page, ctx)).not.toBeNull();
      expect(await allLocalStorage(page)).not.toContain(secret);
    });

    await test.step("the offer says secret fields need re-entering", async () => {
      await reloadToDraftOffer(page);
      await expect(restoreBanner(page)).toContainText(DRAFT_SECRETS);
    });

    await test.step("Restore brings the work back with the key empty", async () => {
      await page.getByTestId("restore-draft-button").click();
      await expect(chatInput(page)).toHaveValue(MY_TEXT);
      await expect(apiKey(page)).toHaveValue("");
    });

    return ctx;
  }

  const randomHex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");

  test(
    "a draft keeps no local copy of a secret, and the restored field is empty",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await secretIsNotKept(page, request, `sk-e2e-secret-${randomHex(12)}`);
      expect(await serverValue(request, ctx, SA, "api_key"), "the server never received the key").toBe("");
    },
  );

  test(
    "an alphanumeric API key is not kept in the draft either",
    {
      tag: ["@workspace", "@database", "@playground"],
      annotation: {
        type: "known defect",
        description:
          "removeApiKeys treats a key matching /^[A-Z][A-Z0-9_]*$/i as a variable name and keeps it " +
          "(#2345; upstream report pending)",
      },
    },
    async ({ page, request }) => {
      test.fail(true, "Known defect: an alphanumeric api_key is stored in plain text in the draft (#2345)");
      const ctx = await secretIsNotKept(page, request, `a${randomHex(31)}`);
      expect(await serverValue(request, ctx, SA, "api_key"), "the server never received the key").toBe("");
    },
  );

  test(
    "a flow too large to keep a local copy warns, and stores no draft",
    { tag: ["@workspace", "@database", "@playground"] },
    async ({ page, request }) => {
      const ctx = await setup(request, { text: "x".repeat(TOO_LARGE) });
      declareRefusedAutosave(page, ctx);
      await openFlowById(page, ctx.flowId);

      await test.step("another session saves a value as large", async () => {
        await writeFromAnotherSession(request, ctx, "y".repeat(TOO_LARGE));
      });

      await test.step("moving Chat Output raises the conflict", async () => {
        const saved = page.waitForResponse(isFlowPatch(ctx.flowId), {
          timeout: 30_000,
        });
        await dragNode(page, CO, 100, 50);
        expect((await saved).status()).toBe(409);
        await expect(conflictBanner(page)).toBeVisible();
      });

      await test.step("the next edit warns that no local copy is kept, and there is no draft", async () => {
        await dragNode(page, CO, 120, 80);
        await expect(page.getByText(DRAFT_NOT_KEPT)).toBeVisible({
          timeout: 20_000,
        });
        expect(await readDraft(page, ctx)).toBeNull();
      });
    },
  );
});
