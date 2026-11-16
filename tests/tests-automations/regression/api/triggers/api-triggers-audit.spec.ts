import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// The audit trail of trigger actions, read through GET /api/v1/authz/audit (#2451).
// Spec doc: docs/api/triggers/api-triggers-audit.md
//
// Every row is read by its action AND its trigger's id, and the bulk actions select
// by trigger_ids, so a parallel worker's rows and triggers never enter a count. The
// one row a policy writes (trigger:policy_denied) needs an instance-global policy
// change and lives in governance/trigger-policy-enforcement.spec.ts.
test.describe("Triggers — the audit trail of owner and operator actions", () => {
  // The first nightly carrying every audit fix of the batch (upstream #16374, #16384).
  const SINCE = "1.14.0.dev26";
  const NODE_ID = "InboundWebhookTrigger-a01";
  const NOT_SUPERUSER = "The user doesn't have enough privileges";
  // Events a dispatcher has not settled yet.
  const UNSETTLED = ["pending", "claimed", "dispatched"];

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let headers: Record<string, string> = {};
  let superuserId = "";

  interface TriggerRead {
    id: string;
    state: string;
    reason: string | null;
  }

  interface AuditRow {
    action: string;
    user_id: string | null;
    resource_type: string | null;
    resource_id: string | null;
    result: string;
    details: Record<string, unknown> | null;
  }

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `the trigger audit rows are complete from ${SINCE}; this build does not carry them all`,
    );
    headers = { Authorization: await getAuthToken(request) };
    const whoami = await request.get("/api/v1/users/whoami", { headers });
    expect(whoami.status()).toBe(200);
    superuserId = ((await whoami.json()) as { id: string }).id;
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  /** An Inbound Webhook → Chat Output flow, and the trigger row its save reconciled. */
  async function webhookTrigger(request: APIRequestContext, label: string): Promise<{ flowId: string; trigger: TriggerRead }> {
    const catalog = await fetchComponentCatalog(request, headers);
    const flowId = await createCatalogFlow(
      request,
      catalog,
      {
        nodes: [
          { id: NODE_ID, type: "InboundWebhookTrigger" },
          { id: "ChatOutput-a01", type: "ChatOutput" },
        ],
        edges: [{ source: NODE_ID, output: "trigger_event", target: "ChatOutput-a01", field: "input_value" }],
      },
      { name: `E2E trigger audit ${label} ${run}`, headers },
    );
    flowIds.push(flowId);
    let rows: TriggerRead[] = [];
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers });
          rows = res.status() === 200 ? await res.json() : [];
          return rows.length;
        },
        { message: "flow save reconciles the trigger node into one row", timeout: 15_000 },
      )
      .toBe(1);
    return { flowId, trigger: rows[0] };
  }

  async function triggerAction(request: APIRequestContext, triggerId: string, action: string): Promise<TriggerRead> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/${action}`, { headers });
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  async function readTrigger(request: APIRequestContext, triggerId: string): Promise<TriggerRead> {
    const res = await request.get(`/api/v1/triggers/${triggerId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  /** The audit rows of one action on one trigger. */
  async function auditRows(request: APIRequestContext, action: string, triggerId: string): Promise<AuditRow[]> {
    const res = await request.get(`/api/v1/authz/audit?action=${action}&resource_id=${triggerId}&size=50`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return (JSON.parse(text) as { items: AuditRow[] }).items;
  }

  /** The row names its trigger and its actor, and reads as allowed. */
  function expectRowOf(row: AuditRow, triggerId: string): void {
    expect(row.resource_type).toBe("trigger");
    expect(row.resource_id).toBe(triggerId);
    expect(row.user_id, "the acting superuser").toBe(superuserId);
    expect(row.result).toBe("allow");
    expect(row.details?.event).toBe("mutation");
  }

  test(
    "an owner's resume, pause and replay each write one audit row naming the trigger",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const { flowId, trigger } = await webhookTrigger(request, "owner");
      let original = "";
      let replay = "";

      await test.step("enable, disable and enable the trigger", async () => {
        expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");
        expect((await triggerAction(request, trigger.id, "disable")).state).toBe("paused");
        expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");
      });

      await test.step("send a test event and replay it", async () => {
        const sent = await request.post(`/api/v1/triggers/${trigger.id}/test`, { headers, data: { payload: { run } } });
        expect(sent.status(), await sent.text()).toBe(202);
        original = ((await sent.json()) as { id: string }).id;
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/triggers/${trigger.id}/events`, { headers });
              const events = (await res.json()) as Array<{ id: string; state: string }>;
              return events.find((event) => event.id === original)?.state;
            },
            { message: "the test event settles before it is replayed", timeout: 45_000 },
          )
          .not.toMatch(new RegExp(`^(${UNSETTLED.join("|")})$`));
        const replayed = await request.post(`/api/v1/triggers/${trigger.id}/replay`, {
          headers,
          data: { event_id: original },
        });
        expect(replayed.status(), await replayed.text()).toBe(202);
        replay = ((await replayed.json()) as { id: string }).id;
      });

      await test.step("one row per action, each naming the trigger, its actor and its flow", async () => {
        const resumes = await auditRows(request, "trigger:resume", trigger.id);
        const pauses = await auditRows(request, "trigger:pause", trigger.id);
        const replays = await auditRows(request, "trigger:replay", trigger.id);
        expect(resumes, "one row per enable").toHaveLength(2);
        expect(pauses, "one row per disable").toHaveLength(1);
        expect(replays, "one row per replay").toHaveLength(1);
        for (const row of [...resumes, ...pauses, ...replays]) {
          expectRowOf(row, trigger.id);
          expect(row.details?.flow_id, "an owner row names the flow").toBe(flowId);
        }
        expect(replays[0].details).toEqual(
          expect.objectContaining({ original_event_id: original, replay_event_id: replay }),
        );
      });
    },
  );

  test(
    "an operator's bulk pause and resume write admin rows only for the triggers it selected",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request }) => {
      const selected = (await webhookTrigger(request, "selected")).trigger;
      const other = (await webhookTrigger(request, "other")).trigger;
      expect((await triggerAction(request, selected.id, "enable")).state).toBe("active");
      expect((await triggerAction(request, other.id, "enable")).state).toBe("active");

      await test.step("a bulk pause by id pauses only the trigger it names", async () => {
        const res = await request.post("/api/v1/triggers/bulk/pause", { headers, data: { trigger_ids: [selected.id] } });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        expect((JSON.parse(text) as { changed: string[] }).changed).toEqual([selected.id]);
        const paused = await readTrigger(request, selected.id);
        expect(paused.state).toBe("paused");
        expect(paused.reason).toBe("paused_by_admin");
        expect((await readTrigger(request, other.id)).state).toBe("active");
      });

      await test.step("the pause writes one admin row for that trigger and none for the other", async () => {
        const rows = await auditRows(request, "trigger:admin_pause", selected.id);
        expect(rows).toHaveLength(1);
        expectRowOf(rows[0], selected.id);
        expect(await auditRows(request, "trigger:admin_pause", other.id)).toEqual([]);
      });

      await test.step("the resume puts it back and writes one admin row for it", async () => {
        const res = await request.post("/api/v1/triggers/bulk/resume", { headers, data: { trigger_ids: [selected.id] } });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        expect((JSON.parse(text) as { changed: string[] }).changed).toEqual([selected.id]);
        expect((await readTrigger(request, selected.id)).state).toBe("active");
        const rows = await auditRows(request, "trigger:admin_resume", selected.id);
        expect(rows).toHaveLength(1);
        expectRowOf(rows[0], selected.id);
        expect(await auditRows(request, "trigger:admin_resume", other.id)).toEqual([]);
      });
    },
  );

  test(
    "the audit log answers only a superuser and is left out of the OpenAPI schema",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ playwright, request }, testInfo) => {
      await test.step("a non-superuser is refused, the superuser is answered", async () => {
        const owner = await createConnectionsOwner(
          () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
          "trgaudit",
        );
        try {
          const refused = await request.get("/api/v1/authz/audit", { headers: owner.headers });
          expect(refused.status()).toBe(403);
          expect((await refused.json()).detail).toBe(NOT_SUPERUSER);
        } finally {
          await owner.dispose();
        }
        const answered = await request.get("/api/v1/authz/audit?size=1", { headers });
        expect(answered.status()).toBe(200);
        expect(await answered.json()).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number) }));
      });

      await test.step("the OpenAPI schema lists the trigger routes but not the audit read", async () => {
        const res = await request.get("/openapi.json");
        expect(res.status()).toBe(200);
        const paths = Object.keys(((await res.json()) as { paths: Record<string, unknown> }).paths);
        expect(paths, "a sanity read: the schema lists the trigger routes").toContain("/api/v1/triggers");
        expect(paths).not.toContain("/api/v1/authz/audit");
      });
    },
  );
});
