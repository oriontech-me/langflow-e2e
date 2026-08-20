import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  LICENCE_UNAVAILABLE_STATUS,
  requireNoEnterpriseLicence,
} from "../../../../helpers/enterprise/entitlement-gate";

/**
 * An Enterprise instance that cannot validate a licence has to be UNAVAILABLE,
 * not OPEN.
 *
 * Those two words describe the same HTTP outcome to a casual reader and opposite
 * outcomes to an operator: one means the entitled feature cannot be used, the
 * other means it is being served without the check that governs it. Most of the
 * SSO surface is blocked on entitlement validation — which is why the rest of
 * that area is untestable without a licence key — and the reachable half is the
 * one that decides which of those two words applies.
 *
 * `login-surface.spec.ts` covers the other half: password login survives SSO
 * being switched on but unusable, and break-glass ships disabled. Between them,
 * "SSO is unavailable" is proven to mean the organisation is neither locked out
 * nor let in. This file does not repeat that.
 *
 * The creation attempt below is a real POST rather than a dry run, because the
 * property under test is that it is refused. The gate skips the whole file on an
 * instance that can validate a licence, so the destructive reading never occurs.
 */
const GATED_READ = "/api/v1/sso/entitlements";
const GATED_WRITE = "/api/v1/sso/connections";

/**
 * Asserted exactly, not with a substring match.
 *
 * A licence failure is a natural place for a stack trace, an internal hostname,
 * a signing-key identifier or a vendor URL to escape into a response body — and
 * each of those would be a leak no other test in this suite would notice. The
 * cost of pinning it is real and intended: rewording the message fails this
 * test, which is a one-line update here, while a silently widened message is
 * exactly what an exact assertion exists to catch.
 */
const LICENCE_MESSAGE = "Enterprise license validation is unavailable";

/** Endpoints that must keep working — an unlicensed EE is not a broken EE. */
const CORE_ENDPOINTS = [
  "/api/v1/flows/",
  "/api/v1/all",
  "/api/v1/projects/",
  "/api/v1/users/whoami",
];

test.describe("Enterprise — without a licence, the entitled surface fails closed", () => {
  test(
    "the gated read and the gated write refuse with one stable, non-leaking message",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireNoEnterpriseLicence(request, auth);

      const read = await request.get(GATED_READ, {
        headers: { Authorization: auth },
      });
      const write = await request.post(GATED_WRITE, {
        headers: { Authorization: auth },
        data: {
          display_name: "entitlement-fail-closed probe",
          protocol: "oidc",
          provider: "generic",
          config: {
            issuer: "https://example.invalid",
            client_id: "probe",
            client_secret: "probe",
          },
        },
      });

      await test.step("both answer 503", async () => {
        expect(read.status()).toBe(LICENCE_UNAVAILABLE_STATUS);
        expect(write.status()).toBe(LICENCE_UNAVAILABLE_STATUS);
      });

      const readBody = (await read.json()) as Record<string, unknown>;
      const writeBody = (await write.json()) as Record<string, unknown>;

      await test.step("with the same message on both", async () => {
        // Compared to each other as well as to the literal: a per-route
        // divergence is a message that grew somewhere, which is the shape of a
        // leak.
        expect(readBody.detail).toBe(LICENCE_MESSAGE);
        expect(writeBody.detail).toBe(LICENCE_MESSAGE);
      });

      await test.step("and nothing besides that message", async () => {
        expect(Object.keys(readBody)).toEqual(["detail"]);
        expect(Object.keys(writeBody)).toEqual(["detail"]);
      });
    },
  );

  test(
    "the refusal is total: no connection comes into existence",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireNoEnterpriseLicence(request, auth);

      // The assertion that separates "unavailable" from "open". A 503 on the
      // creation route means nothing if a connection is left half-created for a
      // later request to find.
      const connections = await request.get(GATED_WRITE, {
        headers: { Authorization: auth },
      });
      expect(connections.status()).toBe(200);
      expect(await connections.json()).toEqual([]);
    },
  );

  test(
    "authentication is answered before entitlement, so the gate enumerates nothing",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireNoEnterpriseLicence(request, auth);

      // Deliberately no Authorization header. If the licence gate ran first, an
      // anonymous caller could map which Enterprise surfaces a deployment has by
      // reading which ones answer 503 rather than 403.
      const anonymous = await request.get(GATED_READ);

      expect(anonymous.status()).toBe(403);
      expect(await anonymous.text()).not.toContain("license");
    },
  );

  test(
    "an unlicensed instance is missing its entitled features, not broken",
    { tag: ["@enterprise", "@api", "@auth", "@sso"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireNoEnterpriseLicence(request, auth);

      for (const path of CORE_ENDPOINTS) {
        const response = await request.get(path, {
          headers: { Authorization: auth },
        });
        expect(
          response.status(),
          `${path} answered ${response.status()} on an instance whose only ` +
            `missing piece is a licence — the entitlement gate has a wider blast ` +
            `radius than the entitled surface`,
        ).toBe(200);
      }
    },
  );
});
