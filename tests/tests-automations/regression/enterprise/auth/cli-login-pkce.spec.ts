import { expect, test } from "../../../../fixtures/fixtures";
import {
  approveCliLogin,
  authorizeCliLogin,
  createVerifier,
  exchangeCliCode,
  fetchConsentPage,
} from "../../../../helpers/enterprise/cli-login";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";

/**
 * CLI sign-in is credential ISSUANCE (see docs/enterprise/auth/cli-login-pkce.md):
 * it mints a full access token for a client that never sees the password. Every
 * refusal below is what stops a stolen or guessed code from becoming a session.
 *
 * Each negative case takes its OWN authorization, because a failed exchange
 * consumes the code — reusing one would make every later assertion pass for the
 * wrong reason.
 *
 * The refusals all share one opaque message on purpose, so these assert the
 * REFUSAL and never the reason: pinning distinct messages would pin an
 * information leak the product deliberately avoids.
 */
test.describe("Enterprise — CLI sign-in (authorization code + PKCE)", () => {
  test(
    "a correct exchange issues a token that actually authenticates",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const authorization = await authorizeCliLogin(request, auth, { state: "happy-path" });

      const response = await exchangeCliCode(request, auth, authorization);
      expect(response.status()).toBe(200);
      const issued = (await response.json()).access_token;
      expect(issued).toBeTruthy();

      // "Issued" must mean usable, not merely present in a payload.
      const whoami = await request.get("/api/v1/users/whoami", {
        headers: { Authorization: `Bearer ${issued}` },
      });
      expect(whoami.status()).toBe(200);
    },
  );

  test(
    "the code is bound to its verifier, its state and its redirect",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);

      await test.step("a wrong code_verifier is refused", async () => {
        const authorization = await authorizeCliLogin(request, auth, { state: "wrong-verifier" });
        const response = await exchangeCliCode(request, auth, authorization, {
          // Valid length, wrong value: below 43 characters the API refuses on
          // length alone, which would assert validation instead of PKCE.
          codeVerifier: createVerifier(),
        });
        expect(response.ok()).toBe(false);
      });

      await test.step("a state other than the authorized one is refused", async () => {
        const authorization = await authorizeCliLogin(request, auth, { state: "bound-state" });
        const response = await exchangeCliCode(request, auth, authorization, {
          state: "some-other-state",
        });
        expect(response.ok()).toBe(false);
      });

      await test.step("a redirect other than the authorized one is refused", async () => {
        const authorization = await authorizeCliLogin(request, auth, { state: "bound-redirect" });
        const response = await exchangeCliCode(request, auth, authorization, {
          redirectUri: "http://127.0.0.1:8888/elsewhere",
        });
        expect(response.ok()).toBe(false);
      });
    },
  );

  test(
    "an authorization code cannot be spent twice",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const authorization = await authorizeCliLogin(request, auth, { state: "single-use" });

      expect((await exchangeCliCode(request, auth, authorization)).status()).toBe(200);
      expect((await exchangeCliCode(request, auth, authorization)).ok()).toBe(false);
    },
  );

  test(
    "the consent step resists CSRF, foreign origins and framing",
    { tag: ["@enterprise", "@api", "@auth"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);

      const consent = await fetchConsentPage(request, auth, { state: "consent-headers" });
      expect(consent.status()).toBe(200);

      await test.step("the page confines where its form may post", async () => {
        const csp = consent.headers()["content-security-policy"];
        expect(csp).toBeTruthy();
        // The form may only post back to this instance and to the redirect the
        // caller asked for — the restriction that keeps an approval from being
        // driven into someone else's endpoint.
        expect(csp).toContain("form-action 'self' http://127.0.0.1:9999");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(consent.headers()["cache-control"]).toContain("no-store");
      });

      const html = await consent.text();
      const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1] as string;
      const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1] as string;

      await test.step("a bad CSRF token is refused", async () => {
        const response = await approveCliLogin(request, auth, {
          requestId,
          csrfToken: "not-the-issued-token",
        });
        expect(response.ok()).toBe(false);
      });

      await test.step("a foreign origin is refused", async () => {
        const response = await approveCliLogin(request, auth, {
          requestId,
          csrfToken,
          origin: "http://attacker.example",
        });
        expect(response.ok()).toBe(false);
      });
    },
  );
});
