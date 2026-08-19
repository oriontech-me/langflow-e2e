import { expect, test } from "../../../../fixtures/fixtures";
import {
  EE_PASSWORD,
  getEnterpriseAuthToken,
  loginWithPassword,
} from "../../../../helpers/enterprise/enterprise-auth";

/**
 * What the login screen may offer, and the emergency account behind it (see
 * docs/enterprise/auth/login-surface.md).
 *
 * The golden invariant here is that an SSO mistake must never lock an
 * organisation out of its own instance. It is reachable without a licence
 * because an instance with SSO switched on and no usable connection IS the
 * misconfigured state.
 */
test.describe("Enterprise — login surface and break-glass defaults", () => {
  test(
    "password login survives SSO being switched on but unusable",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const methods = await request.get("/api/v1/auth/methods");
      expect(methods.status()).toBe(200);
      const body = await methods.json();

      // SSO *switched on* is not SSO *available*: with no usable connection the
      // login screen must still offer the local form, or the instance is shut.
      expect(body.show_local_form).toBe(true);
      expect(body.sso.enabled).toBe(false);
      expect(body.sso.providers).toEqual([]);

      // The half that makes the first half mean something: the advertised form
      // has to actually work.
      const token = await loginWithPassword(request, EE_PASSWORD);
      const whoami = await request.get("/api/v1/users/whoami", {
        headers: { Authorization: token },
      });
      expect(whoami.status()).toBe(200);
    },
  );

  test(
    "break-glass ships disabled and unused",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const settings = await request.get("/api/v1/sso/settings", {
        headers: { Authorization: auth },
      });
      expect(settings.status()).toBe(200);
      const body = await settings.json();

      expect(body.break_glass_enabled).toBe(false);
      expect(body.break_glass_last_used_at).toBeNull();
      // The account exists even while disabled — that is what makes "disabled by
      // default" a decision rather than an absence.
      expect(body.break_glass_user_id).toBeTruthy();
    },
  );

  test(
    "enabling break-glass is explicit, reflected, and does not count as using it",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const headers = { Authorization: auth };

      try {
        const enabled = await request.patch("/api/v1/sso/settings", {
          headers,
          data: { break_glass_enabled: true },
        });
        expect(enabled.status()).toBe(200);
        const body = await enabled.json();
        expect(body.break_glass_enabled).toBe(true);

        // Arming it is not using it. A timestamp here would make the audit trail
        // useless for the only question it answers.
        expect(body.break_glass_last_used_at).toBeNull();

        const readBack = await request.get("/api/v1/sso/settings", { headers });
        expect((await readBack.json()).break_glass_enabled).toBe(true);
      } finally {
        // The only write in this area. Leaving break-glass armed would be a
        // worse outcome than the test failing.
        await request.patch("/api/v1/sso/settings", {
          headers,
          data: { break_glass_enabled: false },
        });
      }
    },
  );
});
