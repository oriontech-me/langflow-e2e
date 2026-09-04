import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// The five operations of the session and token lifecycle.
// Spec doc: docs/api/auth/api-session-auth-lifecycle.md
//
// TWO findings drive this file. POST /api/v1/logout answers 200 and the SAME bearer
// keeps working afterwards — logout clears cookies, not tokens. And POST
// /api/v1/refresh is COOKIE-driven: it answers 200 for a caller holding
// refresh_token_lf and 401 for one carrying only a bearer, so which context issues
// the call decides the answer.
//
// Budget: OSS rate-limits POST /api/v1/login at 5/min per IP on a FIXED window, so
// this file issues exactly ONE successful login; every other token comes from
// auto_login, and logout/refresh run on a throwaway token so no other spec's
// session is involved.
test.describe("Auth API — session, login, logout and refresh", () => {
  let headers: Record<string, string> = {};
  let anonymous: APIRequestContext;

  test.beforeAll(async ({ request, playwright }) => {
    headers = { Authorization: await getAuthToken(request) };
    anonymous = await playwright.request.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860",
      extraHTTPHeaders: {},
    });
  });

  test.afterAll(async () => {
    await anonymous.dispose();
  });

  test(
    "the session probe answers anonymous and authenticated alike, and says which",
    { tag: ["@stable", "@api", "@auth"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/session"]);

      const anon = await anonymous.get("/api/v1/session");
      // 200, not 401: the anonymous answer is a contract of its own — this is the
      // "who am I" probe the frontend calls before it has a credential.
      expect(anon.status()).toBe(200);
      const anonBody = await anon.json();
      expect(Object.keys(anonBody).sort()).toEqual([
        "authenticated",
        "store_api_key",
        "user",
      ]);

      const authed = await request.get("/api/v1/session", { headers });
      expect(authed.status()).toBe(200);
      const authedBody = await authed.json();
      expect(Object.keys(authedBody).sort()).toEqual([
        "authenticated",
        "store_api_key",
        "user",
      ]);

      // Same envelope, different content: the credential is what fills `user`.
      expect(authedBody).not.toEqual(anonBody);
      expect(authedBody.authenticated).toBe(true);
      expect(authedBody.user, "an authenticated session names its user").toBeTruthy();
      expect(anonBody.authenticated).toBe(false);
    },
  );

  test(
    "login takes a form body and refuses an empty one",
    { tag: ["@stable", "@api", "@auth"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/login", "GET /api/v1/session"]);
      const username = process.env.LANGFLOW_SUPERUSER ?? "langflow";
      const password = process.env.LANGFLOW_SUPERUSER_PASSWORD ?? "langflow123";

      await test.step("the ONE login of this file", async () => {
        // Form-encoded, not JSON — and counted: 5/min per IP, fixed window.
        const res = await request.post("/api/v1/login", {
          form: { username, password },
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual([
          "access_token",
          "refresh_token",
          "token_type",
        ]);
        expect(body.token_type).toBe("bearer");

        // The token is real, not just well-shaped.
        const probe = await request.get("/api/v1/session", {
          headers: { Authorization: `Bearer ${body.access_token}` },
        });
        expect(probe.status()).toBe(200);
        expect((await probe.json()).authenticated).toBe(true);
      });

      await test.step("an empty body is refused on the form fields", async () => {
        const res = await request.post("/api/v1/login", { headers, data: {} });
        expect(res.status()).toBe(422);
        const locs = ((await res.json()).detail as Array<{ loc: string[] }>).map(
          (d) => d.loc.join("."),
        );
        expect(locs.some((loc) => loc.includes("username"))).toBe(true);
      });
    },
  );

  test(
    "logout leaves the access token working, and refresh is cookie-driven",
    { tag: ["@stable", "@api", "@auth"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/auto_login",
        "POST /api/v1/refresh",
        "POST /api/v1/logout",
        "GET /api/v1/all",
      ]);

      // A throwaway token: everything below is issued with it, so no other spec's
      // session is logged out.
      const auto = await request.get("/api/v1/auto_login");
      expect(auto.status(), await auto.text()).toBe(200);
      const tokens = await auto.json();
      expect(Object.keys(tokens).sort()).toEqual([
        "access_token",
        "refresh_token",
        "token_type",
      ]);
      const throwaway = { Authorization: `Bearer ${tokens.access_token}` };

      await test.step("the throwaway token works before anything else happens", async () => {
        const res = await request.get("/api/v1/all", { headers: throwaway });
        expect(res.status()).toBe(200);
      });

      await test.step("refresh is COOKIE-driven: it works with one, and refuses a bare bearer", async () => {
        // The fixture context holds the cookies auto_login set
        // (access_token_lf, refresh_token_lf, apikey_tkn_lflw), so this call is the
        // real refresh path and answers a fresh token pair.
        const res = await request.post("/api/v1/refresh", { headers: throwaway });
        expect(res.status(), await res.text()).toBe(200);
        expect(Object.keys(await res.json()).sort()).toEqual([
          "access_token",
          "refresh_token",
          "token_type",
        ]);

        // The same call from a context with NO cookies, carrying only the bearer,
        // is refused — a bearer is not a credential for this route. This half is
        // asserted from the anonymous context on purpose; the declared operation is
        // already credited by the call above.
        const bearerOnly = await anonymous.post("/api/v1/refresh", { headers: throwaway });
        expect(bearerOnly.status()).toBe(401);
      });

      await test.step("logout answers 200 with a message", async () => {
        const res = await request.post("/api/v1/logout", { headers: throwaway });
        expect(res.status(), await res.text()).toBe(200);
        expect(typeof (await res.json()).message).toBe("string");
      });

      await test.step("and the SAME access token still works afterwards", async () => {
        const res = await request.get("/api/v1/all", { headers: throwaway });
        // The finding: logout clears cookies, it does not invalidate the token.
        // Asserted explicitly so that a future version which DOES invalidate fails
        // here and gets read, instead of silently changing the security posture.
        expect(
          res.status(),
          "logout now invalidates the access token — the contract changed, " +
            "update this spec and the doc rather than relaxing the assertion",
        ).toBe(200);
      });
    },
  );
});
