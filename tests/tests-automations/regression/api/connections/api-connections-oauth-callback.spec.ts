import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";
import {
  OAUTH_FAILURE_BODY,
  OAUTH_RATE_LIMIT_TITLE,
  OAUTH_RESPONSE_HEADERS,
  type CallbackResult,
  sendOAuthCallback,
  startOAuth,
} from "../../../../helpers/integrations/oauth-callback";
import registrations from "../../../../../scripts/lib/fake-oauth-registrations.json";

// The OAuth callback's controls, driven the way a browser would (#2307).
// Spec doc: docs/api/connections/api-connections-oauth-callback.md
//
// Needs #2301's fake registrations on the instance. Serial on purpose: test 3
// exhausts the per-IP callback bucket and the owner's start bucket, so it runs
// last and in the same worker as the rest.
test.describe.configure({ mode: "serial" });

const COLLECTION = "/api/v1/connections";
const CALLBACK = `GET ${COLLECTION}/oauth/{provider}/callback`;
const START = `POST ${COLLECTION}/{connection_id}/oauth/start`;
const GOOGLE = "e2e-google";
const IDENTITY_SCOPES = ["openid", "email"];
/** Exact copy, measured on 1.14.0.dev2: the JSON `429` every other route answers. */
const TOO_MANY = { detail: "Too many requests. Please try again later.", retry_after: "60" };
/** The per-minute default of the login limit both OAuth browser routes fall back to. */
const BROWSER_ROUTE_BUCKET = 5;

/** The fields a callback may change; compared whole, so any other write shows too. */
type RowState = Pick<
  ConnectionRead,
  "status" | "status_reason" | "has_credentials" | "granted_scopes" | "health" | "updated_at"
>;

test.describe("Connections — the OAuth callback's controls", () => {
  let owner: ConnectionsOwner;
  const rows: CreatedConnection[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connoauth",
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every connection this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  async function plant(
    request: APIRequestContext,
    label: string,
    options: { pending?: boolean; grantedScopes?: string[] } = {},
  ): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, {
      label: `connoauth_${label}`,
      grantedScopes: options.grantedScopes,
      credentials: options.pending ? null : undefined,
    });
    rows.push(row);
    return row;
  }

  async function rowState(request: APIRequestContext, id: string): Promise<RowState> {
    const res = await request.get(COLLECTION, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    const row = ((await res.json()) as ConnectionRead[]).find((item) => item.id === id);
    expect(row, `the owner's list carries ${id}`).toBeDefined();
    const { status, status_reason, has_credentials, granted_scopes, health, updated_at } = row!;
    return { status, status_reason, has_credentials, granted_scopes, health, updated_at };
  }

  function expectOAuthHeaders(response: APIResponse) {
    const headers = response.headers();
    for (const [name, value] of Object.entries(OAUTH_RESPONSE_HEADERS)) {
      expect(headers[name], `${response.url()} carries ${name}`).toBe(value);
    }
  }

  /** Every refused callback: the same 400 page, whatever the cause. */
  function expectFailurePage({ response, body }: CallbackResult) {
    expect(response.status(), body).toBe(400);
    expect(response.headers()["content-type"]).toMatch(/^text\/html/);
    expect(body).toBe(OAUTH_FAILURE_BODY);
    expectOAuthHeaders(response);
  }

  test(
    "a callback without the binding cookie is refused and leaves the state usable, and the state completes neither on another provider's path nor twice",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`, `GET ${COLLECTION}`, START, CALLBACK]);
      const row = await plant(request, "pending", { pending: true });

      const started = await test.step("oauth/start builds Google's authorization URL locally and binds the browser", async () => {
        const started = await startOAuth(request, owner.headers, row.id, {
          registrationId: GOOGLE,
          scopes: IDENTITY_SCOPES,
        });
        const url = started.authorizationUrl;
        expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
        expect(url.searchParams.get("client_id")).toBe(registrations[GOOGLE].client_id);
        expect(new URL(url.searchParams.get("redirect_uri")!).pathname).toBe(`${COLLECTION}/oauth/google/callback`);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("scope")?.split(" ")).toEqual(IDENTITY_SCOPES);
        expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(started.cookie.attributes).toEqual({
          httponly: true,
          "max-age": "600",
          path: `${COLLECTION}/oauth`,
          samesite: "lax",
        });
        expectOAuthHeaders(started.response);
        return started;
      });
      const before = await rowState(request, row.id);
      expect(before).toMatchObject({ status: "pending", status_reason: null, has_credentials: false });

      await test.step("the callback without the cookie is refused and touches nothing", async () => {
        expectFailurePage(
          await sendOAuthCallback(request, {
            provider: "google",
            state: started.state,
            cookie: null,
            query: { error: "access_denied" },
          }),
        );
        expect(await rowState(request, row.id)).toEqual(before);
      });

      const failed = await test.step("the same state and cookie on Slack's path are consumed as a failed authorization", async () => {
        expectFailurePage(
          await sendOAuthCallback(request, {
            provider: "slack",
            state: started.state,
            cookie: started.cookie,
            query: { code: "e2e-fake-code" },
          }),
        );
        // A reason is written only when a callback consumes the state: this is
        // also the proof the cookie-less call above left it usable.
        const after = await rowState(request, row.id);
        expect(after).toMatchObject({ status: "error", status_reason: "oauth-failed", has_credentials: false });
        return after;
      });

      await test.step("the same state and cookie again, on Google's path, are refused and touch nothing", async () => {
        expectFailurePage(
          await sendOAuthCallback(request, {
            provider: "google",
            state: started.state,
            cookie: started.cookie,
            query: { error: "access_denied" },
          }),
        );
        expect(await rowState(request, row.id)).toEqual(failed);
      });
    },
  );

  test(
    "a newer start supersedes the older one, and a denied consent keeps the saved credential",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `GET ${COLLECTION}`,
        START,
        CALLBACK,
        `POST ${COLLECTION}/{connection_id}/health`,
      ]);
      const row = await plant(request, "ready", { grantedScopes: IDENTITY_SCOPES });
      const scopes = { registrationId: GOOGLE, scopes: IDENTITY_SCOPES };

      const older = await startOAuth(request, owner.headers, row.id, scopes);
      const newer = await startOAuth(request, owner.headers, row.id, scopes);
      expect(newer.state).not.toBe(older.state);
      expect(newer.cookie.name).not.toBe(older.cookie.name);
      const before = await rowState(request, row.id);
      expect(before).toMatchObject({ status: "ready", status_reason: null, has_credentials: true });

      await test.step("the older start's state is refused and touches nothing", async () => {
        expectFailurePage(
          await sendOAuthCallback(request, {
            provider: "google",
            state: older.state,
            cookie: older.cookie,
            query: { error: "access_denied" },
          }),
        );
        expect(await rowState(request, row.id)).toEqual(before);
      });

      await test.step("the newer start's denial is recorded, and the credential stays", async () => {
        expectFailurePage(
          await sendOAuthCallback(request, {
            provider: "google",
            state: newer.state,
            cookie: newer.cookie,
            query: { error: "access_denied" },
          }),
        );
        const after = await rowState(request, row.id);
        expect(after).toMatchObject({
          status: "ready",
          status_reason: "oauth-denied",
          has_credentials: true,
          granted_scopes: before.granted_scopes,
        });
        expect(after.updated_at).not.toBe(before.updated_at);
      });

      await test.step("the next health check still reads the saved credential", async () => {
        const res = await request.post(`${COLLECTION}/${row.id}/health`, { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(200);
        expect(await res.json()).toMatchObject({
          status: "ready",
          status_reason: null,
          health: "healthy",
          has_credentials: true,
        });
      });
    },
  );

  test(
    "the OAuth routes a browser reaches answer an HTML 429, and oauth/start answers the JSON one",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`, START, CALLBACK]);

      // Each bucket allows 5 a minute; earlier tests in the same window leave
      // fewer, so the 429 arrives within 6 calls, never later.
      async function untilRefused(send: () => Promise<APIResponse>): Promise<APIResponse[]> {
        const answers: APIResponse[] = [];
        for (let i = 0; i <= BROWSER_ROUTE_BUCKET; i++) {
          const res = await send();
          answers.push(res);
          if (res.status() === 429) break;
        }
        expect(answers.at(-1)!.status(), `a 429 within ${BROWSER_ROUTE_BUCKET + 1} calls`).toBe(429);
        return answers;
      }

      async function expectHtmlRateLimit(answers: APIResponse[]) {
        for (const res of answers.slice(0, -1)) {
          expect(res.status()).toBe(400);
          expect(await res.text()).toBe(OAUTH_FAILURE_BODY);
        }
        const refused = answers.at(-1)!;
        const body = await refused.text();
        expect(refused.headers()["content-type"]).toMatch(/^text\/html/);
        expect(body).toContain(`<title>${OAUTH_RATE_LIMIT_TITLE}</title>`);
        expect(body).toContain(`<h1>${OAUTH_RATE_LIMIT_TITLE}</h1>`);
        expect(refused.headers()["retry-after"]).toBe("60");
        expectOAuthHeaders(refused);
      }

      await test.step("the callback", async () => {
        await expectHtmlRateLimit(
          await untilRefused(async () =>
            (
              await sendOAuthCallback(request, {
                provider: "google",
                state: "e2e-not-a-state",
                cookie: null,
                absorbRateLimit: false,
              })
            ).response,
          ),
        );
      });

      await test.step("the Desktop browser handoff, a bucket of its own", async () => {
        await expectHtmlRateLimit(
          await untilRefused(() =>
            request.get(`${COLLECTION}/oauth/google/browser?state=e2e-not-a-state&handoff=e2e-not-a-handoff`, {
              maxRedirects: 0,
            }),
          ),
        );
      });

      await test.step("oauth/start, limited per user, answers the JSON shape", async () => {
        const row = await plant(request, "start_limit", { pending: true });
        const answers = await untilRefused(() =>
          request.post(`${COLLECTION}/${row.id}/oauth/start`, {
            headers: owner.headers,
            data: { registration_id: GOOGLE, scopes: IDENTITY_SCOPES },
          }),
        );
        for (const res of answers.slice(0, -1)) expect(res.status(), await res.text()).toBe(200);
        const refused = answers.at(-1)!;
        expect(refused.headers()["content-type"]).toMatch(/^application\/json/);
        expect(await refused.json()).toEqual(TOO_MANY);
      });
    },
  );
});
