import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import { requireEnvironmentPolicy } from "../../../../helpers/enterprise/policy-gate";
import { readPolicyBundle } from "../../../../helpers/governance/policy-state";

/**
 * Where a deployment-declared policy survives once a runtime write supersedes it.
 *
 * `environment-policy-authority` owns the defect: a runtime write WINS against
 * a policy the operator declared. #1559 extends it — the win is permanent, the
 * environment variable is read at initialization only, and no current-state
 * surface says the deployment is being ignored.
 *
 * This covers the half that is neither a defect nor already asserted: the
 * `policy-bundle/history` entry is the ONLY record that the deployment declared
 * anything, and THIS SUITE'S OWN GATE depends on it.
 *
 * `requireEnvironmentPolicy` decides whether an instance is operator-declared by
 * reading that history and filtering `source === "environment"`. It has to — the
 * live bundle cannot answer, since after any admin write it reports
 * `source: "api"` and the shape an API-written policy would have. So if the
 * history stopped retaining that entry, the gate would return undefined, every
 * spec in this directory would `test.skip`, and the lane would report green
 * while blaming the reader's start command for a correctly configured instance.
 * A green all-skip, misattributed — the failure mode #1010 and #1012 exist to
 * prevent, arriving through a product change nothing else would notice.
 *
 * The OSS sibling `governance/model-provider-policy/provider-allowlist-and-bundle-
 * revisioning` reads the same endpoint but asserts only that a revision NUMBER
 * appears — nothing about the `source` or the declared keys, which is the whole
 * content the gate reads.
 */

/** Declared by the deployment. The gate skips, naming the start command, otherwise. */
const DECLARED_COMPONENT = "CombineText";

/** Written at runtime to supersede it. Deliberately a different key. */
const RUNTIME_COMPONENT = "Prompt";

interface HistoryEntry {
  revision?: number;
  source?: string;
  blocked_component_keys?: string[];
}

async function readHistory(
  request: APIRequestContext,
  auth: string,
): Promise<HistoryEntry[]> {
  const response = await request.get("/api/v1/policy-bundle/history", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const { items } = (await response.json()) as { items: HistoryEntry[] };
  expect(Array.isArray(items), "the history is not a list of revisions").toBe(true);
  return items;
}

/** The newest environment-sourced revision — what the gate reads. */
function declaredRevision(history: HistoryEntry[]): HistoryEntry | undefined {
  return history
    .filter((entry) => entry.source === "environment")
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
}

test.describe("Enterprise — the history is the only record that the deployment declared a policy", () => {
  test(
    "a runtime write supersedes the declaration, and the history keeps it with its source and keys",
    { tag: ["@enterprise", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [DECLARED_COMPONENT],
      });

      const declaredBefore = declaredRevision(await readHistory(request, auth));
      expect(
        declaredBefore,
        "the gate admitted this instance, so the history must hold an environment revision",
      ).toBeDefined();

      let attempt: Awaited<ReturnType<APIRequestContext["put"]>> | undefined;
      try {
        await test.step("a runtime write takes, and the live bundle changes hands", async () => {
          attempt = await request.put("/api/v1/catalog-policy/components", {
            headers: { Authorization: auth },
            data: { blocked: [RUNTIME_COMPONENT] },
          });
          expect(attempt.status()).toBe(200);

          const live = await readPolicyBundle(request, auth);
          // The defect its sibling spec owns; asserted here only far enough to
          // establish that the declaration really has been superseded, which is
          // the precondition for everything below.
          expect(live.source).toBe("api");
          expect(live.revision ?? 0).toBeGreaterThan(declaredBefore!.revision ?? 0);
          expect(live.blocked_component_keys).toEqual([RUNTIME_COMPONENT]);
        });

        await test.step("and the history still holds the environment revision, intact", async () => {
          const declaredAfter = declaredRevision(await readHistory(request, auth));
          expect(
            declaredAfter,
            "the environment revision left the history once a runtime write superseded it — " +
              "requireEnvironmentPolicy reads exactly this, so every spec in this directory " +
              "would now skip and the lane would report green",
          ).toBeDefined();

          // Not merely "a revision number is present", which the OSS sibling
          // already covers. The gate reads the SOURCE and the caller reads the
          // KEYS, so both have to survive.
          expect(declaredAfter!.revision).toBe(declaredBefore!.revision);
          expect(declaredAfter!.source).toBe("environment");
          expect(declaredAfter!.blocked_component_keys).toContain(DECLARED_COMPONENT);
        });
      } finally {
        // Restore what the deployment declared. Without this a red run leaves
        // the instance permissive and anything reading the catalog afterwards
        // reports a second, derived failure that hides this one. It cannot
        // restore the PROVENANCE — that is the defect #1559 records.
        if (attempt?.ok()) {
          await request.put("/api/v1/catalog-policy/components", {
            headers: { Authorization: auth },
            data: { blocked: bundle.blocked_component_keys ?? [] },
          });
        }
      }
    },
  );

  test(
    "and no current-state surface names the declaration it superseded",
    { tag: ["@enterprise", "@regression", "@governance"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      const bundle = await requireEnvironmentPolicy(request, auth, {
        blockedComponents: [DECLARED_COMPONENT],
      });

      let attempt: Awaited<ReturnType<APIRequestContext["put"]>> | undefined;
      try {
        attempt = await request.put("/api/v1/catalog-policy/components", {
          headers: { Authorization: auth },
          data: { blocked: [RUNTIME_COMPONENT] },
        });
        expect(attempt.status()).toBe(200);

        // This is what makes the sibling test's claim exact rather than
        // decorative: the history is the SOLE record, so losing it loses the
        // fact that the deployment declared anything.
        //
        // A future build that fixes #1559 by surfacing the disagreement in the
        // current state will turn this red. That is the correct signal, not a
        // false alarm — the premise this spec is built on would have changed,
        // and the assertion and its doc move together.
        for (const surface of [
          "/api/v1/policy-bundle",
          "/api/v1/catalog-policy/components",
        ]) {
          const response = await request.get(surface, {
            headers: { Authorization: auth },
          });
          expect(response.status()).toBe(200);
          expect(
            await response.text(),
            `${surface} names the superseded declaration — #1559 may have been fixed, in ` +
              `which case this spec's premise changed and its doc needs updating`,
          ).not.toContain(DECLARED_COMPONENT);
        }
      } finally {
        if (attempt?.ok()) {
          await request.put("/api/v1/catalog-policy/components", {
            headers: { Authorization: auth },
            data: { blocked: bundle.blocked_component_keys ?? [] },
          });
        }
      }
    },
  );
});
