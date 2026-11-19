import type { APIRequestContext, Locator, Page, Request, Response } from "@playwright/test";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import {
  type ConnectionRead,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";
import { untilNotRateLimited } from "../../../../helpers/integrations/oauth-callback";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// The Add dialog's pasted-token path for the five 1.14 providers that connect only
// through a pasted token (#2500).
// Spec doc: docs/core-functionality/integrations/connection-token-providers.md
//
// No provider accepts a fake token, and since 1.14.0.dev26 the server checks a pasted
// token against the provider before saving it, so every Continue here ends in a 422.
// That refusal — what the dialog sends, shows and leaves behind — is the contract.
//
// The browser is the superuser (auto-login), but every connection, manifest and
// whoami request the page sends goes out with a throwaway user's token, so this
// file spends that user's per-user buckets and never the superuser's. Beside
// connection-oauth-wizard.spec.ts at --workers=2 its reads as the superuser failed
// one wizard test in each of two runs (the spec doc's *Step by step*).

test.describe("Connections — the pasted-token providers in the Add dialog", () => {
  const PAGE = "/settings/connections";
  const COLLECTION = "/api/v1/connections";
  /** The online token check, which turns a fake token into a refusal (langflow 1.14 batch). */
  const TOKEN_CHECK_SINCE = "1.14.0.dev26";
  /**
   * Each provider's one manual-token profile, measured on 1.14.0.dev32. Asserted
   * against the manifest before use, so a changed identity, scope or expiry rule
   * fails by name instead of reading as a different dialog.
   */
  const PROFILES: Record<string, ManualTokenProfile> = {
    github: { id: "github-installation", identity: "service", required_scopes: [], requires_expiry: true },
    gitlab: { id: "gitlab-personal-token", identity: "user_delegated", required_scopes: ["api"], requires_expiry: false },
    discord: { id: "discord-bot-token", identity: "bot", required_scopes: [], requires_expiry: false },
    telegram: { id: "telegram-bot-token", identity: "bot", required_scopes: [], requires_expiry: false },
    whatsapp: {
      id: "whatsapp-system-user",
      identity: "service",
      required_scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      requires_expiry: false,
    },
  };
  const PROVIDERS = Object.keys(PROFILES);
  const COPY = {
    tokenHelp: "Paste an access token for this provider. Langflow checks the token before saving it.",
  };
  // Every answer ConnectionService gives for a pasted credential the provider refused,
  // or could not be asked about (services/connection/service.py). The provider's answer
  // varies with egress and from day to day, so a run accepts any of these and nothing
  // else. A local copy of api-connections-lifecycle.spec.ts test 9's set, its API twin.
  const CHECKED = [
    "The provider rejected this token. Paste a valid token and try again.",
    "The provider denied this token check. Check the token's permissions and account access.",
    "The provider rate limited this token check. Wait and try again.",
    "Langflow could not reach the provider. Check this server's outbound network and DNS settings, then try again.",
    "The provider rejected this connection configuration. Check the setup guide and token settings.",
    "The provider could not check this token. Try again.",
  ];
  const GITHUB_CHECKED = [
    "GitHub rejected this token. Paste a valid GitHub App installation token and try again.",
    "GitHub rejected this token. Use a GitHub App installation token with repository access.",
    ...CHECKED,
  ];
  /** Refused before any provider call: no lane configures WhatsApp (#2498 left it out). */
  const WHATSAPP_UNCONFIGURED = "Configure the WhatsApp app, app secret, WABA, phone ID and Graph API version on this server.";
  const PAST_EXPIRY = "2020-01-01T00:00";

  interface ManualTokenProfile {
    id: string;
    identity: "user_delegated" | "bot" | "service";
    required_scopes: string[];
    requires_expiry: boolean;
  }
  interface ManifestProvider {
    provider_id: string;
    display_name: string;
    docs_url: string;
    manual_token_profiles: ManualTokenProfile[];
  }
  interface TokenCreateBody {
    provider_key: string;
    name: string;
    display_name: string;
    ownership_mode: string;
    executing_identity: { identity: string };
    granted_scopes: string[];
    allow_non_interactive: boolean;
    credentials: { access_token: string; expires_at?: string };
  }

  let owner: ConnectionsOwner;
  let manifest = new Map<string, ManifestProvider>();
  const handles: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "conntok",
    );
  });

  test.afterAll(async () => {
    // Deleting the user takes any row it still owns with it.
    await owner?.dispose();
  });

  test.beforeEach(async ({ context, request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, TOKEN_CHECK_SINCE)),
      `a pasted token is checked against the provider from ${TOKEN_CHECK_SINCE}; before it a fake token is saved`,
    );
    if (manifest.size === 0) {
      const res = await request.get("/api/v1/integrations", { headers: owner.headers });
      expect(res.status(), await res.text()).toBe(200);
      const { providers } = (await res.json()) as { providers: ManifestProvider[] };
      manifest = new Map(providers.map((provider) => [provider.provider_id, provider]));
    }
    // The page as the throwaway user: the Authorization header wins over the
    // superuser's session cookie. whoami goes too, so the page agrees about who owns
    // the rows it lists (a row owned by someone else is not in the default view).
    await context.route(
      (url) =>
        url.pathname.startsWith(COLLECTION) || url.pathname === "/api/v1/integrations" || url.pathname === "/api/v1/users/whoami",
      async (route) => {
        const headers = { ...route.request().headers(), authorization: owner.headers.Authorization };
        let response: Awaited<ReturnType<typeof route.fetch>>;
        try {
          response = await route.fetch({ headers });
        } catch {
          // The page closed while the request was in flight: nothing is left to answer.
          return route.abort().catch(() => undefined);
        }
        await route.fulfill({ response }).catch(() => undefined);
      },
    );
  });

  test.afterEach(async ({ request }) => {
    const mine = new Set(handles.splice(0));
    if (mine.size === 0) return;
    for (const row of await listConnections(request)) {
      if (!mine.has(row.name)) continue;
      await deleteConnection(request, row.id, { headers: owner.headers }).catch((error) => {
        console.warn(`⚠️ Orphan connection left behind (${row.name}): ${error}`);
      });
    }
  });

  async function listConnections(request: APIRequestContext): Promise<ConnectionRead[]> {
    const { result: res } = await untilNotRateLimited(
      "the test's connection list read",
      () => request.get(COLLECTION, { headers: owner.headers }),
      (res) => res.status(),
    );
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as ConnectionRead[];
  }

  /** The manifest row of a pasted-token provider, its profile checked against PROFILES. */
  function providerOf(id: string): ManifestProvider {
    const provider = manifest.get(id);
    expect(provider, `the manifest lists ${id}`).toBeDefined();
    expect(provider!.manual_token_profiles, `${id}'s manual-token profile`).toEqual([PROFILES[id]]);
    return provider!;
  }

  function newHandle(label: string): string {
    const name = uniqueConnectionName(`conntok_${label}`);
    handles.push(name);
    return name;
  }

  function refusalsOf(id: string): string[] {
    if (id === "whatsapp") return [WHATSAPP_UNCONFIGURED];
    return id === "github" ? GITHUB_CHECKED : CHECKED;
  }

  /** Opens Add and chooses `id` by its display name (the field is a combobox from 1.14.0.dev23). */
  async function openAddDialog(page: Page, id: string): Promise<Locator> {
    const { display_name } = providerOf(id);
    await page.goto(PAGE);
    await page.getByTestId("add-connection").click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    await expect(dialog).toBeVisible();
    const field = dialog.getByTestId("connection-provider");
    if ((await field.innerText()).trim() !== display_name) {
      await field.click();
      await page.getByRole("listbox").getByRole("option", { name: display_name, exact: true }).click();
    }
    // innerText, not toHaveText: the provider icon's own text is in textContent.
    await expect.poll(async () => (await field.innerText()).trim(), { message: `${id} is chosen` }).toBe(display_name);
    return dialog;
  }

  /** The next create the page sends, as the server answered it. */
  function createAnswered(page: Page): Promise<Response> {
    return page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === COLLECTION,
    );
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

  /**
   * A future time as the expiry field takes it (local, minutes), and the UTC instant
   * it names — both computed in the page, in the browser's own time zone.
   */
  function futureExpiry(page: Page): Promise<{ local: string; utc: string }> {
    return page.evaluate(() => {
      const at = new Date(Date.now() + 365 * 24 * 3600 * 1000);
      at.setSeconds(0, 0);
      const pad = (n: number) => String(n).padStart(2, "0");
      const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
      return { local, utc: at.toISOString() };
    });
  }

  /** The refusal, its `detail` within the accepted set, and the alert showing it verbatim. */
  async function expectRefusalShown(dialog: Locator, res: Response, accepted: string[], who: string): Promise<string> {
    const text = await res.text();
    expect(res.status(), text).toBe(422);
    const { detail } = JSON.parse(text) as { detail: unknown };
    expect(accepted, `${who}'s refusal`).toContain(detail);
    await expect(dialog.getByRole("alert"), "the dialog shows the server's own refusal").toHaveText(detail as string);
    return detail as string;
  }

  test(
    "each pasted-token provider opens on its token form: no sign-in, no identity choice, no scopes, its own setup guide",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      const writes = recordWrites(page);
      for (const id of PROVIDERS) {
        await test.step(`${id} offers a token, and nothing else`, async () => {
          const { docs_url } = providerOf(id);
          const profile = PROFILES[id];
          const dialog = await openAddDialog(page, id);
          await expect(dialog.getByTestId("connection-method"), "no sign-in or token choice").toHaveCount(0);
          await expect(dialog.getByTestId("connection-identity"), "the profile's one identity is not asked").toHaveCount(0);
          await expect(dialog.locator('[data-testid^="connection-scope-"]'), "no scope list").toHaveCount(0);
          const token = dialog.getByTestId("connection-token");
          await expect(token).toBeVisible();
          await expect(token).toHaveAttribute("type", "password");
          await expect(dialog.getByTestId("connection-token-help")).toHaveText(COPY.tokenHelp);
          await expect(dialog.getByTestId("connection-setup-guide"), "the manifest's docs_url").toHaveAttribute("href", docs_url);
          await expect(dialog.getByTestId("connection-allow-background-runs")).toHaveAttribute("aria-checked", "false");
          const expiry = dialog.getByTestId("connection-token-expires-at");
          await expect(expiry, `an expiry field only where the profile requires one`).toHaveCount(profile.requires_expiry ? 1 : 0);

          const proceed = dialog.getByTestId("connection-continue");
          await expect(proceed, "nothing filled").toBeDisabled();
          await dialog.getByTestId("connection-name").fill(uniqueConnectionName(`conntok_form_${id}`));
          await expect(proceed, "a handle but no token").toBeDisabled();
          await token.fill(`e2e-fake-${id}-token`);
          if (profile.requires_expiry) {
            await expect(proceed, "a token but no expiry").toBeDisabled();
            await expiry.fill((await futureExpiry(page)).local);
          }
          await expect(proceed, "everything the profile needs").toBeEnabled();
        });
      }
      expect(writes, "choosing and filling the form sends no write").toEqual([]);
    },
  );

  test(
    "a token the provider refuses is shown verbatim, kept for correction, and stores nothing",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      // Five refusals on purpose: a 422 per provider.
      (page as PageWithErrorHooks).allowHttpErrors();
      const mine: string[] = [];
      for (const id of PROVIDERS) {
        await test.step(`${id}: Continue sends the profile, and the refusal stays on screen`, async () => {
          const profile = PROFILES[id];
          const dialog = await openAddDialog(page, id);
          const handle = newHandle(id);
          mine.push(handle);
          const token = `e2e-fake-${id}-token`;
          await dialog.getByTestId("connection-name").fill(handle);
          await dialog.getByTestId("connection-token").fill(token);
          if (profile.requires_expiry) {
            await dialog.getByTestId("connection-token-expires-at").fill((await futureExpiry(page)).local);
          }
          const answered = createAnswered(page);
          await dialog.getByTestId("connection-continue").click();
          const res = await answered;

          const body = res.request().postDataJSON() as TokenCreateBody;
          expect(body, "the create the dialog sends").toMatchObject({
            provider_key: id,
            name: handle,
            display_name: handle,
            ownership_mode: "user",
            executing_identity: { identity: profile.identity },
            allow_non_interactive: false,
            credentials: { access_token: token },
          });
          expect([...body.granted_scopes].sort(), "the profile's required scopes").toEqual([...profile.required_scopes].sort());

          await expectRefusalShown(dialog, res, refusalsOf(id), id);
          await expect(dialog, "a refusal keeps the dialog open").toBeVisible();
          await expect(dialog.getByTestId("connection-token"), "the token is kept for correction").toHaveValue(token);
          await expect(dialog.getByTestId("connection-continue")).toBeEnabled();
          await dialog.getByTestId("connection-token").fill(`${token}-edited`);
          await expect(dialog.getByRole("alert"), "editing the token clears the refusal").toHaveCount(0);
        });
      }

      await test.step("no refused handle reached the list", async () => {
        const stored = (await listConnections(request)).filter((row) => mine.includes(row.name));
        expect(stored.map((row) => `${row.provider_key}/${row.name}`), "a refused token stores nothing").toEqual([]);
      });
    },
  );

  test(
    "GitHub requires a future expiry, sent as UTC, and Allow background runs reaches the request",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      (page as PageWithErrorHooks).allowHttpErrors();
      const dialog = await openAddDialog(page, "github");
      const writes = recordWrites(page);
      const token = "e2e-fake-github-token";
      await dialog.getByTestId("connection-name").fill(newHandle("github_expiry"));
      await dialog.getByTestId("connection-token").fill(token);
      const expiry = dialog.getByTestId("connection-token-expires-at");
      const proceed = dialog.getByTestId("connection-continue");

      await test.step("a past expiry is marked invalid and cannot be sent", async () => {
        await expiry.fill(PAST_EXPIRY);
        await expect(expiry).toHaveAttribute("aria-invalid", "true");
        await expect(proceed).toBeDisabled();
        expect(writes, "nothing was sent").toEqual([]);
      });

      const when = await futureExpiry(page);

      await test.step("a future expiry and the background-runs choice are both in the create", async () => {
        await expiry.fill(when.local);
        await expect(expiry).not.toHaveAttribute("aria-invalid", "true");
        await expect(proceed).toBeEnabled();
        const background = dialog.getByTestId("connection-allow-background-runs");
        await background.click();
        await expect(background).toHaveAttribute("aria-checked", "true");

        const answered = createAnswered(page);
        await proceed.click();
        const res = await answered;
        const body = res.request().postDataJSON() as TokenCreateBody;
        expect(body.allow_non_interactive, "the ticked choice").toBe(true);
        expect(body.credentials, "the token and its expiry, as UTC").toEqual({ access_token: token, expires_at: when.utc });
        await expectRefusalShown(dialog, res, GITHUB_CHECKED, "github");
      });
    },
  );

  test(
    "Reconnect on a pending token connection sends the token to that row and leaves it pending when refused",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      (page as PageWithErrorHooks).allowHttpErrors();
      const handle = newHandle("gitlab_reconnect");
      const { id, connection } = await createConnectionViaApi(request, owner.headers, {
        name: handle,
        displayName: handle,
        providerKey: "gitlab",
        identity: PROFILES.gitlab.identity,
        credentials: null,
      });
      expect(connection.status, "a token connection with no credential is pending").toBe("pending");

      await page.goto(PAGE);
      const writes = recordWrites(page);
      await page.getByTestId(`authorize-${handle}`).click();
      const dialog = page.getByRole("dialog", { name: `Reconnect ${handle}` });

      await test.step("the dialog is the token form for this row", async () => {
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId("connection-provider"), "the provider is the row's").toHaveCount(0);
        await expect(dialog.getByTestId("connection-name"), "the handle is the row's").toHaveCount(0);
        await expect(dialog.locator('[data-testid^="connection-scope-"]')).toHaveCount(0);
        await expect(dialog.getByTestId("connection-token")).toBeVisible();
      });

      await test.step("Continue sends the token to the row, and the refusal is shown", async () => {
        const token = "e2e-fake-gitlab-token";
        await dialog.getByTestId("connection-token").fill(token);
        const answered = page.waitForResponse(
          (res) => res.request().method() === "POST" && new URL(res.url()).pathname === `${COLLECTION}/${id}/token`,
        );
        await dialog.getByTestId("connection-continue").click();
        const res = await answered;
        expect(res.request().postDataJSON(), "only the token and the background-runs choice").toEqual({
          credentials: { access_token: token },
          allow_non_interactive: false,
        });
        await expectRefusalShown(dialog, res, CHECKED, "gitlab");
        expect(writes, "Reconnect writes to the row, and creates nothing").toEqual([`POST ${COLLECTION}/${id}/token`]);
      });

      await test.step("the row is unchanged: still pending, still without a credential", async () => {
        const row = (await listConnections(request)).find((item) => item.id === id);
        expect(row, "the row is still there").toBeDefined();
        expect(row).toMatchObject({ status: "pending", has_credentials: false });
      });
    },
  );
});
