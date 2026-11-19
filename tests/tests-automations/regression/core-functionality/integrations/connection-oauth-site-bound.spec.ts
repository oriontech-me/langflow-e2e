import type { APIRequestContext, Locator, Page, Request, Response } from "@playwright/test";
import sites from "../../../../../scripts/lib/fake-integration-sites.json";
import registrations from "../../../../../scripts/lib/fake-oauth-registrations.json";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { type ConnectionRead, uniqueConnectionName } from "../../../../helpers/integrations/create-connection";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";
import { installFakeOAuthProvider } from "../../../../helpers/integrations/fake-oauth-provider";
import { untilNotRateLimited } from "../../../../helpers/integrations/oauth-callback";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// The Add dialog walked to consent for the four site-bound OAuth providers (#2499).
// Spec doc: docs/core-functionality/integrations/connection-oauth-site-bound.md
//
// Needs #2498's fake deployment sites and registrations. The test plays the provider
// (installFakeOAuthProvider), and the page talks to the server as a throwaway user:
// its starts and reads are that user's buckets, never the superuser's. The OAuth
// callback is not routed — it is authenticated by its state and binding cookie.

test.describe("Connections — the Add dialog for the site-bound OAuth providers", () => {
  const PAGE = "/settings/connections";
  const COLLECTION = "/api/v1/connections";
  const REGISTRATIONS = `${COLLECTION}/oauth/registrations`;
  /** The first build serving all four providers. */
  const PROVIDERS_SINCE = "1.14.0.dev23";
  /**
   * What each registration requires, measured on 1.14.0.dev32: the dialog locks these.
   * Pinned against the served list, so a changed requirement fails by name.
   */
  const REQUIRED: Record<string, string[]> = {
    jira: ["offline_access"],
    confluence: ["offline_access"],
    salesforce: ["api", "id", "refresh_token"],
    servicenow: ["langflow_table_read"],
  };
  const SITE_BOUND = Object.keys(REQUIRED);
  /** Where each provider's consent starts, and the query keys its authorization URL carries. */
  const ATLASSIAN_KEYS = ["audience", "client_id", "prompt", "redirect_uri", "response_type", "scope", "state"];
  const PKCE_KEYS = ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"];
  const AUTHORIZE: Record<string, { endpoint: string; keys: string[]; fixed: Record<string, string> }> = {
    jira: {
      endpoint: "https://auth.atlassian.com/authorize",
      keys: ATLASSIAN_KEYS,
      fixed: { audience: "api.atlassian.com", prompt: "consent" },
    },
    confluence: {
      endpoint: "https://auth.atlassian.com/authorize",
      keys: ATLASSIAN_KEYS,
      fixed: { audience: "api.atlassian.com", prompt: "consent" },
    },
    salesforce: {
      endpoint: `${sites.LANGFLOW_SALESFORCE_ORIGIN}/services/oauth2/authorize`,
      keys: [...PKCE_KEYS, "prompt"].sort(),
      fixed: { prompt: "login consent", code_challenge_method: "S256" },
    },
    servicenow: {
      endpoint: `${sites.LANGFLOW_SERVICENOW_ORIGIN}/oauth_auth.do`,
      keys: PKCE_KEYS,
      fixed: { code_challenge_method: "S256" },
    },
  };
  /** One Atlassian and one origin provider are denied; the other two are cancelled (the callback budget is per IP). */
  const DENIED = new Set(["jira", "salesforce"]);
  /** Unticked before Continue, to prove an optional scope stays out of the request. */
  const UNTICKED: Record<string, string> = { jira: "write:jira-work" };
  const COPY = {
    required: "Required for this connection",
    waiting: "Waiting for consent in the provider's window…",
    denied: "The provider denied authorization.",
  };
  const RISK_LABEL: Record<string, string> = { read: "Read", write: "Write", destructive: "Destructive" };
  const OUTCOME_TIMEOUT = 180_000;

  interface Capability {
    display_name: string;
    risk: string;
    required_scopes: string[];
  }
  interface ManifestProvider {
    provider_id: string;
    display_name: string;
    docs_url: string;
    capabilities: Capability[];
  }
  interface ServedRegistration {
    id: string;
    provider: string;
    scopes: string[];
    required_scopes: string[];
  }

  let owner: ConnectionsOwner;
  let manifest = new Map<string, ManifestProvider>();
  const handles: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connsite",
    );
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  test.beforeEach(async ({ context, request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, PROVIDERS_SINCE)),
      `Jira, Confluence, Salesforce and ServiceNow are all served from ${PROVIDERS_SINCE}`,
    );
    if (manifest.size === 0) {
      const res = await request.get("/api/v1/integrations", { headers: owner.headers });
      expect(res.status(), await res.text()).toBe(200);
      const { providers } = (await res.json()) as { providers: ManifestProvider[] };
      manifest = new Map(providers.map((provider) => [provider.provider_id, provider]));
    }
    // The page as the throwaway user, except the callback and its browser handoff,
    // which carry no token. whoami goes too, so the page agrees about who owns its rows.
    await context.route(
      (url) =>
        (url.pathname.startsWith(COLLECTION) && !/^\/api\/v1\/connections\/oauth\/[^/]+\/(callback|browser)/.test(url.pathname)) ||
        url.pathname === "/api/v1/integrations" ||
        url.pathname === "/api/v1/users/whoami",
      async (route) => {
        const headers = { ...route.request().headers(), authorization: owner.headers.Authorization };
        let response: Awaited<ReturnType<typeof route.fetch>>;
        try {
          response = await route.fetch({ headers });
        } catch {
          return route.abort().catch(() => undefined);
        }
        await route.fulfill({ response }).catch(() => undefined);
      },
    );
  });

  test.afterEach(async ({ request }) => {
    const mine = new Set(handles.splice(0));
    if (mine.size === 0) return;
    // A denied or cancelled Add deletes its own row, so read before charging a DELETE.
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

  function providerOf(id: string): ManifestProvider {
    const provider = manifest.get(id);
    expect(provider, `the manifest lists ${id}`).toBeDefined();
    return provider!;
  }

  /** The canonical fake registration of a provider (#2498). */
  function canonical(id: string): { client_id: string; redirect_uri: string; scopes: string[] } {
    const registration = (registrations as Record<string, { client_id: string; redirect_uri: string; scopes: string[] }>)[`e2e-${id}`];
    expect(registration, `scripts/lib/fake-oauth-registrations.json has e2e-${id}`).toBeDefined();
    return registration;
  }

  /** The registration the instance serves for a provider, its requirement pinned. */
  async function servedRegistration(request: APIRequestContext, id: string): Promise<ServedRegistration> {
    const res = await request.get(`${REGISTRATIONS}?provider=${id}`, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    const { registrations: served } = (await res.json()) as { registrations: ServedRegistration[] };
    const registration = served.find((item) => item.id === `e2e-${id}`);
    expect(registration, `the instance serves e2e-${id} (#2498's site and registration)`).toBeDefined();
    expect([...registration!.required_scopes].sort(), `e2e-${id}'s required scopes`).toEqual([...REQUIRED[id]].sort());
    return registration!;
  }

  function newHandle(label: string): string {
    const name = uniqueConnectionName(`connsite_${label}`);
    handles.push(name);
    return name;
  }

  function registrationsListed(page: Page, provider: string): Promise<Response> {
    return page.waitForResponse(
      (res) => {
        const url = new URL(res.url());
        return url.pathname === REGISTRATIONS && res.request().method() === "GET" && url.searchParams.get("provider") === provider;
      },
      { timeout: OUTCOME_TIMEOUT },
    );
  }

  /**
   * Opens Add, chooses `id`, and waits for its registration list: a Continue sent
   * before that list arrives names the provider id as the registration, which the
   * server refuses (measured on Jira, the race connection-oauth-wizard records).
   */
  async function openAddDialog(page: Page, id: string): Promise<Locator> {
    const { display_name } = providerOf(id);
    await page.goto(PAGE);
    const listed = registrationsListed(page, id);
    await page.getByTestId("add-connection").click();
    const dialog = page.getByRole("dialog", { name: "Add connection" });
    await expect(dialog).toBeVisible();
    const field = dialog.getByTestId("connection-provider");
    if ((await field.innerText()).trim() !== display_name) {
      await field.click();
      await page.getByRole("listbox").getByRole("option", { name: display_name, exact: true }).click();
    }
    await expect.poll(async () => (await field.innerText()).trim(), { message: `${id} is chosen` }).toBe(display_name);
    expect((await listed).status(), `the ${id} registration list`).toBe(200);
    return dialog;
  }

  function scopeLabel(dialog: Locator, scope: string): Locator {
    return dialog.getByTestId(`connection-scope-${scope}`).locator("xpath=ancestor::label[1]");
  }

  async function listedScopes(dialog: Locator): Promise<string[]> {
    return dialog
      .locator('[data-testid^="connection-scope-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("connection-scope-".length)));
  }

  async function checkedScopes(dialog: Locator): Promise<string[]> {
    return dialog
      .locator('[data-testid^="connection-scope-"][aria-checked="true"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("connection-scope-".length)));
  }

  function recordWrites(page: Page): string[] {
    const writes: string[] = [];
    page.on("request", (request: Request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith(COLLECTION)) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    return writes;
  }

  function write(page: Page, method: "POST" | "DELETE", path: (pathname: string) => boolean): Promise<Response> {
    return page.waitForResponse((res) => res.request().method() === method && path(new URL(res.url()).pathname), {
      timeout: OUTCOME_TIMEOUT,
    });
  }

  const sorted = (items: string[]) => [...items].sort();

  test(
    "each site-bound provider lists its scopes ticked, locks the required ones, and names its setup guide",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const writes = recordWrites(page);
      for (const id of SITE_BOUND) {
        await test.step(`${id}: every scope is offered and ticked, the required ones locked`, async () => {
          const served = await servedRegistration(request, id);
          expect(sorted(served.scopes), `e2e-${id} serves the canonical scopes`).toEqual(sorted(canonical(id).scopes));
          const { docs_url, capabilities } = providerOf(id);
          const dialog = await openAddDialog(page, id);

          expect(sorted(await listedScopes(dialog)), "the dialog offers exactly the registration's scopes").toEqual(
            sorted(served.scopes),
          );
          expect(sorted(await checkedScopes(dialog)), "every scope starts ticked").toEqual(sorted(served.scopes));
          for (const scope of served.scopes) {
            const box = dialog.getByTestId(`connection-scope-${scope}`);
            const lines = (await scopeLabel(dialog, scope).innerText()).split("\n").map((line) => line.trim());
            if (REQUIRED[id].includes(scope)) {
              await expect(box, `${scope} is required, so locked`).toBeDisabled();
              expect(lines, `${scope} says why it is locked`).toContain(COPY.required);
              continue;
            }
            await expect(box, `${scope} is optional`).toBeEnabled();
            const needing = capabilities.filter((capability) => capability.required_scopes.includes(scope));
            expect(needing.length, `the manifest names an action needing ${scope}`).toBeGreaterThan(0);
            for (const capability of needing) {
              const at = lines.indexOf(capability.display_name);
              expect(at, `${scope} names ${capability.display_name}: ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
              expect(lines[at + 1], `${capability.display_name}'s risk`).toBe(RISK_LABEL[capability.risk]);
            }
          }
          await expect(dialog.getByTestId("connection-setup-guide"), "the manifest's docs_url").toHaveAttribute("href", docs_url);
        });
      }
      expect(writes, "opening the dialog and choosing a provider sends no write").toEqual([]);
    },
  );

  test(
    "consent at each site-bound provider starts with the ticked scopes, and a denied or cancelled one leaves no row",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, context, request }, testInfo) => {
      // The denied callbacks answer 400 on purpose.
      (page as PageWithErrorHooks).allowHttpErrors();
      for (const id of SITE_BOUND) {
        await test.step(`${id}: the start and the authorization URL, then ${DENIED.has(id) ? "a denial" : "a cancel"}`, async () => {
          // Installed per provider: Jira and Confluence share Atlassian's host, and the later route answers it.
          const provider = await installFakeOAuthProvider(context, testInfo.project.use.baseURL!, id);
          provider.answer(DENIED.has(id) ? "deny" : "stall");
          const { client_id, redirect_uri } = canonical(id);
          const dialog = await openAddDialog(page, id);
          const handle = newHandle(id);
          await dialog.getByTestId("connection-name").fill(handle);
          const untick = UNTICKED[id];
          if (untick) {
            await dialog.getByTestId(`connection-scope-${untick}`).click();
            await expect(dialog.getByTestId(`connection-scope-${untick}`)).toHaveAttribute("aria-checked", "false");
          }
          const ticked = sorted(await checkedScopes(dialog));

          const created = write(page, "POST", (path) => path === COLLECTION);
          const started = write(page, "POST", (path) => path.endsWith("/oauth/start"));
          const callback = DENIED.has(id) ? provider.nextCallback({ timeout: OUTCOME_TIMEOUT }) : null;
          await dialog.getByTestId("connection-continue").click();

          const createRes = await created;
          expect(createRes.status(), await createRes.text()).toBe(201);
          const row = (await createRes.json()) as ConnectionRead;
          expect(row).toMatchObject({ provider_key: id, name: handle, status: "pending" });

          const startRes = await started;
          expect(startRes.status(), await startRes.text()).toBe(200);
          const startBody = startRes.request().postDataJSON() as { registration_id: string; scopes: string[] };
          expect(startBody.registration_id, "the fake registration, not the provider id").toBe(`e2e-${id}`);
          expect(sorted(startBody.scopes), "the ticked scopes").toEqual(ticked);

          await expect.poll(() => provider.requests.length, { message: "the popup reached the provider" }).toBeGreaterThan(0);
          const url = provider.requests[provider.requests.length - 1];
          const expected = AUTHORIZE[id];
          expect(`${url.origin}${url.pathname}`, "the provider's authorization endpoint").toBe(expected.endpoint);
          expect(sorted([...url.searchParams.keys()]), "exactly the provider's parameters").toEqual(sorted(expected.keys));
          for (const [key, value] of Object.entries(expected.fixed)) expect(url.searchParams.get(key), key).toBe(value);
          expect(url.searchParams.get("client_id")).toBe(client_id);
          expect(url.searchParams.get("redirect_uri")).toBe(redirect_uri);
          expect(url.searchParams.get("response_type")).toBe("code");
          expect(url.searchParams.get("state"), "a one-shot state").toMatch(/^[A-Za-z0-9_-]{43}$/);
          if (url.searchParams.has("code_challenge")) {
            expect(url.searchParams.get("code_challenge"), "an S256 challenge").toMatch(/^[A-Za-z0-9_-]{43}$/);
          }
          expect(sorted((url.searchParams.get("scope") ?? "").split(" ")), "the authorization asks the ticked scopes").toEqual(ticked);
          if (untick) expect(url.searchParams.get("scope")!.split(" "), `${untick} was unticked`).not.toContain(untick);

          const deleted = write(page, "DELETE", (path) => path === `${COLLECTION}/${row.id}`);
          if (callback) {
            expect((await callback).status(), "the denied callback").toBe(400);
            await expect(dialog.getByText(COPY.denied), "the dialog says the provider denied it").toBeVisible({
              timeout: OUTCOME_TIMEOUT,
            });
          } else {
            await expect(dialog.getByText(COPY.waiting)).toBeVisible();
            await dialog.getByRole("button", { name: "Cancel" }).click();
          }
          expect((await deleted).status(), "the dialog deletes the row it created").toBe(204);
          const left = (await listConnections(request)).filter((item) => item.name === handle);
          expect(left, "no row is left behind").toEqual([]);
        });
      }
    },
  );
});
