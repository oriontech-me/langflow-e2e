import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import {
  type CatalogComponent,
  type CatalogNodeSpec,
  createCatalogFlow,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type CreateConnectionOptions,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";

// Connector components on the canvas, and the connection picker beside their field.
// Spec doc: docs/core-functionality/integrations/connector-node-picker.md
//
// The UI runs as the superuser, and the superuser's connection list holds EVERY
// user's rows (`_list_visible_rows`), so the picker shows whatever any spec in the
// run seeded. Every assertion keys on this file's own handles; no count is read.
//
// Rows are planted through a throwaway owner (#2295), whose rows the superuser's
// picker lists. Only test 6 spends superuser writes (2 rows, 4 writes): a trigger
// accepting its flow owner's own row needs a row the superuser owns.
test.describe("Connector components — the palette, the canvas and the connection picker", () => {
  /** The connection field's id on every connector node; always scoped by its node. */
  const FIELD = "connectionref_connection_ref_connection";
  const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
  const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
  // Exact copy, measured on 1.13.0.dev47 (connections.picker.* in the en bundle).
  const COPY = {
    loading: "Loading connections…",
    empty: "No google connections yet. Create one in Settings, then refresh.",
    loadFailed: "Could not load connections.",
    noScopes: "No scope required",
    notFound: "not found",
    missingGmailSend: "Missing gmail.send",
    userRequired: "Runs as the instance, not a user",
    userOwnedRequired: "Not owned by the flow owner",
    pending: "Pending",
    revoked: "Revoked",
  };
  /** The palette group each manifest provider lives in, under the Bundles tab. */
  const PROVIDERS = [
    { id: "google", label: "Google", group: "disclosure-bundles-google" },
    { id: "microsoft", label: "Microsoft 365", group: "disclosure-bundles-microsoft 365" },
    { id: "slack", label: "Slack", group: "disclosure-bundles-slack" },
  ] as const;

  interface Capability {
    id: string;
    identity: "user_delegated" | "bot" | "service";
    component_ref: string;
  }
  interface ManifestProvider {
    provider_id: string;
    capabilities: Capability[];
  }
  /** One manifest component, resolved against the catalog. */
  interface Connector {
    provider: string;
    ref: string;
    /** The catalog key, which is also the node's `data.type`. */
    key: string;
    displayName: string;
    trigger: boolean;
    identities: Set<Capability["identity"]>;
  }

  let owner: ConnectionsOwner;
  let superHeaders: Record<string, string>;
  let catalog: Record<string, unknown>;
  let connectors: Connector[];
  const flowIds: string[] = [];
  const rows: CreatedConnection[] = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connpicker",
    );
    superHeaders = { Authorization: await getAuthToken(request) };
    catalog = await fetchComponentCatalog(request, superHeaders);
    const res = await request.get("/api/v1/integrations", { headers: superHeaders });
    expect(res.status(), await res.text()).toBe(200);
    const { providers } = (await res.json()) as { providers: ManifestProvider[] };
    connectors = [];
    for (const provider of providers) {
      for (const capability of provider.capabilities) {
        const known = connectors.find((c) => c.ref === capability.component_ref);
        if (known) {
          known.identities.add(capability.identity);
          continue;
        }
        const key = catalogKey(capability.component_ref);
        const entry = findCatalogComponent(catalog, key);
        connectors.push({
          provider: provider.provider_id,
          ref: capability.component_ref,
          key,
          displayName: String(entry.display_name),
          trigger: Boolean((entry.metadata as { trigger_kind?: string } | undefined)?.trigger_kind),
          identities: new Set([capability.identity]),
        });
      }
    }
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor first, so the flow's own polls do not 404 into the log.
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers: superHeaders }).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow and connection this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    // Deleting the owner takes any row it still owns with it.
    await owner?.dispose();
  });

  /** The catalog key of a manifest `component_ref` (`ext:<provider>:<ref>@official`). */
  function catalogKey(ref: string): string {
    for (const [category, entries] of Object.entries(catalog)) {
      if (category === "component_display_names" || !entries || typeof entries !== "object") continue;
      for (const key of Object.keys(entries)) {
        if (key === ref || key.match(/^ext:[^:]+:([^@]+)@/)?.[1] === ref) return key;
      }
    }
    throw new Error(`manifest component ${ref} is not in GET /api/v1/all`);
  }

  function connector(ref: string): Connector {
    const found = connectors.find((c) => c.ref === ref);
    if (!found) throw new Error(`the manifest no longer names ${ref}`);
    return found;
  }

  /** The sidebar's add button for a display name: lowercased, spaces as `-`. */
  const addButtonId = (displayName: string) =>
    `add-component-button-${displayName.toLowerCase().replace(/ /g, "-")}`;

  const uniqueFlowName = (label: string) =>
    `e2e-2297-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** A flow of the superuser's, built over the API and opened in the editor. */
  async function openCatalogFlow(
    page: Page,
    request: APIRequestContext,
    label: string,
    nodes: CatalogNodeSpec[],
  ): Promise<string> {
    const flowId = await createCatalogFlow(request, catalog, { nodes, edges: [] }, {
      name: uniqueFlowName(label),
      headers: superHeaders,
    });
    flowIds.push(flowId);
    await openFlowById(page, flowId);
    return flowId;
  }

  async function openBlankFlow(page: Page, request: APIRequestContext, label: string): Promise<void> {
    const flowId = await createFlow(
      request,
      {
        name: uniqueFlowName(label),
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: superHeaders },
    );
    flowIds.push(flowId);
    await openFlowById(page, flowId);
  }

  /** A row of the throwaway owner's, deleted after the test. */
  async function plant(
    request: APIRequestContext,
    label: string,
    options: CreateConnectionOptions = {},
  ): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, { label: `picker_${label}`, ...options });
    rows.push(row);
    return row;
  }

  const handleOf = (row: CreatedConnection) => `${row.connection.provider_key}/${row.name}`;

  /** The picker of one node. The popover renders inside the node, so it scopes too. */
  function picker(page: Page, nodeId: string) {
    const node = page.getByTestId(`rf__node-${nodeId}`);
    return {
      node,
      trigger: node.getByTestId(FIELD),
      value: node.getByTestId(`value-connection-${FIELD}`),
      options: node.locator('[data-testid^="connection-option-"]'),
      option: (handle: string) => node.getByTestId(`connection-option-${handle}`),
      footer: node.getByText(/^(Requires .+|No scope required)$/),
      clear: node.getByTestId(`clear-connection-${FIELD}`),
      refresh: node.getByTestId(`refresh-connections-${FIELD}`),
      copy: (text: string) => node.getByText(text, { exact: true }),
    };
  }
  type Picker = ReturnType<typeof picker>;

  /** Opens the popover and waits for the list to settle. */
  async function openPicker(p: Picker): Promise<void> {
    await p.trigger.click();
    await expect(p.refresh, "the picker popover is open").toBeVisible();
    await expect(p.copy(COPY.loading)).toBeHidden({ timeout: 30000 });
  }

  async function closePicker(page: Page, p: Picker): Promise<void> {
    await page.keyboard.press("Escape");
    await expect(p.refresh).toBeHidden();
  }

  /**
   * The badge an option carries, or none. The badge is the one element of the option
   * titled with something other than its handle (it is titled with its reason).
   */
  const badgeOf = (option: Locator, handle: string) => option.locator(`[title]:not([title="${handle}"])`);

  /** The handles a picker lists, read from its option testids. */
  async function listedHandles(p: Picker): Promise<string[]> {
    const ids = await p.options.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
    return ids.map((id) => id.replace(/^connection-option-/, ""));
  }

  /** The picker's own list request, `GET /api/v1/connections?provider=<provider>`. */
  const isList = (provider: string) => (url: URL) =>
    url.pathname === "/api/v1/connections" && url.searchParams.get("provider") === provider;

  function waitForList(page: Page, provider: string) {
    const matches = isList(provider);
    return page.waitForResponse((res) => res.request().method() === "GET" && matches(new URL(res.url())));
  }

  /** The value a saved flow stores in one node's connection field. */
  async function savedHandle(request: APIRequestContext, flowId: string, nodeId: string): Promise<unknown> {
    const res = await request.get(`/api/v1/flows/${flowId}`, { headers: superHeaders });
    expect(res.status(), await res.text()).toBe(200);
    const flow = (await res.json()) as {
      data: { nodes: Array<{ id: string; data: { node: CatalogComponent } }> };
    };
    const node = flow.data.nodes.find((n) => n.id === nodeId);
    return node?.data.node.template.connection?.value;
  }

  test(
    "the Bundles palette holds every manifest action in its provider's group and no trigger",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const groups = new Map<string, string[]>();

      await test.step("the manifest splits into actions and triggers by the catalog's trigger_kind", async () => {
        for (const provider of PROVIDERS) {
          const actions = connectors.filter((c) => c.provider === provider.id && !c.trigger);
          expect(actions.length, `${provider.label} actions in the manifest`).toBeGreaterThan(0);
        }
        expect(connectors.filter((c) => c.trigger).length, "triggers in the manifest").toBeGreaterThan(0);
      });

      await test.step("each provider group under Bundles is read", async () => {
        await openBlankFlow(page, request, "palette");
        await page.getByTestId("sidebar-nav-bundles").click();
        for (const provider of PROVIDERS) {
          const disclosure = page.getByTestId(provider.group);
          await expect(disclosure, `the ${provider.label} group`).toBeVisible({ timeout: 30000 });
          await disclosure.click();
          const group = page.locator('li[data-sidebar="menu-item"]', { has: disclosure });
          const buttons = group.locator('[data-testid^="add-component-button-"]');
          await expect(buttons.first(), `the ${provider.label} group expanded`).toBeVisible();
          groups.set(
            provider.id,
            await buttons.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? "")),
          );
        }
      });

      await test.step("every action is in its own provider's group", async () => {
        for (const action of connectors.filter((c) => !c.trigger)) {
          expect(groups.get(action.provider), `${action.displayName} (${action.ref})`).toContain(
            addButtonId(action.displayName),
          );
        }
      });

      await test.step("no trigger is in any group", async () => {
        const everything = [...groups.values()].flat();
        for (const trigger of connectors.filter((c) => c.trigger)) {
          expect(everything, `${trigger.displayName} (${trigger.ref})`).not.toContain(addButtonId(trigger.displayName));
        }
      });

      await test.step("every Slack action names the identity it runs as", async () => {
        for (const action of connectors.filter((c) => c.provider === "slack" && !c.trigger)) {
          expect(action.identities.size, `${action.ref} has one identity`).toBe(1);
          const suffix = action.identities.has("bot") ? "(as app)" : "(as user)";
          expect(
            action.displayName.slice(-suffix.length),
            `${action.displayName} runs as ${[...action.identities][0]}`,
          ).toBe(suffix);
        }
      });
    },
  );

  for (const provider of PROVIDERS) {
    test(
      `every ${provider.label} action in the manifest lands on the canvas with an unbound connection field`,
      { tag: ["@stable", "@components", "@integrations"] },
      async ({ page, request }) => {
        const actions = connectors.filter((c) => c.provider === provider.id && !c.trigger);
        expect(actions.length, `${provider.label} actions in the manifest`).toBeGreaterThan(0);
        await openBlankFlow(page, request, `canvas-${provider.id}`);
        const nodeIds = () =>
          page
            .locator('[data-testid^="rf__node-"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));

        for (const action of actions) {
          await test.step(`${action.displayName} is added and asks for a ${provider.id} connection`, async () => {
            const before = await nodeIds();
            await addComponentFromSidebar(page, action.displayName, addButtonId(action.displayName));
            const added = (await nodeIds()).filter((id) => !before.includes(id));
            expect(added, `one new node for ${action.displayName}`).toHaveLength(1);
            expect(added[0], "the new node is the manifest's component").toContain(action.key);
            const node = page.getByTestId(added[0]);
            await expect(node.getByTestId(`value-connection-${FIELD}`)).toHaveText(
              `Select a ${provider.id} connection`,
            );
          });
        }
      },
    );
  }

  test(
    "the picker lists its provider's connections and names why each unusable one cannot run",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const planted: Record<"usable" | "noScopes" | "bot" | "pending" | "revoked", CreatedConnection> = {
        usable: await plant(request, "usable", { grantedScopes: [GMAIL_SEND] }),
        noScopes: await plant(request, "noscopes"),
        bot: await plant(request, "bot", { identity: "bot", grantedScopes: [GMAIL_SEND] }),
        pending: await plant(request, "pending", { credentials: null, grantedScopes: [GMAIL_SEND] }),
        revoked: await plant(request, "revoked", { grantedScopes: [GMAIL_SEND] }),
      };

      await test.step("the revoked row is revoked", async () => {
        const res = await request.post(`/api/v1/connections/${planted.revoked.id}/revoke`, {
          headers: owner.headers,
        });
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe("revoked");
        expect(planted.pending.connection.status, "a credential-free row").toBe("pending");
      });

      const googleList = waitForList(page, "google");
      const slackList = waitForList(page, "slack");
      await openCatalogFlow(page, request, "reasons", [
        { id: "gmail", type: connector("GmailSendComponent").key },
        { id: "slackapp", type: connector("SlackPostAsAppComponent").key },
      ]);
      const gmail = picker(page, "gmail");
      const slack = picker(page, "slackapp");

      await test.step("the Google picker asks the server for google rows only", async () => {
        expect((await googleList).status()).toBe(200);
        await openPicker(gmail);
      });

      await test.step("the usable row carries no badge", async () => {
        const handle = handleOf(planted.usable);
        await expect(gmail.option(handle)).toBeVisible();
        await expect(badgeOf(gmail.option(handle), handle)).toHaveCount(0);
      });

      await test.step("every unusable row carries its reason", async () => {
        const expected: Array<[CreatedConnection, string]> = [
          [planted.noScopes, COPY.missingGmailSend],
          [planted.bot, COPY.userRequired],
          [planted.pending, COPY.pending],
          [planted.revoked, COPY.revoked],
        ];
        for (const [row, reason] of expected) {
          const handle = handleOf(row);
          await expect(gmail.option(handle), handle).toBeVisible();
          await expect(badgeOf(gmail.option(handle), handle), handle).toHaveText(reason);
        }
      });

      await test.step("every listed handle is a google one, and the footer names the field's scope", async () => {
        const handles = await listedHandles(gmail);
        for (const handle of handles) expect(handle).toMatch(/^google\//);
        await expect(gmail.footer).toHaveText("Requires gmail.send");
        await closePicker(page, gmail);
      });

      await test.step("the Slack picker asks for slack rows and lists none of the google ones", async () => {
        expect((await slackList).status()).toBe(200);
        await openPicker(slack);
        for (const row of Object.values(planted)) {
          await expect(slack.option(handleOf(row))).toHaveCount(0);
        }
        for (const handle of await listedHandles(slack)) expect(handle).toMatch(/^slack\//);
      });
    },
  );

  test(
    "a trigger refuses a connection its flow's owner does not own",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      // The superuser owns the flow, so only the superuser's own user row is usable.
      const own = await createConnectionViaApi(request, superHeaders, {
        label: "picker_own",
        grantedScopes: [GMAIL_READONLY],
      });
      rows.push(own);
      const instance = await createConnectionViaApi(request, superHeaders, {
        label: "picker_instance",
        ownershipMode: "instance",
        grantedScopes: [GMAIL_READONLY],
      });
      rows.push(instance);
      const other = await plant(request, "other", { grantedScopes: [GMAIL_READONLY] });

      // Triggers are not in the palette: a flow saved over the API is the only way in.
      await openCatalogFlow(page, request, "trigger", [
        { id: "gmailtrigger", type: connector("GoogleOnGmailTriggerComponent").key },
      ]);
      const trigger = picker(page, "gmailtrigger");
      await openPicker(trigger);

      await test.step("the flow owner's own row carries no badge", async () => {
        const handle = handleOf(own);
        await expect(trigger.option(handle)).toBeVisible();
        await expect(badgeOf(trigger.option(handle), handle)).toHaveCount(0);
      });

      await test.step("the instance row and another user's row are not the flow owner's", async () => {
        for (const row of [instance, other]) {
          const handle = handleOf(row);
          await expect(trigger.option(handle), handle).toBeVisible();
          await expect(badgeOf(trigger.option(handle), handle), handle).toHaveText(COPY.userOwnedRequired);
        }
      });
    },
  );

  test(
    "the requirement line follows the node's inputs",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      await openCatalogFlow(page, request, "scopes", [
        { id: "sharepoint", type: connector("SharePointListComponent").key },
        { id: "slacktrigger", type: connector("SlackOnMessageTriggerComponent").key },
      ]);
      const sharepoint = picker(page, "sharepoint");
      const siteId = sharepoint.node.getByTestId("popover-anchor-input-site_id");
      const driveId = sharepoint.node.getByTestId("popover-anchor-input-drive_id");

      async function footerReads(expected: string): Promise<void> {
        await openPicker(sharepoint);
        await expect(sharepoint.footer).toHaveText(expected);
        await closePicker(page, sharepoint);
      }

      await test.step("no input set: only the required scope", async () => {
        await footerReads("Requires Files.Read");
      });

      await test.step("a site adds Sites.Read.All", async () => {
        await siteId.fill("e2e-site");
        await footerReads("Requires Files.Read, Sites.Read.All");
      });

      await test.step("a drive adds Files.Read.All", async () => {
        await driveId.fill("e2e-drive");
        await footerReads("Requires Files.Read, Files.Read.All, Sites.Read.All");
      });

      await test.step("clearing the site drops Sites.Read.All", async () => {
        await siteId.fill("");
        await footerReads("Requires Files.Read, Files.Read.All");
      });

      await test.step("a field with no required scope says so", async () => {
        const slack = picker(page, "slacktrigger");
        await openPicker(slack);
        await expect(slack.footer).toHaveText(COPY.noScopes);
      });
    },
  );

  test(
    "an empty list says how to get a connection, and Refresh fetches a new one",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      // The superuser sees every user's google rows, so the empty state is reached
      // by answering the picker's own request with []. The only mocked response here.
      const googleList = isList("google");
      await page.route(googleList, (route) => route.fulfill({ json: [] }));
      await openCatalogFlow(page, request, "empty", [{ id: "gmail", type: connector("GmailSendComponent").key }]);
      const gmail = picker(page, "gmail");

      await test.step("the empty list says how to get one", async () => {
        await openPicker(gmail);
        await expect(gmail.copy(COPY.empty)).toBeVisible();
        await expect(gmail.options).toHaveCount(0);
      });

      let refetched = 0;
      page.on("request", (req) => {
        if (req.method() === "GET" && googleList(new URL(req.url()))) refetched++;
      });

      const row = await test.step("a row created while the picker is open is not listed yet", async () => {
        await page.unroute(googleList);
        const planted = await plant(request, "refresh", { grantedScopes: [GMAIL_SEND] });
        await expect(gmail.option(handleOf(planted))).toHaveCount(0);
        await expect(gmail.copy(COPY.empty)).toBeVisible();
        expect(refetched, "the list is cached: nothing fetched it again").toBe(0);
        return planted;
      });

      await test.step("Refresh fetches the list and the row appears", async () => {
        const fetched = waitForList(page, "google");
        await gmail.refresh.click();
        expect((await fetched).status()).toBe(200);
        await expect(gmail.option(handleOf(row))).toBeVisible();
        await expect(gmail.copy(COPY.empty)).toBeHidden();
      });
    },
  );

  test(
    "a list that fails to load says so",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      // The 500 below is this test's own mock.
      (page as PageWithErrorHooks).allowHttpErrors();
      await page.route(isList("google"), (route) =>
        route.fulfill({ status: 500, json: { detail: "e2e: mocked list failure" } }),
      );
      await openCatalogFlow(page, request, "failed", [{ id: "gmail", type: connector("GmailSendComponent").key }]);
      const gmail = picker(page, "gmail");
      await gmail.trigger.click();
      await expect(gmail.refresh, "the picker popover is open").toBeVisible();
      // React-query retries before giving up: ~31 s, measured on 1.13.0.dev47.
      await expect(gmail.copy(COPY.loadFailed)).toBeVisible({ timeout: 60000 });
      await expect(gmail.options).toHaveCount(0);
    },
  );

  test(
    "picking a connection binds its handle, a reload keeps it, and Clear unbinds it",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const row = await plant(request, "bind", { grantedScopes: [GMAIL_SEND] });
      const handle = handleOf(row);
      const flowId = await openCatalogFlow(page, request, "bind", [
        { id: "gmail", type: connector("GmailSendComponent").key },
      ]);
      const gmail = picker(page, "gmail");

      await test.step("picking the row shows its handle and saves it", async () => {
        await openPicker(gmail);
        await gmail.option(handle).click();
        await expect(gmail.value).toHaveText(handle);
        await expect
          .poll(() => savedHandle(request, flowId, "gmail"), { timeout: 30000, message: "the saved handle" })
          .toBe(handle);
      });

      await test.step("a reload still shows it", async () => {
        // A full navigation, through the helper's canvas budget: the editor rebuilds
        // the component catalog on every load (`/api/v1/all?force_refresh=true`),
        // measured at 3–14 s here and longer under load.
        await openFlowById(page, flowId);
        await expect(gmail.value).toHaveText(handle, { timeout: 30000 });
      });

      await test.step("Clear unbinds it, on the canvas and in the saved flow", async () => {
        await openPicker(gmail);
        await gmail.clear.click();
        await expect(gmail.value).toHaveText("Select a google connection");
        await expect
          .poll(() => savedHandle(request, flowId, "gmail"), { timeout: 30000, message: "the saved handle" })
          .toBe("");
      });
    },
  );

  test(
    "a handle that outlived its connection is shown as not found",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const row = await plant(request, "dangling", { grantedScopes: [GMAIL_SEND] });
      const handle = handleOf(row);
      const flowId = await createCatalogFlow(
        request,
        catalog,
        { nodes: [{ id: "gmail", type: connector("GmailSendComponent").key, values: { connection: handle } }], edges: [] },
        { name: uniqueFlowName("dangling"), headers: superHeaders },
      );
      flowIds.push(flowId);

      await test.step("the connection is deleted before the flow opens", async () => {
        await row.deleteConnection(request);
        rows.splice(rows.indexOf(row), 1);
        expect(await savedHandle(request, flowId, "gmail"), "the flow still names the handle").toBe(handle);
      });

      await test.step("the field keeps the handle and marks it not found", async () => {
        const listed = waitForList(page, "google");
        await openFlowById(page, flowId);
        expect((await listed).status()).toBe(200);
        const gmail = picker(page, "gmail");
        await expect(gmail.value).toHaveText(handle);
        await expect(gmail.trigger.getByText(COPY.notFound, { exact: true })).toBeVisible();
      });
    },
  );
});
