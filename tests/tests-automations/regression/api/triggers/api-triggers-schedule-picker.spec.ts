import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  buildCatalogFlow,
  fetchComponentCatalog,
  findCatalogComponent,
  type CatalogFlowData,
} from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { listTriggers, type TriggerRead } from "../../../../helpers/triggers/trigger-api";

// The Schedule picker's server contract (#2569, upstream #16322).
// Spec doc: docs/api/triggers/api-triggers-schedule-picker.md
//
// Every flow is saved through the API only: the defect #16322 fixed was a cron compiled
// only on a canvas field refresh, so an API-saved flow ran the stale stored cron.

const TIMING_KEYS = ["cron", "crons", "interval_minutes", "run_at"] as const;
const WEEKLY_NO_DAYS_MESSAGE = "Pick at least one day of the week.";
const BAD_TIME_MESSAGE = "Write the time of day as 18:30 or 6:30 PM; got '25:00'.";
const UNKNOWN_TZ_MESSAGE = "Unknown timezone; use an IANA timezone name.";
// Loads on the nightly image (its tzdata ships the posix/ tree) but is not in
// available_timezones(), so it is outside the picker's list.
const UNLISTED_TZ = "posix/America/New_York";

type Catalog = Record<string, unknown>;
type Template = Record<string, { value?: unknown; show?: boolean } & Record<string, unknown>>;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type StoredNode = { data: { node: Record<string, unknown> & { template: Template } } };

/** The first node's frontend node, typed: catalog flows hold exactly one node here. */
function nodeOf(data: CatalogFlowData): StoredNode["data"]["node"] {
  return (data.nodes[0] as unknown as StoredNode).data.node;
}

/** Only the timing keys present in a row's config, with their values. */
function timingOf(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TIMING_KEYS.filter((k) => k in config).map((k) => [k, config[k]]));
}

test.describe("Triggers API — the Schedule picker is compiled on the server", () => {
  let headers: Record<string, string>;
  let catalog: Catalog;
  let hasPicker = false;
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    catalog = await fetchComponentCatalog(request, headers);
    hasPicker = "schedule_type" in findCatalogComponent(catalog, "ScheduleTrigger").template;
  });

  test.beforeEach(() => {
    test.skip(!hasPicker, "the Schedule picker (schedule_type) ships from 1.14.0.dev30 (upstream #16322)");
  });

  test.afterAll(async ({ request }) => {
    const failures: string[] = [];
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, { headers }).catch((e) => failures.push(String(e)));
    }
    expect(failures, "teardown must delete every flow this file created").toEqual([]);
  });

  function graph(nodeId: string, values: Record<string, unknown>): CatalogFlowData {
    return buildCatalogFlow(catalog, { nodes: [{ id: nodeId, type: "ScheduleTrigger", values }], edges: [] });
  }

  async function saveFlow(request: APIRequestContext, label: string, data: CatalogFlowData): Promise<string> {
    const id = await createFlow(request, { name: unique(`E2E schedule picker ${label}`), data }, { headers });
    createdFlowIds.push(id);
    return id;
  }

  async function patchFlow(request: APIRequestContext, flowId: string, data: unknown): Promise<void> {
    const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data: { data } });
    expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  }

  async function storedTemplate(request: APIRequestContext, flowId: string): Promise<{ data: CatalogFlowData; template: Template }> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
    expect(res.status(), `GET /api/v1/flows/${flowId}`).toBe(200);
    const data = (await res.json()).data as CatalogFlowData;
    return { data, template: nodeOf(data).template };
  }

  /** The one row flow save reconciled out of the node, polled until it satisfies `until`. */
  async function nodeTrigger(
    request: APIRequestContext,
    flowId: string,
    nodeId: string,
    until: (row: TriggerRead) => boolean = () => true,
    what = "the reconciled trigger row",
  ): Promise<TriggerRead> {
    let row: TriggerRead | undefined;
    await expect
      .poll(
        async () => {
          const rows = await listTriggers(request, headers, { flow_id: flowId });
          row = rows.length === 1 ? rows[0] : undefined;
          return row !== undefined && row.node_id === nodeId && until(row);
        },
        { message: what, timeout: 15_000 },
      )
      .toBe(true);
    return row!;
  }

  test(
    "each schedule type compiles on the server from a flow saved through the API",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const cases: Array<{ label: string; values: Record<string, unknown>; timing: Record<string, unknown> }> = [
        {
          label: "interval",
          values: { schedule_type: "At regular intervals", interval_minutes: 15, timezone: "America/Sao_Paulo" },
          timing: { interval_minutes: 15 },
        },
        {
          label: "once",
          values: { schedule_type: "Once", run_at: "2030-12-24T18:30", timezone: "Europe/Berlin" },
          timing: { run_at: "2030-12-24T18:30" },
        },
        {
          label: "daily several minutes",
          values: { schedule_type: "Daily", times_of_day: ["08:00", "12:00", "18:30"], timezone: "UTC" },
          timing: { crons: ["0 8,12 * * *", "30 18 * * *"] },
        },
        {
          label: "daily 12h clock",
          values: { schedule_type: "Daily", times_of_day: ["6:30 PM"], timezone: "UTC" },
          timing: { cron: "30 18 * * *" },
        },
        {
          label: "weekly",
          values: {
            schedule_type: "Weekly",
            days_of_week: ["Monday", "Tuesday", "Wednesday", "Friday"],
            times_of_day: ["09:15"],
            timezone: "Asia/Tokyo",
          },
          timing: { cron: "15 9 * * 1-3,5" },
        },
        {
          label: "monthly",
          values: { schedule_type: "Monthly", days_of_month: ["1", "15", "31"], times_of_day: ["07:00"], timezone: "UTC" },
          timing: { cron: "0 7 1,15,31 * *" },
        },
        {
          label: "custom",
          values: { schedule_type: "Custom (cron)", cron_expression: "*/7 3 * * 1-5", timezone: "UTC" },
          timing: { cron: "*/7 3 * * 1-5" },
        },
      ];

      for (const c of cases) {
        await test.step(`${c.label}: the row holds exactly ${JSON.stringify(c.timing)} in ${c.values.timezone}`, async () => {
          const nodeId = `ScheduleTrigger-p${createdFlowIds.length}`;
          const flowId = await saveFlow(request, c.label, graph(nodeId, c.values));
          const row = await nodeTrigger(request, flowId, nodeId);
          expect(timingOf(row.config), "the compiled timing, and no other timing key").toEqual(c.timing);
          expect(row.config.timezone, "the picked timezone").toBe(c.values.timezone);
          expect(row.reason, "a usable pick is pending, not invalid").toBe("pending");
        });
      }
    },
  );

  test(
    "an unusable pick stores no timing, reads config_invalid, and enabling it is refused with the picker's reason",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const nodeId = "ScheduleTrigger-unusable";
      const data = graph(nodeId, { schedule_type: "Daily", times_of_day: ["08:00"], timezone: "UTC" });
      const flowId = await saveFlow(request, "unusable", data);

      await test.step("a Daily pick compiles to its cron", async () => {
        const row = await nodeTrigger(request, flowId, nodeId);
        expect(timingOf(row.config)).toEqual({ cron: "0 8 * * *" });
      });

      let triggerId = "";

      await test.step("switching to Weekly with no days drops the old cron and reads config_invalid", async () => {
        const template = nodeOf(data).template;
        template.schedule_type.value = "Weekly";
        template.days_of_week.value = [];
        await patchFlow(request, flowId, data);
        const row = await nodeTrigger(request, flowId, nodeId, (r) => r.reason === "config_invalid", "the row turns config_invalid");
        triggerId = row.id;
        expect(timingOf(row.config), "the old schedule must not keep running").toEqual({ cron: "" });
        expect(row.last_error).toBe(WEEKLY_NO_DAYS_MESSAGE);
        expect(row.blocked_actions.resume).toBe("config_invalid");
      });

      await test.step("enabling it is refused 409 with the picker's message, not a cron error", async () => {
        const res = await request.post(`/api/v1/triggers/${triggerId}/enable`, { headers });
        const raw = await res.text();
        expect(res.status(), `POST /enable on an unusable pick — ${raw}`).toBe(409);
        expect(JSON.parse(raw).detail).toEqual({ code: null, message: WEEKLY_NO_DAYS_MESSAGE });
      });

      await test.step("a time of day the picker cannot read is refused the same way", async () => {
        const badId = "ScheduleTrigger-badtime";
        const badFlow = await saveFlow(
          request,
          "bad time",
          graph(badId, { schedule_type: "Daily", times_of_day: ["25:00"], timezone: "UTC" }),
        );
        const row = await nodeTrigger(request, badFlow, badId);
        expect({ timing: timingOf(row.config), reason: row.reason, last_error: row.last_error }).toEqual({
          timing: { cron: "" },
          reason: "config_invalid",
          last_error: BAD_TIME_MESSAGE,
        });
      });
    },
  );

  test(
    "a custom cron survives switching the type away and back",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const nodeId = "ScheduleTrigger-survive";
      const customCron = `*/${7 + (Date.now() % 20)} * * * *`;
      const data = graph(nodeId, { schedule_type: "Custom (cron)", cron_expression: customCron, timezone: "UTC" });
      const flowId = await saveFlow(request, "custom survives", data);

      await test.step("Custom runs the hand-written cron", async () => {
        const row = await nodeTrigger(request, flowId, nodeId);
        expect(timingOf(row.config)).toEqual({ cron: customCron });
      });

      await test.step("switching to Daily runs the Daily cron", async () => {
        const template = nodeOf(data).template;
        template.schedule_type.value = "Daily";
        template.times_of_day.value = ["08:00"];
        await patchFlow(request, flowId, data);
        const row = await nodeTrigger(request, flowId, nodeId, (r) => r.config.cron === "0 8 * * *", "the row runs the Daily cron");
        expect(timingOf(row.config)).toEqual({ cron: "0 8 * * *" });
      });

      await test.step("the stored node still holds the hand-written cron, and switching it back runs it again", async () => {
        const stored = await storedTemplate(request, flowId);
        expect(stored.template.cron_expression.value, "the compiled Daily cron must not overwrite the field").toBe(
          customCron,
        );
        // Built from the STORED flow, not this test's copy: that is what makes it a check of the server.
        stored.template.schedule_type.value = "Custom (cron)";
        await patchFlow(request, flowId, stored.data);
        const row = await nodeTrigger(request, flowId, nodeId, (r) => r.config.cron === customCron, "the row runs the custom cron again");
        expect(timingOf(row.config)).toEqual({ cron: customCron });
      });
    },
  );

  test(
    "a timezone that loads but is not listed is kept, and an unknown one is refused",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      await test.step(`${UNLISTED_TZ} is outside the picker's list and kept on the row`, async () => {
        const options = (findCatalogComponent(catalog, "ScheduleTrigger").template as Template).timezone.options as string[];
        expect(options.length, "the catalog lists the picker's zones").toBeGreaterThan(100);
        expect(options, "the zone must be outside the list for this to test anything").not.toContain(UNLISTED_TZ);

        const nodeId = "ScheduleTrigger-unlisted";
        const flowId = await saveFlow(
          request,
          "unlisted tz",
          graph(nodeId, { schedule_type: "Daily", times_of_day: ["08:00"], timezone: UNLISTED_TZ }),
        );
        const row = await nodeTrigger(request, flowId, nodeId);
        expect({ timezone: row.config.timezone, reason: row.reason }).toEqual({ timezone: UNLISTED_TZ, reason: "pending" });
      });

      await test.step("an unknown zone reads config_invalid with its reason", async () => {
        const nodeId = "ScheduleTrigger-unknowntz";
        const flowId = await saveFlow(
          request,
          "unknown tz",
          graph(nodeId, { schedule_type: "Daily", times_of_day: ["08:00"], timezone: "Etc/Unknown" }),
        );
        const row = await nodeTrigger(request, flowId, nodeId);
        expect({ reason: row.reason, last_error: row.last_error }).toEqual({
          reason: "config_invalid",
          last_error: UNKNOWN_TZ_MESSAGE,
        });
      });
    },
  );

  test(
    "a node saved before the picker keeps its own cron, on save and through Update",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const component = findCatalogComponent(catalog, "ScheduleTrigger") as unknown as { template: Template };
      const code = component.template.code.value as string;
      const defaultCron = component.template.cron_expression.value as string;
      const legacyCron = "5 4 * * *";

      /** A node as the picker-less component saved it: no `schedule_type` field at all. */
      function legacyNode(cron: string): StoredNode["data"]["node"] {
        const node = structuredClone(nodeOf(graph("ScheduleTrigger-legacy", { cron_expression: cron, timezone: "UTC" })));
        delete (node.template as Partial<Template>).schedule_type;
        return node;
      }

      async function update(frontendNode: StoredNode["data"]["node"]): Promise<Template> {
        const res = await request.post("/api/v1/custom_component", { headers, data: { code, frontend_node: frontendNode } });
        const raw = await res.text();
        expect(res.status(), `POST /api/v1/custom_component — ${raw.slice(0, 300)}`).toBe(200);
        return JSON.parse(raw).data.template as Template;
      }

      await test.step("saved without a schedule type, the row runs the node's own cron", async () => {
        const nodeId = "ScheduleTrigger-legacy";
        const data = graph(nodeId, { cron_expression: legacyCron, timezone: "UTC" });
        delete (nodeOf(data).template).schedule_type;
        const flowId = await saveFlow(request, "legacy", data);
        const row = await nodeTrigger(request, flowId, nodeId);
        expect(timingOf(row.config)).toEqual({ cron: legacyCron });
      });

      await test.step("Update opens it on Custom (cron) with its own cron shown", async () => {
        const t = await update(legacyNode(legacyCron));
        expect({ type: t.schedule_type.value, cron: t.cron_expression.value, cronShown: t.cron_expression.show }).toEqual({
          type: "Custom (cron)",
          cron: legacyCron,
          cronShown: true,
        });
      });

      await test.step("a node that already has a type keeps it through Update", async () => {
        const modern = structuredClone(
          nodeOf(
            graph("ScheduleTrigger-modern", {
              schedule_type: "Daily",
              times_of_day: ["08:00"],
              cron_expression: legacyCron,
              timezone: "UTC",
            }),
          ),
        );
        expect((await update(modern)).schedule_type.value).toBe("Daily");
      });

      await test.step("a picker-less node whose cron equals the picker defaults opens on the defaults", async () => {
        const defaultType = component.template.schedule_type.value;
        const t = await update(legacyNode(defaultCron));
        expect({ type: t.schedule_type.value, cron: t.cron_expression.value }).toEqual({
          type: defaultType,
          cron: defaultCron,
        });
        expect(defaultType, "the defaults are a picked type, not Custom").not.toBe("Custom (cron)");
      });
    },
  );
});
