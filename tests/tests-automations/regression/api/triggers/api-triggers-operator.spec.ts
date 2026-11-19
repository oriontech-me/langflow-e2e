import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog, findCatalogComponent } from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { createConnectionViaApi } from "../../../../helpers/integrations/create-connection";
import { retryOnDroppedConnection } from "../../../../helpers/api/retry-on-dropped-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import {
  bulkTriggers,
  createTrigger,
  getTrigger,
  listTriggers,
  newestFirst,
  runProvider,
  setTriggerEnabled,
  TRIGGER_READ_KEYS,
  type TriggerAction,
  type TriggerRead,
  type TriggerState,
} from "../../../../helpers/triggers/trigger-api";

// The triggers operator API: listing across flows, scope=all, server-computed
// actions, bulk pause and resume, and the session labels (#2448).
// Spec doc: docs/api/triggers/api-triggers-operator.md
//
// TRG-7 (upstream #15786) made the server the one place that decides what a
// caller may do with a trigger: every TriggerRead carries allowed_actions,
// blocked_actions and reason, and the page renders them as given. So a wrong
// answer here is a wrong page everywhere, and this file pins the answer itself.
//
// Two facts make the matrix reachable without driving a trigger through real
// provider failures, both measured on 1.14.0.dev28: the create route writes a
// row straight into any state, and it takes any provider name that matches the
// pattern. The second one is also what keeps the bulk honest on a shared
// instance — a bulk by provider is instance-wide across users, so every bulk
// below acts on a provider unique to the test (`runProvider`) or on ids.
test.describe("Triggers — the operator API", () => {
  // The operator routes ship in 1.14.0.dev1 (upstream #15786), but the TriggerRead
  // this file pins — 28 keys, `last_error_code` among them — is #16132's, first in
  // 1.14.0.dev16. Measured on 1.14.0.dev14: 27 keys, so tests 1 and 3 fail there
  // while 2, 4 and 5 pass. The floor is the contract asserted, not the route.
  const OPERATOR_SINCE = "1.14.0.dev16";
  const NOT_FOUND = { detail: "Trigger not found" };
  // A kind with a `.` that no installed bundle serves. Measured: an operator can
  // pause it like any armed trigger, `enable` refuses it with the sentence below,
  // and a test event on it is deferred as `provider-unavailable`.
  const UNSERVED_KIND = "e2e.event";
  const PROVIDER_UNAVAILABLE = "This trigger provider is unavailable. Install its integration bundle before enabling it.";
  const REFUSED_RESUME_PREFIX = "An administrator resumed this trigger, but it could not start: ";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // One throwaway owner per worker: its login counts against the per-IP login
  // budget (5/min). Deleting it takes its flows, triggers and connections.
  let owner: ConnectionsOwner | undefined;
  let ownerName = "";
  const ownerHeaders = () => (owner as ConnectionsOwner).headers;

  // Flows the SUPERUSER created in this test; the owner's go with the owner.
  const superFlowIds: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "trgoperator",
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
      !(await servedVersionAtLeast(request, OPERATOR_SINCE)),
      `the TriggerRead this file pins ships in ${OPERATOR_SINCE} (upstream #15786, #16132); this build does not carry it`,
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

  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  const sorted = (values: string[]) => [...values].sort();

  async function superHeaders(request: APIRequestContext): Promise<Record<string, string>> {
    return { Authorization: await getAuthToken(request) };
  }

  async function whoami(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
    const res = await request.get("/api/v1/users/whoami", { headers });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { username: string }).username;
  }

  /** An empty flow — a trigger needs a flow to ride, not a graph. */
  async function emptyFlow(
    request: APIRequestContext,
    headers: Record<string, string>,
    label: string,
    asSuperuser = false,
  ): Promise<{ id: string; name: string }> {
    const name = `E2E operator ${label} ${run}`;
    const id = await createFlow(request, { name, data: { nodes: [], edges: [] } }, { headers });
    if (asSuperuser) superFlowIds.push(id);
    return { id, name };
  }

  /** The 422 entries of a FastAPI validation refusal, as `{type, loc}`. */
  async function validationErrors(res: { status(): number; text(): Promise<string> }) {
    const text = await res.text();
    expect(res.status(), text).toBe(422);
    return ((JSON.parse(text) as { detail: Array<{ type: string; loc: unknown[]; msg: string }> }).detail ?? []).map(
      ({ type, loc, msg }) => ({ type, loc, msg }),
    );
  }

  async function expectDetail(res: { status(): number; text(): Promise<string> }, status: number, body: unknown) {
    const text = await res.text();
    expect(res.status(), text).toBe(status);
    expect(JSON.parse(text)).toEqual(body);
  }

  /**
   * The three-owner-row seed tests 1 and 2 share: on flow A an active and a
   * paused webhook, on flow B a pending `e2e.event`, plus one active webhook of
   * the superuser's own — all on a provider no other test uses.
   */
  async function seedListing(request: APIRequestContext, label: string) {
    const provider = runProvider(label);
    const su = await superHeaders(request);
    const flowA = await emptyFlow(request, ownerHeaders(), `${label} A`);
    const flowB = await emptyFlow(request, ownerHeaders(), `${label} B`);
    const superFlow = await emptyFlow(request, su, `${label} super`, true);
    const make = (headers: Record<string, string>, flowId: string, kind: string, state: TriggerState, name: string) =>
      createTrigger(request, headers, { flow_id: flowId, name: `${name} ${run}`, kind, provider, state });
    const active = await make(ownerHeaders(), flowA.id, "inbound_webhook", "active", "owner active");
    const paused = await make(ownerHeaders(), flowA.id, "inbound_webhook", "paused", "owner paused");
    const pending = await make(ownerHeaders(), flowB.id, UNSERVED_KIND, "pending", "owner pending");
    const superActive = await make(su, superFlow.id, "inbound_webhook", "active", "super active");
    return { provider, su, flowA, flowB, superFlow, active, paused, pending, superActive };
  }

  test(
    "lists the caller's own triggers across flows, newest first, filtered by provider and state",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
      ]);
      const seed = await test.step("Seed three owner rows on two flows and one superuser row, on one provider", () =>
        seedListing(request, "list"),
      );
      const ownerIds = [seed.active.id, seed.paused.id, seed.pending.id];

      let ordered: TriggerRead[] = [];
      await test.step("The owner's list holds exactly its three rows, each with its flow's name, newest first", async () => {
        const rows = await listTriggers(request, ownerHeaders(), { provider: seed.provider });
        expect(sorted(ids(rows))).toEqual(sorted(ownerIds));
        const flowNames = new Map([
          [seed.active.id, seed.flowA.name],
          [seed.paused.id, seed.flowA.name],
          [seed.pending.id, seed.flowB.name],
        ]);
        for (const row of rows) {
          expect(row.flow_name, `flow_name of ${row.name}`).toBe(flowNames.get(row.id));
          expect(row.owner_username, "owner_username is the operator view's").toBeNull();
          expect(sorted(Object.keys(row)), `keys of ${row.name}`).toEqual([...TRIGGER_READ_KEYS]);
        }
        ordered = [...rows].sort(newestFirst);
        expect(ids(rows), "created_at desc, id desc").toEqual(ids(ordered));
      });

      await test.step("The superuser's own list holds only its own row: no cross-user prefilter in OSS", async () => {
        const rows = await listTriggers(request, seed.su, { provider: seed.provider });
        expect(ids(rows)).toEqual([seed.superActive.id]);
        await expectDetail(
          await request.get("/api/v1/triggers", { headers: seed.su, params: { flow_id: seed.flowA.id } }),
          404,
          NOT_FOUND,
        );
      });

      await test.step("A single-object response carries no flow name", async () => {
        const row = await getTrigger(request, ownerHeaders(), seed.active.id);
        expect(row.id).toBe(seed.active.id);
        expect(row.flow_name).toBeNull();
      });

      await test.step("provider and state filter by exact match", async () => {
        const active = await listTriggers(request, ownerHeaders(), { provider: seed.provider, state: "active" });
        expect(ids(active)).toEqual([seed.active.id]);
        const paused = await listTriggers(request, ownerHeaders(), { provider: seed.provider, state: "paused" });
        expect(ids(paused)).toEqual([seed.paused.id]);
      });

      await test.step("limit and offset page through the same order; limit is 1–200", async () => {
        for (const offset of [0, 1, 2]) {
          const page = await listTriggers(request, ownerHeaders(), { provider: seed.provider, limit: 1, offset });
          expect(ids(page), `offset ${offset}`).toEqual([ordered[offset].id]);
        }
        const below = await validationErrors(await request.get("/api/v1/triggers", { headers: ownerHeaders(), params: { limit: 0 } }));
        expect(below.map(({ type, loc }) => ({ type, loc }))).toEqual([{ type: "greater_than_equal", loc: ["query", "limit"] }]);
        const above = await validationErrors(await request.get("/api/v1/triggers", { headers: ownerHeaders(), params: { limit: 201 } }));
        expect(above.map(({ type, loc }) => ({ type, loc }))).toEqual([{ type: "less_than_equal", loc: ["query", "limit"] }]);
        const max = await listTriggers(request, ownerHeaders(), { provider: seed.provider, limit: 200 });
        expect(Array.isArray(max), "the body is a bare array: no total count").toBe(true);
        expect(max).toHaveLength(3);
      });
    },
  );

  test(
    "scope=all is superuser-only and shows every user's triggers with their owner and no actions on rows the caller does not own",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "POST /api/v1/triggers", "GET /api/v1/triggers"]);
      const seed = await test.step("Seed the owner's rows and one superuser row on one provider", () =>
        seedListing(request, "scope"),
      );
      const superName = await whoami(request, seed.su);

      await test.step("A non-superuser is refused the operator view", async () => {
        await expectDetail(
          await request.get("/api/v1/triggers", { headers: ownerHeaders(), params: { scope: "all" } }),
          403,
          { detail: "Only a superuser can list every user's triggers." },
        );
      });

      await test.step("The superuser sees every user's rows with each owner's username", async () => {
        const rows = await listTriggers(request, seed.su, { scope: "all", provider: seed.provider });
        expect(sorted(ids(rows))).toEqual(sorted([seed.active.id, seed.paused.id, seed.pending.id, seed.superActive.id]));
        expect(ids(rows), "created_at desc, id desc").toEqual(ids([...rows].sort(newestFirst)));
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const id of [seed.active.id, seed.paused.id, seed.pending.id]) {
          expect(byId.get(id)?.owner_username).toBe(ownerName);
          expect(byId.get(id)?.allowed_actions, "a row on another user's flow allows no action").toEqual([]);
        }
        const own = byId.get(seed.superActive.id);
        expect(own?.owner_username).toBe(superName);
        expect(own?.allowed_actions).toEqual(["pause", "test", "replay", "delete", "rotate_secret"]);
        expect(own?.blocked_actions).toEqual({});
      });

      await test.step("Another user's rows block every action on the caller, unless a state reason outranks it", async () => {
        const rows = await listTriggers(request, seed.su, { scope: "all", provider: seed.provider });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const DENIED = "insufficient_permission";
        expect(byId.get(seed.active.id)?.blocked_actions).toEqual({
          pause: DENIED,
          test: DENIED,
          replay: DENIED,
          delete: DENIED,
          rotate_secret: DENIED,
        });
        // test and replay on a paused trigger read the STATE's reason: it is true
        // whatever access the caller is later granted.
        expect(byId.get(seed.paused.id)?.blocked_actions).toEqual({
          resume: DENIED,
          test: "paused",
          replay: "paused",
          delete: DENIED,
          rotate_secret: DENIED,
        });
        expect(byId.get(seed.pending.id)?.blocked_actions).toEqual({
          pause: DENIED,
          resume: DENIED,
          test: DENIED,
          replay: DENIED,
          delete: DENIED,
        });
      });

      await test.step("scope=all combines with flow_id, provider and state", async () => {
        const rows = await listTriggers(request, seed.su, {
          scope: "all",
          flow_id: seed.flowA.id,
          provider: seed.provider,
          state: "paused",
        });
        expect(ids(rows)).toEqual([seed.paused.id]);
        expect(rows[0].owner_username).toBe(ownerName);
      });
    },
  );

  test(
    "computes each trigger's actions on the server, by state and by kind",
    { tag: ["@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/connections",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/test",
      ]);
      type Expected = {
        reason: string | null;
        allowed: TriggerAction[];
        blocked: Partial<Record<TriggerAction, string>>;
      };
      // The owner's answer for an inbound_webhook, measured on 1.14.0.dev28, in
      // the server's display order (pause, resume, test, reconnect, replay,
      // delete, rotate_secret).
      const WEBHOOK: Record<TriggerState, Expected> = {
        pending: { reason: "pending", allowed: ["pause", "resume", "test", "replay", "delete", "rotate_secret"], blocked: {} },
        active: { reason: null, allowed: ["pause", "test", "replay", "delete", "rotate_secret"], blocked: {} },
        paused: { reason: "paused", allowed: ["resume", "delete", "rotate_secret"], blocked: { test: "paused", replay: "paused" } },
        expired: {
          reason: "expired",
          allowed: ["pause", "resume", "delete", "rotate_secret"],
          blocked: { test: "expired", replay: "expired" },
        },
        dead: { reason: "dead", allowed: ["delete", "rotate_secret"], blocked: { resume: "dead", test: "dead", replay: "dead" } },
        error: { reason: "error", allowed: ["pause", "resume", "test", "replay", "delete", "rotate_secret"], blocked: {} },
        needs_reconnect: {
          reason: "needs_reconnect",
          allowed: ["pause", "test", "replay", "delete", "rotate_secret"],
          blocked: { resume: "needs_reconnect" },
        },
      };
      const provider = runProvider("actions");
      const flow = await emptyFlow(request, ownerHeaders(), "actions");
      const make = (kind: string, state: TriggerState, extra: { connection_id?: string } = {}) =>
        createTrigger(request, ownerHeaders(), {
          flow_id: flow.id,
          name: `${kind} ${state} ${run}`,
          kind,
          provider,
          state,
          ...extra,
        });
      const check = (row: TriggerRead, expected: Expected, label: string) => {
        expect(sorted(Object.keys(row)), `${label}: the TriggerRead key set`).toEqual([...TRIGGER_READ_KEYS]);
        expect(row.reason, `${label}: reason`).toBe(expected.reason);
        expect(row.allowed_actions, `${label}: allowed_actions`).toEqual(expected.allowed);
        expect(row.blocked_actions, `${label}: blocked_actions`).toEqual(expected.blocked);
      };

      await test.step("An inbound_webhook in each state: pause, resume, test, replay and rotate_secret follow the state", async () => {
        for (const state of Object.keys(WEBHOOK) as TriggerState[]) {
          const created = await make("inbound_webhook", state);
          expect(created.state).toBe(state);
          check(created, WEBHOOK[state], `inbound_webhook ${state} (create)`);
          check(await getTrigger(request, ownerHeaders(), created.id), WEBHOOK[state], `inbound_webhook ${state} (read)`);
        }
      });

      let unserved: TriggerRead | undefined;
      await test.step("Another kind drops rotate_secret, the one action only an inbound_webhook has", async () => {
        unserved = await make(UNSERVED_KIND, "active");
        check(unserved, { reason: null, allowed: ["pause", "test", "replay", "delete"], blocked: {} }, `${UNSERVED_KIND} active`);
        const pending = await make(UNSERVED_KIND, "pending");
        check(pending, { reason: "pending", allowed: ["pause", "resume", "test", "replay", "delete"], blocked: {} }, `${UNSERVED_KIND} pending`);
      });

      await test.step("A connection-backed trigger gains reconnect, blocked while the connection is fine", async () => {
        const connection = await createConnectionViaApi(request, ownerHeaders(), { label: "trgop actions" });
        for (const state of ["pending", "active"] as const) {
          const row = await make("inbound_webhook", state, { connection_id: connection.id });
          const base = WEBHOOK[state];
          check(
            row,
            { ...base, blocked: { ...base.blocked, reconnect: "reconnect_not_needed" } },
            `inbound_webhook ${state} with a connection`,
          );
        }
      });

      await test.step("degraded: an active trigger whose test event the dispatcher defers keeps its state and reports it", async () => {
        const res = await request.post(`/api/v1/triggers/${unserved?.id}/test`, { headers: ownerHeaders(), data: { payload: {} } });
        expect(res.status(), await res.text()).toBe(202);
        let row: TriggerRead | undefined;
        await expect
          .poll(async () => (row = await retryOnDroppedConnection(() => getTrigger(request, ownerHeaders(), unserved?.id as string))).last_error, {
            message: "the dispatcher records the deferral on the trigger",
            timeout: 30_000,
            // Under the server's 2 s keep-alive close (#2236, #2243).
            intervals: [1000],
          })
          .toBe("provider-unavailable");
        expect(row?.state).toBe("active");
        expect(row?.reason).toBe("degraded");
      });

      const INVALID_CRON = "Invalid cron expression: a valid five-field cron expression is required.";
      let invalid: TriggerRead | undefined;

      await test.step("config_invalid: a canvas Schedule with an invalid cron reconciles into a pending row that says so", async () => {
        const catalog = await fetchComponentCatalog(request, ownerHeaders());
        // `schedule_type: "Custom (cron)"` is what makes the server read
        // `cron_expression`: since upstream #16322 (1.14.0.dev30) the template
        // defaults to "Weekly", and the reconciler compiles the picker fields
        // instead, so with the default type the invalid cron is never read and the
        // row reconciles as a plain `pending` (#2476). Before dev30 the template has
        // no `schedule_type` and the cron is the schedule, so the field is set only
        // where it exists — this file's floor is OPERATOR_SINCE, not dev30.
        const picker =
          "schedule_type" in findCatalogComponent(catalog, "ScheduleTrigger").template
            ? { schedule_type: "Custom (cron)" }
            : {};
        const flowId = await createCatalogFlow(
          request,
          catalog,
          {
            nodes: [
              {
                id: "ScheduleTrigger-bad01",
                type: "ScheduleTrigger",
                values: { ...picker, cron_expression: "not a cron" },
              },
            ],
            edges: [],
          },
          { name: `E2E operator invalid cron ${run}`, headers: ownerHeaders() },
        );
        let rows: TriggerRead[] = [];
        await expect
          .poll(async () => (rows = await retryOnDroppedConnection(() => listTriggers(request, ownerHeaders(), { flow_id: flowId }))).length, {
            message: "flow save reconciles the Schedule node into one row",
            timeout: 10_000,
            intervals: [1000],
          })
          .toBe(1);
        expect(rows[0]).toMatchObject({
          kind: "schedule",
          node_id: "ScheduleTrigger-bad01",
          state: "pending",
          reason: "config_invalid",
          last_error_code: "invalid_cron",
          last_error: INVALID_CRON,
        });
        invalid = rows[0];
      });

      await test.step("config_invalid: enable refuses the row for the reason it reports, and changes nothing", async () => {
        const id = (invalid as TriggerRead).id;
        const res = await request.post(`/api/v1/triggers/${id}/enable`, { headers: ownerHeaders() });
        await expectDetail(res, 409, { detail: { code: "invalid_cron", message: INVALID_CRON } });
        expect(await getTrigger(request, ownerHeaders(), id)).toMatchObject({ state: "pending", reason: "config_invalid" });
      });

      // DECLARED FAILING from here on: LE-3454 (#2464). The server lists `resume`
      // as allowed on a config_invalid row although `enable` refuses it (above),
      // against capabilities.py's own rule that an allowed action is one the route
      // accepts: `_decide()` blocks resume by reason on needs_reconnect, never on
      // pending. Everything above runs undeclared, so a broken setup or a changed
      // refusal still reddens the test. The day the fix ships this step passes,
      // Playwright reports "expected to fail, but passed", and that is the signal
      // to delete this line.
      test.fail(true, "LE-3454: resume is listed as allowed on a config_invalid trigger that enable refuses");

      await test.step("config_invalid: resume is blocked with the reason enable refuses it for", async () => {
        const row = await getTrigger(request, ownerHeaders(), (invalid as TriggerRead).id);
        expect(row.allowed_actions, "an action enable refuses is not listed as allowed").not.toContain("resume");
        expect(row.blocked_actions.resume, "resume is blocked by the row's own reason").toBe("config_invalid");
      });
    },
  );

  test(
    "bulk pause and resume are superuser-only, select by provider and ids, and re-arm only what an operator paused",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/disable",
        "POST /api/v1/triggers/bulk/pause",
        "POST /api/v1/triggers/bulk/resume",
      ]);
      const su = await superHeaders(request);

      await test.step("Anyone but a superuser is refused both bulk routes", async () => {
        for (const action of ["pause", "resume"]) {
          await expectDetail(
            await request.post(`/api/v1/triggers/bulk/${action}`, { headers: ownerHeaders(), data: { trigger_ids: [randomUUID()] } }),
            403,
            { detail: "The user doesn't have enough privileges" },
          );
        }
      });

      await test.step("The body needs a filter, refuses extra fields and takes 1–500 ids", async () => {
        const post = (data: unknown) => request.post("/api/v1/triggers/bulk/pause", { headers: su, data });
        for (const data of [{}, { dry_run: true }]) {
          expect(await validationErrors(await post(data))).toEqual([
            { type: "value_error", loc: ["body"], msg: "Value error, Name a provider, trigger_ids, or both." },
          ]);
        }
        const shape = async (data: unknown) => (await validationErrors(await post(data))).map(({ type, loc }) => ({ type, loc }));
        expect(await shape({ provider: runProvider("x"), extra: 1 })).toEqual([{ type: "extra_forbidden", loc: ["body", "extra"] }]);
        expect(await shape({ trigger_ids: [] })).toEqual([{ type: "too_short", loc: ["body", "trigger_ids"] }]);
        expect(await shape({ trigger_ids: Array.from({ length: 501 }, () => randomUUID()) })).toEqual([
          { type: "too_long", loc: ["body", "trigger_ids"] },
        ]);
        expect(await shape({ provider: "BAD" })).toEqual([{ type: "string_pattern_mismatch", loc: ["body", "provider"] }]);
      });

      const provider = runProvider("bulk");
      const flow = await emptyFlow(request, ownerHeaders(), "bulk");
      const superFlow = await emptyFlow(request, su, "bulk super", true);
      const seeded = new Map<string, TriggerState>();
      const make = async (headers: Record<string, string>, flowId: string, kind: string, state: TriggerState, label: string) => {
        const row = await createTrigger(request, headers, { flow_id: flowId, name: `${label} ${run}`, kind, provider, state });
        seeded.set(row.id, state);
        return row.id;
      };
      const t = {
        active: await make(ownerHeaders(), flow.id, "inbound_webhook", "active", "bulk active"),
        error: await make(ownerHeaders(), flow.id, "inbound_webhook", "error", "bulk error"),
        needsReconnect: await make(ownerHeaders(), flow.id, "inbound_webhook", "needs_reconnect", "bulk needs_reconnect"),
        pending: await make(ownerHeaders(), flow.id, "inbound_webhook", "pending", "bulk pending"),
        paused: await make(ownerHeaders(), flow.id, "inbound_webhook", "paused", "bulk paused"),
        expired: await make(ownerHeaders(), flow.id, "inbound_webhook", "expired", "bulk expired"),
        dead: await make(ownerHeaders(), flow.id, "inbound_webhook", "dead", "bulk dead"),
        refused: await make(ownerHeaders(), flow.id, UNSERVED_KIND, "active", "bulk unserved"),
        superActive: await make(su, superFlow.id, "inbound_webhook", "active", "bulk super active"),
      };
      const name = new Map(Object.entries(t).map(([label, id]) => [id, label]));
      const labels = (list: string[]) => list.map((id) => name.get(id) ?? id).sort();
      const armed = [t.active, t.error, t.needsReconnect, t.refused, t.superActive];
      const neverArmed = [t.pending, t.paused, t.expired, t.dead];
      const rowsOnProvider = async () =>
        new Map((await listTriggers(request, su, { scope: "all", provider })).map((row) => [row.id, row]));

      await test.step("Both filters select their intersection", async () => {
        const both = await bulkTriggers(request, su, "pause", { provider, trigger_ids: [t.active, randomUUID()], dry_run: true });
        expect(both).toMatchObject({ matched: 1, changed: [t.active], unchanged: [], failed: [] });
        const disjoint = await bulkTriggers(request, su, "pause", { provider: runProvider("other"), trigger_ids: [t.active], dry_run: true });
        expect(disjoint).toMatchObject({ matched: 0, changed: [], unchanged: [], failed: [], owners: 0 });
      });

      await test.step("A dry-run pause reports what it would change across both owners, and writes nothing", async () => {
        const result = await bulkTriggers(request, su, "pause", { provider, dry_run: true });
        expect(sorted(Object.keys(result))).toEqual(["action", "changed", "dry_run", "failed", "matched", "owners", "unchanged"]);
        expect(result).toMatchObject({ action: "pause", dry_run: true, matched: 9, failed: [], owners: 2 });
        expect(labels(result.changed)).toEqual(labels(armed));
        expect(labels(result.unchanged)).toEqual(labels(neverArmed));
        for (const [id, row] of await rowsOnProvider()) {
          expect(row.state, `${name.get(id)} after a dry run`).toBe(seeded.get(id));
          expect(row.admin_paused_at, `${name.get(id)} after a dry run`).toBeNull();
        }
      });

      await test.step("Pause takes out active, error and needs_reconnect, and marks each as paused by an admin", async () => {
        const result = await bulkTriggers(request, su, "pause", { provider });
        expect(result).toMatchObject({ action: "pause", dry_run: false, matched: 9, failed: [], owners: 2 });
        expect(labels(result.changed)).toEqual(labels(armed));
        expect(labels(result.unchanged)).toEqual(labels(neverArmed));
        const rows = await rowsOnProvider();
        for (const id of armed) {
          expect(rows.get(id), `${name.get(id)} after the pause`).toMatchObject({ state: "paused", reason: "paused_by_admin" });
          expect(rows.get(id)?.admin_paused_at, `${name.get(id)} carries the operator's mark`).not.toBeNull();
        }
        for (const id of neverArmed) {
          expect(rows.get(id)?.state, `${name.get(id)} is left alone`).toBe(seeded.get(id));
          expect(rows.get(id)?.admin_paused_at).toBeNull();
        }
        const ownerView = await getTrigger(request, ownerHeaders(), t.active);
        expect(ownerView).toMatchObject({ reason: "paused_by_admin", allowed_actions: ["resume", "delete", "rotate_secret"] });
        expect(ownerView.blocked_actions).toEqual({ test: "paused_by_admin", replay: "paused_by_admin" });
      });

      await test.step("The owner's own pause clears the operator's mark", async () => {
        const row = await setTriggerEnabled(request, ownerHeaders(), t.active, false);
        expect(row).toMatchObject({ state: "paused", reason: "paused", admin_paused_at: null });
      });

      await test.step("A dry-run resume selects only what an operator paused, and writes nothing", async () => {
        const result = await bulkTriggers(request, su, "resume", { provider, dry_run: true });
        expect(result).toMatchObject({ action: "resume", dry_run: true, matched: 9, failed: [], owners: 2 });
        // The dry run decides eligibility and never calls enable, so the row
        // enable will refuse is counted here as a change (spec doc: Measured,
        // not asserted — the dialog's count can exceed what the confirm does).
        expect(labels(result.changed)).toEqual(labels([t.error, t.needsReconnect, t.refused, t.superActive]));
        expect(labels(result.unchanged)).toEqual(labels([t.active, ...neverArmed]));
        const rows = await rowsOnProvider();
        for (const id of [t.error, t.needsReconnect, t.refused, t.superActive]) {
          expect(rows.get(id)?.reason, `${name.get(id)} after a dry run`).toBe("paused_by_admin");
        }
      });

      await test.step("Resume re-arms what an operator paused; a refused one is released, stays paused and says why", async () => {
        const result = await bulkTriggers(request, su, "resume", { provider });
        expect(result).toMatchObject({ action: "resume", dry_run: false, matched: 9, owners: 2 });
        expect(labels(result.changed)).toEqual(labels([t.error, t.needsReconnect, t.superActive]));
        expect(labels(result.unchanged)).toEqual(labels([t.active, ...neverArmed]));
        expect(result.failed).toEqual([{ trigger_id: t.refused, detail: PROVIDER_UNAVAILABLE }]);
        const rows = await rowsOnProvider();
        for (const id of [t.error, t.needsReconnect, t.superActive]) {
          expect(rows.get(id), `${name.get(id)} after the resume`).toMatchObject({ state: "active", reason: null, admin_paused_at: null });
        }
        expect(rows.get(t.refused)).toMatchObject({
          state: "paused",
          reason: "paused",
          admin_paused_at: null,
          last_error: `${REFUSED_RESUME_PREFIX}${PROVIDER_UNAVAILABLE}`,
        });
        expect(rows.get(t.active), "the owner's own pause stays theirs").toMatchObject({ state: "paused", reason: "paused" });
        for (const id of neverArmed) expect(rows.get(id)?.state, `${name.get(id)}`).toBe(seeded.get(id));
      });
    },
  );

  test(
    "labels the sessions a trigger on the flow started, and nothing else",
    { tag: ["@api", "@integrations", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/test",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/triggers/sessions",
      ]);
      const provider = runProvider("sessions");
      const sessionsUrl = (params: Array<[string, string]>) => `/api/v1/triggers/sessions?${new URLSearchParams(params)}`;

      /** A flow with one active webhook, sent one test event; resolves once the event has its session. */
      async function triggeredSession(label: string) {
        const flow = await emptyFlow(request, ownerHeaders(), `sessions ${label}`);
        const trigger = await createTrigger(request, ownerHeaders(), {
          flow_id: flow.id,
          name: `sessions ${label} ${run}`,
          kind: "inbound_webhook",
          provider,
          state: "active",
        });
        const res = await request.post(`/api/v1/triggers/${trigger.id}/test`, { headers: ownerHeaders(), data: { payload: {} } });
        const text = await res.text();
        expect(res.status(), text).toBe(202);
        const eventId = (JSON.parse(text) as { id: string }).id;
        let sessionId: string | null = null;
        await expect
          .poll(
            async () => {
              const events = await retryOnDroppedConnection(() =>
                request.get(`/api/v1/triggers/${trigger.id}/events`, { headers: ownerHeaders() }),
              );
              expect(events.status()).toBe(200);
              const rows = (await events.json()) as Array<{ id: string; session_id: string | null }>;
              return (sessionId = rows.find((event) => event.id === eventId)?.session_id ?? null);
            },
            { message: `the test event on ${label} is dispatched with a session`, timeout: 30_000, intervals: [1000] },
          )
          .toBeTruthy();
        return { flow, trigger, sessionId: sessionId as unknown as string };
      }

      const [a, b] = await test.step("Two flows, each with a trigger that started a session", async () => [
        await triggeredSession("A"),
        await triggeredSession("B"),
      ]);

      await test.step("Flow A's lookup labels A's session and leaves out B's and an unknown one", async () => {
        const res = await request.get(
          sessionsUrl([
            ["flow_id", a.flow.id],
            ["session_id", a.sessionId],
            ["session_id", b.sessionId],
            ["session_id", `unknown-${run}`],
          ]),
          { headers: ownerHeaders() },
        );
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const rows = JSON.parse(text) as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(sorted(Object.keys(rows[0]))).toEqual(["kind", "provider", "session_id", "started_at", "trigger_id", "trigger_name"]);
        expect(rows[0]).toMatchObject({
          session_id: a.sessionId,
          trigger_id: a.trigger.id,
          trigger_name: a.trigger.name,
          kind: "inbound_webhook",
          provider,
        });
        expect(typeof rows[0].started_at).toBe("string");
      });

      await test.step("flow_id and 1–100 session ids are required", async () => {
        const shape = async (url: string) =>
          (await validationErrors(await request.get(url, { headers: ownerHeaders() }))).map(({ type, loc }) => ({ type, loc }));
        expect(await shape(sessionsUrl([["session_id", a.sessionId]]))).toEqual([{ type: "missing", loc: ["query", "flow_id"] }]);
        expect(await shape(sessionsUrl([["flow_id", a.flow.id]]))).toEqual([{ type: "missing", loc: ["query", "session_id"] }]);
        const many = (n: number) => Array.from({ length: n }, (_, i): [string, string] => ["session_id", `s${i}`]);
        expect(await shape(sessionsUrl([["flow_id", a.flow.id], ...many(101)]))).toEqual([{ type: "too_long", loc: ["query", "session_id"] }]);
        const hundred = await request.get(sessionsUrl([["flow_id", a.flow.id], ...many(100)]), { headers: ownerHeaders() });
        expect(hundred.status(), await hundred.text()).toBe(200);
        expect(await hundred.json()).toEqual([]);
      });

      await test.step("A flow the caller cannot read answers 404", async () => {
        const su = await superHeaders(request);
        await expectDetail(
          await request.get(sessionsUrl([["flow_id", a.flow.id], ["session_id", a.sessionId]]), { headers: su }),
          404,
          NOT_FOUND,
        );
        await expectDetail(
          await request.get(sessionsUrl([["flow_id", randomUUID()], ["session_id", a.sessionId]]), { headers: ownerHeaders() }),
          404,
          NOT_FOUND,
        );
      });
    },
  );
});
