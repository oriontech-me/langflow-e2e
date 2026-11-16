import type { APIRequestContext, Page, Request, Route } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type CatalogFlowSpec,
  createCatalogFlow,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import { deliverSignedWebhook, jsonBody } from "../../../../helpers/triggers/sign-webhook";

// The trigger node's own controls: badge, Enabled, background-run consent, webhook secret (#2449).
// Spec doc: docs/core-functionality/integrations/trigger-node-controls.md
//
// Each control reads or writes the trigger row flow-save reconciliation keeps for
// the node, so every state the node shows is read back from the server too. The
// connection-backed trigger is Google Calendar over a planted connection: Gmail
// refuses a planted credential before consent is read. The events drawer is the
// sibling file, `trigger-events-drawer.spec.ts`.
test.describe("Triggers on the canvas — the trigger node's controls", () => {
  // The first nightly serving the whole 1.14 triggers batch.
  const SINCE = "1.14.0.dev26";
  const CALENDAR = "ext:google:GoogleOnCalendarTriggerComponent@official";
  const CALENDAR_NAME = "Google Calendar: On Event";
  const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
  const WEBHOOK_NODE = "InboundWebhookTrigger-n01";
  const CALENDAR_NODE = "GoogleCalendarTrigger-n01";
  const INBOUND_ROW = "triggers_inbound webhook_draggable";

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  const connections: CreatedConnection[] = [];
  let headers: Record<string, string> = {};

  interface TriggerRead {
    id: string;
    kind: string;
    node_id: string | null;
    state: string;
    reason: string | null;
    connection_id: string | null;
  }

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `the trigger node controls ship in ${SINCE}; this build does not carry them`,
    );
    headers = { Authorization: await getAuthToken(request) };
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor first, so the node's polls and a pending autosave do not 404 into the log.
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    // Flows first: deleting a flow takes its trigger rows, which reference the connection.
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    for (const connection of connections.splice(0)) {
      await connection.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow and connection this test created is deleted").toEqual([]);
  });

  async function createFlow(request: APIRequestContext, label: string, spec: CatalogFlowSpec): Promise<string> {
    const catalog = await fetchComponentCatalog(request, headers);
    const id = await createCatalogFlow(request, catalog, spec, {
      name: `E2E trigger node ${label} ${run}`,
      headers,
    });
    flowIds.push(id);
    return id;
  }

  /** Inbound Webhook into a Chat Output, so an accepted delivery has a flow to run. */
  function webhookFlow(request: APIRequestContext, label: string): Promise<string> {
    return createFlow(request, label, {
      nodes: [
        { id: WEBHOOK_NODE, type: "InboundWebhookTrigger" },
        { id: "ChatOutput-n01", type: "ChatOutput" },
      ],
      edges: [{ source: WEBHOOK_NODE, output: "trigger_event", target: "ChatOutput-n01", field: "input_value" }],
    });
  }

  /** A planted Google connection and a flow holding one Calendar trigger bound to it. */
  async function calendarFlow(
    request: APIRequestContext,
    label: string,
    options: { scopes: string[]; consent: boolean },
  ): Promise<{ flowId: string; connection: CreatedConnection; trigger: TriggerRead }> {
    const connection = await createConnectionViaApi(request, headers, {
      label: `trg_${label}`,
      grantedScopes: options.scopes,
      allowNonInteractive: options.consent,
    });
    connections.push(connection);
    const flowId = await createFlow(request, label, {
      nodes: [{ id: CALENDAR_NODE, type: CALENDAR, values: { connection: `google/${connection.name}` } }],
      edges: [],
    });
    const trigger = await triggerOf(request, flowId);
    expect(trigger.connection_id, "reconciliation binds the trigger to the connection").toBe(connection.id);
    return { flowId, connection, trigger };
  }

  async function triggersOf(request: APIRequestContext, flowId: string): Promise<TriggerRead[]> {
    const res = await request.get(`/api/v1/triggers?flow_id=${flowId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead[];
  }

  /** The one row flow save reconciled out of the flow's trigger node. */
  async function triggerOf(request: APIRequestContext, flowId: string): Promise<TriggerRead> {
    let rows: TriggerRead[] = [];
    await expect
      .poll(async () => (rows = await triggersOf(request, flowId)).length, {
        message: "flow save reconciles the trigger node into one row",
        timeout: 15_000,
      })
      .toBe(1);
    return rows[0];
  }

  async function readTrigger(request: APIRequestContext, triggerId: string): Promise<TriggerRead> {
    const res = await request.get(`/api/v1/triggers/${triggerId}`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  async function triggerAction(request: APIRequestContext, triggerId: string, action: string): Promise<TriggerRead> {
    const res = await request.post(`/api/v1/triggers/${triggerId}/${action}`, { headers });
    const text = await res.text();
    expect(res.status(), `${action}: ${text}`).toBe(200);
    return JSON.parse(text) as TriggerRead;
  }

  /** One list read: the list shares a 60/min read bucket with the node's own connection query. */
  async function readConnection(request: APIRequestContext, connectionId: string): Promise<ConnectionRead> {
    const res = await request.get("/api/v1/connections?provider=google", { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    const row = (JSON.parse(text) as ConnectionRead[]).find((c) => c.id === connectionId);
    expect(row, `connection ${connectionId} is listed`).toBeDefined();
    return row as ConnectionRead;
  }

  async function ingressOf(request: APIRequestContext, triggerId: string) {
    const res = await request.get(`/api/v1/triggers/${triggerId}/ingress`, { headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    return {
      text,
      body: JSON.parse(text) as { public_id: string | null; ingress_url: string | null; has_signing_secret: boolean },
    };
  }

  const badge = (page: Page) => page.getByTestId("trigger-node-badge");
  const popover = (page: Page) => page.getByTestId("trigger-node-popover");
  const enabledSwitch = (page: Page) => page.getByTestId("trigger-node-enabled");
  const consentSwitch = (page: Page) => page.getByTestId("trigger-node-consent");
  const successToast = (page: Page) => page.locator("p.success-alert-message");
  const errorToast = (page: Page) => page.locator("h3.error-build-foreground");
  /** The `dd` the popover pairs with the `dt` reading `term`. */
  const detail = (page: Page, term: string) =>
    popover(page).locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");

  const isPath = (request: Request, method: string, path: string) =>
    request.method() === method && new URL(request.url()).pathname === path;

  test(
    "a trigger node is unsaved until its flow saves, then shows a badge that follows the trigger",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "unsaved", { nodes: [{ id: "ChatOutput-n01", type: "ChatOutput" }], edges: [] });
      const flowPath = `/api/v1/flows/${flowId}`;

      await test.step("hold the flow's saves and add Inbound Webhook from the palette", async () => {
        await openFlowById(page, flowId);
        const held: Route[] = [];
        let holding = true;
        const isFlowWrite = (url: URL) => url.pathname === flowPath;
        await page.route(isFlowWrite, async (route) => {
          if (holding && route.request().method() === "PATCH") held.push(route);
          else await route.continue();
        });

        await page.getByTestId("sidebar-search-input").fill("inbound webhook");
        const row = page.getByTestId(INBOUND_ROW).locator('div[role="button"]');
        await expect(row, "the palette has settled (#2197)").toHaveAttribute("draggable", "true", { timeout: 20_000 });
        await row.focus();
        await page.keyboard.press("Enter");

        await expect(page.getByTestId("trigger-node-unsaved")).toHaveText("Save the flow to create this trigger.");
        await expect(badge(page), "no badge before the trigger row exists").toHaveCount(0);
        await expect
          .poll(() => held.length, { message: "the autosave carrying the node was issued and is held", timeout: 15_000 })
          .toBeGreaterThan(0);
        expect(await triggersOf(request, flowId), "the server has no trigger row while the save is held").toEqual([]);

        // Stop holding BEFORE releasing, so a save issued meanwhile is not parked
        // forever, and release BEFORE unrouting: unrouting first sends the held
        // routes to the network on their own (#2413).
        holding = false;
        for (const route of held.splice(0)) await route.continue();
        await page.unroute(isFlowWrite);
      });

      await test.step("the badge appears and carries the server's state", async () => {
        const trigger = await triggerOf(request, flowId);
        const nodeId = await page.locator('.react-flow__node[data-id^="InboundWebhookTrigger-"]').getAttribute("data-id");
        expect(trigger.node_id, "the row is the node's").toBe(nodeId);
        expect(trigger.state).toBe("pending");
        await expect(badge(page)).toHaveAttribute("data-state", trigger.state, { timeout: 20_000 });
        await expect(badge(page)).toHaveAccessibleName("Trigger state: Pending. Show details.");
        await expect(page.getByTestId("trigger-node-unsaved")).toHaveCount(0);
      });

      await test.step("the popover opens from the keyboard and returns focus on Escape", async () => {
        const config = await request.get("/api/v1/config", { headers });
        expect(config.status()).toBe(200);
        const interval = ((await config.json()) as { trigger_polling_interval: number }).trigger_polling_interval;
        expect(typeof interval, "the config states the polling interval").toBe("number");

        await badge(page).focus();
        await page.keyboard.press("Enter");
        await expect(popover(page)).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Trigger details" })).toBeVisible();
        await expect(popover(page)).toContainText(
          "Not listening yet. Turn on Enabled to start, or wait while the provider subscription completes.",
        );
        await expect(popover(page)).toContainText(`Checked every ${interval / 1000} s.`);
        await expect(detail(page, "Transport")).toHaveText("Signed request");
        await expect(detail(page, "Last event")).toHaveText("Never");

        await page.keyboard.press("Escape");
        await expect(popover(page)).toHaveCount(0);
        await expect(badge(page)).toBeFocused();
      });
    },
  );

  test(
    "the Enabled switch resumes and pauses the trigger, and a refused resume says why",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const webhookId = await webhookFlow(request, "enabled");
      const trigger = await triggerOf(request, webhookId);
      const calendar = await calendarFlow(request, "noscope", { scopes: [], consent: true });

      await test.step("Enabled resumes the trigger with no toast", async () => {
        await openFlowById(page, webhookId);
        await expect(badge(page)).toHaveAttribute("data-state", "pending", { timeout: 20_000 });
        await expect(enabledSwitch(page)).toHaveAccessibleName("Enabled");
        await expect(enabledSwitch(page)).toHaveAttribute("role", "switch");
        await expect(enabledSwitch(page)).toHaveAttribute("aria-checked", "false");

        const enable = page.waitForResponse((res) => isPath(res.request(), "POST", `/api/v1/triggers/${trigger.id}/enable`));
        await enabledSwitch(page).click();
        expect((await enable).status()).toBe(200);
        await expect(badge(page)).toHaveAttribute("data-state", "active");
        await expect(enabledSwitch(page)).toHaveAttribute("aria-checked", "true");
        expect((await readTrigger(request, trigger.id)).state).toBe("active");
        await expect(successToast(page), "a resume that worked shows no toast").toHaveCount(0);
        await expect(errorToast(page)).toHaveCount(0);
      });

      await test.step("Enabled off pauses it, and a paused trigger blocks the test event", async () => {
        const disable = page.waitForResponse((res) => isPath(res.request(), "POST", `/api/v1/triggers/${trigger.id}/disable`));
        await enabledSwitch(page).click();
        expect((await disable).status()).toBe(200);
        await expect(badge(page)).toHaveAttribute("data-state", "paused");
        expect((await readTrigger(request, trigger.id)).state).toBe("paused");
        await expect(successToast(page)).toHaveCount(0);

        await badge(page).click();
        const sendTest = page.getByTestId("trigger-node-test");
        await expect(sendTest).toHaveAttribute("aria-disabled", "true");
        await expect(sendTest).toHaveAttribute("aria-description", "Resume the trigger first.");
        await page.keyboard.press("Escape");
        await expect(popover(page)).toHaveCount(0);
      });

      await test.step("a resume the server refuses keeps the switch off and names the reason", async () => {
        // The one deliberate 409 of this test; every response before it was monitored.
        (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
        await unmountEditorForCleanup(page);
        await openFlowById(page, calendar.flowId);
        await expect(badge(page)).toHaveAttribute("data-state", "pending", { timeout: 20_000 });
        await expect(consentSwitch(page), "consent is on, so the switch is live").toHaveAttribute("aria-checked", "true");
        await expect(enabledSwitch(page)).not.toHaveAttribute("aria-disabled", "true");

        const enable = page.waitForResponse((res) =>
          isPath(res.request(), "POST", `/api/v1/triggers/${calendar.trigger.id}/enable`),
        );
        await enabledSwitch(page).click();
        const refused = await enable;
        expect(refused.status(), await refused.text()).toBe(409);
        await expect(errorToast(page)).toHaveText(`Couldn't resume ${CALENDAR_NAME}`);
        await expect(page.locator("li", { hasText: "The source connection is missing required scopes" })).toContainText(
          CALENDAR_SCOPE,
        );
        await expect(enabledSwitch(page)).toHaveAttribute("aria-checked", "false");
        await expect(badge(page)).toHaveAttribute("data-state", "pending");
        expect((await readTrigger(request, calendar.trigger.id)).state).toBe("pending");
      });
    },
  );

  test(
    "background-run consent is the connection owner's switch, persists, and the fix path allows and resumes",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const owned = await calendarFlow(request, "consent", { scopes: [CALENDAR_SCOPE], consent: false });

      await test.step("consent starts off and blocks Enabled", async () => {
        await openFlowById(page, owned.flowId);
        await expect(consentSwitch(page)).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
        await expect(consentSwitch(page)).toHaveAccessibleDescription(
          `Lets triggers and schedules use ${owned.connection.displayName} while you're away. Applies to every background use of this connection.`,
        );
        await expect(enabledSwitch(page)).toHaveAttribute("aria-disabled", "true");
        await expect(enabledSwitch(page)).toHaveAccessibleDescription("Allow background runs first.");
      });

      await test.step("turning consent on writes it on the connection", async () => {
        const patch = page.waitForRequest((req) => isPath(req, "PATCH", `/api/v1/connections/${owned.connection.id}`));
        await consentSwitch(page).click();
        const sent = await patch;
        expect(sent.postDataJSON()).toEqual({ allow_non_interactive: true });
        expect((await sent.response())?.status()).toBe(200);
        await expect(consentSwitch(page)).toHaveAttribute("aria-checked", "true");
        expect((await readConnection(request, owned.connection.id)).allow_non_interactive).toBe(true);
        await expect(enabledSwitch(page)).not.toHaveAttribute("aria-disabled", "true");
      });

      await test.step("consent survives a reload", async () => {
        await page.reload();
        await expect(consentSwitch(page)).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
      });

      const stopped = await calendarFlow(request, "fixpath", { scopes: [CALENDAR_SCOPE], consent: true });

      await test.step("a trigger stopped for missing consent offers Reconnect", async () => {
        expect((await triggerAction(request, stopped.trigger.id, "enable")).state).toBe("active");
        const off = await request.patch(`/api/v1/connections/${stopped.connection.id}`, {
          headers,
          data: { allow_non_interactive: false },
        });
        expect(off.status(), await off.text()).toBe(200);
        const sent = await request.post(`/api/v1/triggers/${stopped.trigger.id}/test`, { headers, data: { payload: {} } });
        expect(sent.status(), await sent.text()).toBe(202);
        await expect
          .poll(async () => (await readTrigger(request, stopped.trigger.id)).reason, {
            message: "the dispatcher stops the trigger for missing consent",
            timeout: 30_000,
          })
          .toBe("consent_required");
        expect((await readTrigger(request, stopped.trigger.id)).state).toBe("needs_reconnect");

        await unmountEditorForCleanup(page);
        await openFlowById(page, stopped.flowId);
        await expect(badge(page)).toHaveAttribute("data-state", "needs_reconnect", { timeout: 20_000 });
        await expect(badge(page)).toHaveText("Needs reconnect");
        await badge(page).click();
        await expect(popover(page)).toContainText("Allow background runs is off for this connection.");
        await expect(page.getByTestId("trigger-fix-reconnect")).toBeVisible();
      });

      await test.step("Allow and resume turns consent on, then enables the trigger", async () => {
        await page.getByTestId("trigger-fix-reconnect").click();
        const dialog = page.getByTestId("trigger-consent-dialog");
        await expect(dialog).toContainText("Allow background runs?");

        const calls: string[] = [];
        const record = (req: Request) => {
          if (isPath(req, "PATCH", `/api/v1/connections/${stopped.connection.id}`)) {
            calls.push(`PATCH ${req.postData() ?? ""}`);
          } else if (isPath(req, "POST", `/api/v1/triggers/${stopped.trigger.id}/enable`)) {
            calls.push("POST enable");
          }
        };
        page.on("request", record);
        const enable = page.waitForResponse((res) =>
          isPath(res.request(), "POST", `/api/v1/triggers/${stopped.trigger.id}/enable`),
        );
        await page.getByTestId("trigger-consent-confirm").click();
        expect((await enable).status()).toBe(200);
        page.off("request", record);
        expect(calls.map((c) => c.replace(/\s/g, ""))).toEqual(['PATCH{"allow_non_interactive":true}', "POSTenable"]);

        await expect(successToast(page)).toHaveText(`Resumed ${CALENDAR_NAME}`);
        await expect(dialog).toHaveCount(0);
        await expect(badge(page)).toHaveAttribute("data-state", "active");
        await expect(consentSwitch(page)).toHaveAttribute("aria-checked", "true");
        expect((await readTrigger(request, stopped.trigger.id)).state).toBe("active");
        expect((await readConnection(request, stopped.connection.id)).allow_non_interactive).toBe(true);
      });
    },
  );

  test(
    "the webhook secret is shown once, signs deliveries, and rotating it refuses the old one",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await webhookFlow(request, "secret");
      const trigger = await triggerOf(request, flowId);
      const panel = page.getByTestId("trigger-webhook-panel");
      const secretButton = page.getByTestId("trigger-node-secret");
      const dialog = page.getByTestId("trigger-secret-dialog");

      /** Confirm the dialog, read the value it shows, check it is the one minted, then close it. */
      async function revealSecret(): Promise<string> {
        const minted = page.waitForResponse((res) =>
          isPath(res.request(), "POST", `/api/v1/triggers/${trigger.id}/signing-secret`),
        );
        await page.getByTestId("trigger-secret-rotate").click();
        const res = await minted;
        expect(res.status()).toBe(200);
        const value = page.getByTestId("trigger-secret-value");
        await expect(value).toBeVisible();
        const shown = await value.inputValue();
        expect(shown, "the dialog shows exactly the secret the server minted").toBe(
          ((await res.json()) as { signing_secret: string }).signing_secret,
        );
        await dialog.getByRole("button", { name: "Done" }).click();
        await expect(dialog).toHaveCount(0);
        return shown;
      }

      /** The plaintext is in no field, no text and no markup of the page, and in no trigger read. */
      async function expectSecretGone(secret: string): Promise<void> {
        expect(await page.content(), "the markup does not carry the secret").not.toContain(secret);
        const inPage = await page.evaluate(
          (s) =>
            document.body.innerText.includes(s) ||
            Array.from(document.querySelectorAll("input, textarea")).some((el) => (el as HTMLInputElement).value.includes(s)),
          secret,
        );
        expect(inPage, "no text or field of the page holds the secret").toBe(false);
        expect((await ingressOf(request, trigger.id)).text).not.toContain(secret);
        for (const path of [`/api/v1/triggers/${trigger.id}`, `/api/v1/triggers?flow_id=${flowId}`]) {
          const res = await request.get(path, { headers });
          expect(res.status()).toBe(200);
          expect(await res.text(), `${path} does not carry the secret`).not.toContain(secret);
        }
      }

      let path = "";
      let first = "";

      await test.step("before any secret, no endpoint is shown", async () => {
        await openFlowById(page, flowId);
        await expect(panel).toContainText("Not set. Requests are refused until you create one.", { timeout: 20_000 });
        await expect(page.getByTestId("trigger-node-endpoint")).toHaveCount(0);
        expect((await ingressOf(request, trigger.id)).body).toEqual(
          expect.objectContaining({ public_id: null, ingress_url: null, has_signing_secret: false }),
        );
      });

      await test.step("Create secret shows the value once, then the endpoint", async () => {
        await secretButton.click();
        await expect(dialog).toContainText(
          "Senders sign each request with this secret. Unsigned or mis-signed requests are refused.",
        );
        first = await revealSecret();

        await expect(panel).toContainText("Set. Shown only when created or rotated.");
        const ingress = (await ingressOf(request, trigger.id)).body;
        expect(ingress.has_signing_secret).toBe(true);
        expect(ingress.ingress_url, "the secret mints the public id").toBeTruthy();
        await expect(page.getByTestId("trigger-node-endpoint")).toHaveValue(ingress.ingress_url as string);
        path = new URL(ingress.ingress_url as string).pathname;
        await expectSecretGone(first);
      });

      await test.step("a delivery signed with the shown value is accepted", async () => {
        expect(await deliverSignedWebhook(request, path, first, jsonBody({ text: `signed ${run}` }))).toBe(202);
      });

      await test.step("Rotate secret refuses the old value and accepts the new one", async () => {
        await secretButton.click();
        await expect(dialog).toContainText(
          "Rotating replaces the secret right away. Requests signed with the old one stop working.",
        );
        const second = await revealSecret();
        expect(second, "rotation issues a different secret").not.toBe(first);
        await expectSecretGone(second);

        expect(await deliverSignedWebhook(request, path, first, jsonBody({ text: `old ${run}` })), "old secret").toBe(404);
        expect(await deliverSignedWebhook(request, path, second, jsonBody({ text: `new ${run}` })), "new secret").toBe(202);
      });
    },
  );
});
