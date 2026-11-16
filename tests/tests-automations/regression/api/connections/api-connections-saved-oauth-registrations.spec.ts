import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import { type CreatedConnection, createConnectionViaApi } from "../../../../helpers/integrations/create-connection";
import { startOAuth } from "../../../../helpers/integrations/oauth-callback";
import {
  createRegistrationsOwner,
  listActiveRegistrations,
  listSavedRegistrations,
  MANAGE_PROVIDERS_SINCE,
  putSavedRegistration,
  REGISTRATION_VARIABLE_PREFIX,
  type RegistrationsOwner,
  removeSavedRegistration,
  SAVED_REGISTRATIONS,
  type SavedRegistrationRead,
  secretSentinel,
  SLACK_CALLBACK,
  slackBotRegistration,
  uniqueRegistrationId,
} from "../../../../helpers/integrations/saved-oauth-registrations";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import registrations from "../../../../../scripts/lib/fake-oauth-registrations.json";

// OAuth registrations saved from Settings › Connections › Manage providers (#2421).
// Spec doc: docs/api/connections/api-connections-saved-oauth-registrations.md
//
// A saved registration is instance-wide, so every one this file saves is a Slack
// `bot` registration with an ID of its own, a pair no other spec reads, removed
// through the API in `finally`. The one exception is test 6's Slack `user`
// registration, saved as `hosted`, which this `self_managed` instance never lists
// (#2452). One worker, so one throwaway superuser per run.
test.describe.configure({ mode: "default" });

const COLLECTION = "/api/v1/connections";
const ACTIVE = `${COLLECTION}/oauth/registrations`;
const SAVED_ITEM = `${SAVED_REGISTRATIONS}/{registration_id}`;
const OPS = {
  listSaved: `GET ${SAVED_REGISTRATIONS}`,
  save: `PUT ${SAVED_ITEM}`,
  remove: `DELETE ${SAVED_ITEM}`,
  listActive: `GET ${ACTIVE}`,
  create: `POST ${COLLECTION}`,
  start: `POST ${COLLECTION}/{connection_id}/oauth/start`,
  listVariables: "GET /api/v1/variables/",
  createVariable: "POST /api/v1/variables/",
};
/** The environment registration test 3 overrides; the UI spec overrides `e2e-slack-user`. */
const ENV_BOT = "e2e-slack-bot";
const ENTRY_KEYS = ["has_secret", "id", "registration", "saved_by", "status", "updated_at"];

/** A copy of `registration` without `keys`. */
function without(registration: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(registration).filter(([key]) => !keys.includes(key)));
}
/** Exact copy, measured on 1.14.0.dev28. */
const COPY = {
  notConfigured: "OAuth registration ID is not configured.",
  notFound: "Saved OAuth registration not found.",
  forbidden: "The user doesn't have enough privileges",
  reservedVariable: "OAuth registrations must be managed from Connections settings.",
};

test.describe("Connections — saved OAuth registrations (Manage providers API)", () => {
  let owner: RegistrationsOwner;
  const saved: string[] = [];
  const rows: CreatedConnection[] = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    test.skip(
      !(await servedVersionAtLeast(request, MANAGE_PROVIDERS_SINCE)),
      `saved OAuth registrations ship from ${MANAGE_PROVIDERS_SINCE} (langflow-ai/langflow#16251)`,
    );
    owner = await createRegistrationsOwner(
      request,
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "savedreg",
    );
  });

  test.afterEach(async ({ request }) => {
    // Registrations first, through the API: deleting the owner instead would leave
    // them in use by the process until the next save (see the helper).
    const failures: string[] = [];
    for (const id of saved.splice(0)) {
      await removeSavedRegistration(request, owner.headers, id).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every registration and connection this test created is removed").toEqual([]);
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  function newId(label: string): string {
    const id = uniqueRegistrationId(label);
    saved.push(id);
    return id;
  }

  async function savedEntry(request: APIRequestContext, id: string): Promise<SavedRegistrationRead | undefined> {
    return (await listSavedRegistrations(request, owner.headers)).registrations.find((entry) => entry.id === id);
  }

  async function slackBotConnection(request: APIRequestContext, label: string): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, {
      label: `savedreg_${label}`,
      providerKey: "slack",
      identity: "bot",
      credentials: null,
    });
    rows.push(row);
    return row;
  }

  test(
    "a saved registration is listed without its secrets, used by the next consent at once, replaced with its secret kept, and removed",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([OPS.listSaved, OPS.save, OPS.remove, OPS.listActive, OPS.create, OPS.start]);
      const id = newId("lifecycle");
      const clientSecret = secretSentinel("client");
      const signingSecret = secretSentinel("signing");
      const first = slackBotRegistration({ clientId: `e2e-client-${id}`, clientSecret, signingSecret });
      const row = await slackBotConnection(request, "lifecycle");

      await test.step("the ID is in neither list before the save", async () => {
        expect(await savedEntry(request, id)).toBeUndefined();
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.map((item) => item.id)).not.toContain(id);
      });

      const before = await test.step("the save answers 204, and the entry carries six keys and no secret", async () => {
        const res = await putSavedRegistration(request, owner.headers, id, first);
        expect(res.status(), await res.text()).toBe(204);
        const list = await listSavedRegistrations(request, owner.headers);
        expect(list.response.headers()["cache-control"]).toBe("no-store");
        expect(list.text).not.toContain(clientSecret);
        expect(list.text).not.toContain(signingSecret);
        const entries = list.registrations.filter((entry) => entry.id === id);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
        expect(entry.registration).toEqual(without(first, "client_secret", "signing_secret"));
        expect(entry).toMatchObject({ has_secret: true, saved_by: owner.username, status: "pending" });
        expect(entry.updated_at).not.toBeNull();
        return entry;
      });

      await test.step("the wizard's registration list offers it at once, as a Slack bot registration", async () => {
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        const listed = active.registrations.find((item) => item.id === id);
        expect(listed, `GET ${ACTIVE}?provider=slack carries ${id}`).toBeDefined();
        expect(listed).toMatchObject({ provider: "slack", profile: "bot", scopes: first.scopes });
        expect(active.text).not.toContain(clientSecret);
      });

      await test.step("a new connection's consent starts with the saved client and redirect", async () => {
        const started = await startOAuth(request, owner.headers, row.id, { registrationId: id, scopes: ["chat:write"] });
        expect(started.authorizationUrl.searchParams.get("client_id")).toBe(first.client_id);
        expect(started.authorizationUrl.searchParams.get("redirect_uri")).toBe(SLACK_CALLBACK);
      });

      const second = slackBotRegistration({ clientId: `e2e-client-v2-${id}`, scopes: ["chat:write", "users:read"] });

      await test.step("a replace with no secret is accepted, so the saved secret was kept", async () => {
        // Confidential with no secret is refused (test 2): a 204 here means the
        // server carried the saved one over.
        const res = await putSavedRegistration(request, owner.headers, id, second);
        expect(res.status(), await res.text()).toBe(204);
        const entry = await savedEntry(request, id);
        expect(entry?.registration).toEqual(second);
        expect(entry).toMatchObject({ has_secret: true, saved_by: owner.username, status: "pending" });
        expect(new Date(entry!.updated_at!).getTime()).toBeGreaterThan(new Date(before.updated_at!).getTime());
      });

      await test.step("the next consent starts with the replaced client", async () => {
        const started = await startOAuth(request, owner.headers, row.id, { registrationId: id, scopes: ["chat:write"] });
        expect(started.authorizationUrl.searchParams.get("client_id")).toBe(second.client_id);
      });

      await test.step("a removal takes it out of both lists and out of consent; a second one finds nothing", async () => {
        const res = await request.delete(`${SAVED_REGISTRATIONS}/${id}`, { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(204);
        expect(await savedEntry(request, id)).toBeUndefined();
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.map((item) => item.id)).not.toContain(id);
        const start = await request.post(`${COLLECTION}/${row.id}/oauth/start`, {
          headers: owner.headers,
          data: { registration_id: id, scopes: ["chat:write"] },
        });
        expect(start.status(), await start.text()).toBe(400);
        expect(await start.json()).toEqual({ detail: COPY.notConfigured });
        const again = await request.delete(`${SAVED_REGISTRATIONS}/${id}`, { headers: owner.headers });
        expect(again.status()).toBe(404);
        expect(await again.json()).toEqual({ detail: COPY.notFound });
      });
    },
  );

  test(
    "an invalid registration is refused with a message that names the problem, and never echoes what was sent",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([OPS.save, OPS.listSaved]);
      const id = newId("invalid");
      const secret = secretSentinel("invalid");
      const valid = slackBotRegistration({ clientId: `e2e-client-${id}`, clientSecret: secret });
      const refusals: Array<{ name: string; registration: Record<string, unknown>; detail: string }> = [
        {
          name: "a confidential client with no secret",
          registration: slackBotRegistration({ clientId: `e2e-client-${id}` }),
          detail: "Confidential clients require exactly one secret or private key",
        },
        {
          name: "a redirect URI that is not the provider callback",
          registration: { ...valid, redirect_uri: "https://e2e.invalid/oauth/callback" },
          detail: "OAuth redirect must be HTTPS (or loopback HTTP) at the provider callback",
        },
        {
          name: "no client_id",
          registration: without(valid, "client_id"),
          detail: "OAuth registration field 'client_id' is required.",
        },
        {
          name: "Microsoft with no tenant",
          registration: {
            provider: "microsoft",
            client_id: `e2e-client-${id}`,
            client_secret: secret,
            redirect_uri: "http://localhost/api/v1/connections/oauth/microsoft/callback",
            scopes: ["Mail.Read"],
          },
          detail: "Microsoft OAuth requires a fixed tenant UUID",
        },
        {
          name: "a field the registration does not define",
          registration: { ...valid, e2e_unknown_field: secret },
          detail: "OAuth registration contains unsupported fields.",
        },
        {
          name: "an empty scopes list",
          registration: { ...valid, scopes: [] },
          detail: "OAuth registration field 'scopes' is invalid.",
        },
      ];

      for (const refusal of refusals) {
        await test.step(`${refusal.name} → 422 "${refusal.detail}"`, async () => {
          const res = await putSavedRegistration(request, owner.headers, id, refusal.registration);
          const text = await res.text();
          expect(res.status(), text).toBe(422);
          expect(JSON.parse(text)).toEqual({ detail: refusal.detail });
          expect(text, "the refusal does not echo the secret or the unknown field's value").not.toContain(secret);
        });
      }

      await test.step("an ID outside the pattern is refused at the path", async () => {
        const res = await putSavedRegistration(request, owner.headers, "Bad_ID", valid);
        const text = await res.text();
        expect(res.status(), text).toBe(422);
        const detail = (JSON.parse(text) as { detail: Array<{ type: string; loc: string[] }> }).detail;
        expect(detail.map(({ type, loc }) => ({ type, loc }))).toEqual([
          { type: "string_pattern_mismatch", loc: ["path", "registration_id"] },
        ]);
        expect(text).not.toContain(secret);
      });

      await test.step("a key beside the registration in the body is refused, without its value", async () => {
        const res = await request.put(`${SAVED_REGISTRATIONS}/${id}`, {
          headers: owner.headers,
          data: { registration: valid, e2e_extra_key: secret },
        });
        const text = await res.text();
        expect(res.status(), text).toBe(422);
        const detail = (JSON.parse(text) as { detail: Array<{ type: string; loc: string[]; msg: string }> }).detail;
        expect(detail.map(({ type, loc, msg }) => ({ type, loc, msg }))).toEqual([
          { type: "extra_forbidden", loc: ["body", "e2e_extra_key"], msg: "Extra inputs are not permitted" },
        ]);
        expect(text, "the refusal does not echo the extra key's value").not.toContain(secret);
      });

      await test.step("nothing was saved", async () => {
        expect(await savedEntry(request, id)).toBeUndefined();
      });
    },
  );

  test(
    "an ID the server environment defines stays the environment's: saved as overridden, not used, and removable without touching it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([OPS.save, OPS.listSaved, OPS.listActive, OPS.create, OPS.start, OPS.remove]);
      const environment = registrations[ENV_BOT];
      const row = await slackBotConnection(request, "override");

      const envListed = await test.step("the registration list serves the environment's e2e-slack-bot", async () => {
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        const listed = active.registrations.find((item) => item.id === ENV_BOT);
        expect(listed, `#2301's fake registrations are served (${ENV_BOT})`).toBeDefined();
        expect(listed!.scopes).toEqual(environment.scopes);
        return listed!;
      });

      saved.push(ENV_BOT);
      const override = slackBotRegistration({
        clientId: `e2e-override-${uniqueRegistrationId("ovr")}`,
        clientSecret: secretSentinel("override"),
      });

      await test.step("saving the same ID is accepted and reads overridden", async () => {
        const res = await putSavedRegistration(request, owner.headers, ENV_BOT, override);
        expect(res.status(), await res.text()).toBe(204);
        expect(await savedEntry(request, ENV_BOT)).toMatchObject({
          status: "overridden",
          saved_by: owner.username,
          registration: { client_id: override.client_id },
        });
      });

      await test.step("the instance still uses the environment's: its scopes, and its client in consent", async () => {
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.find((item) => item.id === ENV_BOT)).toEqual(envListed);
        const started = await startOAuth(request, owner.headers, row.id, {
          registrationId: ENV_BOT,
          scopes: ["chat:write"],
        });
        expect(started.authorizationUrl.searchParams.get("client_id")).toBe(environment.client_id);
      });

      await test.step("removing the saved copy leaves the environment's registration as it was", async () => {
        const res = await request.delete(`${SAVED_REGISTRATIONS}/${ENV_BOT}`, { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(204);
        expect(await savedEntry(request, ENV_BOT)).toBeUndefined();
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.find((item) => item.id === ENV_BOT)).toEqual(envListed);
      });
    },
  );

  test(
    "a saved registration's secrets reach no read, and its storage cannot be written as a global variable",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([OPS.save, OPS.listSaved, OPS.listActive, OPS.listVariables, OPS.createVariable]);
      const id = newId("secrets");
      const clientSecret = secretSentinel("client");
      const signingSecret = secretSentinel("signing");
      const registration = slackBotRegistration({ clientId: `e2e-client-${id}`, clientSecret, signingSecret });

      await test.step("save a registration carrying both secrets", async () => {
        const res = await putSavedRegistration(request, owner.headers, id, registration);
        expect(res.status(), await res.text()).toBe(204);
      });

      await test.step("neither secret is in the saved list or the registration list", async () => {
        const list = await listSavedRegistrations(request, owner.headers);
        expect(list.registrations.map((entry) => entry.id)).toContain(id);
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.map((item) => item.id)).toContain(id);
        for (const text of [list.text, active.text]) {
          expect(text).not.toContain(clientSecret);
          expect(text).not.toContain(signingSecret);
        }
      });

      await test.step("the saver's global variables list neither the storage row nor a secret", async () => {
        const res = await request.get("/api/v1/variables/", { headers: owner.headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        const names = (JSON.parse(text) as Array<{ name: string }>).map((variable) => variable.name);
        expect(names.filter((name) => name.startsWith(REGISTRATION_VARIABLE_PREFIX))).toEqual([]);
        expect(text).not.toContain(clientSecret);
        expect(text).not.toContain(signingSecret);
      });

      await test.step("the storage name is refused as a new variable, and the registration is unchanged", async () => {
        const res = await request.post("/api/v1/variables/", {
          headers: owner.headers,
          data: { name: `${REGISTRATION_VARIABLE_PREFIX}${id}`, value: "{}", type: "Credential", default_fields: [] },
        });
        expect(res.status(), await res.text()).toBe(422);
        expect(await res.json()).toEqual({ detail: COPY.reservedVariable });
        expect(await savedEntry(request, id)).toMatchObject({
          registration: { client_id: registration.client_id },
          has_secret: true,
        });
      });
    },
  );

  test(
    "a regular user is refused on all three routes and changes nothing",
    { tag: ["@stable", "@api", "@integrations", "@auth"] },
    async ({ playwright, request, apiCoverage }, testInfo) => {
      apiCoverage.declare([OPS.save, OPS.listSaved, OPS.remove, OPS.createVariable]);
      const id = newId("refused");
      const registration = slackBotRegistration({ clientId: `e2e-client-${id}`, clientSecret: secretSentinel("refused") });
      const res = await putSavedRegistration(request, owner.headers, id, registration);
      expect(res.status(), await res.text()).toBe(204);
      const before = await savedEntry(request, id);

      const superHeaders = { Authorization: await getAuthToken(request) };
      let user: ThrowawayUser | undefined;
      try {
        user = await createThrowawayUser(request, {
          superHeaders,
          newContext: () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
          prefix: "savedregreg",
          track: (created) => {
            user = created;
          },
        });
        const regular = user.headers;

        await test.step("listing, saving and removing each answer 403", async () => {
          const attempts = [
            await request.get(SAVED_REGISTRATIONS, { headers: regular }),
            await putSavedRegistration(request, regular, id, slackBotRegistration({
              clientId: "e2e-regular-user",
              clientSecret: secretSentinel("regular"),
            })),
            await request.delete(`${SAVED_REGISTRATIONS}/${id}`, { headers: regular }),
          ];
          for (const attempt of attempts) {
            expect(attempt.status(), `${attempt.url()}: ${await attempt.text()}`).toBe(403);
            expect(await attempt.json()).toEqual({ detail: COPY.forbidden });
          }
        });

        await test.step("the storage name is refused to a regular user's variables too", async () => {
          const created = await request.post("/api/v1/variables/", {
            headers: regular,
            data: { name: `${REGISTRATION_VARIABLE_PREFIX}${id}`, value: "{}", type: "Credential", default_fields: [] },
          });
          expect(created.status(), await created.text()).toBe(422);
          expect(await created.json()).toEqual({ detail: COPY.reservedVariable });
        });

        await test.step("the registration is still saved, unchanged", async () => {
          expect(await savedEntry(request, id)).toEqual(before);
        });
      } finally {
        if (user) await deleteThrowawayUser(request, superHeaders, user);
      }
    },
  );

  test(
    "a saved secret is carried into a replace, and only null clears it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([OPS.save, OPS.listSaved, OPS.listActive]);
      const id = newId("nullclear");
      // Slack `user`, because a bot client cannot be public; `hosted`, because this
      // instance is `self_managed`, so the registration never joins the list the
      // connection wizard reads.
      const confidential: Record<string, unknown> = {
        provider: "slack",
        profile: "user",
        client_id: `e2e-client-${id}`,
        redirect_uri: SLACK_CALLBACK,
        scopes: ["search:read"],
        context: "hosted",
        owner: "langflow",
      };
      const notListed = async () => {
        const active = await listActiveRegistrations(request, owner.headers, "slack");
        expect(active.registrations.map((item) => item.id), `a hosted registration stays out of ${ACTIVE}`).not.toContain(
          id,
        );
      };
      const refused = async (registration: Record<string, unknown>, detail: string) => {
        const res = await putSavedRegistration(request, owner.headers, id, registration);
        const text = await res.text();
        expect(res.status(), text).toBe(422);
        expect(JSON.parse(text)).toEqual({ detail });
      };

      await test.step("a confidential user registration is saved with its secret, and is not listed", async () => {
        const res = await putSavedRegistration(request, owner.headers, id, {
          ...confidential,
          client_secret: secretSentinel("nullclear"),
        });
        expect(res.status(), await res.text()).toBe(204);
        const entry = await savedEntry(request, id);
        expect(entry?.has_secret).toBe(true);
        expect(entry?.registration).toEqual(confidential);
        await notListed();
      });

      await test.step("null on a confidential client is refused: its secret can be replaced, never removed", async () => {
        await refused({ ...confidential, client_secret: null }, "Confidential clients require exactly one secret or private key");
        expect((await savedEntry(request, id))?.has_secret).toBe(true);
      });

      await test.step("a switch to public without the field is refused: the saved secret was carried into it", async () => {
        await refused({ ...confidential, client_type: "public" }, "Public clients cannot contain registration secrets");
        const entry = await savedEntry(request, id);
        expect(entry?.has_secret).toBe(true);
        expect(entry?.registration, "the entry is unchanged, still confidential").toEqual(confidential);
      });

      await test.step("the same switch with null clears the secret", async () => {
        const res = await putSavedRegistration(request, owner.headers, id, {
          ...confidential,
          client_type: "public",
          client_secret: null,
        });
        expect(res.status(), await res.text()).toBe(204);
        const entry = await savedEntry(request, id);
        expect(entry?.has_secret).toBe(false);
        expect(entry?.registration).toEqual({ ...confidential, client_type: "public" });
        await notListed();
      });
    },
  );
});
