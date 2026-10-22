import type { APIRequestContext, Locator, Page, Request } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type ConnectionRead,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";
import {
  type FakeOAuthProvider,
  absorbStartRateLimit,
  installFakeOAuthProvider,
} from "../../../../helpers/integrations/fake-oauth-provider";

// The Add / Reconnect wizard of /settings/connections, walked up to consent (#2307).
// Spec doc: docs/core-functionality/integrations/connection-oauth-wizard.md
//
// Needs #2301's fake registrations. The test plays the provider: a context route
// answers the authorization URL with a redirect to the instance's real callback
// (or a page that never redirects), so the dialog learns every outcome the way it
// does in production, by polling the row. Runs as the superuser (auto-login), and
// keys every locator on the connection's unique handle.
//
// In order, in one worker, on purpose (a failure does not skip the rest): a
// waiting dialog lists the connections every 2 s, and the list is limited to
// 60/minute per user. Two dialogs waiting out the shared callback window side by
// side read the superuser's list 429 (measured at --workers=2); one at a time
// stays at about half of it.
test.describe.configure({ mode: "default" });

test.describe("Connections — the Add and Reconnect wizard, up to consent", () => {
  const PAGE = "/settings/connections";
  const COLLECTION = "/api/v1/connections";
  const GOOGLE = "e2e-google";
  const HELD = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
  // Exact copy, measured on 1.14.0.dev2 (connections.add.* in the en bundle).
  const COPY = {
    waiting: "Waiting for consent in the provider's window…",
    denied: "The provider denied authorization.",
    expired: "The sign-in link expired. Start again to get a new one.",
    failed: "Authorization did not complete.",
    untracked:
      "Langflow can no longer track the sign-in window. If the provider shows an error, ask your administrator to check the OAuth registration before trying again.",
    noRegistration: "No OAuth registration is configured for this provider. Ask an operator to add one.",
    operatorSetup:
      "Ask a Langflow administrator to set LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS on the Langflow server, then restart it.",
    callbackUnavailable:
      "Open Langflow at its public HTTPS URL (or localhost for local use) to get a suggested redirect URI.",
    copied: "Redirect URI copied.",
    granted: "Granted",
  };
  const RISK_LABEL: Record<string, string> = { read: "Read", write: "Write", destructive: "Destructive" };

  let superHeaders: Record<string, string>;
  let provider: FakeOAuthProvider;
  const handles: string[] = [];

  test.beforeEach(async ({ page, request }, testInfo) => {
    superHeaders = { Authorization: await getAuthToken(request) };
    provider = await installFakeOAuthProvider(page.context(), testInfo.project.use.baseURL!);
    await absorbStartRateLimit(page);
  });

  test.afterEach(async ({ request }) => {
    const mine = new Set(handles.splice(0));
    if (mine.size === 0) return;
    // An unfinished Add deletes its own row, so read the list rather than
    // charging a 404 DELETE to the shared write bucket.
    for (const row of await listConnections(request)) {
      if (!mine.has(row.name)) continue;
      await deleteConnection(request, row.id, { headers: superHeaders }).catch((error) => {
        console.warn(`⚠️ Orphan connection left behind (${row.name}): ${error}`);
      });
    }
  });

  async function listConnections(request: APIRequestContext): Promise<ConnectionRead[]> {
    const res = await request.get(COLLECTION, { headers: superHeaders });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as ConnectionRead[];
  }

  async function readConnection(request: APIRequestContext, name: string): Promise<ConnectionRead | undefined> {
    return (await listConnections(request)).find((row) => row.name === name);
  }

  function newHandle(label: string): string {
    const name = uniqueConnectionName(`connwiz_${label}`);
    handles.push(name);
    return name;
  }

  /**
   * Opens Add and waits for its registration list. Continue is enabled before
   * that list arrives, and a Continue sent meanwhile names the provider id as
   * the registration (`"google"`), which the server refuses: measured by
   * delaying the list, and seen once in CI. The spec doc records it.
   */
  async function openAddDialog(page: Page): Promise<Locator> {
    await page.goto(PAGE);
    const listed = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `${COLLECTION}/oauth/registrations` && res.request().method() === "GET",
    );
    await page.getByTestId("add-connection").click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    await expect(dialog).toBeVisible();
    expect((await listed).status()).toBe(200);
    return dialog;
  }

  async function fillDetails(page: Page, name: string) {
    await page.getByTestId("connection-name").fill(name);
    await page.getByTestId("connection-display-name").fill(`E2E ${name}`);
  }

  /** Every non-GET connection request the page sends from now on. */
  function recordWrites(page: Page): string[] {
    const writes: string[] = [];
    page.on("request", (request: Request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith(COLLECTION)) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    return writes;
  }

  /** The label of one scope's checkbox, which lists every action needing it. */
  function scopeLabel(dialog: Locator, scope: string): Locator {
    return dialog.getByTestId(`connection-scope-${scope}`).locator("xpath=ancestor::label[1]");
  }

  async function checkedScopes(dialog: Locator): Promise<string[]> {
    return dialog
      .locator('[data-testid^="connection-scope-"][aria-checked="true"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("connection-scope-".length)));
  }

  test(
    "the Add dialog lists every Google scope with the risk of each action that needs it, and offers Slack a token instead of a sign-in",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const res = await request.get("/api/v1/integrations", { headers: superHeaders });
      expect(res.status(), await res.text()).toBe(200);
      const manifest = (await res.json()) as {
        providers: Array<{
          provider_id: string;
          capabilities: Array<{ display_name: string; risk: string; required_scopes: string[] }>;
        }>;
      };
      const google = manifest.providers.find((item) => item.provider_id === "google")!;
      expect(google, "the manifest serves Google").toBeDefined();
      const writes = recordWrites(page);
      const dialog = await openAddDialog(page);

      await test.step("the provider options are the manifest's, Google first and selected", async () => {
        const select = page.getByTestId("connection-provider");
        const values = await select.locator("option").evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
        expect(values).toEqual(manifest.providers.map((item) => item.provider_id));
        await expect(select).toHaveValue("google");
      });

      await test.step("every scope a Google action needs is checked and names that action with its risk", async () => {
        const pairs = google.capabilities.flatMap((capability) =>
          capability.required_scopes.map((scope) => ({ scope, capability })),
        );
        expect(pairs.length, "the manifest declares Google scopes").toBeGreaterThan(0);
        for (const { scope, capability } of pairs) {
          await expect(dialog.getByTestId(`connection-scope-${scope}`), scope).toBeChecked();
          const lines = (await scopeLabel(dialog, scope).innerText()).split("\n").map((line) => line.trim());
          const at = lines.indexOf(capability.display_name);
          expect(at, `${scope} names ${capability.display_name}: ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
          expect(lines[at + 1], `${capability.display_name}'s risk`).toBe(RISK_LABEL[capability.risk]);
        }
        // One registration per provider and profile: no picker, and no setup help.
        await expect(dialog.locator("#connection-registration")).toHaveCount(0);
        await expect(dialog.getByTestId("connection-callback-url")).toHaveCount(0);
      });

      await test.step("Slack offers a sign-in or a pasted token, as the user or as a bot", async () => {
        await page.getByTestId("connection-provider").selectOption("slack");
        const method = page.getByTestId("connection-method");
        await expect(method.locator("option")).toHaveText(["Sign in with Slack", "Paste a token"]);
        await expect(method).toHaveValue("oauth");
        await expect(page.getByTestId("connection-identity").locator("option")).toHaveText([
          "The signed-in user",
          "A bot",
        ]);
        await expect(dialog.locator('[data-testid^="connection-scope-"]').first()).toBeVisible();
      });

      await test.step("a pasted token replaces the scope list and points to the Slack bundle's guide", async () => {
        await page.getByTestId("connection-method").selectOption("token");
        await expect(page.getByTestId("connection-token")).toBeVisible();
        await expect(dialog.locator('[data-testid^="connection-scope-"]')).toHaveCount(0);
        await expect(page.getByTestId("connection-setup-guide")).toHaveAttribute(
          "href",
          "https://docs.langflow.org/bundles-slack#two-executing-identities",
        );
      });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(writes, "browsing the dialog creates nothing").toEqual([]);
    },
  );

  test(
    "with no OAuth registration, the dialog explains the operator setup and offers this instance's callback URL",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      await page.route("**/api/v1/connections/oauth/registrations**", (route) =>
        route.fulfill({ json: { registrations: [] } }),
      );
      const writes = recordWrites(page);
      const dialog = await openAddDialog(page);
      const help = dialog.getByTestId("connection-setup-help");

      await test.step("the setup help names the missing registration and the variable to set", async () => {
        await expect(help.getByRole("alert")).toHaveText(COPY.noRegistration);
        await expect(help).toContainText(COPY.operatorSetup);
      });

      await test.step("the suggested redirect URI is this instance's callback, copied as shown", async () => {
        const origin = new URL(page.url());
        const registrable =
          origin.protocol === "https:" ||
          (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
        if (registrable) {
          const expected = `${origin.origin}${COLLECTION}/oauth/google/callback`;
          await expect(dialog.getByTestId("connection-callback-url")).toHaveText(expected);
          await dialog.getByTestId("connection-copy-callback").click();
          await expect(help.getByText(COPY.copied)).toBeVisible();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
        } else {
          // The broker refuses any other redirect, so the page offers none.
          await expect(help).toContainText(COPY.callbackUnavailable);
          await expect(dialog.getByTestId("connection-callback-url")).toHaveCount(0);
        }
      });

      await test.step("Continue stays disabled with the details filled", async () => {
        await fillDetails(page, uniqueConnectionName("connwiz_noreg"));
        await expect(page.getByTestId("connection-continue")).toBeDisabled();
      });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(writes, "a dialog that cannot start consent creates nothing").toEqual([]);
    },
  );

  test(
    "the registration picked is the one consent starts with, a closed sign-in window is reported, and Cancel discards the half-made connection",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      // A second Google registration, listed first: the picker must not just
      // send whatever it preselected.
      await page.route("**/api/v1/connections/oauth/registrations**", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { registrations: Array<{ id: string }> };
        const real = body.registrations.find((item) => item.id === GOOGLE);
        if (real) body.registrations.unshift({ ...real, id: `${GOOGLE}-alt` });
        await route.fulfill({ response, json: body });
      });
      provider.answer("stall");
      const name = newHandle("pick");
      const dialog = await openAddDialog(page);

      await test.step("the picker offers both registrations and preselects the first", async () => {
        const picker = dialog.getByLabel("OAuth registration");
        await expect(picker.locator("option")).toHaveText([`${GOOGLE}-alt`, GOOGLE]);
        await expect(picker).toHaveValue(`${GOOGLE}-alt`);
        await picker.selectOption(GOOGLE);
      });

      const popup = await test.step("Continue starts consent with the picked registration and the checked scopes", async () => {
        await fillDetails(page, name);
        const scopes = await checkedScopes(dialog);
        expect(scopes.length).toBeGreaterThan(0);
        const started = page.waitForResponse((res) => res.url().endsWith("/oauth/start"));
        const opened = page.context().waitForEvent("page");
        await page.getByTestId("connection-continue").click();
        const start = await started;
        expect(start.status(), await start.text()).toBe(200);
        const sent = start.request().postDataJSON() as { registration_id: string; scopes: string[] };
        expect(sent.registration_id).toBe(GOOGLE);
        expect([...sent.scopes].sort()).toEqual([...scopes].sort());
        const popup = await opened;
        await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        await expect(dialog).toContainText(COPY.waiting);
        return popup;
      });

      await test.step("closing the sign-in window unanswered is reported, with Try again", async () => {
        await popup.close();
        await expect(dialog.getByText(COPY.untracked)).toBeVisible();
        await expect(dialog.getByTestId("connection-try-again")).toBeVisible();
      });

      await test.step("Cancel deletes the unfinished connection", async () => {
        const row = await readConnection(request, name);
        expect(row, "Continue created the row").toMatchObject({ status: "pending" });
        const deleted = page.waitForResponse(
          (res) => res.request().method() === "DELETE" && res.url().endsWith(`${COLLECTION}/${row!.id}`),
        );
        await page.getByTestId("connection-done").click();
        expect((await deleted).status()).toBe(204);
        await expect(dialog).toBeHidden();
        expect(await readConnection(request, name)).toBeUndefined();
      });
    },
  );

  test(
    "a denied consent, then an expired sign-in link, each say so, and the row records why",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const name = newHandle("deny");
      const dialog = await openAddDialog(page);
      await fillDetails(page, name);

      await test.step("the provider denies: the dialog says so and the row records oauth-denied", async () => {
        provider.answer("deny");
        const callback = provider.nextCallback();
        await page.getByTestId("connection-continue").click();
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.denied);
        expect(await readConnection(request, name)).toMatchObject({
          status: "error",
          status_reason: "oauth-denied",
          has_credentials: false,
        });
      });

      await test.step("Try again, and the provider returns neither code nor error: the link expired", async () => {
        provider.answer("no-code");
        const callback = provider.nextCallback();
        await page.getByTestId("connection-try-again").click();
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.expired);
        expect(await readConnection(request, name)).toMatchObject({
          status: "error",
          status_reason: "oauth-expired",
        });
        expect(provider.requests, "both attempts reached the provider").toHaveLength(2);
      });

      await test.step("Cancel deletes the row", async () => {
        await page.getByTestId("connection-done").click();
        await expect(dialog).toBeHidden();
        await expect.poll(async () => readConnection(request, name)).toBeUndefined();
      });
    },
  );

  test(
    "an abandoned Reconnect leaves a working connection as it was",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const name = newHandle("reconnect");
      await createConnectionViaApi(request, superHeaders, { name, grantedScopes: HELD });
      const before = await readConnection(request, name);
      expect(before).toMatchObject({ status: "ready", status_reason: null, has_credentials: true });
      provider.answer("stall");

      await page.goto(PAGE);
      const row = page.getByTestId(`connection-row-${name}`);
      await expect(row).toBeVisible({ timeout: 30000 });
      await page.getByTestId(`connection-menu-${name}`).click();
      await page.getByRole("menuitem", { name: "Reconnect" }).click();
      const dialog = page.getByRole("dialog", { name: `Reconnect E2E ${name}` });

      await test.step("the dialog checks the scopes the connection holds and marks them Granted", async () => {
        await expect(dialog).toBeVisible();
        for (const scope of HELD) {
          await expect(dialog.getByTestId(`connection-scope-${scope}`), scope).toBeChecked();
          await expect(scopeLabel(dialog, scope), scope).toContainText(COPY.granted);
        }
      });

      const popup = await test.step("Authorize starts consent for the held scopes", async () => {
        const started = page.waitForResponse((res) => res.url().endsWith("/oauth/start"));
        const opened = page.context().waitForEvent("page");
        await page.getByTestId("connection-authorize").click();
        const start = await started;
        expect(start.status(), await start.text()).toBe(200);
        const sent = start.request().postDataJSON() as { registration_id: string; scopes: string[] };
        expect(sent.registration_id).toBe(GOOGLE);
        expect([...sent.scopes].sort()).toEqual([...HELD].sort());
        await expect(dialog).toContainText(COPY.waiting);
        return await opened;
      });

      await test.step("Cancel closes the dialog and the window, and writes nothing", async () => {
        const writes = recordWrites(page);
        await page.getByTestId("connection-done").click();
        await expect(dialog).toBeHidden();
        await expect.poll(() => popup.isClosed()).toBe(true);
        // A cancelled Add deletes from the click itself; a Reconnect must send nothing.
        await page.waitForTimeout(1000);
        expect(writes).toEqual([]);
      });

      await test.step("the row is exactly as it was, and still reads Ready", async () => {
        const after = await readConnection(request, name);
        expect(after).toMatchObject({
          status: "ready",
          status_reason: null,
          has_credentials: true,
          granted_scopes: before!.granted_scopes,
          updated_at: before!.updated_at,
        });
        await expect(row).toContainText("Ready");
        for (const reason of [COPY.denied, COPY.expired, COPY.failed]) {
          await expect(row).not.toContainText(reason);
        }
      });
    },
  );

  test(
    "a pending connection the provider refuses shows Error, with the reason, on the page",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const name = newHandle("pending");
      await createConnectionViaApi(request, superHeaders, { name, credentials: null });
      await page.goto(PAGE);
      const row = page.getByTestId(`connection-row-${name}`);
      await expect(row).toBeVisible({ timeout: 30000 });
      await expect(row).toContainText("Pending");

      const dialog = page.getByRole("dialog", { name: `Reconnect E2E ${name}` });

      await test.step("Authorize on the row opens the dialog with nothing to request yet", async () => {
        await page.getByTestId(`authorize-${name}`).click();
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId("connection-authorize")).toBeDisabled();
        await dialog.getByTestId("connection-scope-openid").click();
        await dialog.getByTestId("connection-scope-email").click();
        await expect(page.getByTestId("connection-authorize")).toBeEnabled();
      });

      await test.step("the provider denies, and Cancel keeps the row", async () => {
        provider.answer("deny");
        const callback = provider.nextCallback();
        await page.getByTestId("connection-authorize").click();
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.denied);
        const writes = recordWrites(page);
        await page.getByTestId("connection-done").click();
        await expect(dialog).toBeHidden();
        await page.waitForTimeout(1000);
        expect(writes, "a Reconnect never deletes its row").toEqual([]);
      });

      await test.step("the page shows Error with the reason, and the API agrees", async () => {
        await expect(row).toContainText(/Error\s*The provider denied authorization\./);
        expect(await readConnection(request, name)).toMatchObject({
          status: "error",
          status_reason: "oauth-denied",
          has_credentials: false,
        });
      });
    },
  );
});
