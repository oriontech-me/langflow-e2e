import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  buildCatalogFlow,
  type CatalogFlowData,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { createConnectionViaApi } from "../../../../helpers/integrations/create-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import { deliverSignedWebhook, jsonBody, mintSigningSecret } from "../../../../helpers/triggers/sign-webhook";
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  pinTrigger,
  setTriggerEnabled,
  TRIGGER_READ_KEYS,
  type TriggerCreate,
  type TriggerRead,
  type TriggerState,
  updateTrigger,
} from "../../../../helpers/triggers/trigger-api";

// The trigger lifecycle: CRUD, the state machine, pinning, the canvas-only kinds,
// flow-save reconciliation, and the three leads from manual QA (#2303).
// Spec doc: docs/api/triggers/api-triggers-lifecycle.md
//
// The sibling files in this directory each made the trigger they needed; this one
// owns the calls themselves. Every premise below was measured on 1.14.0.dev32, and
// four of the issue's (written against release-1.13.0 code) did not hold — the
// spec doc lists them. Every row is created by a throwaway owner made once per
// worker, so nothing here can touch another spec's triggers.
test.describe("Triggers — the lifecycle", () => {
  // `last_error_code` — part of the 28-key TriggerRead this file asserts — is
  // upstream #16132's, first in 1.14.0.dev16.
  const LIFECYCLE_SINCE = "1.14.0.dev16";
  const NOT_FOUND = { detail: "Trigger not found" };
  const VERSION_NOT_FOUND = { detail: "Flow version not found for this trigger's flow." };
  const NODE_REMOVED_ERROR = "trigger node removed from the flow";
  const NODE_REMOVED_REFUSAL = {
    detail: {
      code: "node_removed",
      message: "The trigger node was removed from the flow. Add it back to resume the trigger.",
    },
  };
  const INVALID_CRON = "Invalid cron expression: a valid five-field cron expression is required.";
  const BAD_SCHEMA_ERROR = "The payload schema must be valid JSON, or empty to accept any body.";
  const DEPLOYMENT_NOT_DISPATCHED =
    "Trigger binding target 'deployment' is stored but not dispatched in this release; re-bind the trigger to its flow to run it.";
  // A yearly cron: armed in test 5, it must not fire inside a run.
  const CRON = "0 0 1 1 *";
  const SCHEDULE_NODE = "ScheduleTrigger-life01";
  const WEBHOOK_NODE = "InboundWebhookTrigger-life01";
  const CANVAS_ONLY_KINDS = [
    "slack.message",
    "slack.reaction",
    "microsoft.mail",
    "microsoft.calendar",
    "microsoft.file",
    "google.gmail",
    "google.calendar",
    "google.drive",
  ];
  const UNSETTLED_EVENT_STATES = ["pending", "claimed", "dispatched"];

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  interface TriggerEventRead {
    id: string;
    state: string;
    payload: Record<string, unknown>;
    error: string | null;
  }

  // One throwaway owner per worker: its login counts against the per-IP login
  // budget (5/min). Deleting it takes its flows and triggers with it.
  let owner: ConnectionsOwner | undefined;
  const headers = () => (owner as ConnectionsOwner).headers;
  const flowIds: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "trglife",
    );
  });

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, LIFECYCLE_SINCE)),
      `the TriggerRead this file pins ships in ${LIFECYCLE_SINCE} (upstream #16132); this build does not carry it`,
    );
  });

  test.afterEach(async ({ request }) => {
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers: headers() }).catch((error) => {
        // Already gone (test 5 deletes one on purpose) or left for the owner's
        // deletion in afterAll, which takes every flow it owns.
        if (!String(error).includes("404")) console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  const sorted = (values: string[]) => [...values].sort();

  async function emptyFlow(request: APIRequestContext, label: string): Promise<string> {
    const id = await createFlow(
      request,
      { name: `E2E lifecycle ${label} ${run}`, data: { nodes: [], edges: [] } },
      { headers: headers() },
    );
    flowIds.push(id);
    return id;
  }

  async function catalogFlow(request: APIRequestContext, label: string, data: CatalogFlowData): Promise<string> {
    const id = await createFlow(request, { name: `E2E lifecycle ${label} ${run}`, data }, { headers: headers() });
    flowIds.push(id);
    return id;
  }

  /** A graph holding one Schedule node on the yearly cron. */
  async function scheduleGraph(request: APIRequestContext): Promise<CatalogFlowData> {
    const catalog = await fetchComponentCatalog(request, headers());
    // Since upstream #16322 (1.14.0.dev30) `schedule_type` decides whether the cron
    // is read at all, and defaults to Weekly. Builds before it have no such field,
    // and there the cron is the schedule — so it is set only when it exists.
    const values: Record<string, unknown> = { cron_expression: CRON };
    if ("schedule_type" in findCatalogComponent(catalog, "ScheduleTrigger").template) {
      values.schedule_type = "Custom (cron)";
    }
    return buildCatalogFlow(catalog, { nodes: [{ id: SCHEDULE_NODE, type: "ScheduleTrigger", values }], edges: [] });
  }

  /** A graph holding one Inbound Webhook node whose `payload_schema` is the given text. */
  async function webhookGraph(request: APIRequestContext, payloadSchema: string): Promise<CatalogFlowData> {
    const catalog = await fetchComponentCatalog(request, headers());
    return buildCatalogFlow(catalog, {
      nodes: [{ id: WEBHOOK_NODE, type: "InboundWebhookTrigger", values: { payload_schema: payloadSchema } }],
      edges: [],
    });
  }

  /** The one row flow save reconciled out of the flow's trigger node. */
  async function nodeTrigger(request: APIRequestContext, flowId: string, nodeId: string): Promise<TriggerRead> {
    let rows: TriggerRead[] = [];
    await expect
      .poll(async () => (rows = await listTriggers(request, headers(), { flow_id: flowId })).length, {
        message: "flow save reconciles the trigger node into one row",
        timeout: 10_000,
      })
      .toBe(1);
    expect(rows[0].node_id, "the row is bound to the trigger node").toBe(nodeId);
    return rows[0];
  }

  async function patchFlowData(request: APIRequestContext, flowId: string, data: unknown): Promise<void> {
    const res = await request.patch(`/api/v1/flows/${flowId}`, { headers: headers(), data: { data } });
    expect(res.status(), await res.text()).toBe(200);
  }

  async function expectDetail(res: { status(): number; text(): Promise<string> }, status: number, body: unknown) {
    const text = await res.text();
    expect(res.status(), text).toBe(status);
    expect(JSON.parse(text)).toEqual(body);
  }

  /** The single FastAPI validation entry of a 422, as `{type, loc}` (plus `msg` when asked). */
  async function validationError(res: { status(): number; text(): Promise<string> }) {
    const text = await res.text();
    expect(res.status(), text).toBe(422);
    const detail = (JSON.parse(text) as { detail: Array<{ type: string; loc: unknown[]; msg: string }> }).detail;
    expect(detail, text).toHaveLength(1);
    return detail[0];
  }

  const make = (request: APIRequestContext, flowId: string, name: string, extra: Partial<TriggerCreate> = {}) =>
    createTrigger(request, headers(), { flow_id: flowId, name: `${name} ${run}`, kind: "inbound_webhook", ...extra });

  async function snapshot(request: APIRequestContext, flowId: string): Promise<string> {
    const res = await request.post(`/api/v1/flows/${flowId}/versions/`, { headers: headers(), data: {} });
    const text = await res.text();
    expect(res.status(), text).toBe(201);
    return (JSON.parse(text) as { id: string }).id;
  }

  async function events(request: APIRequestContext, triggerId: string): Promise<TriggerEventRead[]> {
    const res = await request.get(`/api/v1/triggers/${triggerId}/events`, { headers: headers() });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerEventRead[];
  }

  /** The trigger's one event, once the dispatcher has settled it. */
  async function settledOnlyEvent(request: APIRequestContext, triggerId: string, what: string): Promise<TriggerEventRead> {
    let rows: TriggerEventRead[] = [];
    await expect
      .poll(
        async () => {
          rows = await events(request, triggerId);
          return rows.length === 1 && !UNSETTLED_EVENT_STATES.includes(rows[0].state);
        },
        { message: `${what} settles into exactly one event`, timeout: 45_000 },
      )
      .toBe(true);
    return rows[0];
  }

  test(
    "creates, reads, lists, updates and deletes a trigger on the owner's own flow",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/flows/{flow_id}/versions/",
        "POST /api/v1/connections",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "PATCH /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/pin",
        "DELETE /api/v1/triggers/{trigger_id}",
      ]);
      const flowId = await emptyFlow(request, "crud");

      const created = await test.step("Create answers 201 with the 28 keys, the defaults, and the flow owner as owner", async () => {
        const row = await make(request, flowId, "crud");
        expect(sorted(Object.keys(row))).toEqual([...TRIGGER_READ_KEYS]);
        expect(row).toMatchObject({
          flow_id: flowId,
          user_id: (owner as ConnectionsOwner).userId,
          kind: "inbound_webhook",
          state: "pending",
          reason: "pending",
          binding_target: "flow",
          session_policy: "per_event",
          concurrency_limit: 1,
          max_attempts: 5,
          config: {},
          provider: null,
          node_id: null,
          connection_id: null,
          deployment_id: null,
          flow_version_id: null,
          last_error: null,
        });
        return row;
      });

      await test.step("GET by id returns the created row; the flow's list holds exactly it, with the flow's name", async () => {
        expect(await getTrigger(request, headers(), created.id)).toEqual(created);
        const rows = await listTriggers(request, headers(), { flow_id: flowId });
        expect(rows.map((row) => row.id)).toEqual([created.id]);
        expect(rows[0].flow_name).toBe(`E2E lifecycle crud ${run}`);
      });

      await test.step("PATCH changes name, concurrency_limit, max_attempts and session_policy, and a re-read agrees", async () => {
        const change = { name: `crud renamed ${run}`, concurrency_limit: 3, max_attempts: 7, session_policy: "shared" as const };
        expect(await updateTrigger(request, headers(), created.id, change)).toMatchObject(change);
        expect(await getTrigger(request, headers(), created.id)).toMatchObject(change);
      });

      await test.step("An explicit null on each required field is refused, and nothing changes", async () => {
        const before = await getTrigger(request, headers(), created.id);
        for (const field of ["name", "config", "binding_target", "session_policy", "concurrency_limit", "max_attempts"]) {
          const entry = await validationError(
            await request.patch(`/api/v1/triggers/${created.id}`, { headers: headers(), data: { [field]: null } }),
          );
          expect(entry, `PATCH {${field}: null}`).toEqual({
            type: "value_error",
            loc: ["body", field],
            msg: "Value error, This field cannot be null.",
          });
        }
        expect(await getTrigger(request, headers(), created.id)).toEqual(before);
      });

      await test.step("An explicit null clears each nullable reference that was set, and a re-read agrees", async () => {
        // Each reference is SET first: clearing a field that is already null proves
        // nothing, and would pass a server that dropped nulls (exclude_none) instead
        // of honouring them (exclude_unset). `deployment_id` is not among them: it is a
        // foreign key to a deployment row this suite cannot make (that needs a provider
        // account), and a made-up id is the deployment lead's subject — accepted where
        // the database does not enforce foreign keys, a 500 where it does (#2539).
        const connection = await createConnectionViaApi(request, headers(), { label: "trglife refs" });
        const version = await snapshot(request, flowId);
        const set = {
          connection_id: connection.id,
          flow_version_id: version,
        };
        await updateTrigger(request, headers(), created.id, { connection_id: set.connection_id });
        await pinTrigger(request, headers(), created.id, set.flow_version_id);
        const before = await getTrigger(request, headers(), created.id);
        expect(
          { connection_id: before.connection_id, flow_version_id: before.flow_version_id },
          "the two references are set before they are cleared",
        ).toEqual(set);
        for (const field of ["connection_id", "flow_version_id"] as const) {
          expect((await updateTrigger(request, headers(), created.id, { [field]: null }))[field], `PATCH {${field}: null}`).toBeNull();
          expect((await getTrigger(request, headers(), created.id))[field], `PATCH {${field}: null}, re-read`).toBeNull();
        }
      });

      await test.step("A schedule created through the API validates its cron, on create and on PATCH", async () => {
        const schedule = await createTrigger(request, headers(), {
          flow_id: flowId,
          name: `crud schedule ${run}`,
          kind: "schedule",
          config: { cron: CRON },
        });
        const expected = { kind: "schedule", state: "pending", config: { cron: CRON, timezone: "UTC", catchup_policy: "coalesce" } };
        expect(schedule).toMatchObject(expected);
        expect(await getTrigger(request, headers(), schedule.id)).toMatchObject(expected);
        await expectDetail(
          await request.post("/api/v1/triggers", {
            headers: headers(),
            data: { flow_id: flowId, name: `crud bad cron ${run}`, kind: "schedule", config: { cron: "not a cron" } },
          }),
          422,
          { detail: INVALID_CRON },
        );
        await expectDetail(
          await request.patch(`/api/v1/triggers/${schedule.id}`, { headers: headers(), data: { config: { cron: "not a cron" } } }),
          422,
          { detail: INVALID_CRON },
        );
        expect((await getTrigger(request, headers(), schedule.id)).config).toEqual(expected.config);
        await deleteTrigger(request, headers(), schedule.id);
      });

      await test.step("DELETE answers 204; afterwards GET and a second DELETE are 404 and the list is empty", async () => {
        // The helper throws on anything but a 204, and returns the parsed body: none.
        expect(await deleteTrigger(request, headers(), created.id)).toBeUndefined();
        await expectDetail(await request.get(`/api/v1/triggers/${created.id}`, { headers: headers() }), 404, NOT_FOUND);
        await expectDetail(await request.delete(`/api/v1/triggers/${created.id}`, { headers: headers() }), 404, NOT_FOUND);
        expect(await listTriggers(request, headers(), { flow_id: flowId })).toEqual([]);
      });
    },
  );

  test(
    "enable arms and disable pauses, idempotently, from every state but dead",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/disable",
      ]);
      const flowId = await emptyFlow(request, "states");

      await test.step("pending → enable → enable → disable → disable → enable, each answer re-read", async () => {
        const row = await make(request, flowId, "machine");
        const expectState = async (answer: TriggerRead, state: TriggerState, reason: string | null, what: string) => {
          expect({ state: answer.state, reason: answer.reason }, what).toEqual({ state, reason });
          const reread = await getTrigger(request, headers(), row.id);
          expect({ state: reread.state, reason: reread.reason }, `${what}, re-read`).toEqual({ state, reason });
        };
        await expectState(await setTriggerEnabled(request, headers(), row.id, true), "active", null, "enable");
        await expectState(await setTriggerEnabled(request, headers(), row.id, true), "active", null, "enable again (idempotent)");
        await expectState(await setTriggerEnabled(request, headers(), row.id, false), "paused", "paused", "disable");
        await expectState(await setTriggerEnabled(request, headers(), row.id, false), "paused", "paused", "disable again (idempotent)");
        await expectState(await setTriggerEnabled(request, headers(), row.id, true), "active", null, "enable after a pause");
      });

      // `needs_reconnect` also enables, while its `resume` reads blocked: the spec doc
      // records that as measured and deliberately unpinned (a candidate defect), so it
      // is not in this loop.
      await test.step("expired and error each enable to active", async () => {
        for (const state of ["expired", "error"] as const) {
          const row = await make(request, flowId, `from ${state}`, { state });
          expect(row.state, `the row was created ${state}`).toBe(state);
          expect((await getTrigger(request, headers(), row.id)).state, `the row was created ${state}, re-read`).toBe(state);
          expect((await setTriggerEnabled(request, headers(), row.id, true)).state, `enable from ${state}`).toBe("active");
          expect((await getTrigger(request, headers(), row.id)).state, `enable from ${state}, re-read`).toBe("active");
        }
      });

      await test.step("A dead trigger refuses enable (an object) and disable (a string), and stays dead", async () => {
        const row = await make(request, flowId, "dead", { state: "dead" });
        await expectDetail(
          await request.post(`/api/v1/triggers/${row.id}/enable`, { headers: headers() }),
          409,
          { detail: { code: null, message: "Trigger in state 'dead' cannot be enabled." } },
        );
        await expectDetail(
          await request.post(`/api/v1/triggers/${row.id}/disable`, { headers: headers() }),
          409,
          { detail: "A dead trigger cannot be disabled." },
        );
        expect((await getTrigger(request, headers(), row.id)).state).toBe("dead");
      });
    },
  );

  test(
    "pins a trigger to a version of its own flow, and to nothing else",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/flows/{flow_id}/versions/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "PATCH /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/pin",
      ]);
      const flowA = await emptyFlow(request, "pin A");
      const flowB = await emptyFlow(request, "pin B");

      const [versionA, versionB] = await test.step("Snapshot both flows", async () => [
        await snapshot(request, flowA),
        await snapshot(request, flowB),
      ]);

      const row = await make(request, flowA, "pinned");
      const pinOf = async () => (await getTrigger(request, headers(), row.id)).flow_version_id;

      await test.step("Pinning the own flow's version sets it", async () => {
        expect((await pinTrigger(request, headers(), row.id, versionA)).flow_version_id).toBe(versionA);
        expect(await pinOf()).toBe(versionA);
      });

      await test.step("Another flow's version and an unknown id are 404, and the pin stays", async () => {
        for (const [what, id] of [
          ["another flow's version", versionB],
          ["an unknown id", randomUUID()],
        ] as const) {
          await expectDetail(
            await request.post(`/api/v1/triggers/${row.id}/pin`, { headers: headers(), data: { flow_version_id: id } }),
            404,
            VERSION_NOT_FOUND,
          );
          expect(await pinOf(), `after pinning ${what}`).toBe(versionA);
        }
      });

      await test.step("An empty body is refused, never read as an unpin", async () => {
        const entry = await validationError(
          await request.post(`/api/v1/triggers/${row.id}/pin`, { headers: headers(), data: {} }),
        );
        expect({ type: entry.type, loc: entry.loc }).toEqual({ type: "missing", loc: ["body", "flow_version_id"] });
        expect(await pinOf()).toBe(versionA);
      });

      await test.step("A null unpins", async () => {
        expect((await pinTrigger(request, headers(), row.id, null)).flow_version_id).toBeNull();
        expect(await pinOf()).toBeNull();
      });

      await test.step("PATCH and create are held to the same rule as pin", async () => {
        await expectDetail(
          await request.patch(`/api/v1/triggers/${row.id}`, { headers: headers(), data: { flow_version_id: versionB } }),
          404,
          VERSION_NOT_FOUND,
        );
        expect(await pinOf()).toBeNull();
        await expectDetail(
          await request.post("/api/v1/triggers", {
            headers: headers(),
            data: { flow_id: flowA, name: `cross pin ${run}`, kind: "inbound_webhook", flow_version_id: versionB },
          }),
          404,
          VERSION_NOT_FOUND,
        );
        expect((await listTriggers(request, headers(), { flow_id: flowA })).map((r) => r.id)).toEqual([row.id]);
      });
    },
  );

  test(
    "refuses through the API the kinds that only a component on the canvas creates",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "POST /api/v1/triggers", "GET /api/v1/triggers"]);
      const flowId = await emptyFlow(request, "canvas only");

      await test.step("Each of the eight canvas-only kinds is refused with the sentence naming it", async () => {
        for (const kind of CANVAS_ONLY_KINDS) {
          await expectDetail(
            await request.post("/api/v1/triggers", {
              headers: headers(),
              data: { flow_id: flowId, name: `canvas ${run}`, kind },
            }),
            422,
            { detail: `A '${kind}' trigger is created by adding its component to the flow, not through this API.` },
          );
        }
      });

      await test.step("Nothing was written", async () => {
        expect(await listTriggers(request, headers(), { flow_id: flowId })).toEqual([]);
      });
    },
  );

  test(
    "a flow save creates the trigger unarmed, never arms or disarms it, and pauses it when its node is removed",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "PATCH /api/v1/flows/{flow_id}",
        "DELETE /api/v1/flows/{flow_id}",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
      ]);
      const graph = await scheduleGraph(request);
      const flowId = await catalogFlow(request, "schedule", graph);

      const row = await test.step("The save creates one pending schedule row bound to the node", async () => {
        const trigger = await nodeTrigger(request, flowId, SCHEDULE_NODE);
        expect(trigger).toMatchObject({
          kind: "schedule",
          state: "pending",
          name: `Schedule ${CRON}`,
          config: { cron: CRON, timezone: "UTC", catchup_policy: "coalesce", share_session: false },
          user_id: (owner as ConnectionsOwner).userId,
        });
        return trigger;
      });

      await test.step("Saving the same graph again keeps the row and does not arm it", async () => {
        await patchFlowData(request, flowId, graph);
        const reread = await nodeTrigger(request, flowId, SCHEDULE_NODE);
        expect({ id: reread.id, state: reread.state }).toEqual({ id: row.id, state: "pending" });
      });

      await test.step("Once enabled, saving again does not disarm it", async () => {
        expect((await setTriggerEnabled(request, headers(), row.id, true)).state).toBe("active");
        await patchFlowData(request, flowId, graph);
        expect((await getTrigger(request, headers(), row.id)).state).toBe("active");
      });

      await test.step("Removing the node pauses the row and says why, and enable then refuses it", async () => {
        await patchFlowData(request, flowId, { nodes: [], edges: [] });
        const removed = await getTrigger(request, headers(), row.id);
        expect({
          state: removed.state,
          reason: removed.reason,
          last_error: removed.last_error,
          last_error_code: removed.last_error_code,
          resume: removed.blocked_actions.resume,
        }).toEqual({
          state: "paused",
          reason: "node_removed",
          last_error: NODE_REMOVED_ERROR,
          last_error_code: "node_removed",
          resume: "node_removed",
        });
        await expectDetail(
          await request.post(`/api/v1/triggers/${row.id}/enable`, { headers: headers() }),
          409,
          NODE_REMOVED_REFUSAL,
        );
        expect((await getTrigger(request, headers(), row.id)).state).toBe("paused");
      });

      await test.step("Putting the node back clears the reason and leaves it paused", async () => {
        await patchFlowData(request, flowId, graph);
        const back = await nodeTrigger(request, flowId, SCHEDULE_NODE);
        expect({ id: back.id, state: back.state, reason: back.reason, last_error: back.last_error }).toEqual({
          id: row.id,
          state: "paused",
          reason: "paused",
          last_error: null,
        });
      });

      await test.step("An inbound webhook's payload_schema is parsed into an object, and a malformed one is recorded", async () => {
        const schema = { type: "object", required: ["x"] };
        const good = await catalogFlow(request, "webhook schema", await webhookGraph(request, JSON.stringify(schema)));
        const goodRow = await nodeTrigger(request, good, WEBHOOK_NODE);
        expect(goodRow).toMatchObject({ kind: "inbound_webhook", state: "pending", last_error: null });
        expect(goodRow.config).toEqual({ share_session: false, payload_schema: schema });

        const bad = await catalogFlow(request, "webhook bad schema", await webhookGraph(request, "not json"));
        const badRow = await nodeTrigger(request, bad, WEBHOOK_NODE);
        expect({ state: badRow.state, last_error: badRow.last_error }).toEqual({
          state: "pending",
          last_error: BAD_SCHEMA_ERROR,
        });
      });

      await test.step("Deleting the flow deletes its trigger", async () => {
        await deleteFlow(request, flowId, { headers: headers() });
        await expectDetail(await request.get(`/api/v1/triggers/${row.id}`, { headers: headers() }), 404, NOT_FOUND);
      });
    },
  );

  test(
    "refuses out-of-range and server-owned fields on create and on update",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "PATCH /api/v1/triggers/{trigger_id}",
      ]);
      const flowId = await emptyFlow(request, "validation");
      const accepted: string[] = [];
      const post = (extra: Record<string, unknown>) =>
        request.post("/api/v1/triggers", {
          headers: headers(),
          data: { flow_id: flowId, name: `validation ${run}`, kind: "inbound_webhook", ...extra },
        });

      await test.step("concurrency_limit is 1–100 and max_attempts is 1–20 on create", async () => {
        for (const [field, low, high] of [
          ["concurrency_limit", 1, 100],
          ["max_attempts", 1, 20],
        ] as const) {
          for (const [value, type] of [
            [low - 1, "greater_than_equal"],
            [high + 1, "less_than_equal"],
          ] as const) {
            const entry = await validationError(await post({ [field]: value }));
            expect({ type: entry.type, loc: entry.loc }, `${field}: ${value}`).toEqual({ type, loc: ["body", field] });
          }
          for (const value of [low, high]) {
            const res = await post({ [field]: value });
            const text = await res.text();
            expect(res.status(), `${field}: ${value} — ${text}`).toBe(201);
            accepted.push((JSON.parse(text) as TriggerRead).id);
          }
        }
      });

      const row = await make(request, flowId, "patched");
      accepted.push(row.id);

      await test.step("The same bounds hold on PATCH", async () => {
        for (const [field, value, type] of [
          ["concurrency_limit", 101, "less_than_equal"],
          ["max_attempts", 0, "greater_than_equal"],
        ] as const) {
          const entry = await validationError(
            await request.patch(`/api/v1/triggers/${row.id}`, { headers: headers(), data: { [field]: value } }),
          );
          expect({ type: entry.type, loc: entry.loc }, `PATCH ${field}: ${value}`).toEqual({ type, loc: ["body", field] });
        }
      });

      await test.step("A deployment binding needs deployment_id, on create and on PATCH, and the refused PATCH writes nothing", async () => {
        const refusal = { detail: "A deployment binding requires deployment_id." };
        await expectDetail(await post({ binding_target: "deployment" }), 422, refusal);
        await expectDetail(
          await request.patch(`/api/v1/triggers/${row.id}`, { headers: headers(), data: { binding_target: "deployment" } }),
          422,
          refusal,
        );
        const reread = await getTrigger(request, headers(), row.id);
        expect({ binding_target: reread.binding_target, deployment_id: reread.deployment_id }).toEqual({
          binding_target: "flow",
          deployment_id: null,
        });
      });

      await test.step("config.mechanism_id is refused on create and on PATCH", async () => {
        const refusal = { detail: "mechanism_id is derived from the trigger's connection and cannot be set." };
        await expectDetail(await post({ config: { mechanism_id: "e2e" } }), 422, refusal);
        await expectDetail(
          await request.patch(`/api/v1/triggers/${row.id}`, {
            headers: headers(),
            data: { config: { mechanism_id: "e2e" } },
          }),
          422,
          refusal,
        );
        expect((await getTrigger(request, headers(), row.id)).config).toEqual({});
      });

      await test.step("An extra field, a malformed kind, an empty name and an unknown flow are refused", async () => {
        for (const [extra, type, field] of [
          [{ cadence: "hourly" }, "extra_forbidden", "cadence"],
          [{ kind: "Bad Kind" }, "string_pattern_mismatch", "kind"],
          [{ name: "" }, "string_too_short", "name"],
        ] as const) {
          const entry = await validationError(await post(extra));
          expect({ type: entry.type, loc: entry.loc }).toEqual({ type, loc: ["body", field] });
        }
        await expectDetail(await post({ flow_id: randomUUID() }), 404, NOT_FOUND);
      });

      await test.step("The flow holds only the rows the accepted creates wrote", async () => {
        const rows = await listTriggers(request, headers(), { flow_id: flowId });
        expect(sorted(rows.map((r) => r.id))).toEqual(sorted(accepted));
      });
    },
  );

  test(
    "only the flow's owner can see or act on its triggers",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "PATCH /api/v1/triggers/{trigger_id}",
        "DELETE /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/disable",
        "POST /api/v1/triggers/{trigger_id}/pin",
      ]);
      const flowId = await emptyFlow(request, "owner scope");
      const row = await make(request, flowId, "owned", { state: "active" });
      const su = { Authorization: await getAuthToken(request) };

      await test.step("The superuser gets 404 on every route that names the owner's trigger or flow", async () => {
        const id = row.id;
        const probes: Array<[string, () => Promise<{ status(): number; text(): Promise<string> }>]> = [
          ["GET", () => request.get(`/api/v1/triggers/${id}`, { headers: su })],
          ["PATCH", () => request.patch(`/api/v1/triggers/${id}`, { headers: su, data: { name: `hijacked ${run}` } })],
          ["DELETE", () => request.delete(`/api/v1/triggers/${id}`, { headers: su })],
          ["enable", () => request.post(`/api/v1/triggers/${id}/enable`, { headers: su })],
          ["disable", () => request.post(`/api/v1/triggers/${id}/disable`, { headers: su })],
          ["pin", () => request.post(`/api/v1/triggers/${id}/pin`, { headers: su, data: { flow_version_id: null } })],
          [
            "create on the owner's flow",
            () =>
              request.post("/api/v1/triggers", {
                headers: su,
                data: { flow_id: flowId, name: `intruder ${run}`, kind: "inbound_webhook" },
              }),
          ],
          ["list by the owner's flow", () => request.get("/api/v1/triggers", { headers: su, params: { flow_id: flowId } })],
        ];
        for (const [what, probe] of probes) {
          const res = await probe();
          const text = await res.text();
          expect(res.status(), `${what}: ${text}`).toBe(404);
          expect(JSON.parse(text), what).toEqual(NOT_FOUND);
        }
      });

      await test.step("The owner's trigger is exactly as it was, and alone on its flow", async () => {
        const reread = await getTrigger(request, headers(), row.id);
        expect(reread).toEqual({ ...row, updated_at: reread.updated_at });
        expect(reread.updated_at, "no write reached the row").toBe(row.updated_at);
        expect((await listTriggers(request, headers(), { flow_id: flowId })).map((r) => r.id)).toEqual([row.id]);
      });
    },
  );

  // The three leads from manual QA (TRG-2 / TRG-4). Each reproduces on the image
  // and none has an upstream ticket yet, so each asserts TODAY's behaviour, in its
  // own test so a fix to one cannot take the others' @stable with it. When one goes
  // red with a "LEAD:" message, upstream changed it: turn it into the fixed contract.
  test(
    "lead: a deployment binding's deployment_id is never checked — stored and failed at dispatch, or a 500 where foreign keys are enforced",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      // Declared per branch below, as each is driven: the 500 branch never reaches a row.
      apiCoverage.declare(["POST /api/v1/flows/", "POST /api/v1/triggers"]);
      const flowId = await emptyFlow(request, "lead deployment");
      const deploymentId = randomUUID();

      // The API never looks the deployment up; `trigger.deployment_id` is a foreign key,
      // so the database decides what the caller sees (#2539). Where foreign keys are
      // enforced (the QA VM's pragmas, any Postgres) the write is a 500 carrying the raw
      // IntegrityError and nothing is stored; where they are not (SQLite's defaults, as
      // the image ships) it is stored and fails only at dispatch. Both are the lead; a
      // 4xx naming the missing deployment would be the fix, and fails here as such.
      const row = await test.step("Create does not check that the deployment_id names a deployment", async () => {
        // `Connection: close`: the IntegrityError is unhandled, so after its 500 the server
        // drops the connection, and the next call on a reused keep-alive socket dies with
        // "socket hang up" (measured on 1.14.0.dev35). Closing this one keeps it out of the pool.
        const res = await request.post("/api/v1/triggers", {
          headers: { ...headers(), Connection: "close" },
          data: { flow_id: flowId, name: `lead deployment ${run}`, kind: "inbound_webhook", binding_target: "deployment", deployment_id: deploymentId },
        });
        const text = await res.text();
        expect([201, 500], `LEAD changed: an unchecked deployment_id answers 201 or 500, this one answered ${res.status()} ${text}`).toContain(
          res.status(),
        );
        test.info().annotations.push({
          type: "deployment-fk",
          description: res.status() === 500 ? "enforced: the create answered 500" : "not enforced: the create answered 201",
        });
        if (res.status() === 500) {
          apiCoverage.declare(["GET /api/v1/triggers"]);
          expect(text, "LEAD: with foreign keys enforced, the unchecked deployment_id surfaces as the database's foreign-key error").toMatch(
            // SQLite through aiosqlite names the class `IntegrityError`; Postgres through
            // psycopg names the driver's `ForeignKeyViolation` instead. Both say "foreign key".
            /(IntegrityError|ForeignKeyViolation)[\s\S]*foreign key/i,
          );
          expect(await listTriggers(request, headers(), { flow_id: flowId }), "the refused create stored nothing").toEqual([]);
          return null;
        }
        apiCoverage.declare([
          "GET /api/v1/triggers/{trigger_id}",
          "POST /api/v1/triggers/{trigger_id}/enable",
          "POST /api/v1/triggers/{trigger_id}/test",
          "GET /api/v1/triggers/{trigger_id}/events",
        ]);
        const created = JSON.parse(text) as TriggerRead;
        const reread = await getTrigger(request, headers(), created.id);
        expect(
          { binding_target: reread.binding_target, deployment_id: reread.deployment_id },
          "LEAD: create accepts a deployment_id that names no deployment",
        ).toEqual({ binding_target: "deployment", deployment_id: deploymentId });
        return created;
      });

      // Foreign keys enforced: the 500 above is the whole lead, and there is no row to arm.
      if (row === null) return;

      await test.step("Enable arms it", async () => {
        expect((await setTriggerEnabled(request, headers(), row.id, true)).state, "LEAD: enable arms it").toBe("active");
        expect((await getTrigger(request, headers(), row.id)).state, "LEAD: enable arms it, re-read").toBe("active");
      });

      await test.step("The refusal arrives only when an event is dispatched", async () => {
        const res = await request.post(`/api/v1/triggers/${row.id}/test`, { headers: headers(), data: { payload: {} } });
        expect(res.status(), await res.text()).toBe(202);
        const event = await settledOnlyEvent(request, row.id, "the test event");
        expect({ state: event.state, error: event.error }, "LEAD: the refusal arrives at dispatch").toEqual({
          state: "failed",
          error: DEPLOYMENT_NOT_DISPATCHED,
        });
        const after = await getTrigger(request, headers(), row.id);
        expect({ state: after.state, reason: after.reason, last_error: after.last_error }).toEqual({
          state: "active",
          reason: "degraded",
          last_error: DEPLOYMENT_NOT_DISPATCHED,
        });
      });
    },
  );

  test(
    "lead: enable arms a webhook whose payload_schema is malformed, and erases the error",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
      ]);
      const flowId = await catalogFlow(request, "lead bad schema", await webhookGraph(request, "not json"));

      const row = await test.step("The save records the malformed schema on a pending row", async () => {
        const trigger = await nodeTrigger(request, flowId, WEBHOOK_NODE);
        expect({ state: trigger.state, last_error: trigger.last_error }).toEqual({ state: "pending", last_error: BAD_SCHEMA_ERROR });
        return trigger;
      });

      await test.step("Enable arms it anyway and the error is gone, while the schema is still malformed", async () => {
        const enabled = await setTriggerEnabled(request, headers(), row.id, true);
        const reread = await getTrigger(request, headers(), row.id);
        for (const [what, answer] of [
          ["enable's answer", enabled],
          ["re-read", reread],
        ] as const) {
          expect(
            { state: answer.state, last_error: answer.last_error, payload_schema: answer.config.payload_schema },
            `LEAD: enable validates only schedule configs — the malformed schema arms and its error is erased (${what})`,
          ).toEqual({ state: "active", last_error: null, payload_schema: "not json" });
        }
      });
    },
  );

  test(
    "lead: a stored payload_schema is not enforced on delivery",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "GET /api/v1/triggers/{trigger_id}/events",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
      ]);
      const schema = { type: "object", required: ["x"] };
      const flowId = await catalogFlow(request, "lead schema", await webhookGraph(request, JSON.stringify(schema)));

      const row = await test.step("The save stores the schema, and enable arms the trigger", async () => {
        const trigger = await nodeTrigger(request, flowId, WEBHOOK_NODE);
        expect(trigger.config.payload_schema).toEqual(schema);
        expect((await setTriggerEnabled(request, headers(), trigger.id, true)).state).toBe("active");
        expect((await getTrigger(request, headers(), trigger.id)).state, "enable, re-read").toBe("active");
        return trigger;
      });

      await test.step("A signed delivery breaking the schema is accepted and runs to completion", async () => {
        const ingress = await mintSigningSecret(request, row.id, headers());
        const delivery = { y: 1 };
        expect(
          await deliverSignedWebhook(request, ingress.path, ingress.secret, jsonBody(delivery)),
          "LEAD: a body breaking the schema is accepted",
        ).toBe(202);
        const event = await settledOnlyEvent(request, row.id, "the delivery");
        expect(
          { state: event.state, delivery: event.payload.delivery },
          "LEAD: the delivery breaking the schema runs to completion",
        ).toEqual({ state: "completed", delivery });
      });
    },
  );
});
