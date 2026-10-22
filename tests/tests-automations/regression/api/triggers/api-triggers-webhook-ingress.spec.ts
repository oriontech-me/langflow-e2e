import { createHmac, randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { createCustomComponentGraphFlow } from "../../../../helpers/flows/build-custom-component-graph";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";

// Inbound webhook ingress: signing, the uniform 404, events, test and replay (#2308).
// Spec doc: docs/api/triggers/api-triggers-webhook-ingress.md
//
// `POST /api/v1/triggers/ingress/{provider}/{public_id}` takes a write from nobody:
// the only proof is an HMAC over the body. So the secret is shown once, a delivery
// is accepted once, and every refusal is the same 404 — a refusal that differed by
// cause would tell a caller which ids exist and how close a signature came. Each
// rejection probe below carries exactly ONE defect and is otherwise signed with the
// right secret, and is paired with a 202 control: a probe signed with a wrong
// secret would be refused for the secret's sake and measure nothing.
//
// The trigger lifecycle is #2303's and who a run executes as is #2309's. A trigger
// whose every run fails still reading healthy is a known defect owned by #2328.
test.describe("Triggers — inbound webhook ingress", () => {
  // Events a dispatcher has not settled yet.
  const UNSETTLED = ["pending", "claimed", "dispatched"];
  // Under the server's 2 s keep-alive: a longer gap between polls races the idle
  // close and surfaces as ECONNRESET (measured on 1.13.0.dev47, as in #2306).
  const POLL_MS = 1_000;
  // `trigger_ingress_max_body_bytes` and `trigger_ingress_signature_tolerance_s`, at their defaults.
  const MAX_BODY_BYTES = 1_048_576;
  const TOLERANCE_S = 300;
  const NOT_FOUND = '{"detail":"Not found"}';
  const NODE_ID = "InboundWebhookTrigger-e2e01";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  interface TriggerRead {
    id: string;
    kind: string;
    node_id: string | null;
    state: string;
    last_error: string | null;
  }

  interface TriggerEventRead {
    id: string;
    dedupe_key: string;
    state: string;
    attempt: number;
    payload: Record<string, unknown>;
    session_id: string | null;
    job_id: string | null;
    replay_of_event_id: string | null;
    error: string | null;
  }

  interface Ingress {
    path: string;
    publicId: string;
    secret: string;
  }

  // One throwaway owner per worker, not per test. Its login counts against the
  // login route's per-IP budget (5/min, `helpers/auth/login-request.ts`); an owner
  // per test spent seven logins per file and sat out a full window mid-run
  // (measured: +60 s). Every call below is scoped by flow or trigger id, so the
  // tests never read each other's rows. Deleting the owner takes its flows and
  // triggers with it.
  let owner: ConnectionsOwner | undefined;

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "trgingress",
    );
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  const headers = () => (owner as ConnectionsOwner).headers;
  const now = () => Math.floor(Date.now() / 1000);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** `X-Langflow-Signature` exactly as `verify_webhook` checks it: `v1=` HMAC-SHA256 over `v1:{ts}:{body}`. */
  function signature(secret: string, timestamp: number, body: Buffer): string {
    const mac = createHmac("sha256", secret).update(`v1:${timestamp}:`).update(body).digest("hex");
    return `v1=${mac}`;
  }

  function signedHeaders(secret: string, timestamp: number, body: Buffer): Record<string, string> {
    return {
      "content-type": "application/json",
      "X-Langflow-Signature": signature(secret, timestamp, body),
      "X-Langflow-Timestamp": String(timestamp),
    };
  }

  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  /**
   * A JSON body of exactly `bytes` bytes. `{"pad":"` + padding + `"}` is 10 bytes of
   * framing, so the padding is the rest.
   */
  function bodyOfSize(bytes: number): Buffer {
    const body = Buffer.from(`{"pad":"${"x".repeat(bytes - 10)}"}`);
    expect(body, "the padded body has the exact size asked for").toHaveLength(bytes);
    return body;
  }

  async function post(request: APIRequestContext, path: string, hdrs: Record<string, string>, body: Buffer) {
    const res = await request.post(path, { headers: hdrs, data: body });
    return { status: res.status(), body: await res.body(), headers: res.headers() };
  }

  /** The webhook flow: the trigger node's Event output into a Chat Output, so the run writes the event down. */
  async function webhookFlow(request: APIRequestContext, label: string): Promise<string> {
    const catalog = await fetchComponentCatalog(request, headers());
    return createCatalogFlow(
      request,
      catalog,
      {
        nodes: [
          { id: NODE_ID, type: "InboundWebhookTrigger" },
          { id: "ChatOutput-e2e01", type: "ChatOutput" },
        ],
        edges: [{ source: NODE_ID, output: "trigger_event", target: "ChatOutput-e2e01", field: "input_value" }],
      },
      { name: `E2E ingress ${label} ${run}`, headers: headers() },
    );
  }

  async function triggersOf(request: APIRequestContext, flowId: string): Promise<TriggerRead[]> {
    const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers: headers() });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead[];
  }

  /** The row flow save reconciled out of the trigger node — the one whose runs receive `event_payload`. */
  async function nodeTrigger(request: APIRequestContext, flowId: string): Promise<TriggerRead> {
    let rows: TriggerRead[] = [];
    await expect
      .poll(async () => (rows = await triggersOf(request, flowId)).length, {
        message: "flow save reconciles the trigger node into one row",
        timeout: 10_000,
      })
      .toBe(1);
    const [row] = rows;
    expect(row.kind).toBe("inbound_webhook");
    expect(row.node_id, "the row is bound to the trigger node").toBe(NODE_ID);
    return row;
  }

  async function createTrigger(request: APIRequestContext, data: Record<string, unknown>): Promise<TriggerRead> {
    const res = await request.post("/api/v1/triggers", { headers: headers(), data });
    const text = await res.text();
    expect(res.status(), text).toBe(201);
    return JSON.parse(text) as TriggerRead;
  }

  async function triggerAction(request: APIRequestContext, triggerId: string, action: string): Promise<TriggerRead> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/${action}`, { headers: headers() });
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  async function mintSecret(request: APIRequestContext, triggerId: string): Promise<Ingress> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/signing-secret`, { headers: headers() });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    const body = JSON.parse(text) as { public_id: string; ingress_url: string; signing_secret: string };
    expect(body.signing_secret, "the secret is answered").toBeTruthy();
    const path = new URL(body.ingress_url).pathname;
    expect(path, "the URL names the webhook provider and the public id").toBe(
      `/api/v1/triggers/ingress/webhook/${body.public_id}`,
    );
    return { path, publicId: body.public_id, secret: body.signing_secret };
  }

  /** A webhook flow, its node trigger enabled, and an armed ingress. */
  async function armedWebhook(request: APIRequestContext, label: string) {
    const flowId = await webhookFlow(request, label);
    const trigger = await nodeTrigger(request, flowId);
    expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");
    return { flowId, trigger, ingress: await mintSecret(request, trigger.id) };
  }

  async function events(request: APIRequestContext, triggerId: string): Promise<TriggerEventRead[]> {
    const res = await request.get(`/api/v1/triggers/${triggerId}/events`, { headers: headers() });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerEventRead[];
  }

  /** The event `match` accepts, once the dispatcher has settled it. Matched by id or key, never by position. */
  async function settledEvent(
    request: APIRequestContext,
    triggerId: string,
    match: (event: TriggerEventRead) => boolean,
    what: string,
    timeoutMs = 45_000,
  ): Promise<TriggerEventRead> {
    const deadline = Date.now() + timeoutMs;
    let last: TriggerEventRead | undefined;
    while (Date.now() < deadline) {
      last = (await events(request, triggerId)).find(match);
      if (last && !UNSETTLED.includes(last.state)) return last;
      await sleep(POLL_MS);
    }
    throw new Error(`${what} did not settle within ${timeoutMs / 1000} s (last seen: ${JSON.stringify(last)})`);
  }

  /** A completed event: its run exists and is named. */
  function expectRan(event: TriggerEventRead, what: string): void {
    expect(event.state, `${what} ran to completion (error: ${event.error})`).toBe("completed");
    expect(event.error, `${what} carries no error`).toBeNull();
    expect(event.job_id, `${what} names the job it created`).toBeTruthy();
    expect(event.session_id, `${what} names its run's session`).toBeTruthy();
  }

  /**
   * The event the flow's trigger node handed on, as the Chat Output wrote it into
   * the run's session: a fenced JSON block holding the dispatcher's envelope.
   */
  async function deliveredEnvelope(
    request: APIRequestContext,
    flowId: string,
    event: TriggerEventRead,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers: headers() });
      expect(res.status()).toBe(200);
      const message = ((await res.json()) as Array<{ session_id: string; text: string }>).find(
        (m) => m.session_id === event.session_id,
      );
      if (message) {
        const fenced = /```json\s*([\s\S]*?)\s*```/.exec(message.text);
        expect(fenced, `the run wrote the event as a JSON block: ${message.text}`).not.toBeNull();
        return JSON.parse((fenced as RegExpExecArray)[1]) as Record<string, unknown>;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`session ${event.session_id} recorded no message within 15 s`);
  }

  test(
    "the signing secret is answered once, never read back, and a rotation retires the old one at once while the address stays",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "GET /api/v1/triggers/{trigger_id}/ingress",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
      ]);
      const flowId = await webhookFlow(request, "secret");
      const trigger = await nodeTrigger(request, flowId);
      expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");

      const readIngress = async () => {
        const res = await request.get(`/api/v1/triggers/${trigger.id}/ingress`, { headers: headers() });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        return { text, body: JSON.parse(text) as Record<string, unknown> };
      };

      await test.step("before a mint there is no address and no secret", async () => {
        const { body } = await readIngress();
        expect(body).toEqual({
          trigger_id: trigger.id,
          public_id: null,
          ingress_url: null,
          has_signing_secret: false,
        });
      });

      const first = await test.step("the mint answers the address and the secret, once", async () => {
        const res = await request.post(`/api/v1/triggers/${trigger.id}/signing-secret`, { headers: headers() });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(
          ["has_signing_secret", "ingress_url", "public_id", "signing_secret", "trigger_id"].sort(),
        );
        expect(body.has_signing_secret).toBe(true);
        expect(typeof body.signing_secret === "string" && body.signing_secret.length > 0).toBe(true);
        expect(new URL(body.ingress_url as string).pathname).toBe(`/api/v1/triggers/ingress/webhook/${body.public_id}`);
        return {
          path: new URL(body.ingress_url as string).pathname,
          publicId: body.public_id as string,
          url: body.ingress_url as string,
          secret: body.signing_secret as string,
        };
      });

      await test.step("the secret is never read back", async () => {
        const { text, body } = await readIngress();
        expect(body).toEqual({
          trigger_id: trigger.id,
          public_id: first.publicId,
          ingress_url: first.url,
          has_signing_secret: true,
        });
        expect(text, "the ingress read does not carry the secret").not.toContain(first.secret);
        const row = await request.get(`/api/v1/triggers/${trigger.id}`, { headers: headers() });
        expect(row.status()).toBe(200);
        expect(await row.text(), "the trigger read does not carry the secret").not.toContain(first.secret);
        const list = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers: headers() });
        expect(await list.text(), "the trigger list does not carry the secret").not.toContain(first.secret);
      });

      const second = await test.step("a rotation keeps the address and changes the secret", async () => {
        const rotated = await mintSecret(request, trigger.id);
        expect(rotated.publicId, "public_id survives the rotation").toBe(first.publicId);
        expect(rotated.path).toBe(first.path);
        expect(rotated.secret, "the rotation mints a new secret").not.toBe(first.secret);
        return rotated;
      });

      await test.step("the old secret stops verifying at once; the new one is accepted", async () => {
        const ts = now();
        const body = json({ e2e: run, marker: "rotation" });
        const old = await post(request, first.path, signedHeaders(first.secret, ts, body), body);
        expect(old.status, "a delivery signed with the retired secret is refused").toBe(404);
        expect(old.body.toString()).toBe(NOT_FOUND);
        const fresh = await post(request, second.path, signedHeaders(second.secret, ts, body), body);
        expect(fresh.status, `the same delivery signed with the new secret is accepted: ${fresh.body}`).toBe(202);
      });

      await test.step("only an inbound webhook owns a secret", async () => {
        const schedule = await createTrigger(request, { flow_id: flowId, name: `E2E schedule ${run}`, kind: "schedule" });
        const detail = "Only inbound webhook triggers have an owner-managed signing secret.";
        const ingress = await request.get(`/api/v1/triggers/${schedule.id}/ingress`, { headers: headers() });
        expect(ingress.status()).toBe(409);
        expect((await ingress.json()).detail).toBe(detail);
        const mint = await request.post(`/api/v1/triggers/${schedule.id}/signing-secret`, { headers: headers() });
        expect(mint.status()).toBe(409);
        expect((await mint.json()).detail).toBe(detail);
      });
    },
  );

  test(
    "a signed delivery is accepted once, runs, and reaches the flow through event_payload",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const { flowId, trigger, ingress } = await armedWebhook(request, "delivery");
      const delivery = { e2e: run, marker: "delivery" };
      const body = json(delivery);
      const signed = signedHeaders(ingress.secret, now(), body);

      const row = await test.step("a signed delivery answers 202 and appends one row", async () => {
        const res = await post(request, ingress.path, signed, body);
        expect(res.status, res.body.toString()).toBe(202);
        expect(res.body, "the acceptance carries no body").toHaveLength(0);
        const rows = await events(request, trigger.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].dedupe_key).toMatch(/^ingress:webhook:[0-9a-f]{32}$/);
        expect(rows[0].payload).toEqual({ provider: "webhook", delivery });
        return rows[0];
      });

      await test.step("the identical delivery again is accepted and collapsed", async () => {
        const res = await post(request, ingress.path, signed, body);
        expect(res.status, "a redelivery is acknowledged, not refused").toBe(202);
        const rows = await events(request, trigger.id);
        expect(rows.map((e) => e.id), "the redelivery appended nothing").toEqual([row.id]);
      });

      const settled = await test.step("the row runs to completion", async () => {
        const event = await settledEvent(request, trigger.id, (e) => e.id === row.id, "the delivery");
        expectRan(event, "the delivery");
        return event;
      });

      await test.step("the flow received the delivery through event_payload", async () => {
        const envelope = await deliveredEnvelope(request, flowId, settled);
        expect(envelope.event_id, "the run was fed this row").toBe(row.id);
        expect(envelope.dedupe_key).toBe(row.dedupe_key);
        expect(envelope.kind).toBe("inbound_webhook");
        expect(envelope.payload, "the flow sees the exact body that was signed").toEqual({ provider: "webhook", delivery });
      });
    },
  );

  test(
    "every refusal answers the same 404, byte for byte, and writes no ledger row",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/disable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
      ]);
      const { trigger, ingress } = await armedWebhook(request, "probes");
      const { secret } = ingress;
      const at = (provider: string, publicId = ingress.publicId) => `/api/v1/triggers/ingress/${provider}/${publicId}`;
      const probeBody = (marker: string) => json({ e2e: run, marker });
      // Everything a refusal answers, but the clock.
      const shape = (r: { status: number; body: Buffer; headers: Record<string, string> }) => {
        const rest = Object.fromEntries(Object.entries(r.headers).filter(([name]) => name !== "date"));
        return { status: r.status, body: r.body.toString("base64"), headers: rest };
      };

      expect(await events(request, trigger.id), "no delivery has been made yet").toHaveLength(0);

      const reference = await test.step("an unknown public id is the reference refusal", async () => {
        // Same length and alphabet as a real id; the `e2e` prefix keeps it from ever being the trigger's own.
        const unknown = `e2e${randomBytes(24).toString("base64url")}`.slice(0, ingress.publicId.length);
        expect(unknown).not.toBe(ingress.publicId);
        const body = probeBody("unknown-id");
        const res = await post(request, at("webhook", unknown), signedHeaders(secret, now(), body), body);
        expect(res.status).toBe(404);
        expect(res.body.toString(), "the refusal body").toBe(NOT_FOUND);
        expect(res.headers["content-type"]).toBe("application/json");
        return shape(res);
      });

      const expectUniform = async (what: string, path: string, hdrs: Record<string, string>, body: Buffer) => {
        const res = await post(request, path, hdrs, body);
        expect(shape(res), `${what}: the refusal is indistinguishable from an unknown id`).toEqual(reference);
      };

      await test.step("each probe carries one defect and is refused identically", async () => {
        const wrongSig = probeBody("wrong-signature");
        await expectUniform("wrong signature", ingress.path, signedHeaders(`wrong-${secret}`, now(), wrongSig), wrongSig);

        const stale = probeBody("stale");
        const staleTs = now() - TOLERANCE_S - 100;
        await expectUniform("timestamp in the past", ingress.path, signedHeaders(secret, staleTs, stale), stale);

        const future = probeBody("future");
        const futureTs = now() + TOLERANCE_S + 100;
        await expectUniform("timestamp in the future", ingress.path, signedHeaders(secret, futureTs, future), future);

        await expectUniform("no signature headers", ingress.path, { "content-type": "application/json" }, probeBody("bare"));

        const notJson = Buffer.from(`not json ${run}`);
        await expectUniform("a body that is not JSON", ingress.path, signedHeaders(secret, now(), notJson), notJson);

        const oversized = bodyOfSize(MAX_BODY_BYTES + 1);
        await expectUniform("a body over 1 MiB", ingress.path, signedHeaders(secret, now(), oversized), oversized);

        // These pin that the refusal is uniform, not the kind check: were `resolve_target` to accept a
        // webhook trigger under `microsoft` or `google`, that provider's own verifier would still
        // refuse this body, so the 404 holds either way.
        for (const provider of ["microsoft", "google", "nosuch"]) {
          const body = probeBody(`provider-${provider}`);
          await expectUniform(`provider segment ${provider}`, at(provider), signedHeaders(secret, now(), body), body);
        }
      });

      const pausedProbe = await test.step("a paused trigger is refused identically", async () => {
        expect((await triggerAction(request, trigger.id, "disable")).state).toBe("paused");
        const body = probeBody("paused");
        const hdrs = signedHeaders(secret, now(), body);
        await expectUniform("a paused trigger", ingress.path, hdrs, body);
        return { hdrs, body };
      });

      await test.step("no refusal wrote a ledger row", async () => {
        expect(await events(request, trigger.id)).toHaveLength(0);
      });

      await test.step("each probe without its defect is accepted", async () => {
        expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");
        const paused = await post(request, ingress.path, pausedProbe.hdrs, pausedProbe.body);
        expect(paused.status, "the paused probe's exact request, once re-enabled").toBe(202);

        const atLimit = bodyOfSize(MAX_BODY_BYTES);
        const limit = await post(request, ingress.path, signedHeaders(secret, now(), atLimit), atLimit);
        expect(limit.status, "a body of exactly 1 MiB").toBe(202);

        const fresh = probeBody("control");
        const control = await post(request, at("webhook"), signedHeaders(secret, now(), fresh), fresh);
        expect(control.status, "the right provider, a fresh timestamp, the right secret, a JSON body").toBe(202);

        expect(await events(request, trigger.id), "each control appended its row").toHaveLength(3);
      });
    },
  );

  test(
    "the test action appends a synthetic event that runs through the real dispatcher",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/test",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const flowId = await webhookFlow(request, "test");
      const trigger = await nodeTrigger(request, flowId);
      expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");

      const appended = await test.step("test answers 202 with a pending synthetic row", async () => {
        const res = await request.post(`/api/v1/triggers/${trigger.id}/test`, {
          headers: headers(),
          data: { payload: { e2e: run, marker: "test" } },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(202);
        const event = JSON.parse(text) as TriggerEventRead;
        expect(event.state).toBe("pending");
        expect(event.dedupe_key).toMatch(/^test:[0-9a-f-]{36}$/);
        expect(event.payload, "the payload is the request's, marked as a test").toEqual({
          e2e: run,
          marker: "test",
          test: true,
        });
        return event;
      });

      const settled = await test.step("the synthetic row runs to completion", async () => {
        const event = await settledEvent(request, trigger.id, (e) => e.id === appended.id, "the test event");
        expectRan(event, "the test event");
        return event;
      });

      await test.step("the flow received the synthetic payload", async () => {
        const envelope = await deliveredEnvelope(request, flowId, settled);
        expect(envelope.event_id).toBe(appended.id);
        expect(envelope.dedupe_key).toBe(appended.dedupe_key);
        expect(envelope.payload).toEqual(appended.payload);
      });
    },
  );

  test(
    "the test action is refused on a dead trigger",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/test",
        "GET /api/v1/triggers/{trigger_id}/events",
      ]);
      const flowId = await webhookFlow(request, "dead");

      // Nothing moves a trigger to `dead` on its own; creating it in that state is the only way to reach one.
      const dead = await createTrigger(request, {
        flow_id: flowId,
        name: `E2E dead ${run}`,
        kind: "inbound_webhook",
        state: "dead",
      });
      expect(dead.state).toBe("dead");

      await test.step("test answers 409 and appends nothing", async () => {
        const res = await request.post(`/api/v1/triggers/${dead.id}/test`, {
          headers: headers(),
          data: { payload: { e2e: run, marker: "dead" } },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(409);
        expect(JSON.parse(text).detail).toBe("Trigger is dead and cannot be tested.");
        expect(await events(request, dead.id)).toHaveLength(0);
      });
    },
  );

  test(
    "replay appends a new linked row that runs the original payload, and leaves the original as it was",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/triggers",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "POST /api/v1/triggers/{trigger_id}/replay",
        "GET /api/v1/triggers/{trigger_id}/events",
        "GET /api/v1/monitor/messages",
      ]);
      const { flowId, trigger, ingress } = await armedWebhook(request, "replay");
      const delivery = { e2e: run, marker: "replay-original" };

      const original = await test.step("a delivery runs to completion", async () => {
        const body = json(delivery);
        const res = await post(request, ingress.path, signedHeaders(ingress.secret, now(), body), body);
        expect(res.status, res.body.toString()).toBe(202);
        const event = await settledEvent(
          request,
          trigger.id,
          (e) => e.dedupe_key.startsWith("ingress:webhook:"),
          "the original delivery",
        );
        expectRan(event, "the original delivery");
        return event;
      });

      const replay = await test.step("replay answers 202 with a new row linked to the original", async () => {
        const res = await request.post(`/api/v1/triggers/${trigger.id}/replay`, {
          headers: headers(),
          data: { event_id: original.id },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(202);
        const event = JSON.parse(text) as TriggerEventRead;
        expect(event.id, "a replay is a new row").not.toBe(original.id);
        expect(event.replay_of_event_id).toBe(original.id);
        expect(event.dedupe_key.startsWith(`replay:${original.id}:`), event.dedupe_key).toBe(true);
        expect(event.payload, "the replay carries the original payload").toEqual(original.payload);
        return event;
      });

      await test.step("the replay runs the original payload", async () => {
        const settled = await settledEvent(request, trigger.id, (e) => e.id === replay.id, "the replay");
        expectRan(settled, "the replay");
        expect(settled.job_id, "the replay is its own run").not.toBe(original.job_id);
        expect(settled.session_id, "the replay runs in its own session").not.toBe(original.session_id);
        const envelope = await deliveredEnvelope(request, flowId, settled);
        expect(envelope.event_id).toBe(replay.id);
        expect(envelope.payload).toEqual({ provider: "webhook", delivery });
      });

      await test.step("the original row is left as it was", async () => {
        const current = (await events(request, trigger.id)).find((e) => e.id === original.id);
        expect(current, "the original row is still there").toBeDefined();
        expect(current?.state).toBe("completed");
        expect(current?.job_id).toBe(original.job_id);
        expect(current?.replay_of_event_id).toBeNull();
      });

      await test.step("a replay is scoped to its own trigger's events", async () => {
        const unknown = await request.post(`/api/v1/triggers/${trigger.id}/replay`, {
          headers: headers(),
          data: { event_id: "00000000-0000-0000-0000-000000000000" },
        });
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).detail).toBe("Event not found");

        const other = await createTrigger(request, { flow_id: flowId, name: `E2E other ${run}`, kind: "inbound_webhook" });
        const crossed = await request.post(`/api/v1/triggers/${other.id}/replay`, {
          headers: headers(),
          data: { event_id: original.id },
        });
        expect(crossed.status(), "another trigger cannot replay this trigger's event").toBe(404);
        expect((await crossed.json()).detail).toBe("Event not found");
      });
    },
  );

  test(
    "a flow that fails on every delivery records each event as failed, with no retry",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/triggers",
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "GET /api/v1/triggers/{trigger_id}/events",
      ]);
      const catalog = await fetchComponentCatalog(request, headers());
      const failing = await createCustomComponentGraphFlow(
        request,
        catalog,
        { nodes: [{ id: "Boom", kind: "raise" }], edges: [] },
        { name: `E2E ingress failing ${run}`, headers: headers() },
      );
      const trigger = await createTrigger(request, {
        flow_id: failing.flowId,
        name: `E2E failing ${run}`,
        kind: "inbound_webhook",
        max_attempts: 2,
      });
      expect((await triggerAction(request, trigger.id, "enable")).state).toBe("active");
      const ingress = await mintSecret(request, trigger.id);

      await test.step("two distinct deliveries are accepted", async () => {
        for (const marker of ["fail-1", "fail-2"]) {
          const body = json({ e2e: run, marker });
          const res = await post(request, ingress.path, signedHeaders(ingress.secret, now(), body), body);
          expect(res.status, res.body.toString()).toBe(202);
        }
      });

      const expectFailedOnce = (rows: TriggerEventRead[]) => {
        expect(rows, "one row per delivery, and no retry row").toHaveLength(2);
        for (const row of rows) {
          expect(row.state, `the run failed (error: ${row.error})`).toBe("failed");
          expect(row.error).toBe("job_failed");
          expect(row.attempt, "a failed run is not retried").toBe(0);
          expect(row.job_id, "the failure is the run's, not the submit's").toBeTruthy();
        }
      };

      await test.step("each event settles as a failed run", async () => {
        let rows: TriggerEventRead[] = [];
        await expect
          .poll(
            async () => {
              rows = await events(request, trigger.id);
              return rows.filter((e) => !UNSETTLED.includes(e.state)).length;
            },
            { message: "both deliveries settle", timeout: 60_000, intervals: [1000] },
          )
          .toBe(2);
        expectFailedOnce(rows);
      });

      await test.step("one dispatcher poll later nothing was re-queued", async () => {
        // Longer than `trigger_dispatcher_poll_interval_s` (5 s). A retry re-queues the row as `pending`
        // with `attempt` 1 on the pass that settles it, so one more pass is enough to see one.
        await sleep(7_000);
        expectFailedOnce(await events(request, trigger.id));
      });
    },
  );
});
