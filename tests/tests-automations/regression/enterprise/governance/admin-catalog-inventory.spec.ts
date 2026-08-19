import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import { requireEnvironmentPolicy } from "../../../../helpers/enterprise/policy-gate";
import { readPaletteComponentTypes } from "../../../../helpers/governance/policy-state";

/**
 * `GET /api/v1/enterprise-admin/catalog/components` is the Enterprise-only
 * endpoint an administrator's catalog screen reads. It answers one question —
 * what can I block, and what is blocked — and it is the only surface that
 * answers it, so a wrong answer there is not cosmetic: it is the operator
 * choosing policy from a list that does not describe the instance.
 *
 * It is deliberately NOT the palette. The palette is what policy already
 * filtered; the inventory is what policy can be written about, so it must keep
 * listing a component after that component has been blocked — otherwise
 * blocking one would remove it from the screen used to unblock it.
 *
 * That makes the relationship exact rather than vague, and both directions are
 * asserted: the inventory is a superset of the palette (nothing a user can place
 * is ungovernable), and the difference between them is the declared blocklist
 * and nothing else (nothing is being hidden that the operator did not declare).
 *
 * Unlike its sibling `environment-policy-authority`, this spec is expected to
 * PASS. It pins an agreement that holds today so a future change to either side
 * of it cannot move one without the other.
 */
const BLOCKED_COMPONENT = "CombineText";


interface CatalogInventory {
  components: Record<string, Record<string, { policy_keys?: string[] }>>;
  policy_candidates: Record<string, string[]>;
}

test.describe("Enterprise — the admin catalog inventory agrees with the policy", () => {
  test(
    "the inventory lists what policy can govern, including what it already blocks",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });

      const response = await request.get(
        "/api/v1/enterprise-admin/catalog/components",
        { headers: { Authorization: auth } },
      );
      expect(response.status()).toBe(200);
      const inventory = (await response.json()) as CatalogInventory;

      await test.step("the payload is populated", async () => {
        // Refused first: an empty inventory satisfies every set relation below
        // while proving nothing, which is the shape of a false pass (#1012).
        expect(Object.keys(inventory.components).length).toBeGreaterThan(0);
        expect(Object.keys(inventory.policy_candidates).length).toBeGreaterThan(0);
      });

      await test.step("the blocked component is still offered to policy", async () => {
        const entry = Object.values(inventory.components)
          .map((category) => category[BLOCKED_COMPONENT])
          .find(Boolean);
        expect(
          entry,
          `${BLOCKED_COMPONENT} is blocked but absent from the admin inventory, ` +
            `so it cannot be unblocked from the screen that blocked it`,
        ).toBeTruthy();
        expect(entry!.policy_keys).toContain(BLOCKED_COMPONENT);
      });

      await test.step("and it is absent from the palette", async () => {
        expect(await readPaletteComponentTypes(request, auth)).not.toContain(
          BLOCKED_COMPONENT,
        );
      });
    },
  );

  test(
    "the inventory is the palette plus exactly what policy blocks",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });

      const response = await request.get(
        "/api/v1/enterprise-admin/catalog/components",
        { headers: { Authorization: auth } },
      );
      expect(response.status()).toBe(200);
      const inventory = (await response.json()) as CatalogInventory;

      const inventoryTypes = new Set(
        Object.values(inventory.components).flatMap((category) =>
          Object.keys(category),
        ),
      );
      // Excludes `component_display_names`, which is a metadata map and not a
      // category — folding it in doubles the set and reports every real type as
      // a phantom absence here.
      const paletteTypes = await readPaletteComponentTypes(request, auth);

      await test.step("every placeable component is governable", async () => {
        const ungovernable = [...paletteTypes].filter(
          (type) => !inventoryTypes.has(type),
        );
        expect(
          ungovernable,
          "these types are in the palette but absent from the admin inventory, " +
            "so no policy can be written about them",
        ).toEqual([]);
      });

      await test.step("nothing is hidden that policy does not account for", async () => {
        const hidden = [...inventoryTypes]
          .filter((type) => !paletteTypes.has(type))
          .sort();
        expect(hidden).toEqual([...(bundle.blocked_component_keys ?? [])].sort());
      });
    },
  );

  test(
    "every declared blocklist key resolves to a component the inventory lists",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [BLOCKED_COMPONENT],
      });

      const response = await request.get(
        "/api/v1/enterprise-admin/catalog/components",
        { headers: { Authorization: auth } },
      );
      expect(response.status()).toBe(200);
      const inventory = (await response.json()) as CatalogInventory;

      const inventoryTypes = new Set(
        Object.values(inventory.components).flatMap((category) =>
          Object.keys(category),
        ),
      );

      // `policy_candidates` resolves every accepted spelling to the canonical
      // type — display name, class name and type all map to the same entry.
      // Templates have no such resolver, which is why blocking one by display
      // name is accepted and enforces nothing
      // (`governance/catalog-policy/template-blocklist-enforcement`). An
      // operator cannot tell the two behaviours apart except by reading this,
      // so a declared key that resolves to nothing is the silent no-op in its
      // purest form: accepted at boot, echoed by the bundle, enforcing nothing.
      for (const key of bundle.blocked_component_keys ?? []) {
        const resolved = inventory.policy_candidates[key];
        expect(
          resolved,
          `the deployment declared '${key}', which the admin inventory does not ` +
            `offer as a policy key — it can never match a component`,
        ).toBeTruthy();
        expect(resolved!.length).toBeGreaterThan(0);
        for (const type of resolved!) {
          expect(inventoryTypes).toContain(type);
        }
      }
    },
  );
});
