import type { APIRequestContext, Page, Request, Route } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type CatalogNodeSpec, createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import { type ConnectionRead, uniqueConnectionName } from "../../../../helpers/integrations/create-connection";
import {
  absorbReadRateLimit,
  absorbStartRateLimit,
  fetchAbsorbingReadLimit,
  installFakeOAuthProvider,
} from "../../../../helpers/integrations/fake-oauth-provider";
import { untilNotRateLimited } from "../../../../helpers/integrations/oauth-callback";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// Add connection from a connector node's picker (#2452).
// Spec doc: docs/core-functionality/integrations/connector-inline-add.md
//
// No consent can finish on a lane: the fake registrations (#2301) reach
// oauth/start and a denied or expired callback, never a token. The dialog learns
// the outcome by polling GET /api/v1/connections until the row's updated_at moves,
// so tests 3 and 4 play the provider's last step on that read: the new row answers
// `ready` with the scopes the case needs. The create, oauth/start, the value the
// picker writes into the flow and the flow's save are all real, and the real row,
// still `pending`, is deleted afterwards.
//
// The UI runs as the auto-login superuser, whose connection list reads are limited
// to 60 per minute and shared with every connection UI spec; the dialog alone reads
// the list every 2 s while it waits. At `--workers=2` that bucket ran dry (measured
// on 1.14.0.dev28), so the page's list reads and this file's own wait a 429 out
// (`absorbReadRateLimit`, `untilNotRateLimited`), as the OAuth wizard spec does.
// The same goes for `oauth/start` (5 per minute per user, shared with the wizard
// spec), and a UI outcome that follows a read is given the wait's ceiling.
test.describe("Connectors on the canvas — Add connection from the picker", () => {
  // Inline Add is upstream #16332 (dev23); the canvas survives it from #16375 (dev26).
  const SINCE = "1.14.0.dev26";
  const FIELD = "connectionref_connection_ref_connection";
  const GMAIL = "ext:google:GmailSendComponent@official";
  const CALENDAR = "ext:google:GoogleOnCalendarTriggerComponent@official";
  const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
  const COLLECTION = "/api/v1/connections";
  /** An outcome the dialog learns from a read that may have waited out a 429 (the wizard spec's ceiling). */
  const AFTER_A_READ = { timeout: 180_000 };
  const COPY = {
    availabilityFailed: "Could not load integration availability. Refresh to try again.",
    waiting: "Waiting for consent in the provider's window…",
    createdUnavailable: "The connection was created, but it cannot be used by this component.",
    missingGmailSend: "Missing gmail.send",
    placeholder: "Select a google connection",
  };

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const flowIds: string[] = [];
  /** Every handle a dialog was asked to create; the teardown deletes what is left of them. */
  const handles: string[] = [];
  let headers: Record<string, string> = {};
  /**
   * Whether the page has read Google's OAuth registrations. `Continue` starts
   * consent with the registration that list names, so a click before it arrives
   * answers `400 "OAuth registration ID is not configured."` (#2307 measured the
   * same race in the wizard). A flag and not a response wait: a dialog opened a
   * second time reuses the cached list and reads nothing.
   */
  let registrationsRead = false;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `inline Add connection is served from ${SINCE}; this build does not carry the whole batch`,
    );
    headers = { Authorization: await getAuthToken(request) };
    const provider = await installFakeOAuthProvider(page.context(), testInfo.project.use.baseURL as string);
    provider.answer("stall");
    await absorbReadRateLimit(page.context());
    await absorbStartRateLimit(page);
    registrationsRead = false;
    page.on("response", (res) => {
      const url = new URL(res.url());
      if (url.pathname === `${COLLECTION}/oauth/registrations` && url.searchParams.get("provider") === "google" && res.ok()) {
        registrationsRead = true;
      }
    });
  });

  test.afterEach(async ({ page, request }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await unmountEditorForCleanup(page);
    const failures: string[] = [];
    for (const id of flowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(String(error)));
    }
    const mine = handles.splice(0);
    if (mine.length > 0) {
      // One read, then a DELETE only for what is left: a DELETE is a write.
      const rows = await listConnections(request);
      for (const row of rows.filter((candidate) => mine.includes(candidate.name))) {
        const res = await request.delete(`${COLLECTION}/${row.id}`, { headers });
        if (res.status() !== 204) failures.push(`connection ${row.name}: ${res.status()}`);
      }
    }
    expect(failures, "every flow and connection this test created is deleted").toEqual([]);
  });

  /** Every connection the superuser can see, a 429 waited out. */
  async function listConnections(request: APIRequestContext): Promise<ConnectionRead[]> {
    const { result } = await untilNotRateLimited(
      "the test's connection list read",
      () => request.get(COLLECTION, { headers }),
      (res) => res.status(),
    );
    const text = await result.text();
    expect(result.status(), text).toBe(200);
    return JSON.parse(text) as ConnectionRead[];
  }

  async function createFlow(request: APIRequestContext, label: string, nodes: CatalogNodeSpec[]): Promise<string> {
    const catalog = await fetchComponentCatalog(request, headers);
    const id = await createCatalogFlow(request, catalog, { nodes, edges: [] }, { name: `E2E inline add ${label} ${run}`, headers });
    flowIds.push(id);
    return id;
  }

  function newHandle(label: string): string {
    const handle = uniqueConnectionName(`inline_${label}`);
    handles.push(handle);
    return handle;
  }

  /** One node's picker; its popover renders inside the node. */
  function picker(page: Page, nodeId: string) {
    const node = page.getByTestId(`rf__node-${nodeId}`);
    return {
      node,
      trigger: node.getByTestId(FIELD),
      value: node.getByTestId(`value-connection-${FIELD}`),
      refresh: node.getByTestId(`refresh-connections-${FIELD}`),
      add: node.getByTestId(`add-connection-${FIELD}`),
    };
  }
  type Picker = ReturnType<typeof picker>;

  async function openPicker(p: Picker): Promise<void> {
    await p.trigger.click();
    await expect(p.refresh, "the picker popover is open").toBeVisible();
  }

  async function openAddDialog(page: Page, p: Picker) {
    await openPicker(p);
    await expect(p.add).toBeEnabled({ timeout: 20_000 });
    await p.add.click();
    await expect(page.getByTestId("connection-name")).toBeVisible();
    return addDialog(page);
  }

  /** The Add dialog, by its title: its body changes from step to step. */
  const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add connection" });
  /** The footer's Cancel, in the details step and while consent is pending. */
  const cancelButton = (page: Page) => addDialog(page).getByRole("button", { name: "Cancel", exact: true });

  /**
   * Continue, once the dialog holds Google's registrations, and the create it
   * sends. The create is awaited from the click, never armed before the wait for
   * the registrations, which can itself outlast a default timeout.
   */
  async function clickContinue(page: Page) {
    await expect
      .poll(() => registrationsRead, { message: "the dialog has read Google's registrations", ...AFTER_A_READ })
      .toBe(true);
    const created = page.waitForResponse((res) => isCreate(res.request()), AFTER_A_READ);
    await page.getByTestId("connection-continue").click();
    return created;
  }

  const isCreate = (req: Request) => req.method() === "POST" && new URL(req.url()).pathname === COLLECTION;

  /**
   * Plays the provider's last step on the dialog's own poll: in every list read,
   * the row named `handle` answers `ready`, with credentials, the given scopes and a
   * later `updated_at` — what a finished consent writes. Every other row, and every
   * other request, is the server's.
   */
  async function landConsent(page: Page, handle: string, scopes: string[]): Promise<void> {
    await page.route(
      (url) => url.pathname === COLLECTION,
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const res = await fetchAbsorbingReadLimit(route);
        const rows = (await res.json()) as unknown;
        // Anything but a list is the server's to answer as it did.
        if (!Array.isArray(rows)) return route.fulfill({ response: res });
        const landed = (rows as ConnectionRead[]).map((row) =>
          row.name === handle
            ? {
                ...row,
                status: "ready",
                has_credentials: true,
                granted_scopes: scopes,
                updated_at: new Date(Date.now() + 60_000).toISOString().replace("Z", ""),
              }
            : row,
        );
        await route.fulfill({ response: res, json: landed });
      },
    );
  }

  /** Add connection from the Gmail picker, consent lands with `scopes`, then Done. */
  async function addAndLand(page: Page, gmail: Picker, label: string, scopes: string[]): Promise<string> {
    const dialog = await openAddDialog(page, gmail);
    const handle = newHandle(label);
    await landConsent(page, handle, scopes);
    await page.getByTestId("connection-name").fill(handle);
    const created = await clickContinue(page);
    expect(created.status()).toBe(201);
    await expect(dialog).toContainText("Connected", AFTER_A_READ);
    await expect(page.getByTestId("connection-done")).toHaveText("Done");
    await page.getByTestId("connection-done").click();
    await expect(dialog).toBeHidden();
    return handle;
  }

  test(
    "the picker reads availability only while open, and says when it cannot",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "availability", [{ id: "gmail", type: GMAIL }]);
      const reads: string[] = [];
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (url.pathname === "/api/v1/integrations") reads.push(url.search);
      });
      const gmail = picker(page, "gmail");

      await test.step("no availability read until the popover opens", async () => {
        const listed = page.waitForResponse(
          (res) => new URL(res.url()).pathname === COLLECTION && new URL(res.url()).searchParams.get("provider") === "google",
        );
        await openFlowById(page, flowId);
        await listed;
        await expect(gmail.trigger).toBeVisible();
        expect(reads, "the node mounted and read its connections, but not availability").toEqual([]);
      });

      await test.step("opening the popover reads it once, for the field's provider", async () => {
        await openPicker(gmail);
        await expect(gmail.add).toBeEnabled({ timeout: 20_000 });
        expect(reads).toEqual(["?provider=google"]);
        await page.keyboard.press("Escape");
      });

      await test.step("a failed read says so and disables Add connection", async () => {
        // The 500 below is this test's own.
        (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
        await page.route(
          (url) => url.pathname === "/api/v1/integrations",
          (route) => route.fulfill({ status: 500, json: { detail: "e2e: availability read refused" } }),
        );
        await page.reload();
        await expect(gmail.trigger).toBeVisible({ timeout: 30_000 });
        await openPicker(gmail);
        await expect(gmail.node.getByText(COPY.availabilityFailed, { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(gmail.add).toBeDisabled();
      });
    },
  );

  test(
    "Add connection opens a dialog locked to the field, names the row by its handle, and cancelling leaves nothing",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "dialog", [
        { id: "gmail", type: GMAIL },
        { id: "cal", type: CALENDAR },
      ]);
      let dialogOpen = false;
      const unscopedCatalogReads: string[] = [];
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (dialogOpen && url.pathname.startsWith("/api/v1/all") && !url.searchParams.get("flow_id")) {
          unscopedCatalogReads.push(url.href);
        }
      });
      await openFlowById(page, flowId);

      await test.step("a field owned by the flow owner offers no instance sharing", async () => {
        const dialog = await openAddDialog(page, picker(page, "cal"));
        await expect(page.getByTestId("connection-instance-owned")).toHaveCount(0);
        await cancelButton(page).click();
        await expect(dialog).toBeHidden();
      });

      const gmail = picker(page, "gmail");
      const dialog = await openAddDialog(page, gmail);
      dialogOpen = true;

      await test.step("the dialog is locked to Google, offers sharing, and has no display name", async () => {
        await page.getByTestId("connection-provider").click();
        await expect(page.getByRole("option")).toHaveText(["Google Workspace"]);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId("connection-instance-owned")).toBeVisible();
        await expect(page.getByTestId("connection-display-name")).toHaveCount(0);
      });

      const handle = newHandle("cancel");
      let rowId = "";

      await test.step("Continue creates the row named by its handle, then waits for consent", async () => {
        await page.getByTestId("connection-name").fill(handle);
        const res = await clickContinue(page);
        const row = (await res.json()) as ConnectionRead;
        expect(res.status()).toBe(201);
        expect(row.name).toBe(handle);
        expect(row.display_name, "the handle is the display name").toBe(handle);
        expect(row.status).toBe("pending");
        rowId = row.id;
        await expect(dialog).toContainText(COPY.waiting, AFTER_A_READ);
      });

      await test.step("Cancel deletes that row", async () => {
        const deleted = page.waitForResponse(
          (res) => res.request().method() === "DELETE" && new URL(res.url()).pathname === `${COLLECTION}/${rowId}`,
        );
        await cancelButton(page).click();
        expect((await deleted).status()).toBe(204);
        dialogOpen = false;
        await expect(dialog).toBeHidden();
        await expect
          .poll(async () => (await listConnections(request)).some((row) => row.name === handle))
          .toBe(false);
      });

      await test.step("the canvas and the palette survive", async () => {
        await expect(page.locator(".react-flow__node")).toHaveCount(2);
        expect(unscopedCatalogReads, "the dialog never reloaded the catalog without the flow's scope").toEqual([]);
        await page.getByTestId("sidebar-search-input").fill("gmail");
        await expect(page.getByTestId("google_gmail: send email_draggable")).toBeVisible();
      });
    },
  );

  test(
    "a connection created from the picker is selected when it fits the field",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "fits", [{ id: "gmail", type: GMAIL }]);
      await openFlowById(page, flowId);
      const gmail = picker(page, "gmail");
      const handle = await addAndLand(page, gmail, "fits", [GMAIL_SEND, "openid", "email"]);

      await expect(gmail.value).toHaveText(`google/${handle}`);
      await expect
        .poll(
          async () => {
            const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
            const flow = (await res.json()) as {
              data: { nodes: Array<{ id: string; data: { node: { template: { connection?: { value?: unknown } } } } }> };
            };
            return flow.data.nodes.find((node) => node.id === "gmail")?.data.node.template.connection?.value;
          },
          { message: "the flow saves the selected handle", timeout: 20_000 },
        )
        .toBe(`google/${handle}`);
    },
  );

  test(
    "a connection that does not fit the field is reported, not selected",
    { tag: ["@stable", "@components", "@integrations"] },
    async ({ page, request }) => {
      const flowId = await createFlow(request, "unfit", [{ id: "gmail", type: GMAIL }]);
      await openFlowById(page, flowId);
      const gmail = picker(page, "gmail");
      await addAndLand(page, gmail, "unfit", ["openid", "email"]);

      await expect(page.locator("h3.error-build-foreground", { hasText: COPY.createdUnavailable })).toBeVisible();
      await expect(page.locator("li", { hasText: COPY.missingGmailSend })).toBeVisible();
      await expect(gmail.value).toHaveText(COPY.placeholder);
    },
  );
});
