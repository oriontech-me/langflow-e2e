import { createHmac } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type CatalogFlowSpec, createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { parseProbeOutput, probeFlowSpec, type ProbeTarget } from "../../../../helpers/integrations/connection-probe";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { type CreatedConnection, createConnectionViaApi } from "../../../../helpers/integrations/create-connection";

// A trigger run acts as the flow owner (#2309).
// Spec doc: docs/api/triggers/api-triggers-run-identity.md
//
// A trigger run has nobody present: the dispatcher executes it as the flow owner,
// non-interactively. So the owner's user connection needs its opt-in, an instance
// connection does not, and another user's never resolves. The refusal lands in one
// of two places, and both are asserted: a handle named inside the flow is refused
// INSIDE the run (the trigger keeps running), while a trigger that names its own
// `connection_id` is refused by the dispatcher's preflight BEFORE any run exists,
// and the trigger moves to `needs_reconnect`.
//
// The verdict is read from the #2296 probe, in the run whose `session_id` the event
// names. The trigger lifecycle itself is #2303's; only the calls needed to fire a
// run are made here.
test.describe("Triggers — a trigger run acts as the flow owner", () => {
  const OPT_IN_REASON = "non-interactive-opt-in-required";
  const NOT_AUTHORIZED = "connection-not-authorized";
  const PREFLIGHT_ERROR = "connection_not_authorized";
  // Events a dispatcher has not settled yet.
  const UNSETTLED = ["pending", "claimed"];
  // Under the server's 2 s keep-alive: a longer gap between polls races the idle
  // close and surfaces as ECONNRESET (measured on 1.13.0.dev47, as in #2306).
  const POLL_MS = 1_000;

  // Planted credentials, unique per run, swept as TEXT from every probe message
  // (#1967): a verdict that echoed a token would pass every other assertion.
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const sentinels: string[] = [];
  function sentinel(label: string): string {
    const token = `E2E-TRIGGER-${label.toUpperCase()}-SENTINEL-${run}`;
    sentinels.push(token);
    return token;
  }

  interface TriggerRead {
    id: string;
    flow_id: string;
    user_id: string;
    kind: string;
    node_id: string | null;
    connection_id: string | null;
    config: Record<string, unknown>;
    state: string;
    next_fire_at: string | null;
    last_error: string | null;
    updated_at: string | null;
  }

  interface TriggerEventRead {
    id: string;
    dedupe_key: string;
    state: string;
    payload: Record<string, unknown>;
    session_id: string | null;
    job_id: string | null;
    error: string | null;
  }

  // Each test's own owner, and the rows the superuser planted for it. Deleting the
  // owner takes its flows, triggers and connections with it.
  let owner: ConnectionsOwner | undefined;
  const superuserRows: CreatedConnection[] = [];

  test.afterEach(async () => {
    const failures: string[] = [];
    for (const row of superuserRows.splice(0)) {
      await row.deleteConnection().catch((error) => failures.push(String(error)));
    }
    const current = owner;
    owner = undefined;
    await current?.dispose();
    expect(failures, "every connection the superuser planted for this test is deleted").toEqual([]);
  });

  async function newOwner(
    playwright: { request: { newContext(options: { baseURL?: string }): Promise<APIRequestContext> } },
    baseURL: string | undefined,
  ): Promise<ConnectionsOwner> {
    owner = await createConnectionsOwner(() => playwright.request.newContext({ baseURL }), "trgrun");
    return owner;
  }

  /** A row owned by `headers`' user, carrying a sentinel token. */
  async function plantUserRow(
    request: APIRequestContext,
    headers: Record<string, string>,
    label: string,
    allowNonInteractive?: boolean,
  ): Promise<CreatedConnection> {
    return createConnectionViaApi(request, headers, {
      label,
      allowNonInteractive,
      credentials: { access_token: sentinel(label) },
    });
  }

  /** An instance row, its own opt-in sent explicitly OFF: it must resolve because the flag is not read. */
  async function plantInstanceRow(request: APIRequestContext, label: string): Promise<CreatedConnection> {
    const superHeaders = { Authorization: await getAuthToken(request) };
    const row = await createConnectionViaApi(request, superHeaders, {
      label,
      ownershipMode: "instance",
      allowNonInteractive: false,
      credentials: { access_token: sentinel(label) },
    });
    superuserRows.push(row);
    return row;
  }

  async function ownerFlow(request: APIRequestContext, spec: CatalogFlowSpec, label: string): Promise<string> {
    const headers = (owner as ConnectionsOwner).headers;
    const catalog = await fetchComponentCatalog(request, headers);
    return createCatalogFlow(request, catalog, spec, {
      name: `E2E trigger ${label} ${run} ${Math.random().toString(36).slice(2, 6)}`,
      headers,
    });
  }

  async function createTrigger(request: APIRequestContext, data: Record<string, unknown>): Promise<TriggerRead> {
    const res = await request.post("/api/v1/triggers", { headers: (owner as ConnectionsOwner).headers, data });
    const text = await res.text();
    expect(res.status(), text).toBe(201);
    return JSON.parse(text) as TriggerRead;
  }

  async function triggerAction(request: APIRequestContext, triggerId: string, action: string): Promise<TriggerRead> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/${action}`, {
      headers: (owner as ConnectionsOwner).headers,
    });
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  async function readTrigger(request: APIRequestContext, triggerId: string): Promise<TriggerRead> {
    const res = await request.get(`/api/v1/triggers/${triggerId}`, { headers: (owner as ConnectionsOwner).headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  async function setOptIn(request: APIRequestContext, connection: CreatedConnection, on: boolean): Promise<void> {
    const res = await request.patch(`/api/v1/connections/${connection.id}`, {
      headers: (owner as ConnectionsOwner).headers,
      data: { allow_non_interactive: on },
    });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    expect(JSON.parse(text).allow_non_interactive, `the opt-in now reads ${on}`).toBe(on);
  }

  /**
   * The first event `match` accepts, once the dispatcher has settled it. Matched by
   * id or dedupe key, never by position: a schedule keeps appending ticks.
   */
  async function settledEvent(
    request: APIRequestContext,
    triggerId: string,
    match: (event: TriggerEventRead) => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<TriggerEventRead> {
    const deadline = Date.now() + timeoutMs;
    let last: TriggerEventRead | undefined;
    while (Date.now() < deadline) {
      const res = await request.get(`/api/v1/triggers/${triggerId}/events`, {
        headers: (owner as ConnectionsOwner).headers,
      });
      expect(res.status()).toBe(200);
      last = ((await res.json()) as TriggerEventRead[]).find(match);
      if (last && !UNSETTLED.includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error(`${what} did not settle within ${timeoutMs / 1000} s (last seen: ${JSON.stringify(last)})`);
  }

  /**
   * A server timestamp as epoch ms. SQLite serializes them naive and in UTC; a
   * value that already carries an offset is taken as it is, so `Z` is never
   * appended twice.
   */
  function serverTime(value: string | null | undefined): number {
    const parsed = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value ?? "") ? (value as string) : `${value}Z`);
    expect(Number.isNaN(parsed), `a server timestamp parses: ${value}`).toBe(false);
    return parsed;
  }

  /** The probe lines of the run a dispatched event created, found by its session id. */
  async function runVerdicts(
    request: APIRequestContext,
    flowId: string,
    event: TriggerEventRead,
  ): Promise<ReturnType<typeof parseProbeOutput>> {
    // `dispatched` until the dispatcher's next pass closes it out as `completed`
    // (~5 s): a slow poll may see either, and both carry the job and the session.
    expect(["dispatched", "completed"], `the event ran (state: ${event.state}, error: ${event.error})`).toContain(
      event.state,
    );
    expect(event.job_id, "a dispatched event names the job it created").toBeTruthy();
    expect(event.session_id, "a dispatched event names its run's session").toBeTruthy();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, {
        headers: (owner as ConnectionsOwner).headers,
      });
      expect(res.status()).toBe(200);
      const messages = (await res.json()) as Array<{ session_id: string; text: string }>;
      const text = messages
        .filter((m) => m.session_id === event.session_id && m.text.includes("PROBE "))
        .map((m) => m.text)
        .join("\n");
      if (text) {
        for (const token of sentinels) {
          expect(text, "a trigger run's message must not carry a planted token").not.toContain(token);
        }
        return parseProbeOutput(text);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error(`session ${event.session_id} recorded no probe message within 15 s`);
  }

  /** One delivery signed the way `verify_webhook` checks it: `v1=` HMAC-SHA256 over `v1:{ts}:{body}`. */
  async function deliver(request: APIRequestContext, ingressPath: string, secret: string, body: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`;
    const res = await request.post(ingressPath, {
      headers: {
        "content-type": "application/json",
        "X-Langflow-Signature": signature,
        "X-Langflow-Timestamp": timestamp,
      },
      data: body,
    });
    expect(res.status(), await res.text()).toBe(202);
  }

  const resolvedAs = (connection: CreatedConnection, ownerKind: "user" | "instance") => ({
    state: "resolved",
    ownerKind,
    connectionId: connection.id,
  });
  const optInDenied = { state: "denied", code: NOT_AUTHORIZED, reason: OPT_IN_REASON };
  const notTheOwners = { state: "denied", code: "connection-unresolved", reason: "missing" };

  test(
    "a webhook delivery runs as the flow owner: the owner's connection needs the opt-in, the instance's does not, another user's never resolves",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ playwright, request, apiCoverage }, testInfo) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "PATCH /api/v1/connections/{connection_id}",
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "GET /api/v1/triggers/{trigger_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const me = await newOwner(playwright, testInfo.project.use.baseURL);
      const superHeaders = { Authorization: await getAuthToken(request) };

      const mine = await plantUserRow(request, me.headers, "trg_mine");
      const instance = await plantInstanceRow(request, "trg_instance");
      // Another user's row, opted in: if the run used anyone but the owner, this would resolve.
      const theirs = await plantUserRow(request, superHeaders, "trg_theirs", true);
      superuserRows.push(theirs);
      const targets: ProbeTarget[] = [
        { field: "mine", handle: `google/${mine.name}` },
        { field: "instance", handle: `google/${instance.name}` },
        { field: "theirs", handle: `google/${theirs.name}` },
      ];
      const flowId = await ownerFlow(request, probeFlowSpec(targets), "webhook");

      const trigger = await test.step("an inbound webhook trigger is created, enabled and given an ingress", async () => {
        const created = await createTrigger(request, { flow_id: flowId, name: `E2E webhook ${run}`, kind: "inbound_webhook" });
        expect(created.user_id, "the trigger is owned by the flow owner").toBe(me.userId);
        expect(created.connection_id, "the trigger names no connection of its own").toBeNull();
        expect((await triggerAction(request, created.id, "enable")).state).toBe("active");
        return created;
      });

      const ingress = await test.step("rotating the signing secret arms the ingress URL", async () => {
        const res = await request.post(`/api/v1/triggers/${trigger.id}/signing-secret`, { headers: me.headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const body = JSON.parse(text) as { ingress_url: string | null; signing_secret: string; public_id: string | null };
        expect(body.public_id, "the ingress has a public id").toBeTruthy();
        expect(body.ingress_url, "the ingress URL is answered with the secret").toBeTruthy();
        expect(body.signing_secret, "the signing secret is answered once").toBeTruthy();
        const path = new URL(body.ingress_url as string).pathname;
        expect(path, "the URL names the webhook provider and the public id").toBe(
          `/api/v1/triggers/ingress/webhook/${body.public_id}`,
        );
        return { path, secret: body.signing_secret };
      });

      /** One signed delivery, and the verdicts of the run it caused. */
      const deliveryVerdicts = async (marker: string) => {
        const body = JSON.stringify({ e2e: run, marker });
        await deliver(request, ingress.path, ingress.secret, body);
        const event = await settledEvent(
          request,
          trigger.id,
          (e) =>
            e.dedupe_key.startsWith("ingress:webhook:") &&
            JSON.stringify((e.payload as { delivery?: unknown }).delivery) === JSON.stringify({ e2e: run, marker }),
          `the ${marker} delivery`,
        );
        expect(event.payload.provider, "the ledger records the delivery's provider").toBe("webhook");
        return runVerdicts(request, flowId, event);
      };

      await test.step("opt-in off: the owner's row is refused inside the run, the instance row resolves", async () => {
        const verdicts = await deliveryVerdicts("off");
        expect(verdicts.mine, "the owner's row needs the opt-in for an unattended run").toEqual(optInDenied);
        expect(verdicts.instance, "an instance row never reads the opt-in").toEqual(resolvedAs(instance, "instance"));
        expect(verdicts.theirs, "the run executes as the flow owner, who cannot see another user's row").toEqual(
          notTheOwners,
        );
      });

      await test.step("a refusal inside the run leaves the trigger in service", async () => {
        const after = await readTrigger(request, trigger.id);
        expect(after.state, "the trigger keeps running").toBe("active");
        expect(after.last_error, "nothing is recorded against the trigger").toBeNull();
      });

      await test.step("opt-in on: the next delivery resolves the owner's row", async () => {
        await setOptIn(request, mine, true);
        const verdicts = await deliveryVerdicts("on");
        expect(verdicts.mine, "with the opt-in, the owner's row resolves for an unattended run").toEqual(
          resolvedAs(mine, "user"),
        );
        expect(verdicts.instance).toEqual(resolvedAs(instance, "instance"));
        expect(verdicts.theirs, "another user's row stays out of reach, opted in or not").toEqual(notTheOwners);
      });
    },
  );

  test(
    "a trigger that names its connection fails closed before any run, and runs again as soon as the owner opts in",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ playwright, request, apiCoverage }, testInfo) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "PATCH /api/v1/connections/{connection_id}",
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/test",
        "GET /api/v1/triggers/{trigger_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const me = await newOwner(playwright, testInfo.project.use.baseURL);
      const mine = await plantUserRow(request, me.headers, "trg_named");
      const flowId = await ownerFlow(request, probeFlowSpec([{ field: "mine", handle: `google/${mine.name}` }]), "named");

      const trigger = await createTrigger(request, {
        flow_id: flowId,
        name: `E2E named ${run}`,
        kind: "inbound_webhook",
        connection_id: mine.id,
      });
      expect(trigger.connection_id, "the trigger names the owner's connection").toBe(mine.id);
      expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");

      /** A synthetic event through the ordinary ledger, settled. */
      const testEvent = async (marker: string) => {
        const res = await request.post(`/api/v1/triggers/${trigger.id}/test`, {
          headers: me.headers,
          data: { payload: { e2e: run, marker } },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(202);
        const appended = JSON.parse(text) as TriggerEventRead;
        expect(appended.state, "the event is appended to the ledger").toBe("pending");
        return settledEvent(request, trigger.id, (e) => e.id === appended.id, `the ${marker} test event`);
      };

      await test.step("opt-in off: the dispatcher refuses the event before a job exists", async () => {
        const event = await testEvent("off");
        expect(event.state, "the event fails").toBe("failed");
        expect(event.error, "on the connection's authorization").toBe(PREFLIGHT_ERROR);
        expect(event.job_id, "no job was created").toBeNull();
        expect(event.session_id, "no run session was created").toBeNull();
      });

      await test.step("the trigger is marked as needing a reconnect", async () => {
        const after = await readTrigger(request, trigger.id);
        expect(after.state).toBe("needs_reconnect");
        expect(after.last_error).toBe(PREFLIGHT_ERROR);
      });

      // `needs_reconnect` is a dispatchable state: it marks the trigger, it does not
      // hold its events. Each event is preflighted again, so the opt-in alone is
      // what lets the next one run (measured on 1.13.0.dev47).
      await test.step("with the opt-in on, the next event runs as the owner, before any re-enable", async () => {
        await setOptIn(request, mine, true);
        const verdicts = await runVerdicts(request, flowId, await testEvent("on"));
        expect(verdicts.mine).toEqual(resolvedAs(mine, "user"));
        expect((await readTrigger(request, trigger.id)).state, "a successful run does not clear the mark").toBe(
          "needs_reconnect",
        );
      });

      await test.step("re-enabling clears the mark and the recorded error", async () => {
        const enabled = await triggerAction(request, trigger.id, "enable");
        expect(enabled.state).toBe("active");
        expect(enabled.last_error).toBeNull();
      });
    },
  );

  test(
    "a schedule trigger imported through flow JSON fires on its cron and runs as the flow owner",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ playwright, request, apiCoverage }, testInfo) => {
      // Up to a minute for the cron boundary, plus the dispatcher's polls.
      test.setTimeout(240_000);
      apiCoverage.declare([
        "POST /api/v1/connections",
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/disable",
        "GET /api/v1/triggers/{trigger_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const SCHEDULE_NODE = "ScheduleTrigger-tick";
      const me = await newOwner(playwright, testInfo.project.use.baseURL);
      const mine = await plantUserRow(request, me.headers, "trg_tick");
      const instance = await plantInstanceRow(request, "trg_tick_instance");
      const spec = probeFlowSpec([
        { field: "mine", handle: `google/${mine.name}` },
        { field: "instance", handle: `google/${instance.name}` },
      ]);
      spec.nodes.push({
        id: SCHEDULE_NODE,
        type: "ScheduleTrigger",
        values: { cron_expression: "* * * * *", timezone: "UTC" },
      });
      const flowId = await ownerFlow(request, spec, "schedule");

      const trigger = await test.step("saving the flow creates the schedule trigger, unarmed", async () => {
        const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers: me.headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const rows = JSON.parse(text) as TriggerRead[];
        expect(rows, "one trigger row per trigger node").toHaveLength(1);
        const [row] = rows;
        expect(row.kind).toBe("schedule");
        expect(row.node_id, "the row is keyed on the node").toBe(SCHEDULE_NODE);
        expect(row.config.cron).toBe("* * * * *");
        expect(row.config.timezone).toBe("UTC");
        expect(row.state, "saving never arms a trigger").toBe("pending");
        expect(row.user_id, "the row is owned by the flow owner").toBe(me.userId);
        return row;
      });

      const nextFireAt = await test.step("enabling arms it for the next minute boundary", async () => {
        const enabled = await triggerAction(request, trigger.id, "enable");
        expect(enabled.state).toBe("active");
        // `enable` does not compute the fire time: the scheduler does, on its next
        // pass (up to one poll later), from the time of THAT pass. So the bound is
        // measured from the scheduler's write — the row's `updated_at`, server time
        // to the second — never from the enable, which can be a minute boundary
        // earlier.
        const deadline = Date.now() + 30_000;
        let armed: TriggerRead | undefined;
        while (Date.now() < deadline && !armed?.next_fire_at) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          armed = await readTrigger(request, trigger.id);
        }
        expect(armed?.next_fire_at, "the scheduler computes the next fire time").toBeTruthy();
        const fireAt = serverTime(armed?.next_fire_at);
        const armedAt = serverTime(armed?.updated_at);
        expect(new Date(fireAt).getUTCSeconds(), "a whole minute").toBe(0);
        // Not strictly after: a write that started at :59.99 and landed at :00.01
        // reads the boundary itself once truncated to the second. A boundary
        // already past is still a whole second below.
        expect(fireAt, "not before the scheduler armed it").toBeGreaterThanOrEqual(armedAt);
        // 60 s to the next boundary, plus the second `updated_at` is truncated to.
        expect(fireAt - armedAt, "the first minute boundary after the scheduler armed it").toBeLessThanOrEqual(61_000);
        return fireAt;
      });

      await test.step("the tick fires at that minute and runs as the owner", async () => {
        const scheduledAt = new Date(nextFireAt).toISOString().replace(".000Z", "+00:00");
        const event = await settledEvent(
          request,
          trigger.id,
          (e) => e.dedupe_key === `tick:${scheduledAt}`,
          `the ${scheduledAt} tick`,
          // At most the minute to the boundary, plus the scheduler's and the
          // dispatcher's polls (5 s each by default) and the run.
          120_000,
        );
        expect(event.payload.scheduled_at, "the tick names the minute it fired for").toBe(scheduledAt);
        const verdicts = await runVerdicts(request, flowId, event);
        expect(verdicts.mine, "a schedule tick is unattended too").toEqual(optInDenied);
        expect(verdicts.instance).toEqual(resolvedAs(instance, "instance"));
      });

      await test.step("disabling pauses the schedule", async () => {
        expect((await triggerAction(request, trigger.id, "disable")).state).toBe("paused");
      });
    },
  );
});
