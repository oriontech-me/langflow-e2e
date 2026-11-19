import type { APIRequestContext } from "@playwright/test";
import sites from "../../../../../scripts/lib/fake-integration-sites.json";
import registrations from "../../../../../scripts/lib/fake-oauth-registrations.json";
import { expect, test } from "../../../../fixtures/fixtures";
import { type ConnectionRead, createConnectionViaApi } from "../../../../helpers/integrations/create-connection";
import { sendOAuthCallback, startOAuth, untilNotRateLimited } from "../../../../helpers/integrations/oauth-callback";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import {
  type RegistrationsOwner,
  createRegistrationsOwner,
  listActiveRegistrations,
  putSavedRegistration,
  removeSavedRegistration,
  uniqueRegistrationId,
} from "../../../../helpers/integrations/saved-oauth-registrations";

// OAuth for the four site-bound providers, through the API (#2499).
// Spec doc: docs/api/connections/api-connections-oauth-site-bound.md
//
// Needs #2498's fake deployment sites and registrations. One throwaway user,
// promoted to superuser (Manage providers is superuser-only), owns this file's rows
// and saved registrations, so it spends that user's buckets — starts are 5 per
// minute per user — and never the shared superuser's. Nothing here sends a `code`:
// that would reach the providers' real token hosts.

test.describe("Connections API — OAuth for the site-bound providers", () => {
  const COLLECTION = "/api/v1/connections";
  const REGISTRATIONS = `${COLLECTION}/oauth/registrations`;
  const SAVED = `${REGISTRATIONS}/saved`;
  const PROVIDERS_SINCE = "1.14.0.dev23";
  /** What each registration requires, measured on 1.14.0.dev32. */
  const REQUIRED: Record<string, string[]> = {
    jira: ["offline_access"],
    confluence: ["offline_access"],
    salesforce: ["api", "id", "refresh_token"],
    servicenow: ["langflow_table_read"],
  };
  const SITE_BOUND = Object.keys(REQUIRED);
  /** The site each provider reads, and one it does not. */
  const SITE: Record<string, { configured: string; other: string }> = {
    jira: { configured: sites.LANGFLOW_JIRA_CLOUD_ID, other: "00000000-0000-4000-8000-0000000e2e99" },
    confluence: { configured: sites.LANGFLOW_CONFLUENCE_CLOUD_ID, other: "00000000-0000-4000-8000-0000000e2e98" },
    salesforce: { configured: sites.LANGFLOW_SALESFORCE_ORIGIN, other: "https://other-e2e.my.salesforce.com" },
    servicenow: { configured: sites.LANGFLOW_SERVICENOW_ORIGIN, other: "https://other-e2e.service-now.com" },
  };
  /** Each adapter's refusal of a registration bound elsewhere, measured on 1.14.0.dev32. */
  const OFF_SITE: Record<string, string> = {
    jira: "Jira requires a confidential OAuth registration bound to the configured site and scopes.",
    confluence: "Confluence requires a confidential registration bound to the configured site and scopes.",
    salesforce: "Salesforce requires a confidential registration bound to the configured org and scopes.",
    servicenow: "ServiceNow requires a confidential registration bound to its configured instance and scopes.",
  };
  const CALLBACK_FAILED = "OAuth authorization failed. Return to connections and start again.";

  interface ServedRegistration {
    id: string;
    provider: string;
    profile: string;
    context: string;
    client_type: string;
    scopes: string[];
    required_scopes: string[];
  }

  let owner: RegistrationsOwner;
  const saved: string[] = [];

  test.beforeAll(async ({ request, playwright }, testInfo) => {
    owner = await createRegistrationsOwner(
      request,
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "oauthsite",
    );
  });

  test.afterAll(async () => {
    // Deleting the user takes its connections with it.
    await owner?.dispose();
  });

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, PROVIDERS_SINCE)),
      `Jira, Confluence, Salesforce and ServiceNow are all served from ${PROVIDERS_SINCE}`,
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of saved.splice(0)) {
      await removeSavedRegistration(request, owner.headers, id).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every registration this test saved is removed").toEqual([]);
  });

  const sorted = (items: string[]) => [...items].sort();

  /** The canonical fake registration of a provider (#2498). */
  function canonical(id: string): { client_id: string; redirect_uri: string; scopes: string[] } {
    const registration = (registrations as Record<string, { client_id: string; redirect_uri: string; scopes: string[] }>)[`e2e-${id}`];
    expect(registration, `scripts/lib/fake-oauth-registrations.json has e2e-${id}`).toBeDefined();
    return registration;
  }

  async function readRow(request: APIRequestContext, id: string): Promise<ConnectionRead> {
    const { result: res } = await untilNotRateLimited(
      "the test's connection list read",
      () => request.get(COLLECTION, { headers: owner.headers }),
      (res) => res.status(),
    );
    expect(res.status(), await res.text()).toBe(200);
    const row = ((await res.json()) as ConnectionRead[]).find((item) => item.id === id);
    expect(row, `connection ${id} is listed`).toBeDefined();
    return row!;
  }

  async function pending(request: APIRequestContext, provider: string): Promise<string> {
    const { id, connection } = await createConnectionViaApi(request, owner.headers, {
      label: `oauthsite_${provider}`,
      providerKey: provider,
      identity: "user_delegated",
      credentials: null,
    });
    expect(connection.status).toBe("pending");
    return id;
  }

  test(
    "the four site-bound registrations are served, self-managed and confidential, with their required scopes",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${REGISTRATIONS}`]);
      const res = await request.get(REGISTRATIONS, { headers: owner.headers });
      expect(res.status(), await res.text()).toBe(200);
      const served = ((await res.json()) as { registrations: ServedRegistration[] }).registrations;
      for (const id of SITE_BOUND) {
        const registration = served.find((item) => item.id === `e2e-${id}`);
        expect(registration, `e2e-${id} is served — #2498's site and registration`).toBeDefined();
        expect(registration).toMatchObject({ provider: id, profile: "user", context: "self_managed", client_type: "confidential" });
        expect(sorted(registration!.scopes), `e2e-${id}'s scopes`).toEqual(sorted(canonical(id).scopes));
        expect(sorted(registration!.required_scopes), `e2e-${id}'s required scopes`).toEqual(sorted(REQUIRED[id]));
      }
    },
  );

  test(
    "a start that leaves out a required scope is refused, naming it, and the row stays pending",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/oauth/start`,
        `GET ${COLLECTION}`,
      ]);
      const cases = [
        {
          provider: "servicenow",
          scopes: ["langflow_table_write"],
          detail: "Requested scopes must include langflow_table_read for this connection.",
        },
        { provider: "salesforce", scopes: ["api"], detail: "Requested scopes must include id, refresh_token for this connection." },
      ];
      for (const { provider, scopes, detail } of cases) {
        await test.step(`${provider} without ${sorted(REQUIRED[provider]).filter((s) => !scopes.includes(s)).join(", ")}`, async () => {
          const id = await pending(request, provider);
          const res = await request.post(`${COLLECTION}/${id}/oauth/start`, {
            headers: owner.headers,
            data: { registration_id: `e2e-${provider}`, scopes },
          });
          const text = await res.text();
          expect(res.status(), text).toBe(400);
          expect((JSON.parse(text) as { detail: string }).detail).toBe(detail);
          expect(await readRow(request, id), "a refused start leaves the row as it was").toMatchObject({
            status: "pending",
            status_reason: null,
            has_credentials: false,
          });
        });
      }
    },
  );

  test(
    "a callback that brings neither a code nor an error marks the row oauth-expired",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/oauth/start`,
        `GET ${COLLECTION}/oauth/{provider}/callback`,
        `GET ${COLLECTION}`,
      ]);
      const id = await pending(request, "servicenow");
      const started = await startOAuth(request, owner.headers, id, {
        registrationId: "e2e-servicenow",
        scopes: REQUIRED.servicenow,
      });
      expect(started.authorizationUrl.origin, "ServiceNow authorizes on the configured site").toBe(sites.LANGFLOW_SERVICENOW_ORIGIN);
      const { response, body } = await sendOAuthCallback(request, {
        provider: "servicenow",
        state: started.state,
        cookie: started.cookie,
      });
      expect(response.status(), body).toBe(400);
      expect(body).toContain(CALLBACK_FAILED);
      expect(await readRow(request, id), "the server records the expired authorization").toMatchObject({
        status: "error",
        status_reason: "oauth-expired",
        has_credentials: false,
      });
    },
  );

  test(
    "Manage providers saves each site-bound registration bound to its site, and refuses one bound elsewhere",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `PUT ${SAVED}/{registration_id}`,
        `DELETE ${SAVED}/{registration_id}`,
        `GET ${REGISTRATIONS}`,
      ]);
      for (const provider of SITE_BOUND) {
        await test.step(`${provider}: on its site 204, elsewhere 422`, async () => {
          const { redirect_uri, scopes } = canonical(provider);
          const registration = (tenant: string, label: string) => ({
            provider,
            client_id: `e2e-fake-saved-${provider}-${label}`,
            client_secret: "e2e-fake-saved-secret",
            tenant,
            redirect_uri,
            scopes,
            // Hosted: never joins the list the dialogs read, so no other spec sees it.
            context: "hosted",
          });

          const onSite = uniqueRegistrationId(`site_${provider}`);
          saved.push(onSite);
          const ok = await putSavedRegistration(request, owner.headers, onSite, registration(SITE[provider].configured, "site"));
          expect(ok.status(), await ok.text()).toBe(204);
          const { registrations: active } = await listActiveRegistrations(request, owner.headers, provider);
          expect(active.map((item) => item.id), "a hosted registration stays out of the active list").not.toContain(onSite);

          const offSite = uniqueRegistrationId(`other_${provider}`);
          saved.push(offSite);
          const refused = await putSavedRegistration(request, owner.headers, offSite, registration(SITE[provider].other, "other"));
          const text = await refused.text();
          expect(refused.status(), text).toBe(422);
          expect((JSON.parse(text) as { detail: string }).detail).toBe(OFF_SITE[provider]);
        });
      }
    },
  );
});
