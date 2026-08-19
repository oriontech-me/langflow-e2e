import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import { requireEnvironmentPolicy } from "../../../../helpers/enterprise/policy-gate";
import { readCatalogTypes } from "../../../../helpers/governance/policy-state";

/**
 * The half of catalog governance that Enterprise still owns.
 *
 * `governance/catalog-policy/` covers the OSS surface — block a component, it
 * leaves the palette and the write path refuses it — by writing the policy
 * through the admin API. This spec covers the case that API cannot reach: a
 * policy the OPERATOR declared in the deployment, which EE reads at boot and
 * which OSS has no setting for at all.
 *
 * The invariant is authority, not enforcement. Enforcement is already proven by
 * the OSS specs and holds here too; what must additionally be true is that a
 * runtime write cannot undo what the deployment declared. A policy any
 * authenticated administrator can clear constrains nobody, and it fails
 * silently: the container goes on advertising the blocklist in its environment
 * while the running instance no longer applies it.
 *
 * This spec is EXPECTED TO FAIL on current Enterprise builds. The failure is a
 * product finding tracked outside this repository, not a defect in the spec —
 * do not relax the assertions to make the lane green.
 *
 * It needs a FRESH container each run: the assertions read the policy's declared
 * source, and a previous run's write changes it, which fails the spec for a
 * different reason than the one it exists for.
 */
const BLOCKED_COMPONENT = "CombineText";

test.describe("Enterprise — environment-declared policy is authoritative", () => {
  test(
    "policy declared by the deployment is reported as externally managed",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });

      expect(bundle.source).toBe("environment");
      expect(bundle.blocked_component_keys).toContain(BLOCKED_COMPONENT);

      // The field a client gates the read-only admin state on, read from the
      // per-resource endpoint an admin screen actually calls.
      const response = await request.get("/api/v1/catalog-policy/components", {
        headers: { Authorization: auth },
      });
      expect(response.status()).toBe(200);
      expect((await response.json()).managed_externally).toBe(true);
    },
  );

  test(
    "a runtime write cannot clear a policy the deployment declared",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });

      const attempt = await request.put("/api/v1/catalog-policy/components", {
        headers: { Authorization: auth },
        data: { blocked: [] },
      });

      try {
        await test.step("the write is refused", async () => {
          expect(attempt.ok()).toBe(false);
        });

        await test.step("enforcement survives the attempt", async () => {
          // The assertion that matters. A refusal that left the policy cleared
          // anyway would satisfy the step above and still be an escape.
          expect(await readCatalogTypes(request, auth)).not.toContain(BLOCKED_COMPONENT);
        });
      } finally {
        // Restore what the deployment declared. Without this a red run leaves
        // the instance permissive, and anything reading the catalog afterwards
        // reports a second, derived failure that hides this one.
        if (attempt.ok()) {
          await request.put("/api/v1/catalog-policy/components", {
            headers: { Authorization: auth },
            data: { blocked: bundle.blocked_component_keys ?? [] },
          });
        }
      }
    },
  );
});
