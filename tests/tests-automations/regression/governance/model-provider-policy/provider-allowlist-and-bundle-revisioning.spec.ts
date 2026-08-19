import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  describePolicyState,
  isPolicyPristine,
  readCatalogTypes,
  readPolicyBundle,
  restorePolicy,
  snapshotPolicy,
  type PolicySnapshot,
} from "../../../../helpers/governance/policy-state";

// Model provider policy + policy-bundle revisioning (QA-CHECKLIST §21.3–21.4).
// Spec doc:
// docs/governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.md
//
// @destructive: narrowing the provider allowlist hides models from every worker
// sharing the instance. Serial — the revision assertions build on each other.
test.describe.configure({ mode: "serial" });

const APPROVED_PROVIDER_ID = "openai";
const APPROVED_DISPLAY_NAME = "OpenAI";
/** Namespace prefix of a provider that must survive the allowlist. */
const APPROVED_TYPE_PREFIX = "ext:openai:";
/** A component to block, so there are two revisions to move between. */
const SCRATCH_COMPONENT = "DynamicCreateData";

interface RegisteredProvider {
  provider_id: string;
  display_name: string;
}

test.describe("governance — provider allowlist and policy-bundle revisions", () => {
  let token: string;
  let snapshot: PolicySnapshot;
  let pristine = false;
  let skipReason = "";
  let baselineProviders: string[] = [];
  let baselineTypes = new Set<string>();
  /** A registered provider outside the allowlist, resolved from the API. */
  let excludedProviderId = "";
  let allowlistRevision = 0;

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
    const bundle = await readPolicyBundle(request, token);
    pristine = isPolicyPristine(bundle);
    skipReason = `instance already carries a governance policy (${describePolicyState(bundle)}) — the allowlist assertions would be unfalsifiable`;
    if (pristine) {
      snapshot = await snapshotPolicy(request, token);
    }
  });

  test.afterAll(async ({ request }) => {
    if (pristine) {
      await restorePolicy(request, token, snapshot);
    }
  });

  test(
    "an unconfigured instance approves every registered provider",
    { tag: ["@destructive", "@api", "@model-provider"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      const policy = await request.get("/api/v1/model-provider-policy", {
        headers: { Authorization: token },
      });
      expect(policy.status()).toBe(200);
      const body = await policy.json();
      expect(body.approved_provider_ids).toEqual([]);

      const registered = body.registered_providers as RegisteredProvider[];
      // With one provider the allowlist cannot be shown to narrow anything —
      // the whole file would pass vacuously.
      expect(
        registered.length,
        "fewer than two registered providers: the allowlist cannot be shown to narrow anything",
      ).toBeGreaterThan(1);
      excludedProviderId =
        registered.find((p) => p.provider_id !== APPROVED_PROVIDER_ID)!
          .provider_id;

      const providers = await request.get("/api/v1/models/providers", {
        headers: { Authorization: token },
      });
      baselineProviders = (await providers.json()) as string[];
      expect(baselineProviders).toContain(APPROVED_DISPLAY_NAME);
      expect(baselineProviders.length).toBe(registered.length);

      baselineTypes = await readCatalogTypes(request, token);
    },
  );

  test(
    "an allowlist narrows the provider list and the component catalog",
    { tag: ["@destructive", "@api", "@model-provider"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await test.step("the policy write is accepted and echoed", async () => {
        const put = await request.put("/api/v1/model-provider-policy", {
          headers: { Authorization: token },
          data: { approved_provider_ids: [APPROVED_PROVIDER_ID] },
        });
        expect(put.status()).toBe(200);
        expect((await put.json()).approved_provider_ids).toEqual([
          APPROVED_PROVIDER_ID,
        ]);
      });

      await test.step("only the approved provider is offered", async () => {
        const providers = await request.get("/api/v1/models/providers", {
          headers: { Authorization: token },
        });
        expect(await providers.json()).toEqual([APPROVED_DISPLAY_NAME]);
      });

      await test.step("the excluded provider is still registered", async () => {
        // The control that separates policy from packaging: an image missing a
        // provider distribution shows the same shortened list (see
        // docs/component-distribution-policy.md).
        const policy = await request.get("/api/v1/model-provider-policy", {
          headers: { Authorization: token },
        });
        const registered = (await policy.json())
          .registered_providers as RegisteredProvider[];
        expect(registered.map((p) => p.provider_id)).toContain(
          excludedProviderId,
        );
      });

      await test.step("its components leave the catalog", async () => {
        const types = await readCatalogTypes(request, token);
        const excludedPrefix = `ext:${excludedProviderId}:`;
        expect(
          [...types].filter((type) => type.startsWith(excludedPrefix)),
        ).toEqual([]);
        expect(
          [...types].filter((type) => type.startsWith(APPROVED_TYPE_PREFIX))
            .length,
        ).toBeGreaterThan(0);
        expect(types.size).toBeLessThan(baselineTypes.size);
      });

      await test.step("the write minted a new bundle revision", async () => {
        const bundle = await readPolicyBundle(request, token);
        expect(bundle.revision).toBeGreaterThan(snapshot.revision);
        expect(bundle.source).toBe("api");
        expect(bundle.approved_provider_ids).toEqual([APPROVED_PROVIDER_ID]);
        allowlistRevision = bundle.revision!;
      });
    },
  );

  test(
    "a rollback is refused on a stale expected_revision and appends when current",
    { tag: ["@destructive", "@api", "@governance"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await test.step("a second, unrelated change gives us a revision to leave", async () => {
        const put = await request.put("/api/v1/catalog-policy/components", {
          headers: { Authorization: token },
          data: { blocked: [SCRATCH_COMPONENT] },
        });
        expect(put.status()).toBe(200);
      });

      const history = await request.get("/api/v1/policy-bundle/history", {
        headers: { Authorization: token },
      });
      expect(history.status()).toBe(200);
      const revisions = ((await history.json()).items as { revision: number }[])
        .map((item) => item.revision);
      // Newest first, and the allowlist revision is in there.
      expect(revisions[0]).toBeGreaterThan(allowlistRevision);
      expect(revisions).toContain(allowlistRevision);
      const activeRevision = revisions[0];

      await test.step("a stale expected_revision is refused 409, naming both sides", async () => {
        const stale = await request.post(
          `/api/v1/policy-bundle/rollback/${allowlistRevision}`,
          {
            headers: { Authorization: token },
            data: { expected_revision: allowlistRevision },
          },
        );
        expect(stale.status()).toBe(409);
        const detail = (await stale.json()).detail;
        expect(detail.expected_revision).toBe(allowlistRevision);
        expect(detail.active_revision).toBe(activeRevision);
      });

      await test.step("the current expected_revision is accepted and appends", async () => {
        const rollback = await request.post(
          `/api/v1/policy-bundle/rollback/${allowlistRevision}`,
          {
            headers: { Authorization: token },
            data: { expected_revision: activeRevision, reason: "spec rollback" },
          },
        );
        expect(rollback.status()).toBe(200);
        const bundle = await rollback.json();
        // The counter moves FORWARD carrying old content — a rollback that
        // rewound it would erase the trail it exists to keep.
        expect(bundle.revision).toBeGreaterThan(activeRevision);
        expect(bundle.source).toBe("rollback");
        expect(bundle.rollback_of_revision).toBe(allowlistRevision);
        expect(bundle.reason).toBe("spec rollback");
        expect(bundle.blocked_component_keys).toEqual([]);
        expect(bundle.approved_provider_ids).toEqual([APPROVED_PROVIDER_ID]);
      });

      await test.step("the restored content is enforced, not just recorded", async () => {
        const types = await readCatalogTypes(request, token);
        expect(types.has(SCRATCH_COMPONENT)).toBe(true);
      });
    },
  );

  test(
    "clearing the policy puts providers and catalog back",
    { tag: ["@destructive", "@api", "@model-provider"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await restorePolicy(request, token, snapshot);

      const providers = await request.get("/api/v1/models/providers", {
        headers: { Authorization: token },
      });
      expect(await providers.json()).toEqual(baselineProviders);

      const types = await readCatalogTypes(request, token);
      expect(types.size).toBe(baselineTypes.size);
    },
  );
});
