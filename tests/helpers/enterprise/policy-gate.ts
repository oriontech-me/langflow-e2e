import { test, type APIRequestContext } from "@playwright/test";
import {
  readPolicyBundle,
  type PolicyBundleResponse,
} from "../governance/policy-state";

/**
 * Precondition for the Enterprise environment-policy specs.
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
  /** Template keys the instance must have been started with. */
  blockedTemplates?: string[];
  /** Provider ids the instance must approve. */
  approvedProviders?: string[];
  /** Model keys the instance must have been started with. */
  blockedModels?: string[];
}

/** The environment variable that declares each part of the policy. */
const KNOB: Record<keyof RequiredEnvironmentPolicy, string> = {
  blockedComponents: "LANGFLOW_CATALOG_COMPONENT_BLOCKLIST",
  blockedTemplates: "LANGFLOW_CATALOG_TEMPLATE_BLOCKLIST",
  approvedProviders: "LANGFLOW_MODEL_PROVIDER_ALLOWLIST",
  blockedModels: "LANGFLOW_MODEL_BLOCKLIST",
};

/** Where the bundle reports each part of the policy. */
const BUNDLE_FIELD: Record<
  keyof RequiredEnvironmentPolicy,
  keyof PolicyBundleResponse
> = {
  blockedComponents: "blocked_component_keys",
  blockedTemplates: "blocked_template_keys",
  approvedProviders: "approved_provider_ids",
  blockedModels: "blocked_model_keys",
};

const PARTS = Object.keys(KNOB) as (keyof RequiredEnvironmentPolicy)[];

function declared(
  bundle: PolicyBundleResponse,
  part: keyof RequiredEnvironmentPolicy,
): string[] {
  return (bundle[BUNDLE_FIELD[part]] as string[] | undefined) ?? [];
}

/** The `start-langflow-enterprise.sh` invocation that yields `required`. */
function startCommandFor(required: RequiredEnvironmentPolicy): string {
  const env = PARTS.filter((part) => required[part]?.length).map(
    (part) => `${KNOB[part]}=${required[part]!.join(",")}`,
  );
  return `${env.join(" ")} ./scripts/start-langflow-enterprise.sh`.trim();
}

/**
 * The revision the deployment's own declaration created, or `undefined`.
 *
 * Read from `/api/v1/policy-bundle/history` rather than from the live bundle,
 * and that is the whole design of this gate rather than an optimisation. The
 * live `source` field answers "who wrote the policy that is in force NOW", which
 * stops being the question the moment one of these specs makes its override
 * attempt: on a build where the attempt succeeds the bundle flips to `api` and
 * never reverts for the life of the container.
 *
 * Two earlier shapes of this check both failed on that. Reading the live source
 * made the first failing test skip every test after it — the specs would have
 * reported the defect on one surface and stayed silent about the other three,
 * which is the opposite of why they exist. Memoising the first observation in a
 * module variable did not survive either, because Playwright recycles the worker
 * process after a failed test, so the memo was empty again for the next one.
 *
 * The history row is immune to both: it is durable, it carries the key lists the
 * deployment declared, and a fresh container starts a fresh history. It also
 * says something the live bundle cannot — what the operator declared, as opposed
 * to what survived.
 */
async function readDeclaredRevision(
  request: APIRequestContext,
  auth: string,
): Promise<PolicyBundleResponse | undefined> {
  const response = await request.get("/api/v1/policy-bundle/history", {
    headers: { Authorization: auth },
  });
  if (!response.ok()) return undefined;
  const items = ((await response.json()) as { items?: PolicyBundleResponse[] })
    .items;
  if (!Array.isArray(items)) return undefined;
  // Highest revision wins: a restart onto a persisted database appends a second
  // bootstrap rather than replacing the first, and the newest is the one whose
  // environment is running.
  return items
    .filter((item) => item.source === "environment")
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
}

/**
 * Skip unless the **deployment** declared `required`. Returns the live bundle,
 * which is what a caller needs for `expected_revision` and for restoring.
 *
 * The provenance half is not a formality, and it is what keeps this lane honest.
 * The same blocked set written through the admin API satisfies every other
 * condition here while exercising the OSS path `regression/governance/` already
 * covers — and it is not a hypothetical state, since a previous run of these
 * very specs leaves the container that way.
 *
 * Skipping is the right verdict rather than failing, for the same reason the
 * rest of this gate skips: the instance is not the one the spec needs, which is
 * a statement about the environment, not about Langflow.
 */
export async function requireEnvironmentPolicy(
  request: APIRequestContext,
  auth: string,
  required: RequiredEnvironmentPolicy,
): Promise<PolicyBundleResponse> {
  const bundle = await readPolicyBundle(request, auth);
  const declaration = await readDeclaredRevision(request, auth);

  test.skip(
    declaration === undefined,
    `This instance has no environment-declared policy revision (live bundle is ` +
      `revision ${bundle.revision}, source '${bundle.source}'). These specs read ` +
      `the policy the DEPLOYMENT declared, which the admin API cannot produce. ` +
      `Start the instance with: ${startCommandFor(required)}`,
  );

  const missing = PARTS.flatMap((part) =>
    (required[part] ?? [])
      .filter((key) => !declared(declaration!, part).includes(key))
      .map((key) => `${KNOB[part]} is missing '${key}'`),
  );

  const state = PARTS.map(
    (part) => `${KNOB[part]}=[${declared(declaration!, part).join(", ") || "none"}]`,
  ).join(", ");

  test.skip(
    missing.length > 0,
    `The deployment's declared policy (revision ${declaration!.revision}) does ` +
      `not satisfy this spec: ${missing.join("; ")}. It declared ${state}. ` +
      `Start the instance with: ${startCommandFor(required)}`,
  );

  return bundle;
}
