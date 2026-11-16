import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import {
  createTrigger,
  getTrigger,
  listTriggers,
  runProvider,
  type TriggerAction,
  type TriggerRead,
  type TriggerState,
} from "../../../../helpers/triggers/trigger-api";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";

// Settings › Triggers: the caller's triggers, a row menu drawn from the server,
// and the superuser's operator view (#2448).
// Spec doc: docs/core-functionality/integrations/triggers-settings-page.md
//
// The page renders allowed_actions / blocked_actions as the server sends them and
// never re-derives them from the state, so every menu below is compared item by
// item with the server's answer read in the same test. The server half of that
// answer is pinned in api/triggers/api-triggers-operator.spec.ts.
//
// Every row is created through the API for this run and found by a per-run
// search term: the shared superuser always has other specs' triggers. The bulk
// buttons act on a PROVIDER, instance-wide across users, so the operator test
// seeds its rows under a provider unique to the run (`runProvider`) and the
// confirm can change nothing else.
test.describe("Settings › Triggers — the page", () => {
  // The page ships in 1.14.0.dev10 (upstream #15940) and was reworked by #16064
  // (dev14) and #16132 (dev16); the copy and test ids below are the reworked ones.
  const PAGE_SINCE = "1.14.0.dev16";
  const UNSERVED_KIND = "e2e.event"; // no bundle serves it: an active row offers no resume
  const MENU_ACTIONS: readonly TriggerAction[] = ["pause", "resume", "reconnect", "rotate_secret"];
  const COPY = {
    noMatch: "No triggers match these filters.",
    blockedDead: "This trigger stopped permanently. Delete it instead.",
    blockedPaused: "Resume the trigger first.",
  } as const;

  const token = `trgpage${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let owner: ConnectionsOwner | undefined;
  let ownerName = "";
  const ownerHeaders = () => (owner as ConnectionsOwner).headers;
  const superFlowIds: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "trgpage",
    );
    const ctx = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      const res = await ctx.get("/api/v1/users/whoami", { headers: owner.headers });
      if (!res.ok()) throw new Error(`whoami for the owner answered ${res.status()}: ${await res.text()}`);
      ownerName = ((await res.json()) as { username: string }).username;
    } finally {
      await ctx.dispose();
    }
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, PAGE_SINCE)),
      `Settings › Triggers ships in its reworked form in ${PAGE_SINCE} (upstream #15940, #16064, #16132)`,
    );
  });

  test.afterEach(async ({ request }) => {
    if (superFlowIds.length === 0) return;
    const headers = { Authorization: await getAuthToken(request) };
    for (const id of superFlowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
  });

  async function superHeaders(request: APIRequestContext): Promise<Record<string, string>> {
    return { Authorization: await getAuthToken(request) };
  }

  /** An empty flow; the superuser's are deleted in the teardown, the owner's go with the owner. */
  async function seedFlow(request: APIRequestContext, headers: Record<string, string>, label: string, asSuperuser: boolean) {
    const name = `E2E triggers page ${label} ${token}`;
    const id = await createFlow(request, { name, data: { nodes: [], edges: [] } }, { headers });
    if (asSuperuser) superFlowIds.push(id);
    return { id, name };
  }

  async function seedTrigger(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
    label: string,
    kind: string,
    state: TriggerState,
    provider?: string,
  ): Promise<TriggerRead> {
    return createTrigger(request, headers, { flow_id: flowId, name: `${token} ${label}`, kind, state, provider });
  }

  async function openTriggersPage(page: Page) {
    await page.goto("/");
    await navigateSettingsPages(page, "Settings", "Triggers");
    await expect(page).toHaveURL(/\/settings\/triggers$/);
    await expect(page).toHaveTitle("Triggers | Langflow");
  }

  const row = (page: Page, id: string) => page.getByTestId(`trigger-row-${id}`);
  const rows = (page: Page) => page.locator('[data-testid^="trigger-row-"]');
  const toast = (page: Page, text: string) => page.getByRole("status").getByText(text, { exact: true });
  /**
   * A `Button` label, matched whole but case-blind: Langflow's `Button` title-cases
   * a string child unless `ignoreTitleCase` is set, so the copy "Pause all {{provider}}"
   * renders "Pause All E2eop…". The words are the contract; the casing is the component's.
   */
  const buttonLabel = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

  async function search(page: Page, term: string) {
    const box = page.getByTestId("triggers-search");
    await box.fill(term);
    await expect(box).toHaveValue(term);
  }

  async function chooseOption(page: Page, comboboxTestId: string, option: string) {
    await page.getByTestId(comboboxTestId).click();
    await page.getByRole("option", { name: option, exact: true }).click();
    await expect(page.getByRole("listbox")).toBeHidden();
  }

  /** The text an element's `aria-describedby` points at. */
  async function description(locator: ReturnType<Page["getByTestId"]>): Promise<string | null> {
    return locator.evaluate((el) => {
      const id = el.getAttribute("aria-describedby");
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    });
  }

  test(
    "reaches Settings › Triggers and lists, searches and filters the caller's triggers",
    { tag: ["@integrations", "@settings", "@stable"] },
    async ({ page, request }) => {
      const seed = await test.step("Seed an active, a paused and an error webhook on one superuser flow", async () => {
        const su = await superHeaders(request);
        const flow = await seedFlow(request, su, "listing", true);
        return {
          flow,
          active: await seedTrigger(request, su, flow.id, "active", "inbound_webhook", "active"),
          paused: await seedTrigger(request, su, flow.id, "paused", "inbound_webhook", "paused"),
          error: await seedTrigger(request, su, flow.id, "error", "inbound_webhook", "error"),
        };
      });
      const all = [seed.active, seed.paused, seed.error];

      await test.step("sidebar-nav-Triggers opens /settings/triggers with the caller's table", async () => {
        await openTriggersPage(page);
        await expect(page.getByTestId("triggers-table-mine")).toBeVisible();
      });

      await test.step("A search for the run's term lists exactly the three seeded rows, each naming its flow", async () => {
        await search(page, token);
        await expect(rows(page)).toHaveCount(3);
        for (const trigger of all) {
          await expect(row(page, trigger.id)).toContainText(seed.flow.name);
          await expect(row(page, trigger.id)).toContainText(trigger.name);
        }
      });

      await test.step("The state filter narrows to the paused row, and back", async () => {
        await chooseOption(page, "triggers-state-filter", "Paused");
        await expect(rows(page)).toHaveCount(1);
        await expect(row(page, seed.paused.id)).toBeVisible();
        await chooseOption(page, "triggers-state-filter", "All states");
        await expect(rows(page)).toHaveCount(3);
      });

      await test.step("The Needs attention toggle is pressed and released, and shows only the error row while pressed", async () => {
        const toggle = page.getByTestId("triggers-attention-toggle");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expect(toggle).toHaveText(/^Needs attention \(\d+\)$/);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(rows(page)).toHaveCount(1);
        await expect(row(page, seed.error.id)).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expect(rows(page)).toHaveCount(3);
      });

      await test.step("A search that matches nothing shows the empty state", async () => {
        await search(page, `${token}-nomatch`);
        await expect(page.getByTestId("triggers-empty")).toHaveText(COPY.noMatch);
        await expect(rows(page)).toHaveCount(0);
      });
    },
  );

  test(
    "renders each row's menu from the server's actions, blocks with a reason, and deletes only after confirming",
    { tag: ["@integrations", "@settings", "@stable"] },
    async ({ page, request }) => {
      const su = await superHeaders(request);
      const seed = await test.step("Seed an active unserved kind, a dead and a paused webhook", async () => {
        const flow = await seedFlow(request, su, "menus", true);
        return {
          unserved: await seedTrigger(request, su, flow.id, "unserved", UNSERVED_KIND, "active"),
          dead: await seedTrigger(request, su, flow.id, "dead", "inbound_webhook", "dead"),
          paused: await seedTrigger(request, su, flow.id, "paused", "inbound_webhook", "paused"),
        };
      });

      await openTriggersPage(page);
      await search(page, token);
      await expect(rows(page)).toHaveCount(3);

      /** The menu the page must draw for `trigger`: allowed first, then blocked, as the server listed them. */
      const expectedMenu = (trigger: TriggerRead) => {
        const blocked = Object.keys(trigger.blocked_actions) as TriggerAction[];
        const order = [...trigger.allowed_actions, ...blocked.filter((action) => !trigger.allowed_actions.includes(action))];
        const has = (action: TriggerAction) => order.includes(action);
        return [
          "view_events",
          "open_flow",
          ...order.filter((action) => MENU_ACTIONS.includes(action)),
          ...(has("delete") ? ["delete"] : []),
        ].map((action) => `trigger-action-${action}`);
      };

      const menu = page.getByRole("menu");
      async function openMenu(trigger: TriggerRead) {
        await page.getByTestId(`trigger-menu-${trigger.id}`).click();
        await expect(menu).toBeVisible();
      }
      async function closeMenu() {
        // A blocked item sits inside a tooltip that opens on focus, and Escape
        // dismisses the topmost layer first — the tooltip, then the menu. So one
        // Escape is not always enough, and how many it takes is the layering's.
        await expect(async () => {
          await page.keyboard.press("Escape");
          await expect(menu).toBeHidden({ timeout: 1_000 });
        }).toPass({ timeout: 6_000 });
      }

      await test.step("Each row's menu holds exactly the server's actions, and every blocked one is aria-disabled", async () => {
        for (const seeded of [seed.unserved, seed.dead, seed.paused]) {
          const server = await getTrigger(request, su, seeded.id);
          await openMenu(server);
          const items = menu.getByRole("menuitem");
          await expect(items).toHaveCount(expectedMenu(server).length);
          expect(await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid"))), server.name).toEqual(
            expectedMenu(server),
          );
          for (const [action, reason] of Object.entries(server.blocked_actions)) {
            if (!MENU_ACTIONS.includes(action as TriggerAction) && action !== "delete") continue;
            const item = menu.getByTestId(`trigger-action-${action}`);
            await expect(item, `${server.name}: ${action} blocked by ${reason}`).toHaveAttribute("aria-disabled", "true");
          }
          for (const action of server.allowed_actions) {
            if (!MENU_ACTIONS.includes(action) && action !== "delete") continue;
            await expect(menu.getByTestId(`trigger-action-${action}`), `${server.name}: ${action}`).not.toHaveAttribute(
              "aria-disabled",
            );
          }
          await closeMenu();
        }
      });

      await test.step("An action the server does not list is absent from the menu", async () => {
        await openMenu(seed.unserved);
        await expect(menu.getByTestId("trigger-action-pause")).toBeVisible();
        await expect(menu.getByTestId("trigger-action-resume")).toHaveCount(0);
        await expect(menu.getByTestId("trigger-action-rotate_secret")).toHaveCount(0);
        await closeMenu();
        await openMenu(seed.dead);
        await expect(menu.getByTestId("trigger-action-pause")).toHaveCount(0);
        await closeMenu();
      });

      await test.step("A blocked action stays focusable, explains itself, and does nothing when chosen", async () => {
        const enableRequests: string[] = [];
        const onRequest = (req: { url(): string; method(): string }) => {
          if (req.method() === "POST" && req.url().includes(`/api/v1/triggers/${seed.dead.id}/enable`)) enableRequests.push(req.url());
        };
        page.on("request", onRequest);
        try {
          await openMenu(seed.dead);
          const resume = menu.getByTestId("trigger-action-resume");
          await expect(resume).toHaveAttribute("aria-disabled", "true");
          expect(await description(resume)).toBe(COPY.blockedDead);
          let focused = false;
          for (let i = 0; i < 8 && !focused; i++) {
            focused = await resume.evaluate((el) => el === document.activeElement);
            if (!focused) await page.keyboard.press("ArrowDown");
          }
          await expect(resume, "the keyboard reaches the blocked item").toBeFocused();
          await page.keyboard.press("Enter");
          await expect(menu, "choosing a blocked action leaves the menu open").toBeVisible();
          await closeMenu();
        } finally {
          page.off("request", onRequest);
        }
        expect(enableRequests, "no enable request was sent").toEqual([]);
        expect((await getTrigger(request, su, seed.dead.id)).state).toBe("dead");
      });

      await test.step("The test button of a paused row is blocked the same way, without going disabled", async () => {
        const testButton = page.getByTestId(`trigger-test-${seed.paused.id}`);
        await expect(testButton).toHaveAttribute("aria-disabled", "true");
        await expect(testButton).not.toHaveAttribute("disabled");
        expect(await description(testButton)).toBe(COPY.blockedPaused);
        await testButton.focus();
        await expect(testButton).toBeFocused();
      });

      await test.step("Delete asks first: cancel keeps the trigger, confirm deletes it", async () => {
        const dialog = page.getByRole("dialog");
        await openMenu(seed.paused);
        await menu.getByTestId("trigger-action-delete").click();
        await expect(dialog).toContainText(`This will permanently delete the trigger ${seed.paused.name}.`);
        await dialog.getByTestId("btn_cancel_delete_confirmation_modal").click();
        await expect(dialog).toBeHidden();
        await expect(row(page, seed.paused.id)).toBeVisible();
        expect((await getTrigger(request, su, seed.paused.id)).id, "a cancelled delete deletes nothing").toBe(seed.paused.id);

        await openMenu(seed.paused);
        await menu.getByTestId("trigger-action-delete").click();
        await dialog.getByTestId("btn_delete_delete_confirmation_modal").click();
        await expect(toast(page, `Deleted ${seed.paused.name}`)).toBeVisible();
        await expect(row(page, seed.paused.id)).toBeHidden();
        const gone = await request.get(`/api/v1/triggers/${seed.paused.id}`, { headers: su });
        expect(gone.status(), await gone.text()).toBe(404);
      });
    },
  );

  test(
    "gives a superuser an operator view across users, with a provider bulk previewed by a dry run and per-row admin actions",
    { tag: ["@integrations", "@settings", "@stable"] },
    async ({ page, request }) => {
      const provider = runProvider("page");
      const gone = runProvider("gone");
      const seed = await test.step("Seed the other user's rows on a provider unique to the run, and one provider on no row", async () => {
        const flow = await seedFlow(request, ownerHeaders(), "operator", false);
        const op1 = await seedTrigger(request, ownerHeaders(), flow.id, "op1", "inbound_webhook", "active", provider);
        const op2 = await seedTrigger(request, ownerHeaders(), flow.id, "op2", "inbound_webhook", "active", provider);
        const ownPaused = await seedTrigger(request, ownerHeaders(), flow.id, "own-paused", "inbound_webhook", "paused", provider);
        const vanished = await seedTrigger(request, ownerHeaders(), flow.id, "gone", "inbound_webhook", "active", gone);
        const res = await request.delete(`/api/v1/triggers/${vanished.id}`, { headers: ownerHeaders() });
        expect(res.status(), await res.text()).toBe(204);
        return { op1, op2, ownPaused };
      });
      const su = await superHeaders(request);
      const state = async () =>
        new Map((await listTriggers(request, su, { scope: "all", provider })).map((trigger) => [trigger.id, trigger]));

      const pauseAll = page.getByTestId("triggers-bulk-pause");
      const resumeAll = page.getByTestId("triggers-bulk-resume");
      const bulkDialog = page.getByTestId("triggers-bulk-dialog");

      await test.step("The Scope combobox switches to All triggers, with an Owner column", async () => {
        await openTriggersPage(page);
        await expect(page.getByTestId("triggers-scope-filter")).toHaveText("My triggers");
        await chooseOption(page, "triggers-scope-filter", "All triggers");
        const table = page.getByTestId("triggers-table-all");
        // The operator list pages through every trigger on the instance before it
        // renders anything, so its first load is the slowest thing on the page.
        await expect(table).toBeVisible({ timeout: 15_000 });
        const headers = table.locator("thead th");
        await expect(headers.filter({ hasText: /^Owner$/ })).toHaveCount(1);
        await expect(headers.filter({ hasText: /^Connection$/ })).toHaveCount(0);
      });

      await test.step("The bulk buttons stay disabled until a provider is chosen", async () => {
        await expect(pauseAll).toBeDisabled();
        await expect(resumeAll).toBeDisabled();
        await expect(pauseAll).toHaveText(buttonLabel("Pause all"));
        await expect(resumeAll).toHaveText(buttonLabel("Resume all"));
      });

      await test.step("The provider filter lists only providers present, and choosing one enables the bulk", async () => {
        await page.getByTestId("triggers-provider-filter").click();
        const options = page.getByRole("option");
        await expect(options.first()).toHaveText("All providers");
        await expect(page.getByRole("option", { name: provider, exact: true })).toHaveCount(1);
        await expect(page.getByRole("option", { name: gone, exact: true }), "a provider on no row is not offered").toHaveCount(0);
        await page.getByRole("option", { name: provider, exact: true }).click();
        await expect(rows(page)).toHaveCount(3);
        for (const trigger of [seed.op1, seed.op2, seed.ownPaused]) {
          await expect(row(page, trigger.id)).toContainText(ownerName);
        }
        await expect(pauseAll).toBeEnabled();
        await expect(resumeAll).toBeEnabled();
        await expect(pauseAll).toHaveText(buttonLabel(`Pause all ${provider}`));
        await expect(resumeAll).toHaveText(buttonLabel(`Resume all ${provider}`));
      });

      await test.step("Pause all previews a dry run, and the confirm pauses exactly the two active rows", async () => {
        await pauseAll.click();
        await expect(bulkDialog.getByRole("heading")).toHaveText(`Pause 2 active ${provider} triggers?`);
        await expect(bulkDialog.locator("dd")).toHaveText(["2", "1", "1"]);
        const confirm = bulkDialog.getByTestId("triggers-bulk-confirm");
        await expect(confirm).toHaveText(buttonLabel("Pause 2 triggers"));
        await confirm.click();
        await expect(toast(page, "Paused 2 triggers")).toBeVisible();
        await expect(bulkDialog).toBeHidden();
        const rowsNow = await state();
        for (const trigger of [seed.op1, seed.op2]) {
          expect(rowsNow.get(trigger.id), trigger.name).toMatchObject({ state: "paused", reason: "paused_by_admin" });
        }
        expect(rowsNow.get(seed.ownPaused.id), "the owner's own pause is untouched").toMatchObject({
          state: "paused",
          reason: "paused",
          admin_paused_at: null,
        });
      });

      await test.step("The row menu offers the two admin actions, and Resume admin pause re-arms that row only", async () => {
        await page.getByTestId(`trigger-operator-menu-${seed.op1.id}`).click();
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem")).toHaveText(["Pause as admin", "Resume admin pause"]);
        await menu.getByRole("menuitem", { name: "Resume admin pause" }).click();
        await expect(toast(page, `Resumed ${seed.op1.name}`)).toBeVisible();
        const rowsNow = await state();
        expect(rowsNow.get(seed.op1.id)).toMatchObject({ state: "active", reason: null, admin_paused_at: null });
        expect(rowsNow.get(seed.op2.id)).toMatchObject({ state: "paused", reason: "paused_by_admin" });
      });

      await test.step("Resume admin pause on a row its owner paused changes nothing, and says so", async () => {
        await page.getByTestId(`trigger-operator-menu-${seed.ownPaused.id}`).click();
        await page.getByRole("menu").getByRole("menuitem", { name: "Resume admin pause" }).click();
        await expect(toast(page, `${seed.ownPaused.name} wasn't paused by an admin, so nothing changed.`)).toBeVisible();
        expect((await state()).get(seed.ownPaused.id)).toMatchObject({ state: "paused", reason: "paused" });
      });

      await test.step("Resume all previews the one row an admin still holds, and re-arms it", async () => {
        await resumeAll.click();
        await expect(bulkDialog.getByRole("heading")).toHaveText(`Resume 1 ${provider} trigger paused by an admin?`);
        await expect(bulkDialog.locator("dd")).toHaveText(["1", "2", "1"]);
        const confirm = bulkDialog.getByTestId("triggers-bulk-confirm");
        await expect(confirm).toHaveText(buttonLabel("Resume 1 trigger"));
        await confirm.click();
        await expect(toast(page, "Resumed 1 trigger")).toBeVisible();
        const rowsNow = await state();
        expect(rowsNow.get(seed.op2.id)).toMatchObject({ state: "active", reason: null, admin_paused_at: null });
        expect(rowsNow.get(seed.ownPaused.id)).toMatchObject({ state: "paused", reason: "paused" });
      });
    },
  );
});
