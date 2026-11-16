import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { type CatalogFlowSpec, createCatalogFlow, fetchComponentCatalog } from "../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import {
  buildBundleWrite,
  bundleV2Sets,
  describeBundleV2,
  isBundleV2Pristine,
  type PolicyBundleV2Sets,
  readPolicyBundle,
  readPolicyBundleV2,
  restorePolicyBundleV2,
  writePolicyBundleV2,
} from "../../../helpers/governance/policy-state";
import { servedVersionAtLeast } from "../../../helpers/other/served-version";

// Which trigger kinds may run: the palette, arming, live triggers and dispatch (#2451).
// Spec doc: docs/governance/trigger-policy-enforcement.md
//
// `approved_trigger_kinds` is instance-global, so this file is @destructive and
// refuses to run unless the bundle is pristine. Live rows of a denied kind are paused
// by the policy refresh worker (every 10 s by default), not by the write, so every
// convergence below is polled. The dispatch branch races that refresh, and test 3
// aligns with it first: see the spec doc's "Measured" section.
test.describe.configure({ mode: "serial" });

test.describe("governance — which trigger kinds may run", () => {
  // Trigger governance shipped in upstream #16333, first in 1.14.0.dev23.
  const SINCE = "1.14.0.dev23";
  const REASON = "e2e #2451 trigger policy enforcement";
  const POLICY_MESSAGE = "Blocked by trigger policy. Ask an administrator to approve this trigger kind.";
  const POLICY_BLOCKED = { code: "policy_blocked", message: POLICY_MESSAGE };
  // One refresh is 10 s by default; twice that absorbs a slow tick.
  const REFRESH_TIMEOUT = 20_000;
  // Under the server's 2 s keep-alive, as in the ingress spec.
  const POLL = { intervals: [1_000] };
  const WEBHOOK_NODE = "InboundWebhookTrigger-p01";
  const SCHEDULE_NODE = "ScheduleTrigger-p01";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let auth = "";
  let headers: Record<string, string> = {};
  let snapshot: PolicyBundleV2Sets | undefined;
  let skipReason = "";

  interface TriggerRead {
    id: string;
    kind: string;
    state: string;
    reason: string | null;
    last_error: string | null;
    last_error_code: string | null;
  }

  interface AuditRow {
    action: string;
    result: string;
    details: Record<string, unknown> | null;
  }

  test.beforeAll(async ({ request }) => {
    auth = await getAuthToken(request);
    headers = { Authorization: auth };
    if (!(await servedVersionAtLeast(request, SINCE))) {
      skipReason = `trigger governance ships in ${SINCE} (upstream #16333); this build does not carry it`;
      return;
    }
    const bundle = await readPolicyBundleV2(request, auth);
    if (!isBundleV2Pristine(bundle)) {
      skipReason = `instance already carries a policy (${describeBundleV2(bundle)}) — a "denied ⇒ refused" assertion would be unfalsifiable`;
      return;
    }
    snapshot = bundleV2Sets(bundle);
  });

  test.beforeEach(() => {
    test.skip(snapshot === undefined, skipReason);
  });

  test.afterEach(async ({ page, request }) => {
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  test.afterAll(async ({ request }) => {
    if (snapshot === undefined) return;
    await restorePolicyBundleV2(request, auth, snapshot, `${REASON} — restore`);
  });

  async function createFlow(request: APIRequestContext, label: string, spec: CatalogFlowSpec): Promise<string> {
    const catalog = await fetchComponentCatalog(request, headers);
    const id = await createCatalogFlow(request, catalog, spec, { name: `E2E trigger policy ${label} ${run}`, headers });
    flowIds.push(id);
    return id;
  }

  async function triggersOf(request: APIRequestContext, flowId: string): Promise<TriggerRead[]> {
    const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead[];
  }

  /** The one row flow save reconciled out of the flow's trigger node. */
  async function nodeTrigger(request: APIRequestContext, flowId: string): Promise<TriggerRead> {
    let rows: TriggerRead[] = [];
    await expect
      .poll(async () => (rows = await triggersOf(request, flowId)).length, {
        message: "flow save reconciles the trigger node into one row",
        timeout: 15_000,
      })
      .toBe(1);
    return rows[0];
  }

  async function webhookTrigger(request: APIRequestContext, label: string, enable: boolean) {
    const flowId = await createFlow(request, label, {
      nodes: [
        { id: WEBHOOK_NODE, type: "InboundWebhookTrigger" },
        { id: "ChatOutput-p01", type: "ChatOutput" },
      ],
      edges: [{ source: WEBHOOK_NODE, output: "trigger_event", target: "ChatOutput-p01", field: "input_value" }],
    });
    const trigger = await nodeTrigger(request, flowId);
    expect(trigger.kind).toBe("inbound_webhook");
    if (enable) expect((await triggerAction(request, trigger.id, "enable")).status()).toBe(200);
    return { flowId, trigger };
  }

  async function scheduleTrigger(request: APIRequestContext, label: string) {
    const flowId = await createFlow(request, label, { nodes: [{ id: SCHEDULE_NODE, type: "ScheduleTrigger" }], edges: [] });
    const trigger = await nodeTrigger(request, flowId);
    expect(trigger.kind).toBe("schedule");
    expect(trigger.state).toBe("pending");
    return { flowId, trigger };
  }

  function triggerAction(request: APIRequestContext, triggerId: string, action: string) {
    return request.post(`/api/v1/triggers/${triggerId}/${action}`, { headers });
  }

  async function readTrigger(request: APIRequestContext, triggerId: string): Promise<TriggerRead> {
    const res = await request.get(`/api/v1/triggers/${triggerId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  /** Waits for the policy refresh to pause the row, then checks it says why. */
  async function expectPausedByPolicy(request: APIRequestContext, triggerId: string): Promise<void> {
    await expect
      .poll(async () => (await readTrigger(request, triggerId)).state, {
        message: "the policy refresh pauses a live trigger of a denied kind",
        timeout: REFRESH_TIMEOUT,
        ...POLL,
      })
      .toBe("paused");
    const row = await readTrigger(request, triggerId);
    expect(row.reason).toBe("paused");
    expect(row.last_error_code).toBe("policy_blocked");
    expect(row.last_error).toBe(POLICY_MESSAGE);
  }

  async function expectPolicyRefusal(res: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<void> {
    const text = await res.text();
    expect(res.status(), text).toBe(403);
    expect(JSON.parse(text).detail).toEqual(POLICY_BLOCKED);
  }

  async function setTriggerKinds(request: APIRequestContext, kinds: string[] | null): Promise<void> {
    const written = await writePolicyBundleV2(request, auth, { approved_trigger_kinds: kinds }, REASON);
    expect(written.approved_trigger_kinds ?? null, "the write answers the new value").toEqual(kinds);
  }

  /** The component types the palette's Triggers category offers. */
  async function paletteTriggers(request: APIRequestContext): Promise<string[]> {
    const res = await request.get("/api/v1/all", { headers });
    expect(res.status()).toBe(200);
    return Object.keys(((await res.json()) as Record<string, Record<string, unknown>>).triggers ?? {}).sort();
  }

  async function policyDenials(request: APIRequestContext, triggerId: string): Promise<AuditRow[]> {
    const res = await request.get(`/api/v1/authz/audit?action=trigger:policy_denied&resource_id=${triggerId}&size=50`, {
      headers,
    });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return (JSON.parse(text) as { items: AuditRow[] }).items;
  }

  /** The sidebar's search, with a non-trigger row as the control that it has rendered. */
  async function searchSidebar(page: Page, term: string): Promise<void> {
    await page.getByTestId("sidebar-search-input").fill(term);
  }

  test(
    "approving only Schedule hides Inbound Webhook, refuses arming it, and pauses the one already active",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ page, request }) => {
      const webhook = await webhookTrigger(request, "webhook", true);
      const schedule = await scheduleTrigger(request, "schedule");
      const paletteFlow = await createFlow(request, "palette", { nodes: [{ id: "ChatOutput-p02", type: "ChatOutput" }], edges: [] });

      await test.step("the write answers the new facet, and both API versions read it", async () => {
        await setTriggerKinds(request, ["schedule"]);
        expect((await readPolicyBundleV2(request, auth)).approved_trigger_kinds).toEqual(["schedule"]);
        const v1 = (await readPolicyBundle(request, auth)) as { approved_trigger_kinds?: string[] | null };
        expect(v1.approved_trigger_kinds).toEqual(["schedule"]);
      });

      await test.step("the palette offers Schedule and not Inbound Webhook", async () => {
        expect(await paletteTriggers(request)).toEqual(["ScheduleTrigger"]);
        await openFlowById(page, paletteFlow);
        await searchSidebar(page, "schedule");
        await expect(page.getByTestId("triggers_schedule_draggable")).toBeVisible();
        await searchSidebar(page, "inbound webhook");
        await expect(page.getByTestId("triggers_inbound webhook_draggable")).toHaveCount(0);
      });

      await test.step("the active webhook trigger is paused by the policy; the Schedule one is left alone", async () => {
        await expectPausedByPolicy(request, webhook.trigger.id);
        expect((await readTrigger(request, schedule.trigger.id)).state).toBe("pending");
      });

      await test.step("arming a denied kind is refused, creating it unarmed is not", async () => {
        await expectPolicyRefusal(await triggerAction(request, webhook.trigger.id, "enable"));
        const armed = await request.post("/api/v1/triggers", {
          headers,
          data: { flow_id: paletteFlow, name: `E2E armed ${run}`, kind: "inbound_webhook", state: "active" },
        });
        await expectPolicyRefusal(armed);
        const unarmed = await request.post("/api/v1/triggers", {
          headers,
          data: { flow_id: paletteFlow, name: `E2E unarmed ${run}`, kind: "inbound_webhook" },
        });
        const text = await unarmed.text();
        expect(unarmed.status(), text).toBe(201);
        const created = JSON.parse(text) as TriggerRead;
        expect(created.state).toBe("pending");
        expect(
          (await triggersOf(request, paletteFlow)).map((row) => row.id),
          "the refused create left no row",
        ).toEqual([created.id]);
        await expectPausedByPolicy(request, created.id);
      });

      await test.step("the pause and the refused enable each write a policy denial", async () => {
        const rows = await policyDenials(request, webhook.trigger.id);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.result).toBe("deny");
          expect(row.details).toEqual(
            expect.objectContaining({ kind: "inbound_webhook", purpose: "enable", flow_id: webhook.flowId }),
          );
        }
      });

      await test.step("a v1 write that leaves the facet out keeps it", async () => {
        const current = await readPolicyBundle(request, auth);
        const res = await request.put("/api/v1/policy-bundle", {
          headers,
          data: buildBundleWrite(current, {}, `${REASON} — v1 writer`),
        });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        expect(JSON.parse(text).approved_trigger_kinds).toEqual(["schedule"]);
      });
    },
  );

  test(
    "an empty list denies every kind, and null brings the palette back but not the paused triggers",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ page, request }) => {
      const schedule = await scheduleTrigger(request, "deny all");

      await test.step("[] empties the Triggers category and pauses the pending Schedule trigger", async () => {
        await setTriggerKinds(request, []);
        expect(await paletteTriggers(request)).toEqual([]);
        await openFlowById(page, schedule.flowId);
        await searchSidebar(page, "chat output");
        await expect(page.getByTestId("input_output_chat output_draggable"), "the search has rendered").toBeVisible();
        await searchSidebar(page, "schedule");
        await expect(page.getByTestId("triggers_schedule_draggable")).toHaveCount(0);
        await expectPausedByPolicy(request, schedule.trigger.id);
        await expectPolicyRefusal(await triggerAction(request, schedule.trigger.id, "enable"));
      });

      await test.step("null brings both kinds back, but the Schedule trigger stays paused", async () => {
        await setTriggerKinds(request, null);
        expect(await paletteTriggers(request)).toEqual(["InboundWebhookTrigger", "ScheduleTrigger"]);
        const row = await readTrigger(request, schedule.trigger.id);
        expect(row.state, "lifting a policy does not resume what it paused").toBe("paused");
        expect(row.last_error_code).toBe("policy_blocked");
      });

      await test.step("its owner can resume it", async () => {
        const res = await triggerAction(request, schedule.trigger.id, "enable");
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        expect(JSON.parse(text).state).toBe("active");
      });
    },
  );

  test(
    "an event dispatched under a newly denied kind fails as policy_blocked and pauses its trigger",
    { tag: ["@destructive", "@api", "@integrations", "@governance"] },
    async ({ request }) => {
      const webhook = await webhookTrigger(request, "dispatch", true);
      const canary = await scheduleTrigger(request, "canary");
      let eventId = "";

      await test.step("deny only Schedule, and wait for the refresh to pause the canary", async () => {
        await setTriggerKinds(request, ["inbound_webhook"]);
        await expectPausedByPolicy(request, canary.trigger.id);
        expect((await readTrigger(request, webhook.trigger.id)).state, "an approved kind keeps running").toBe("active");
      });

      await test.step("at once, queue an event and deny Inbound Webhook", async () => {
        const sent = await request.post(`/api/v1/triggers/${webhook.trigger.id}/test`, { headers, data: { payload: { run } } });
        const text = await sent.text();
        expect(sent.status(), text).toBe(202);
        eventId = (JSON.parse(text) as { id: string }).id;
        await setTriggerKinds(request, ["schedule"]);
      });

      await test.step("the dispatcher refuses the event and pauses the trigger", async () => {
        let event: { state: string; error: string | null } | undefined;
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/v1/triggers/${webhook.trigger.id}/events`, { headers });
              event = ((await res.json()) as Array<{ id: string; state: string; error: string | null }>).find(
                (row) => row.id === eventId,
              );
              return event?.state;
            },
            { message: "the queued event is dispatched before the next refresh", timeout: REFRESH_TIMEOUT, ...POLL },
          )
          .toBe("failed");
        expect(event?.error, "refused by the policy, not by a paused trigger").toBe("policy_blocked");
        const row = await readTrigger(request, webhook.trigger.id);
        expect(row.state).toBe("paused");
        expect(row.last_error_code).toBe("policy_blocked");
      });

      await test.step("one denial is audited, for the dispatch", async () => {
        const rows = await policyDenials(request, webhook.trigger.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].result).toBe("deny");
        expect(rows[0].details).toEqual(
          expect.objectContaining({ kind: "inbound_webhook", purpose: "dispatch", flow_id: webhook.flowId }),
        );
      });
    },
  );
});
