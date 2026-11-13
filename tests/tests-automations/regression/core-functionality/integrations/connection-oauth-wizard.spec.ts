import type { APIRequestContext, Locator, Page, Request, Response } from "@playwright/test";
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
  absorbReadRateLimit,
  absorbStartRateLimit,
  fetchAbsorbingReadLimit,
  holdConnectionList,
  installFakeOAuthProvider,
} from "../../../../helpers/integrations/fake-oauth-provider";
import { untilNotRateLimited } from "../../../../helpers/integrations/oauth-callback";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

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
  const MICROSOFT = "e2e-microsoft";
  /** What test 5's Microsoft row holds; Entra never reports `offline_access` as granted. */
  const HELD = ["Mail.Read", "Mail.Send"];
  const OFFLINE_ACCESS = "offline_access";
  /** Each OAuth provider's *Setup guide*, measured on 1.14.0.dev7 (langflow#15796). */
  const SETUP_GUIDE: Record<string, string> = {
    google: "https://docs.langflow.org/connection-oauth#customer-owned-google-registration",
    microsoft: "https://docs.langflow.org/entra-app-registration",
    slack: "https://docs.langflow.org/connection-oauth#customer-owned-slack-registration",
  };
  // Exact copy, measured on 1.14.0.dev2 and 1.14.0.dev7 (connections.* in the en bundle).
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
    someInputs: "For some inputs",
    handleTooltip: (provider: string) =>
      `The identifier flows use to reference this connection, such as ${provider}/work.`,
    displayNameTooltip: "A readable name shown in connection lists to help you recognize this account.",
  };
  const RISK_LABEL: Record<string, string> = { read: "Read", write: "Write", destructive: "Destructive" };
  /**
   * From this build a failed Add deletes the row it created, and Try again creates a
   * new one (langflow#15952, `discardFailedNewConnection`). Neither 1.13 line has it.
   * Decided by the served version, never by whether a row survives (#2336, #2376).
   */
  const FAILED_ADD_DISCARDED_SINCE = "1.14.0.dev10";
  /**
   * From this build *Provider* is a Radix Select (langflow#15951, `ProviderSelect.tsx`):
   * `connection-provider` is a combobox button showing the provider's display_name, and
   * its options are named by display_name with no value in the DOM. Before it, a native
   * <select> of provider ids. Decided by the served version, never by the element (#2413).
   */
  const PROVIDER_COMBOBOX_SINCE = "1.14.0.dev23";
  /**
   * From this build the dialog has no *Display name* field: a connection's display name
   * is its handle (langflow upstream 1dcd9de3fb, "use connection handles as display
   * names", first in 1.14.0.dev26). The 1.13 line and earlier 1.14 builds keep it.
   */
  const NO_DISPLAY_NAME_FIELD_SINCE = "1.14.0.dev26";
  /** Long enough for a start, a callback or a read that waits out two 429 windows (the spec doc's *Budgets*). */
  const OUTCOME_TIMEOUT = 180_000;
  /**
   * For what the page shows only after a fresh list read: such a read may wait out
   * the read bucket's window (`absorbReadRateLimit`), and until it answers the page
   * still shows the previous state. Measured on 1.14.0.dev14: a held read kept
   * test 6's row on Pending for 23 s.
   */
  const AFTER_A_READ = { timeout: OUTCOME_TIMEOUT };

  let superHeaders: Record<string, string>;
  let provider: FakeOAuthProvider;
  /** Whether the served build renders *Provider* as a combobox (see PROVIDER_COMBOBOX_SINCE). */
  let providerCombobox = false;
  /** Whether the served build's dialog still has a *Display name* field. */
  let displayNameField = true;
  /** provider_id → display_name, in the manifest's order: what the combobox is named by. */
  let providerNames = new Map<string, string>();
  const handles: string[] = [];

  test.beforeEach(async ({ page, request }, testInfo) => {
    superHeaders = { Authorization: await getAuthToken(request) };
    providerCombobox = await servedVersionAtLeast(request, PROVIDER_COMBOBOX_SINCE);
    displayNameField = !(await servedVersionAtLeast(request, NO_DISPLAY_NAME_FIELD_SINCE));
    if (providerCombobox && providerNames.size === 0) {
      const res = await request.get("/api/v1/integrations", { headers: superHeaders });
      expect(res.status(), await res.text()).toBe(200);
      const { providers } = (await res.json()) as { providers: Array<{ provider_id: string; display_name: string }> };
      providerNames = new Map(providers.map((item) => [item.provider_id, item.display_name]));
    }
    provider = await installFakeOAuthProvider(page.context(), testInfo.project.use.baseURL!);
    await absorbStartRateLimit(page);
    await absorbReadRateLimit(page.context());
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
    // The test's reads share the page's bucket (see absorbReadRateLimit).
    const { result: res } = await untilNotRateLimited(
      "the test's connection list read",
      () => request.get(COLLECTION, { headers: superHeaders }),
      (res) => res.status(),
    );
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
   * The dialog's `oauth/start`, as the server finally answered it: a start refused
   * with 429 is resent once its window resets (`absorbStartRateLimit`), which a
   * validation burst or a CI retry reaches, so the wait is the helpers' cap.
   */
  function startAnswered(page: Page): Promise<Response> {
    return page.waitForResponse((res) => res.url().endsWith("/oauth/start"), { timeout: OUTCOME_TIMEOUT });
  }

  /** The next registration list the page reads, for `provider` when given. */
  function registrationsListed(page: Page, provider?: string): Promise<Response> {
    return page.waitForResponse(
      (res) => {
        const url = new URL(res.url());
        return (
          url.pathname === `${COLLECTION}/oauth/registrations` &&
          res.request().method() === "GET" &&
          (provider === undefined || url.searchParams.get("provider") === provider)
        );
      },
      // A read refused with 429 answers once its window resets.
      { timeout: OUTCOME_TIMEOUT },
    );
  }

  /** The provider field, a native select or (from 1.14.0.dev23) a combobox. */
  const providerField = (page: Page) => page.getByTestId("connection-provider");

  /** The provider ids the field offers, in its order. */
  async function providerOptionIds(page: Page): Promise<string[]> {
    if (!providerCombobox) {
      return providerField(page)
        .locator("option")
        .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    }
    await providerField(page).click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const names = await listbox.getByRole("option").evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText.trim()));
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    return names.map((name) => providerIdNamed(name));
  }

  /** The provider id the field currently shows. */
  async function chosenProvider(page: Page): Promise<string> {
    if (!providerCombobox) return providerField(page).inputValue();
    return providerIdNamed((await providerField(page).innerText()).trim());
  }

  /** Picks a provider by id: its option is named by the manifest's display_name. */
  async function chooseProvider(page: Page, providerId: string): Promise<void> {
    if (!providerCombobox) {
      await providerField(page).selectOption(providerId);
      return;
    }
    const name = providerNames.get(providerId);
    expect(name, `the manifest names provider ${providerId}`).toBeDefined();
    await providerField(page).click();
    await page.getByRole("listbox").getByRole("option", { name, exact: true }).click();
    // innerText, not toHaveText: the provider icon's own text ("Microsoft") is in textContent.
    await expect.poll(() => chosenProvider(page), { message: `${providerId} is chosen` }).toBe(providerId);
  }

  function providerIdNamed(name: string): string {
    const match = [...providerNames].find(([, displayName]) => displayName === name);
    expect(match, `"${name}" is a manifest provider's display_name`).toBeDefined();
    return match![0];
  }

  /**
   * Opens Add, waits for its registration list, then picks `provider` and waits
   * for that provider's list too. Continue is enabled before the list arrives, and
   * a Continue sent meanwhile names the provider id as the registration
   * (`"google"`), which the server refuses: measured by delaying the list, and
   * seen once in CI. The spec doc records it.
   *
   * The list is fetched per provider (`?provider=<id>`), and the dialog preselects
   * the first provider listed, which on 1.14.0.dev7 is GitHub (langflow#15957). So
   * the first list is GitHub's, and waiting for it alone left Google's in flight:
   * on 1.14.0.dev14 that lost the race (#2376). `null` keeps the preselection, for
   * the test that asserts it.
   */
  async function openAddDialog(page: Page, provider: string | null = "google"): Promise<Locator> {
    await page.goto(PAGE);
    const listed = registrationsListed(page);
    await page.getByTestId("add-connection").click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    await expect(dialog).toBeVisible();
    expect((await listed).status()).toBe(200);
    if (provider && (await chosenProvider(page)) !== provider) {
      const picked = registrationsListed(page, provider);
      await chooseProvider(page, provider);
      expect((await picked).status(), `the ${provider} registration list`).toBe(200);
    }
    return dialog;
  }

  /**
   * The list read the dialog itself polls, carrying `name` with `reason`: what the
   * server recorded, as the dialog read it. From 1.14.0.dev10 the dialog deletes a
   * failed Add's row right after that read, so a list read by the test comes too
   * late (#2376). A read held by `holdConnectionList` answers the snapshot taken
   * before the callback, never the reason, so it cannot match.
   */
  async function polledRow(page: Page, name: string, reason: string): Promise<ConnectionRead> {
    const carries = (rows: ConnectionRead[]) => rows.find((row) => row.name === name && row.status_reason === reason);
    const res = await page.waitForResponse(
      async (res) =>
        res.request().method() === "GET" &&
        new URL(res.url()).pathname === COLLECTION &&
        res.status() === 200 &&
        carries((await res.json().catch(() => [])) as ConnectionRead[]) !== undefined,
      { timeout: OUTCOME_TIMEOUT },
    );
    return carries((await res.json()) as ConnectionRead[])!;
  }

  /** The next connection the page creates or deletes, as the server answered it. */
  function connectionWrite(page: Page, method: "POST" | "DELETE"): Promise<Response> {
    return page.waitForResponse(
      (res) =>
        res.request().method() === method &&
        (method === "POST"
          ? new URL(res.url()).pathname === COLLECTION
          : new URL(res.url()).pathname.startsWith(`${COLLECTION}/`)),
      { timeout: OUTCOME_TIMEOUT },
    );
  }

  /** From 1.14.0.dev10: the dialog deleted `row`, and the list no longer carries it. */
  async function expectDiscarded(request: APIRequestContext, deleted: Promise<Response>, row: ConnectionRead) {
    const res = await deleted;
    expect(new URL(res.url()).pathname, "the dialog deletes the row it created").toBe(`${COLLECTION}/${row.id}`);
    expect(res.status()).toBe(204);
    expect(await readConnection(request, row.name), "a failed Add leaves no row").toBeUndefined();
  }

  /**
   * The tooltip a help button shows on hover, closed again afterwards. The
   * content is hoverable, so leaving the trigger opens a grace area towards it,
   * and a tooltip closes only on a later pointer move outside that area: a single
   * jump away left it open (measured), so the pointer leaves in steps.
   */
  async function expectTooltip(page: Page, testId: string, text: string) {
    await page.getByTestId(testId).hover();
    await expect(page.getByRole("tooltip")).toHaveText(text);
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }

  async function fillDetails(page: Page, name: string) {
    await page.getByTestId("connection-name").fill(name);
    if (displayNameField) await page.getByTestId("connection-display-name").fill(`E2E ${name}`);
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
      const dialog = await openAddDialog(page, null);

      await test.step("the provider options are the manifest's, the first one selected", async () => {
        expect(await providerOptionIds(page)).toEqual(manifest.providers.map((item) => item.provider_id));
        await expect.poll(() => chosenProvider(page), { message: "the first provider is preselected" }).toBe(
          manifest.providers[0].provider_id,
        );
        await chooseProvider(page, "google");
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
        await chooseProvider(page, "slack");
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
    "the registration picked is the one consent starts with, a lost sign-in window still learns the provider's answer, and Cancel discards the half-made connection",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const discards = await servedVersionAtLeast(request, FAILED_ADD_DISCARDED_SINCE);
      // A second Google registration, listed first: the picker must not just
      // send whatever it preselected.
      await page.route("**/api/v1/connections/oauth/registrations**", async (route) => {
        let response: Awaited<ReturnType<typeof fetchAbsorbingReadLimit>>;
        try {
          response = await fetchAbsorbingReadLimit(route);
        } catch {
          // The page closed while the read waited: nothing is left to answer.
          return route.abort().catch(() => undefined);
        }
        const body = (await response.json()) as { registrations: Array<{ id: string }> };
        const real = body.registrations.find((item) => item.id === GOOGLE);
        if (real) body.registrations.unshift({ ...real, id: `${GOOGLE}-alt` });
        await route.fulfill({ response, json: body }).catch(() => undefined);
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
        const started = startAnswered(page);
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

      await test.step("closing the sign-in window unanswered is reported, with the setup guide and Try again", async () => {
        await popup.close();
        await expect(dialog.getByRole("status")).toHaveText(COPY.untracked);
        await expect(dialog.getByTestId("connection-setup-guide")).toHaveAttribute("href", SETUP_GUIDE.google);
        await expect(dialog.getByTestId("connection-try-again")).toBeVisible();
        expect(await readConnection(request, name), "Continue created the row").toMatchObject({ status: "pending" });
      });

      await test.step("the provider's answer arriving anyway still reaches the dialog", async () => {
        // The popup is gone, so the denial is delivered the way its redirect would
        // have: the attempt's state, to the real callback, with the binding cookie
        // oauth/start set. page.request shares the context's jar, which holds that
        // cookie; it is path-scoped, so context.cookies(origin) does not list it.
        const state = provider.requests.at(-1)?.searchParams.get("state");
        expect(state, "the popup opened an authorization URL with a state").toBeTruthy();
        const params = new URLSearchParams({ state: state!, error: "access_denied" });
        const denied = polledRow(page, name, "oauth-denied");
        const discarded = discards ? connectionWrite(page, "DELETE") : null;
        // The dialog keeps polling while a 429 is waited out: hold its reads until the callback lands.
        const { result: callback } = await holdConnectionList(page.context(), () =>
          untilNotRateLimited(
            "the Google callback delivered after the popup closed",
            () => page.request.get(`${COLLECTION}/oauth/google/callback?${params}`, { maxRedirects: 0 }),
            (res) => res.status(),
          ),
        );
        expect(callback.status(), await callback.text()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.denied, AFTER_A_READ);
        await expect(dialog.getByText(COPY.untracked)).toHaveCount(0);
        await expect(dialog.getByTestId("connection-setup-help")).toHaveCount(0);
        const row = await denied;
        expect(row, "the server recorded the denial on the row").toMatchObject({
          status: "error",
          status_reason: "oauth-denied",
          has_credentials: false,
        });
        if (discarded) {
          await expectDiscarded(request, discarded, row);
        } else {
          expect(await readConnection(request, name)).toMatchObject({
            status: "error",
            status_reason: "oauth-denied",
            has_credentials: false,
          });
        }
      });

      await test.step("Cancel leaves no connection behind", async () => {
        if (discards) {
          const writes = recordWrites(page);
          await page.getByTestId("connection-done").click();
          await expect(dialog).toBeHidden();
          await page.waitForTimeout(1000);
          expect(writes, "the failed Add is already gone, so Cancel has nothing to delete").toEqual([]);
        } else {
          const row = await readConnection(request, name);
          expect(row, "the denied row is still there").toBeDefined();
          const deleted = page.waitForResponse(
            (res) => res.request().method() === "DELETE" && res.url().endsWith(`${COLLECTION}/${row!.id}`),
          );
          await page.getByTestId("connection-done").click();
          expect((await deleted).status()).toBe(204);
          await expect(dialog).toBeHidden();
        }
        expect(await readConnection(request, name)).toBeUndefined();
      });
    },
  );

  test(
    "a denied consent, then an expired sign-in link, each say so, and the row records why",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const discards = await servedVersionAtLeast(request, FAILED_ADD_DISCARDED_SINCE);
      const name = newHandle("deny");
      const dialog = await openAddDialog(page);
      await fillDetails(page, name);

      const first = await test.step("the provider denies: the dialog says so and the row records oauth-denied", async () => {
        provider.answer("deny");
        const callback = provider.nextCallback({ timeout: OUTCOME_TIMEOUT });
        const created = connectionWrite(page, "POST");
        const denied = polledRow(page, name, "oauth-denied");
        const discarded = discards ? connectionWrite(page, "DELETE") : null;
        await page.getByTestId("connection-continue").click();
        const createdRes = await created;
        expect(createdRes.status(), await createdRes.text()).toBe(201);
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.denied, AFTER_A_READ);
        const row = await denied;
        expect(row.id, "the row Continue created").toBe(((await createdRes.json()) as ConnectionRead).id);
        expect(row, "the server recorded the denial on the row").toMatchObject({
          status: "error",
          status_reason: "oauth-denied",
          has_credentials: false,
        });
        if (discarded) {
          await expectDiscarded(request, discarded, row);
        } else {
          expect(await readConnection(request, name)).toMatchObject({
            status: "error",
            status_reason: "oauth-denied",
            has_credentials: false,
          });
        }
        return row;
      });

      await test.step("Try again, and the provider returns neither code nor error: the link expired", async () => {
        provider.answer("no-code");
        const callback = provider.nextCallback({ timeout: OUTCOME_TIMEOUT });
        const recreated = discards ? connectionWrite(page, "POST") : null;
        const expired = polledRow(page, name, "oauth-expired");
        const discarded = discards ? connectionWrite(page, "DELETE") : null;
        await page.getByTestId("connection-try-again").click();
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.expired, AFTER_A_READ);
        const row = await expired;
        expect(row, "the server recorded the expired link on the row").toMatchObject({
          status: "error",
          status_reason: "oauth-expired",
          has_credentials: false,
        });
        if (recreated && discarded) {
          const res = await recreated;
          expect(res.status(), await res.text()).toBe(201);
          const id = ((await res.json()) as ConnectionRead).id;
          expect(id, "Try again creates a new row, the first one being gone").not.toBe(first.id);
          expect(row.id, "the row Try again created").toBe(id);
          await expectDiscarded(request, discarded, row);
        } else {
          expect(row.id, "Try again retries the same row").toBe(first.id);
          expect(await readConnection(request, name)).toMatchObject({
            status: "error",
            status_reason: "oauth-expired",
          });
        }
        expect(provider.requests, "both attempts reached the provider").toHaveLength(2);
      });

      await test.step("Cancel leaves no connection behind", async () => {
        const writes = recordWrites(page);
        await page.getByTestId("connection-done").click();
        await expect(dialog).toBeHidden();
        await expect.poll(async () => readConnection(request, name)).toBeUndefined();
        if (discards) {
          await page.waitForTimeout(1000);
          expect(writes, "the failed Add is already gone, so Cancel has nothing to delete").toEqual([]);
        }
      });
    },
  );

  test(
    "an abandoned Reconnect leaves a working connection as it was, and asks Microsoft for the offline access it never reports as granted",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }, testInfo) => {
      const name = newHandle("reconnect");
      await createConnectionViaApi(request, superHeaders, { name, providerKey: "microsoft", grantedScopes: HELD });
      const before = await readConnection(request, name);
      expect(before).toMatchObject({ status: "ready", status_reason: null, has_credentials: true });
      const microsoft = await installFakeOAuthProvider(page.context(), testInfo.project.use.baseURL!, "microsoft");
      const requested = [...HELD, OFFLINE_ACCESS].sort();

      await page.goto(PAGE);
      const row = page.getByTestId(`connection-row-${name}`);
      await expect(row).toBeVisible({ timeout: 30000 });
      await page.getByTestId(`connection-menu-${name}`).click();
      await page.getByRole("menuitem", { name: "Reconnect" }).click();
      const dialog = page.getByRole("dialog", { name: `Reconnect E2E ${name}` });

      await test.step("the held scopes are checked and Granted; offline_access is checked, not Granted", async () => {
        await expect(dialog).toBeVisible();
        for (const scope of HELD) {
          await expect(dialog.getByTestId(`connection-scope-${scope}`), scope).toBeChecked();
          await expect(scopeLabel(dialog, scope), scope).toContainText(COPY.granted);
        }
        await expect(dialog.getByTestId(`connection-scope-${OFFLINE_ACCESS}`)).toBeChecked();
        await expect(scopeLabel(dialog, OFFLINE_ACCESS)).not.toContainText(COPY.granted);
        // The registration offers more, and none of it is preselected.
        const offered = await dialog.locator('[data-testid^="connection-scope-"]').count();
        expect(offered, "the registration offers scopes the row does not hold").toBeGreaterThan(requested.length);
        expect((await checkedScopes(dialog)).sort()).toEqual(requested);
      });

      const popup = await test.step("Authorize asks for the held scopes and offline_access, in the start and the URL", async () => {
        const started = startAnswered(page);
        const opened = page.context().waitForEvent("page");
        await page.getByTestId("connection-authorize").click();
        const start = await started;
        expect(start.status(), await start.text()).toBe(200);
        const sent = start.request().postDataJSON() as { registration_id: string; scopes: string[] };
        expect(sent.registration_id).toBe(MICROSOFT);
        expect([...sent.scopes].sort()).toEqual(requested);
        const popup = await opened;
        await expect(popup).toHaveURL(/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/authorize\?/);
        const url = microsoft.requests.at(-1);
        expect(url, "the popup reached the provider").toBeDefined();
        expect((url!.searchParams.get("scope") ?? "").split(" ").sort()).toEqual(requested);
        await expect(dialog).toContainText(COPY.waiting);
        return popup;
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
        const callback = provider.nextCallback({ timeout: OUTCOME_TIMEOUT });
        const started = startAnswered(page);
        await page.getByTestId("connection-authorize").click();
        const sent = (await started).request().postDataJSON() as { scopes: string[] };
        // Google adds nothing of its own to what was checked, unlike Microsoft in test 5.
        expect([...sent.scopes].sort()).toEqual(["email", "openid"]);
        expect((await callback).status()).toBe(400);
        await expect(dialog.getByRole("alert")).toHaveText(COPY.denied, AFTER_A_READ);
        const writes = recordWrites(page);
        await page.getByTestId("connection-done").click();
        await expect(dialog).toBeHidden();
        await page.waitForTimeout(1000);
        expect(writes, "a Reconnect never deletes its row").toEqual([]);
      });

      await test.step("the page shows Error with the reason, and the API agrees", async () => {
        await expect(row).toContainText(/Error\s*The provider denied authorization\./, AFTER_A_READ);
        expect(await readConnection(request, name)).toMatchObject({
          status: "error",
          status_reason: "oauth-denied",
          has_credentials: false,
        });
      });
    },
  );

  test(
    "the Add dialog explains its fields, links each provider's setup guide, and marks the Microsoft scopes only some inputs need",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const res = await request.get("/api/v1/integrations", { headers: superHeaders });
      expect(res.status(), await res.text()).toBe(200);
      const manifest = (await res.json()) as {
        providers: Array<{
          provider_id: string;
          capabilities: Array<{
            display_name: string;
            risk: string;
            required_scopes: string[];
            conditional_scopes: Array<{ scope: string }>;
          }>;
        }>;
      };
      const microsoft = manifest.providers.find((item) => item.provider_id === "microsoft")!;
      expect(microsoft, "the manifest serves Microsoft 365").toBeDefined();
      const writes = recordWrites(page);
      const dialog = await openAddDialog(page);

      await test.step("Handle and Display name each explain themselves", async () => {
        await expectTooltip(page, "connection-handle-help", COPY.handleTooltip("google"));
        if (displayNameField) {
          await expectTooltip(page, "connection-display-name-help", COPY.displayNameTooltip);
        } else {
          // From 1.14.0.dev26 the handle is the display name, and the dialog asks for one only.
          await expect(dialog.getByTestId("connection-display-name")).toHaveCount(0);
          await expect(dialog.getByTestId("connection-display-name-help")).toHaveCount(0);
        }
      });

      await test.step("each OAuth provider links its own setup guide, and the handle example follows it", async () => {
        for (const [providerId, guide] of Object.entries(SETUP_GUIDE)) {
          await chooseProvider(page, providerId);
          await expect(dialog.getByTestId("connection-setup-guide"), providerId).toHaveAttribute("href", guide);
          await expectTooltip(page, "connection-handle-help", COPY.handleTooltip(providerId));
        }
      });

      await test.step("a Microsoft scope names each action needing it, marking those that need it only for some inputs", async () => {
        await chooseProvider(page, "microsoft");
        const pairs = microsoft.capabilities.flatMap((capability) => [
          ...capability.required_scopes.map((scope) => ({ scope, capability, conditional: false })),
          ...capability.conditional_scopes.map(({ scope }) => ({ scope, capability, conditional: true })),
        ]);
        expect(
          pairs.filter((pair) => pair.conditional).length,
          "the manifest declares Microsoft scopes that only some inputs need",
        ).toBeGreaterThan(0);
        for (const { scope, capability, conditional } of pairs) {
          const lines = (await scopeLabel(dialog, scope).innerText()).split("\n").map((line) => line.trim());
          const at = lines.indexOf(capability.display_name);
          expect(at, `${scope} names ${capability.display_name}: ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
          expect(lines[at + 1], `${capability.display_name}'s risk`).toBe(RISK_LABEL[capability.risk]);
          expect(lines[at + 2] === COPY.someInputs, `${scope} for ${capability.display_name}: conditional`).toBe(
            conditional,
          );
        }
      });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(writes, "browsing the dialog creates nothing").toEqual([]);
    },
  );
});
