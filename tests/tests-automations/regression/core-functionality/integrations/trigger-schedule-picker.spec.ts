import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createCatalogFlow,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { listTriggers, type TriggerRead } from "../../../../helpers/triggers/trigger-api";

// The Schedule picker on the canvas (#2569, upstream #16322).
// Spec doc: docs/core-functionality/integrations/trigger-schedule-picker.md
// The server contract is the sibling api/triggers/api-triggers-schedule-picker.spec.ts.

const NODE_ID = "ScheduleTrigger-canvas1";

// The six schedule types. The dropdown's option testid is `<label>-<index>-option`,
// with the index read from the catalog's options at run time, not from this list.
const TYPES = ["At regular intervals", "Once", "Daily", "Weekly", "Monthly", "Custom (cron)"] as const;
type ScheduleType = (typeof TYPES)[number];

// The field labels each type shows, measured on 1.14.0.dev39 (spec doc table). The
// type and timezone rows are always present and are left out of the comparison.
const FIELDS_BY_TYPE: Record<ScheduleType, string[]> = {
  "At regular intervals": ["title-interval, in minutes"],
  Once: ["title-date and time"],
  Daily: ["title-time of day"],
  Weekly: ["title-days of the week", "title-time of day"],
  Monthly: ["title-days of the month", "title-time of day"],
  "Custom (cron)": ["title-cron expression"],
};
const ALWAYS_SHOWN = new Set(["title-Schedule", "title-schedule type", "title-timezone"]);

// Loads on the server but is not among the dropdown's options (see the API spec).
const UNLISTED_TZ = "posix/America/New_York";
const UNKNOWN_TZ_MESSAGE = "Unknown timezone; use an IANA timezone name.";

type Template = Record<string, { value?: unknown; show?: boolean }>;

test.describe("Triggers on the canvas — the Schedule picker", () => {
  let headers: Record<string, string>;
  let catalog: Record<string, unknown>;
  let optionIndex: Record<string, number>;
  const flowIds: string[] = [];

  test.beforeEach(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    catalog = await fetchComponentCatalog(request, headers);
    const template = findCatalogComponent(catalog, "ScheduleTrigger").template as Record<string, { options?: string[] }>;
    test.skip(!("schedule_type" in template), "the Schedule picker (schedule_type) ships from 1.14.0.dev30 (upstream #16322)");
    const options = template.schedule_type.options ?? [];
    expect([...options].sort(), "the catalog offers exactly the six types").toEqual([...TYPES].sort());
    optionIndex = Object.fromEntries(options.map((label, i) => [label, i]));
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor first, so its polls and a pending autosave do not 404 into the log.
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((e) => failures.push(String(e)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  async function openScheduleFlow(page: Page, request: APIRequestContext, values: Record<string, unknown>): Promise<string> {
    const flowId = await createCatalogFlow(
      request,
      catalog,
      { nodes: [{ id: NODE_ID, type: "ScheduleTrigger", values }], edges: [] },
      { name: `E2E schedule picker canvas ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, headers },
    );
    flowIds.push(flowId);
    await openFlowById(page, flowId);
    await expect(node(page).getByTestId("title-Schedule")).toBeVisible({ timeout: 30_000 });
    return flowId;
  }

  function node(page: Page): Locator {
    return page.locator(`[data-id="${NODE_ID}"]`);
  }

  async function pickType(page: Page, type: ScheduleType): Promise<void> {
    await node(page).getByTestId("dropdown_str_schedule_type").click();
    await page.getByTestId(`${type}-${optionIndex[type]}-option`).click();
    await expect(node(page).getByTestId("value-dropdown-dropdown_str_schedule_type")).toHaveText(type);
  }

  /** The node's field labels, minus the rows every type shows. */
  async function shownFields(page: Page): Promise<string[]> {
    const ids = await node(page)
      .locator('[data-testid^="title-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
    return ids.filter((id) => !ALWAYS_SHOWN.has(id)).sort();
  }

  async function storedTemplate(request: APIRequestContext, flowId: string): Promise<Template> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status(), `GET /api/v1/flows/${flowId}`).toBe(200);
    const nodes = (await res.json()).data.nodes as Array<{ id: string; data: { node: { template: Template } } }>;
    return nodes.find((n) => n.id === NODE_ID)!.data.node.template;
  }

  async function triggerRow(request: APIRequestContext, flowId: string): Promise<TriggerRead | undefined> {
    const rows = await listTriggers(request, headers, { flow_id: flowId });
    return rows.length === 1 ? rows[0] : undefined;
  }

  test(
    "the picker shows only the fields its type needs, and the saved node reads back what it showed",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await openScheduleFlow(page, request, {
        schedule_type: "Daily",
        times_of_day: ["08:00"],
        timezone: "UTC",
      });

      // Weekly comes last and only once, so the stored-node poll below cannot be
      // satisfied by an earlier autosave of the same type.
      for (const type of ["At regular intervals", "Once", "Monthly", "Custom (cron)", "Daily", "Weekly"] as ScheduleType[]) {
        await test.step(`${type}: exactly ${FIELDS_BY_TYPE[type].join(", ")}`, async () => {
          await pickType(page, type);
          await expect.poll(() => shownFields(page), { timeout: 10_000 }).toEqual([...FIELDS_BY_TYPE[type]].sort());
        });
      }

      await test.step("the stored node and the compiled row agree with the last pick (Weekly)", async () => {
        await expect
          .poll(async () => (await storedTemplate(request, flowId)).schedule_type?.value, {
            message: "the autosave stores the last pick",
            timeout: 20_000,
          })
          .toBe("Weekly");
        const t = await storedTemplate(request, flowId);
        const shown = Object.fromEntries(
          ["interval_minutes", "run_at", "times_of_day", "days_of_week", "days_of_month", "cron_expression"].map((k) => [
            k,
            t[k]?.show,
          ]),
        );
        expect(shown, "only Weekly's fields are shown on the stored node").toEqual({
          interval_minutes: false,
          run_at: false,
          times_of_day: true,
          days_of_week: true,
          days_of_month: false,
          cron_expression: false,
        });
        expect({ days: t.days_of_week.value, times: t.times_of_day.value }, "the template defaults, untouched by the picks").toEqual({
          days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          times: ["08:00"],
        });
        await expect
          .poll(async () => (await triggerRow(request, flowId))?.config.cron, {
            message: "the row runs the Weekly cron for those values",
            timeout: 15_000,
          })
          .toBe("0 8 * * 1-5");
      });
    },
  );

  test(
    "a typed cron survives switching the type away and back",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const typedCron = `*/${7 + (Date.now() % 20)} * * * *`;
      const flowId = await openScheduleFlow(page, request, { schedule_type: "Custom (cron)", timezone: "UTC" });
      const cronInput = node(page).getByTestId("popover-anchor-input-cron_expression");

      await test.step("type a cron into the Custom field", async () => {
        await cronInput.fill(typedCron);
        await cronInput.press("Tab");
        await expect(cronInput).toHaveValue(typedCron);
      });

      await test.step("switching to Daily hides the cron field", async () => {
        await pickType(page, "Daily");
        await expect(node(page).getByTestId("title-cron expression")).toHaveCount(0);
      });

      await test.step("switching back to Custom shows the typed cron", async () => {
        await pickType(page, "Custom (cron)");
        await expect(cronInput).toHaveValue(typedCron);
      });

      await test.step("the stored node and the row hold the typed cron", async () => {
        await expect
          .poll(
            async () => {
              const t = await storedTemplate(request, flowId);
              return { type: t.schedule_type?.value, cron: t.cron_expression?.value };
            },
            { message: "the autosave stores Custom with the typed cron", timeout: 20_000 },
          )
          .toEqual({ type: "Custom (cron)", cron: typedCron });
        await expect
          .poll(async () => (await triggerRow(request, flowId))?.config.cron, { timeout: 15_000 })
          .toBe(typedCron);
      });
    },
  );

  test(
    "a saved timezone outside the list is shown and kept when the list opens",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await openScheduleFlow(page, request, {
        schedule_type: "Daily",
        times_of_day: ["08:00"],
        timezone: UNLISTED_TZ,
      });
      const tzValue = node(page).getByTestId("value-dropdown-dropdown_str_timezone");

      let row: TriggerRead | undefined;
      await expect.poll(async () => (row = await triggerRow(request, flowId)) !== undefined).toBe(true);
      // The zone loads only where the server's tzdata ships the legacy posix/ tree; the
      // server says so itself (see the API spec), and then there is nothing to keep.
      test.skip(
        row!.reason === "config_invalid" && row!.last_error === UNKNOWN_TZ_MESSAGE,
        `${UNLISTED_TZ} does not load on this server (its tzdata has no posix/ tree): nothing outside the list to keep`,
      );

      await test.step("the row holds the unlisted zone", async () => {
        expect({ timezone: row!.config.timezone, reason: row!.reason }).toEqual({ timezone: UNLISTED_TZ, reason: "pending" });
      });

      await test.step("the canvas shows it", async () => {
        await expect(tzValue).toHaveText(UNLISTED_TZ);
      });

      await test.step("opening and closing the list without picking keeps it", async () => {
        await node(page).getByTestId("dropdown_str_timezone").click();
        await expect(page.getByRole("option").first(), "the list opened").toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("option"), "the list closed without a pick").toHaveCount(0);
        await expect(tzValue).toHaveText(UNLISTED_TZ);
      });

      await test.step("a save that does not touch the timezone keeps it, on the node and on the row", async () => {
        await pickType(page, "Weekly");
        await expect
          .poll(
            async () => {
              const t = await storedTemplate(request, flowId);
              return { type: t.schedule_type?.value, timezone: t.timezone?.value };
            },
            { message: "the autosave stores Weekly and the unlisted zone", timeout: 20_000 },
          )
          .toEqual({ type: "Weekly", timezone: UNLISTED_TZ });
        await expect
          .poll(async () => {
            const row = await triggerRow(request, flowId);
            return row && { timezone: row.config.timezone, cron: row.config.cron };
          })
          .toEqual({ timezone: UNLISTED_TZ, cron: "0 8 * * 1-5" });
      });
    },
  );
});
