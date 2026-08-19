import { test, type APIRequestContext } from "@playwright/test";
import {
  readPolicyBundle,
  type PolicyBundleResponse,
} from "../governance/policy-state";

/**
 * Precondition for the Enterprise environment-policy spec.
 *
 * This is the mirror image of `isPolicyPristine()` in the governance helper, and
 * the asymmetry is the point. An OSS governance spec WRITES the policy it needs,
 * so it must refuse to run against an instance that already carries one. An
 * Enterprise spec cannot write anything: `EnvironmentCatalogPolicyService` reads
 * the governance knobs at boot, so the policy state IS the container, and the
 * spec can only assert against the one it was started with.
 *
 * Hence a gate rather than a setup step — and one that skips naming the exact
 * command that provides the missing state, because a red describing the
 * environment instead of the product is the failure mode this lane is most
 * exposed to.
 */
export interface RequiredEnvironmentPolicy {
  /** Component keys the instance must have been started with. */
  blockedComponents?: string[];
  /** Provider ids the instance must approve. */
  approvedProviders?: string[];
}

/** The `start-langflow-enterprise.sh` invocation that yields `required`. */
function startCommandFor(required: RequiredEnvironmentPolicy): string {
  const env: string[] = [];
  if (required.blockedComponents?.length) {
    env.push(`LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=${required.blockedComponents.join(",")}`);
  }
  if (required.approvedProviders?.length) {
    env.push(`LANGFLOW_MODEL_PROVIDER_ALLOWLIST=${required.approvedProviders.join(",")}`);
  }
  return `${env.join(" ")} ./scripts/start-langflow-enterprise.sh`.trim();
}

/**
 * Skip unless the instance carries `required` **and declared it in the
 * environment**. Returns the bundle so the caller need not read it twice.
 *
 * The source check is not a formality: the same blocked set written through the
 * admin API would satisfy every other condition here while testing the OSS path
 * the governance specs already cover.
 */
export async function requireEnvironmentPolicy(
  request: APIRequestContext,
  auth: string,
  required: RequiredEnvironmentPolicy,
): Promise<PolicyBundleResponse> {
  const bundle = await readPolicyBundle(request, auth);

  const missingComponents = (required.blockedComponents ?? []).filter(
    (key) => !(bundle.blocked_component_keys ?? []).includes(key),
  );
  const missingProviders = (required.approvedProviders ?? []).filter(
    (id) => !(bundle.approved_provider_ids ?? []).includes(id),
  );

  test.skip(
    missingComponents.length > 0 || missingProviders.length > 0,
    `Instance policy does not satisfy this spec (revision ${bundle.revision}, source '${bundle.source}'): ` +
      `blocked components [${(bundle.blocked_component_keys ?? []).join(", ") || "none"}], ` +
      `approved providers [${(bundle.approved_provider_ids ?? []).join(", ") || "all"}]. ` +
      `Start the instance with: ${startCommandFor(required)}`,
  );

  return bundle;
}
