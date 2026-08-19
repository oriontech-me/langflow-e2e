import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import { requireEnvironmentPolicy } from "../../../../helpers/enterprise/policy-gate";
import {
  readCatalogTypes,
  readPolicyBundle,
} from "../../../../helpers/governance/policy-state";

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
 * All four governance knobs are asserted rather than one and an inference, and
 * each on the surface a user would notice. The inference is unsafe in this exact
 * area: `governance/catalog-policy/template-blocklist-enforcement` measures that
 * blocking a template by its display name is accepted and enforces nothing,
 * while the internal key works — two inputs to one endpoint, opposite outcomes,
 * no error either way. Which is also why the template key here is the internal
 * one.
 *
 * This spec is EXPECTED TO FAIL on current Enterprise builds. The failure is a
 * product finding tracked outside this repository, not a defect in the spec —
 * do not relax the assertions to make the lane green.
 *
 * It needs a FRESH container each run: the assertions read the policy's declared
 * source, and a previous run's write changes it. The gate skips on a written
 * policy rather than failing, so that state reads as the wrong instance instead
 * of a product defect.
 */
const BLOCKED_COMPONENT = "CombineText";
/** The internal key, never the display name — see the header. */
const BLOCKED_TEMPLATE_KEY = "saas_pricing";
const BLOCKED_TEMPLATE_NAME = "SaaS Pricing";
const APPROVED_PROVIDER = "openai";
/** A provider the deployment did NOT approve, used to attempt a widening. */
const UNAPPROVED_PROVIDER = "anthropic";
const BLOCKED_MODEL = "gpt-4o-mini";


async function listedTemplates(
  request: APIRequestContext,
  auth: string,
): Promise<string[]> {
  const response = await request.get("/api/v1/flows/basic_examples/", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { name: string }[]).map(
    (item) => item.name,
  );
}

async function listedProviders(
  request: APIRequestContext,
  auth: string,
): Promise<string[]> {
  const response = await request.get("/api/v1/models/providers", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as string[];
}

test.describe("Enterprise — environment-declared policy is authoritative", () => {
  // No retries, deliberately. Each test here attempts an override, and on a
  // build where the attempt succeeds it consumes the very state the run needs:
  // the live bundle's provenance flips to `api` and never reverts. A retry
  // therefore re-runs against an instance the first attempt already changed, so
  // it cannot confirm or refute anything — it only produces a second, differently
  // worded failure. The gate reads the deployment's own history revision so the
  // remaining tests still run; retrying is the one thing that cannot be salvaged.
  test.describe.configure({ retries: 0 });

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
    "a runtime write cannot clear a component blocklist the deployment declared",
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

  test(
    "a runtime write cannot clear a template blocklist the deployment declared",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedTemplates: [BLOCKED_TEMPLATE_KEY],
      });

      await test.step("the declared block is in force to begin with", async () => {
        // Without this the test could pass against an instance where the key
        // never enforced anything — the display-name no-op in miniature.
        expect(await listedTemplates(request, auth)).not.toContain(
          BLOCKED_TEMPLATE_NAME,
        );
      });

      const attempt = await request.put("/api/v1/catalog-policy/templates", {
        headers: { Authorization: auth },
        data: { blocked: [] },
      });

      try {
        await test.step("the write is refused", async () => {
          expect(attempt.ok()).toBe(false);
        });

        await test.step("the template stays out of the listing", async () => {
          expect(await listedTemplates(request, auth)).not.toContain(
            BLOCKED_TEMPLATE_NAME,
          );
        });
      } finally {
        if (attempt.ok()) {
          await request.put("/api/v1/catalog-policy/templates", {
            headers: { Authorization: auth },
            data: { blocked: bundle.blocked_template_keys ?? [] },
          });
        }
      }
    },
  );

  test(
    "a runtime write cannot widen a provider allowlist the deployment declared",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        approvedProviders: [APPROVED_PROVIDER],
      });

      const baseline = await listedProviders(request, auth);
      await test.step("the allowlist is in force to begin with", async () => {
        // The unapproved provider must be absent for the widening attempt below
        // to mean anything — otherwise it was never constrained.
        expect(baseline.map((name) => name.toLowerCase())).not.toContain(
          UNAPPROVED_PROVIDER,
        );
      });

      const attempt = await request.put("/api/v1/model-provider-policy", {
        headers: { Authorization: auth },
        data: {
          approved_provider_ids: [
            ...(bundle.approved_provider_ids ?? []),
            UNAPPROVED_PROVIDER,
          ],
        },
      });

      try {
        await test.step("the write is refused", async () => {
          expect(attempt.ok()).toBe(false);
        });

        await test.step("the provider listing is unchanged", async () => {
          // Widening is the direction that matters: a runtime write that adds a
          // provider the operator excluded defeats the allowlist just as
          // completely as clearing it, and leaves the policy looking populated.
          expect(await listedProviders(request, auth)).toEqual(baseline);
        });
      } finally {
        if (attempt.ok()) {
          await request.put("/api/v1/model-provider-policy", {
            headers: { Authorization: auth },
            data: { approved_provider_ids: bundle.approved_provider_ids ?? [] },
          });
        }
      }
    },
  );

  test(
    "a runtime write cannot clear a model blocklist the deployment declared",
    { tag: ["@enterprise", "@api", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedModels: [BLOCKED_MODEL],
      });

      // Asserted on the bundle rather than on a listing, and deliberately so:
      // `GET /api/v1/models` filters by provider and never by model — its
      // handler calls the policy's `allows`/`filter`, while the only consumer
      // of the per-model predicate is the option builder behind a component's
      // model dropdown. Asserting absence from the REST listing would assert
      // something the product never promised there.
      const attempt = await request.put("/api/v1/policy-bundle", {
        headers: { Authorization: auth },
        data: {
          expected_revision: bundle.revision,
          approved_provider_ids: bundle.approved_provider_ids ?? [],
          blocked_component_keys: bundle.blocked_component_keys ?? [],
          blocked_template_keys: bundle.blocked_template_keys ?? [],
          blocked_model_keys: [],
          reason: "environment-policy-authority: attempt to clear",
        },
      });

      try {
        await test.step("the write is refused", async () => {
          expect(attempt.ok()).toBe(false);
        });

        await test.step("the bundle still carries the declared model", async () => {
          const after = await readPolicyBundle(request, auth);
          expect(after.blocked_model_keys).toContain(BLOCKED_MODEL);
        });
      } finally {
        if (attempt.ok()) {
          const current = await readPolicyBundle(request, auth);
          await request.put("/api/v1/policy-bundle", {
            headers: { Authorization: auth },
            data: {
              expected_revision: current.revision,
              approved_provider_ids: current.approved_provider_ids ?? [],
              blocked_component_keys: current.blocked_component_keys ?? [],
              blocked_template_keys: current.blocked_template_keys ?? [],
              blocked_model_keys: bundle.blocked_model_keys ?? [],
              reason: "environment-policy-authority: restore",
            },
          });
        }
      }
    },
  );
});
