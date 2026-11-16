import type { APIRequestContext, Locator, Page, Request } from "@playwright/test";
import { expect, type PageWithErrorHooks, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { isConnectionRead } from "../../../../helpers/integrations/fake-oauth-provider";
import {
  createRegistrationsOwner,
  listActiveRegistrations,
  listSavedRegistrations,
  MANAGE_PROVIDERS_SINCE,
  putSavedRegistration,
  type RegistrationsOwner,
  removeSavedRegistration,
  SAVED_REGISTRATIONS,
  secretSentinel,
  slackBotRegistration,
  uniqueRegistrationId,
} from "../../../../helpers/integrations/saved-oauth-registrations";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// The Manage providers panel on /settings/connections (#2421).
// Spec doc: docs/core-functionality/integrations/manage-providers-panel.md
//
// The page is always the auto-login superuser, whose write and read buckets every
// connections spec shares, so the rows this file needs are seeded by a throwaway
// superuser through the API, the page's reads carry that owner's token, and the
// superuser spends only the page's own Replace and Remove.
// Every seeded ID is a Slack `bot` registration, a pair no other spec reads. One
// worker, so one throwaway superuser (one login) per run.
test.describe.configure({ mode: "default" });

const PAGE = "/settings/connections";
/** Environment registrations no spec ever saves over (the Slack ones are overridden). */
const UNTOUCHED_ENV = [
  { id: "e2e-google", provider: "google" },
  { id: "e2e-microsoft", provider: "microsoft" },
];
/** The environment registration test 4 overrides; the API spec overrides `e2e-slack-bot`. */
const ENV_USER = "e2e-slack-user";
const MICROSOFT_TENANT_EXAMPLE = "00000000-0000-0000-0000-000000000000";
/** Exact copy, from `connections.providers.*` in en.json, measured on 1.14.0.dev28. */
const COPY = {
  intro:
    "OAuth apps registered here are shared with the whole instance. New connections can use a provider as soon as you save it; trigger listeners and other Langflow processes pick up a change, including a removal, only after Langflow restarts. A registration with the same ID in the server environment takes precedence. Each saved registration is linked to the superuser who last saved it. Deleting or deactivating that account, or removing its superuser access, makes its registrations unavailable after a restart.",
  empty: "No providers configured yet.",
  active: "Active",
  pending: "Saved. Restart Langflow to finish applying it",
  pendingHint:
    "New connections can use it now. Trigger listeners and other Langflow processes pick it up after a restart.",
  overridden: "Not in use: the server environment defines this ID",
  environment: "Server environment",
  restartNote: "Some features need a restart",
  secretKeep: "Leave blank to keep the current secret",
  savedToast: "Provider saved. Restart Langflow to finish applying it.",
  removedToast: "Provider removed. Restart Langflow to finish removing it.",
  errors: {
    id: "Choose a provider and a registration ID with lowercase letters, numbers, hyphens or underscores.",
    idTaken: (id: string) => `The registration ID ${id} is already in use. Choose another ID.`,
    required: "Enter the client ID and the redirect URI.",
    secret: "A confidential client needs a client secret.",
    tenant: `Microsoft 365 needs a tenant, for example ${MICROSOFT_TENANT_EXAMPLE}.`,
  },
};
const COLUMNS = ["Registration ID", "Provider", "Status", "Saved by", ""];

interface ManifestProvider {
  provider_id: string;
  display_name: string;
  capabilities: Array<{ auth_profile_id: string }>;
  manual_token_profiles?: Array<{ id: string }> | null;
}

test.describe("Connections — the Manage providers panel", () => {
  let owner: RegistrationsOwner;
  let superUsername: string;
  /** The manifest's OAuth providers, in manifest order: what the form's select offers. */
  let oauthProviders: ManifestProvider[];
  const saved: string[] = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    test.skip(
      !(await servedVersionAtLeast(request, MANAGE_PROVIDERS_SINCE)),
      `the Manage providers panel ships from ${MANAGE_PROVIDERS_SINCE} (langflow-ai/langflow#16251)`,
    );
    const superHeaders = { Authorization: await getAuthToken(request) };
    const whoami = await request.get("/api/v1/users/whoami", { headers: superHeaders });
    expect(whoami.status(), await whoami.text()).toBe(200);
    superUsername = ((await whoami.json()) as { username: string }).username;
    const manifest = await request.get("/api/v1/integrations", { headers: superHeaders });
    expect(manifest.status(), await manifest.text()).toBe(200);
    // The panel's own rule (`oauthProfile`): a provider with a capability whose auth
    // profile is not one of its manual-token profiles.
    oauthProviders = ((await manifest.json()) as { providers: ManifestProvider[] }).providers.filter((provider) => {
      const manual = new Set((provider.manual_token_profiles ?? []).map((profile) => profile.id));
      return provider.capabilities.some((capability) => !manual.has(capability.auth_profile_id));
    });
    expect(oauthProviders.map((provider) => provider.provider_id), "the manifest serves OAuth providers").toEqual(
      expect.arrayContaining(["google", "microsoft", "slack"]),
    );
    owner = await createRegistrationsOwner(
      request,
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "panelreg",
    );
  });

  test.beforeEach(async ({ context }) => {
    // The page's connection reads go out with the OWNER's token. Both are
    // superusers, so the server answers them the same (the saved list is shared by
    // every superuser, and neither user owns a connection the panel shows), but
    // the cost lands on the owner's `connections-read` bucket instead of the shared
    // superuser's. That bucket is 60/minute, and the wizard spec alone spends ~63
    // reads in 37 s: measured at --workers=2 beside it, this file's reads on the
    // superuser held 429s for 21–32 s, which delayed this file's toasts past their
    // wait and failed the wizard's Reconnect. Writes are not routed: Replace and
    // Remove are the superuser's own, which is what `saved_by` then asserts.
    await context.route(
      (url) => isConnectionRead(url) || url.pathname === SAVED_REGISTRATIONS,
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const headers = { ...route.request().headers(), authorization: owner.headers.Authorization };
        let response: Awaited<ReturnType<typeof route.fetch>>;
        try {
          response = await route.fetch({ headers });
        } catch {
          // The page closed while the read was in flight: nothing is left to answer.
          return route.abort().catch(() => undefined);
        }
        await route.fulfill({ response }).catch(() => undefined);
      },
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of saved.splice(0)) {
      await removeSavedRegistration(request, owner.headers, id).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every registration this test saved is removed").toEqual([]);
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  async function openPanel(page: Page): Promise<Locator> {
    await page.goto(PAGE);
    await page.getByRole("tab", { name: "Manage providers" }).click();
    const panel = page.getByTestId("manage-providers");
    await expect(panel).toBeVisible({ timeout: 30000 });
    return panel;
  }

  /** The table row whose first cell is exactly `id`. */
  function rowOf(panel: Locator, id: string): Locator {
    return panel.getByRole("row").filter({ has: panel.page().getByRole("cell", { name: id, exact: true }) });
  }

  async function expectRow(row: Locator, cells: [string, string, string, string]) {
    await expect(row).toBeVisible({ timeout: 30000 });
    for (const [index, text] of cells.entries()) {
      await expect(row.getByRole("cell").nth(index), COLUMNS[index]).toHaveText(text);
    }
  }

  function field(dialog: Locator, label: string): Locator {
    return dialog.getByLabel(label, { exact: true });
  }

  /** Every write the page sends to the saved-registration routes from now on. */
  function recordWrites(page: Page): string[] {
    const writes: string[] = [];
    page.on("request", (request: Request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith(SAVED_REGISTRATIONS)) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    return writes;
  }

  function callbackFor(page: Page, provider: string): string {
    // The panel's `callbackUrl`: only an HTTPS or loopback-HTTP origin can be registered.
    const origin = new URL(page.url());
    const registrable =
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
    return registrable ? `${origin.origin}/api/v1/connections/oauth/${provider}/callback` : "";
  }

  async function seed(request: APIRequestContext, id: string, registration: Record<string, unknown>) {
    saved.push(id);
    const res = await putSavedRegistration(request, owner.headers, id, registration);
    expect(res.status(), await res.text()).toBe(204);
  }

  test(
    "the environment's registrations are listed as Active from the server environment with no action, Add provider opens a form prefilled for this instance, and with no registration at all the panel says so",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      const writes = recordWrites(page);
      const panel = await openPanel(page);

      await test.step("the panel explains itself and offers Add provider", async () => {
        await expect(panel.getByText(COPY.intro, { exact: true })).toBeVisible();
        await expect(panel.getByTestId("manage-providers-add")).toBeEnabled();
        await expect(panel.getByRole("columnheader")).toHaveText(COLUMNS);
      });

      await test.step("each environment registration reads Active, from the server environment, with no action", async () => {
        for (const { id, provider } of UNTOUCHED_ENV) {
          const row = rowOf(panel, id);
          await expectRow(row, [id, provider, COPY.active, COPY.environment]);
          await expect(row.getByRole("button"), `${id} offers no action`).toHaveCount(0);
        }
      });

      const dialog = page.getByRole("dialog", { name: "Add provider" });

      await test.step("Add provider lists the manifest's OAuth providers and prefills the first", async () => {
        await panel.getByTestId("manage-providers-add").click();
        await expect(dialog).toBeVisible();
        const provider = field(dialog, "Provider");
        await expect(provider.locator("option")).toHaveText(oauthProviders.map((item) => item.display_name));
        const first = oauthProviders[0].provider_id;
        await expect(provider).toHaveValue(first);
        await expect(field(dialog, "Registration ID")).toHaveValue(`${first}-work`);
        await expect(field(dialog, "Redirect URI")).toHaveValue(callbackFor(page, first));
      });

      await test.step("choosing Google Workspace prefills its ID and callback; Cancel writes nothing", async () => {
        await field(dialog, "Provider").selectOption("google");
        await expect(field(dialog, "Registration ID")).toHaveValue("google-work");
        await expect(field(dialog, "Redirect URI")).toHaveValue(callbackFor(page, "google"));
        await expect(field(dialog, "Client type")).toHaveValue("confidential");
        await expect(dialog.getByTestId("manage-providers-restart-note")).toHaveText(COPY.restartNote);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeHidden();
        expect(writes, "browsing the form sends nothing").toEqual([]);
      });

      await test.step("with both lists empty, the panel reads its empty state and still offers Add provider", async () => {
        // Unreachable on any lane, which always serves #2301's registrations.
        await page.route("**/api/v1/connections/oauth/registrations**", (route) =>
          route.request().method() === "GET" ? route.fulfill({ json: { registrations: [] } }) : route.fallback(),
        );
        const reopened = await openPanel(page);
        await expect(reopened.getByText(COPY.empty, { exact: true })).toBeVisible();
        await expect(reopened.getByRole("table")).toHaveCount(0);
        await expect(reopened.getByTestId("manage-providers-add")).toBeEnabled();
      });
    },
  );

  test(
    "the form catches five mistakes before sending anything",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      const writes = recordWrites(page);
      const panel = await openPanel(page);
      await expect(rowOf(panel, UNTOUCHED_ENV[0].id)).toBeVisible({ timeout: 30000 });
      await panel.getByTestId("manage-providers-add").click();
      const dialog = page.getByRole("dialog", { name: "Add provider" });
      await expect(dialog).toBeVisible();
      const save = dialog.getByTestId("manage-providers-save");

      async function expectRefused(message: string) {
        await save.click();
        await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
        await expect(dialog).toBeVisible();
      }

      await test.step("an invalid registration ID", async () => {
        await field(dialog, "Registration ID").fill("Bad ID");
        await expectRefused(COPY.errors.id);
      });

      await test.step("an ID already in the table, the environment's included", async () => {
        await field(dialog, "Registration ID").fill(UNTOUCHED_ENV[0].id);
        await expectRefused(COPY.errors.idTaken(UNTOUCHED_ENV[0].id));
      });

      await test.step("no client ID", async () => {
        await field(dialog, "Registration ID").fill(uniqueRegistrationId("form"));
        await expect(field(dialog, "Client ID")).toHaveValue("");
        await expectRefused(COPY.errors.required);
      });

      await test.step("a confidential client with no secret", async () => {
        await field(dialog, "Client ID").fill("e2e-form-client");
        await expectRefused(COPY.errors.secret);
      });

      await test.step("Microsoft 365 with no tenant", async () => {
        await field(dialog, "Provider").selectOption("microsoft");
        await expect(dialog.getByLabel("Tenant", { exact: true })).toHaveAttribute("placeholder", MICROSOFT_TENANT_EXAMPLE);
        await field(dialog, "Client ID").fill("e2e-form-client");
        await field(dialog, "Client secret").fill(secretSentinel("form"));
        await expectRefused(COPY.errors.tenant);
      });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(writes, "no mistake reached the server").toEqual([]);
    },
  );

  test(
    "a saved registration shows its status and saver, Replace keeps the secret, and Remove deletes it",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      const id = uniqueRegistrationId("panel");
      const clientSecret = secretSentinel("client");
      const signingSecret = secretSentinel("signing");
      const seeded = slackBotRegistration({
        clientId: `e2e-client-${id}`,
        scopes: ["chat:write", "users:read"],
        clientSecret,
        signingSecret,
      });
      await seed(request, id, seeded);
      const panel = await openPanel(page);
      const row = rowOf(panel, id);

      await test.step("the row reads its provider, the pending status with its hint, and the saver", async () => {
        await expectRow(row, [id, "slack", COPY.pending, owner.username]);
        await expect(row.getByRole("button", { name: "Replace" })).toBeVisible();
        await expect(row.getByRole("button", { name: "Remove" })).toBeVisible();
        await row.getByRole("cell").nth(2).locator("[tabindex='0']").hover();
        await expect(page.getByRole("tooltip")).toHaveText(COPY.pendingHint);
        await page.mouse.move(0, 0, { steps: 5 });
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(clientSecret);
        expect(html).not.toContain(signingSecret);
      });

      const dialog = page.getByRole("dialog", { name: `Replace ${id}` });

      await test.step("Replace shows the saved values, with the provider and ID locked and the secret blank", async () => {
        await row.getByRole("button", { name: "Replace" }).click();
        await expect(dialog).toBeVisible();
        await expect(field(dialog, "Provider")).toBeDisabled();
        await expect(field(dialog, "Provider")).toHaveValue("slack");
        await expect(field(dialog, "Registration ID")).toBeDisabled();
        await expect(field(dialog, "Registration ID")).toHaveValue(id);
        await expect(field(dialog, "Client ID")).toHaveValue(String(seeded.client_id));
        await expect(field(dialog, "Client secret")).toHaveValue("");
        await expect(field(dialog, "Client secret")).toHaveAttribute("placeholder", COPY.secretKeep);
        await expect(field(dialog, "Redirect URI")).toHaveValue(String(seeded.redirect_uri));
        await expect(field(dialog, "Scopes (comma-separated)")).toHaveValue("chat:write, users:read");
      });

      const replacedClient = `e2e-client-v2-${id}`;

      await test.step("saving a new client ID keeps the secret and the hidden fields, and the saver follows", async () => {
        await field(dialog, "Client ID").fill(replacedClient);
        const put = page.waitForResponse(
          (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === `${SAVED_REGISTRATIONS}/${id}`,
        );
        await dialog.getByTestId("manage-providers-save").click();
        const response = await put;
        expect(response.status()).toBe(204);
        const sent = (response.request().postDataJSON() as { registration: Record<string, unknown> }).registration;
        expect(sent).toMatchObject({ client_id: replacedClient, profile: "bot", provider: "slack" });
        expect(sent, "a blank secret is not sent, so the saved one is kept").not.toHaveProperty("client_secret");
        await expect(page.getByText(COPY.savedToast, { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        const entry = (await listSavedRegistrations(request, owner.headers)).registrations.find((item) => item.id === id);
        expect(entry).toMatchObject({
          registration: { client_id: replacedClient },
          has_secret: true,
          saved_by: superUsername,
          status: "pending",
        });
        await expect(row.getByRole("cell").nth(3)).toHaveText(superUsername);
      });

      await test.step("Remove deletes it with no confirmation, and it leaves the table and both server lists", async () => {
        const removed = page.waitForResponse(
          (res) => res.request().method() === "DELETE" && new URL(res.url()).pathname === `${SAVED_REGISTRATIONS}/${id}`,
        );
        await row.getByRole("button", { name: "Remove" }).click();
        expect((await removed).status()).toBe(204);
        await expect(page.getByText(COPY.removedToast, { exact: true })).toBeVisible();
        await expect(row).toHaveCount(0);
        const savedList = await listSavedRegistrations(request, owner.headers);
        expect(savedList.registrations.map((item) => item.id)).not.toContain(id);
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.map((item) => item.id)).not.toContain(id);
      });
    },
  );

  test(
    "an environment ID saved here reads Not in use",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page, request }) => {
      await seed(
        request,
        ENV_USER,
        slackBotRegistration({ clientId: `e2e-override-${uniqueRegistrationId("ovr")}`, clientSecret: secretSentinel("ovr") }),
      );
      const panel = await openPanel(page);
      const row = rowOf(panel, ENV_USER);
      await expectRow(row, [ENV_USER, "slack", COPY.overridden, owner.username]);
      await expect(row.getByRole("button", { name: "Replace" })).toBeVisible();
      await expect(row.getByRole("button", { name: "Remove" })).toBeVisible();
    },
  );

  test(
    "Add provider saves a Slack registration (declared failing: the form sends the manifest's auth profile id)",
    { tag: ["@stable", "@integrations", "@settings", "@ui-ux"] },
    async ({ page }) => {
      const panel = await openPanel(page);
      await expect(rowOf(panel, UNTOUCHED_ENV[0].id)).toBeVisible({ timeout: 30000 });
      await panel.getByTestId("manage-providers-add").click();
      const dialog = page.getByRole("dialog", { name: "Add provider" });
      await expect(dialog).toBeVisible();
      const id = uniqueRegistrationId("add");
      saved.push(id);

      await test.step("choosing Slack prefills its ID and callback", async () => {
        await field(dialog, "Provider").selectOption("slack");
        await expect(field(dialog, "Registration ID")).toHaveValue("slack-work");
        await expect(field(dialog, "Redirect URI")).toHaveValue(callbackFor(page, "slack"));
        await field(dialog, "Registration ID").fill(id);
        await field(dialog, "Client ID").fill(`e2e-client-${id}`);
        await field(dialog, "Client secret").fill(secretSentinel("add"));
      });

      // From here the defect decides. The form sends the manifest's auth profile ID
      // (`slack-user-oauth`) as `profile`, which `OAuthRegistration` refuses with 422
      // "OAuth registration field 'profile' is invalid." (measured on 1.14.0.dev28,
      // REGRESSIONS.md › Candidates). The 422 IS the defect, so it is not reported.
      // When this starts passing, upstream fixed it: drop test.fail() and allowHttpErrors().
      (page as PageWithErrorHooks).allowHttpErrors();
      test.fail(true, "#2421: Manage providers sends profile 'slack-user-oauth' for Slack and the save is refused (422)");

      await test.step("Save stores it, and the row reads pending", async () => {
        const put = page.waitForResponse(
          (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === `${SAVED_REGISTRATIONS}/${id}`,
        );
        await dialog.getByTestId("manage-providers-save").click();
        const response = await put;
        expect(response.status(), await response.text()).toBe(204);
        await expect(page.getByText(COPY.savedToast, { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        await expectRow(rowOf(panel, id), [id, "slack", COPY.pending, superUsername]);
      });
    },
  );
});
