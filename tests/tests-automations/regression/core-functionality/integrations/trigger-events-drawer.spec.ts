import type { APIRequestContext, Locator, Page, Request } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import {
  deliverSignedWebhook,
  jsonBody,
  type MintedSecret,
  mintSigningSecret,
} from "../../../../helpers/triggers/sign-webhook";

// The trigger node's events drawer: paging, server filters, replay and the payload tree (#2449).
// Spec doc: docs/core-functionality/integrations/trigger-events-drawer.md
//
// The list is seeded with one real signed delivery, which runs the flow, and with
// test events sent to a PAUSED trigger: they answer 202 at once and never run the
// flow, where 52 deliveries would cost minutes of runs for a test about a list.
// The dispatcher terminalizes them one per tick (~5 s), oldest first, so counts
// that depend on their state are never asserted; the rows a filter shows are.
// "Newest first" holds to the second only (`created_at` resolution, ties by id),
// so the drawer's order is compared with the API's, never with the send order.
test.describe("Triggers on the canvas — the events drawer", () => {
  // The first nightly serving the whole 1.14 triggers batch.
  const SINCE = "1.14.0.dev26";
  const NODE_ID = "InboundWebhookTrigger-d01";
  const PAGE_SIZE = 50;
  const SEEDED_TESTS = 52;
  const QUEUED = "No run has started for this event yet.";
  const ENDED = "This event ended before a run was started, so there is no run to open.";
  const NO_MATCH = "No events match this filter.";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  let headers: Record<string, string> = {};

  interface TriggerEventRead {
    id: string;
    dedupe_key: string;
    state: string;
    job_id: string | null;
    replay_of_event_id: string | null;
    error: string | null;
  }

  interface Armed {
    flowId: string;
    flowName: string;
    triggerId: string;
    ingress: MintedSecret;
  }

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `the trigger events drawer ships in ${SINCE}; this build does not carry it`,
    );
    headers = { Authorization: await getAuthToken(request) };
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor first, so the drawer's polls do not 404 into the log.
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  async function triggerAction(request: APIRequestContext, triggerId: string, action: string): Promise<string> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/${action}`, { headers });
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(200);
    return (JSON.parse(text) as { state: string }).state;
  }

  /** Inbound Webhook into a Chat Output, its trigger enabled and its signing secret minted. */
  async function armedWebhook(request: APIRequestContext, label: string): Promise<Armed> {
    const catalog = await fetchComponentCatalog(request, headers);
    const flowName = `E2E trigger events ${label} ${run}`;
    const flowId = await createCatalogFlow(
      request,
      catalog,
      {
        nodes: [
          { id: NODE_ID, type: "InboundWebhookTrigger" },
          { id: "ChatOutput-d01", type: "ChatOutput" },
        ],
        edges: [{ source: NODE_ID, output: "trigger_event", target: "ChatOutput-d01", field: "input_value" }],
      },
      { name: flowName, headers },
    );
    flowIds.push(flowId);
    let rows: { id: string; node_id: string | null }[] = [];
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
    expect(rows[0].node_id).toBe(NODE_ID);
    const triggerId = rows[0].id;
    expect(await triggerAction(request, triggerId, "enable")).toBe("active");
    const ingress = await mintSigningSecret(request, triggerId, headers);
    return { flowId, flowName, triggerId, ingress };
  }

  async function events(request: APIRequestContext, triggerId: string, query = ""): Promise<TriggerEventRead[]> {
    const res = await request.get(`/api/v1/triggers/${triggerId}/events${query}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerEventRead[];
  }

  async function eventState(request: APIRequestContext, triggerId: string, eventId: string): Promise<string> {
    const found = (await events(request, triggerId, "?limit=200")).find((e) => e.id === eventId);
    expect(found, `event ${eventId} is listed`).toBeDefined();
    return (found as TriggerEventRead).state;
  }

  /** One signed delivery, accepted, then waited on until its flow run completes. */
  async function deliverAndComplete(request: APIRequestContext, armed: Armed, body: unknown): Promise<TriggerEventRead> {
    const before = new Set((await events(request, armed.triggerId, "?limit=200")).map((e) => e.id));
    expect(await deliverSignedWebhook(request, armed.ingress.path, armed.ingress.secret, jsonBody(body))).toBe(202);
    let delivery: TriggerEventRead | undefined;
    await expect
      .poll(
        async () => {
          delivery = (await events(request, armed.triggerId)).find(
            (e) => !before.has(e.id) && e.dedupe_key.startsWith("ingress:"),
          );
          return delivery?.state;
        },
        { message: "the delivery's flow run completes", timeout: 60_000 },
      )
      .toBe("completed");
    const done = delivery as TriggerEventRead;
    expect(done.job_id, "the completed delivery names its run").toBeTruthy();
    return done;
  }

  async function sendTest(request: APIRequestContext, triggerId: string, payload: object): Promise<TriggerEventRead> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/test`, { headers, data: { payload } });
    const text = await res.text();
    expect(res.status(), text).toBe(202);
    return JSON.parse(text) as TriggerEventRead;
  }

  const drawer = (page: Page) => page.getByTestId("trigger-events-drawer");
  const rows = (page: Page) => drawer(page).locator("ul[aria-label='Events, newest first'] > li > button");
  const eventRow = (page: Page, id: string) => page.getByTestId(`trigger-event-${id}`);
  const openRun = (page: Page) => page.getByTestId("trigger-event-open-run");
  const replayButton = (page: Page) => page.getByTestId("trigger-event-replay");
  const pill = (page: Page, filter: string) => page.getByTestId(`trigger-events-filter-${filter}`);
  /** Each row's lines as rendered: receipt, origin tag (Test or Replay), time, summary, state. */
  const rowLines = (page: Page) =>
    rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText.split("\n").map((l) => l.trim())));

  const isEventsRead = (triggerId: string, req: Request) =>
    req.method() === "GET" && new URL(req.url()).pathname === `/api/v1/triggers/${triggerId}/events`;

  async function openDrawer(page: Page, armed: Armed): Promise<void> {
    await openFlowById(page, armed.flowId);
    await expect(page.getByTestId("trigger-node-badge")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("trigger-node-badge").click();
    await page.getByTestId("trigger-node-events").click();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page)).toContainText(`Events · ${armed.flowName}`);
  }

  /** Click a filter pill; returns the URL of the events read it caused. */
  async function applyFilter(page: Page, armed: Armed, filter: string): Promise<URL> {
    const read = page.waitForRequest(
      (req) => isEventsRead(armed.triggerId, req) && new URL(req.url()).searchParams.get("filter") === filter,
    );
    await pill(page, filter).click();
    const url = new URL((await read).url());
    await expect(pill(page, filter)).toHaveAttribute("aria-pressed", "true");
    return url;
  }

  test(
    "the events drawer pages 50 at a time and filters on the server",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const armed = await armedWebhook(request, "paging");
      let delivery: TriggerEventRead;
      const seeded: TriggerEventRead[] = [];

      await test.step("one delivery runs, then 52 test events queue on the paused trigger", async () => {
        delivery = await deliverAndComplete(request, armed, { text: `paging delivery ${run}` });
        expect(await triggerAction(request, armed.triggerId, "disable")).toBe("paused");
        for (let i = 0; i < SEEDED_TESTS; i++) {
          seeded.push(await sendTest(request, armed.triggerId, { subject: `seed ${i} ${run}` }));
        }
        await expect
          .poll(async () => (await events(request, armed.triggerId, "?filter=failed")).length, {
            message: "the paused trigger has failed at least one test event, so Needs attention has rows",
            timeout: 30_000,
          })
          .toBeGreaterThan(0);
      });

      await test.step("the drawer lists the newest 50 and selects the first, still queued", async () => {
        // `created_at` has one-second resolution and ties break by id, so the
        // first event is the API's, not necessarily the last one sent.
        const [first] = await events(request, armed.triggerId, "?limit=1");
        expect(seeded.map((e) => e.id), "the first event is one of the seeded tests").toContain(first.id);
        await openDrawer(page, armed);
        await expect(rows(page)).toHaveCount(PAGE_SIZE);
        await expect(rows(page).first()).toHaveAttribute("data-testid", `trigger-event-${first.id}`);
        await expect(eventRow(page, first.id)).toHaveAttribute("aria-current", "true");
        await expect(openRun(page)).toHaveAttribute("aria-disabled", "true");
        await expect(openRun(page)).toHaveAccessibleDescription(QUEUED);
        expect(["pending", "claimed"], "the first test event is still queued behind the older ones").toContain(
          await eventState(request, armed.triggerId, first.id),
        );
      });

      await test.step("Load older reads the next page by offset and then disappears", async () => {
        const more = page.getByTestId("trigger-events-load-more");
        await expect(more).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });
        const read = page.waitForRequest(
          (req) => isEventsRead(armed.triggerId, req) && new URL(req.url()).searchParams.get("offset") === "50",
        );
        await more.click();
        const params = new URL((await read).url()).searchParams;
        expect(params.get("limit")).toBe(String(PAGE_SIZE + 1));
        expect(params.get("filter")).toBeNull();
        await expect(rows(page)).toHaveCount(SEEDED_TESTS + 1);
        await expect(more).toHaveCount(0);
        await expect(eventRow(page, delivery.id)).toBeVisible();
      });

      await test.step("Tests lists only test events, tagged Test", async () => {
        await applyFilter(page, armed, "tests");
        await expect(rows(page)).toHaveCount(PAGE_SIZE);
        const lines = await rowLines(page);
        expect(
          lines.filter((l) => !l.includes("Test")),
          "every row the Tests filter shows carries the Test tag",
        ).toEqual([]);
        await expect(eventRow(page, delivery.id)).toHaveCount(0);
      });

      await test.step("Needs attention lists only failed or dead events", async () => {
        await applyFilter(page, armed, "failed");
        await expect(rows(page).first()).toBeVisible();
        const states = await rows(page).evaluateAll((els) =>
          els.map((el) => el.querySelector('[data-testid="trigger-event-state"]')?.getAttribute("data-state") ?? null),
        );
        expect(states.length).toBeGreaterThan(0);
        expect(states.filter((s) => s !== "failed" && s !== "dead"), "only failed or dead rows").toEqual([]);
      });

      await test.step("Replays and Skipped come back empty and say so", async () => {
        for (const filter of ["replays", "skipped"]) {
          await applyFilter(page, armed, filter);
          await expect(page.getByTestId("trigger-events-empty")).toHaveText(NO_MATCH);
          await expect(rows(page)).toHaveCount(0);
        }
      });

      await test.step("All shows every loaded event again", async () => {
        await pill(page, "all").click();
        await expect(pill(page, "all")).toHaveAttribute("aria-pressed", "true");
        await expect(rows(page)).toHaveCount(SEEDED_TESTS + 1);
      });
    },
  );

  test(
    "replaying an event confirms, queues a new event, selects it and shows its lineage",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const armed = await armedWebhook(request, "replay");
      let delivery: TriggerEventRead;
      let tested: TriggerEventRead;

      await test.step("a delivery completes, then a test event fails on the paused trigger", async () => {
        delivery = await deliverAndComplete(request, armed, { text: `replay delivery ${run}` });
        expect(await triggerAction(request, armed.triggerId, "disable")).toBe("paused");
        tested = await sendTest(request, armed.triggerId, { subject: `replay source ${run}` });
        await expect
          .poll(async () => eventState(request, armed.triggerId, tested.id), {
            message: "a paused trigger ends the test event without a run",
            timeout: 30_000,
          })
          .toBe("failed");
      });

      await test.step("a delivery that ran opens its flow, and a paused trigger blocks replay", async () => {
        await openDrawer(page, armed);
        await eventRow(page, delivery.id).click();
        await expect(eventRow(page, delivery.id)).toHaveAttribute("aria-current", "true");
        await expect(openRun(page)).not.toHaveAttribute("aria-disabled", "true");
        await expect(replayButton(page)).toHaveAttribute("aria-disabled", "true");
        await expect(replayButton(page)).toHaveAccessibleDescription("Resume the trigger first.");
      });

      await test.step("an event that ended without a run blocks Open flow and says so", async () => {
        await eventRow(page, tested.id).click();
        await expect(eventRow(page, tested.id)).toHaveAttribute("aria-current", "true");
        await expect(openRun(page)).toHaveAttribute("aria-disabled", "true");
        await expect(openRun(page)).toHaveAccessibleDescription(ENDED);
      });

      await test.step("resuming the trigger unblocks replay", async () => {
        expect(await triggerAction(request, armed.triggerId, "enable")).toBe("active");
        await expect(replayButton(page)).not.toHaveAttribute("aria-disabled", "true", { timeout: 20_000 });
      });

      let replayed: TriggerEventRead;

      await test.step("replaying from Tests confirms, queues a new event and brings it into view", async () => {
        await applyFilter(page, armed, "tests");
        await expect(rows(page)).toHaveCount(1);
        await expect(eventRow(page, tested.id)).toHaveAttribute("aria-current", "true");

        await replayButton(page).click();
        const dialog = page.getByTestId("trigger-replay-dialog");
        await expect(dialog).toContainText("Replay this event?");
        const replay = page.waitForResponse(
          (res) =>
            res.request().method() === "POST" &&
            new URL(res.url()).pathname === `/api/v1/triggers/${armed.triggerId}/replay`,
        );
        await page.getByTestId("trigger-replay-confirm").click();
        const res = await replay;
        expect(res.request().postDataJSON()).toEqual({ event_id: tested.id });
        expect(res.status()).toBe(202);
        replayed = (await res.json()) as TriggerEventRead;
        expect(replayed.replay_of_event_id, "the new event names its original").toBe(tested.id);
        expect(replayed.id).not.toBe(tested.id);

        await expect(page.locator("p.success-alert-message")).toHaveText("Replay queued as a new event");
        await expect(pill(page, "all"), "the filter left Tests for All").toHaveAttribute("aria-pressed", "true");
        await expect(eventRow(page, replayed.id)).toHaveAttribute("aria-current", "true");
        const lines = await eventRow(page, replayed.id).innerText();
        expect(lines.split("\n").map((l) => l.trim()), "the new row is tagged Replay").toContain("Replay");
        await expect(page.getByTestId("trigger-event-lineage")).toContainText("Replay of");
      });

      await test.step("Replays lists exactly the new event", async () => {
        await applyFilter(page, armed, "replays");
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toHaveAttribute("data-testid", `trigger-event-${replayed.id}`);
      });
    },
  );

  test(
    "the payload tree opens only its root and labels every type",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const armed = await armedWebhook(request, "payload");
      const sentinel = `payload tree ${run}`;
      const lines = Array.from({ length: 53 }, (_, i) => i);
      const delivery = await deliverAndComplete(request, armed, {
        text: sentinel,
        order: { id: 7, paid: false, note: null, tags: ["a", "b"], lines },
      });

      const payload = page.getByTestId("trigger-event-payload");
      const exact = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      /** A field's own row: a collection's `summary`, or a primitive's `div`. */
      const field = (label: string): Locator =>
        payload.locator("summary, li > div").filter({ has: page.locator("span.font-medium", { hasText: exact(label) }) });
      const typeOf = (label: string) => field(label).locator("span.rounded");
      const valueOf = (label: string) => field(label).locator("code");
      const countOf = (label: string) => field(label).locator("span.font-sans:not(.rounded)");
      const detailsOf = (label: string) => field(label).locator("xpath=..");

      async function expectCollection(label: string, type: string, count: string, open: boolean): Promise<void> {
        await expect(field(label), `${label} is rendered once`).toHaveCount(1);
        await expect(typeOf(label)).toHaveText(type);
        await expect(countOf(label)).toHaveText(count);
        await expect(detailsOf(label)).toHaveJSProperty("open", open);
      }

      async function expectValue(label: string, type: string, value: string): Promise<void> {
        await expect(field(label), `${label} is rendered once`).toHaveCount(1);
        await expect(typeOf(label)).toHaveText(type);
        await expect(valueOf(label)).toHaveText(value);
      }

      await test.step("only the root is open", async () => {
        await openDrawer(page, armed);
        await eventRow(page, delivery.id).click();
        await expect(eventRow(page, delivery.id)).toHaveAttribute("aria-current", "true");
        await expectCollection("Payload", "Object", "2 fields", true);
        await expectValue("provider", "Text", '"webhook"');
        await expectCollection("delivery", "Object", "2 fields", false);
        await expect(field("text"), "the body is not rendered while delivery is closed").toHaveCount(0);
        await expect(field("order")).toHaveCount(0);
      });

      await test.step("every type is labelled, with its count", async () => {
        await field("delivery").click();
        await expectValue("text", "Text", JSON.stringify(sentinel));
        await expectCollection("order", "Object", "5 fields", false);
        await field("order").click();
        await expectValue("id", "Number", "7");
        await expectValue("paid", "Boolean", "false");
        await expectValue("note", "Null", "null");
        await expectCollection("tags", "Array", "2 items", false);
        await expectCollection("lines", "Array", "53 items", false);
      });

      await test.step("a list longer than 50 shows the first 50 and offers the rest", async () => {
        await field("lines").click();
        await expectValue("[0]", "Number", "0");
        await expectValue("[49]", "Number", "49");
        await expect(field("[50]")).toHaveCount(0);
        const showMore = payload.getByRole("button", { name: /^Show \d+ more$/ });
        await expect(showMore).toHaveText("Show 3 more");
        await showMore.click();
        for (const index of [50, 51, 52]) await expectValue(`[${index}]`, "Number", String(index));
        await expect(showMore).toHaveCount(0);
      });
    },
  );
});
