import type { APIRequestContext } from "@playwright/test";

/**
 * Shared plumbing for the catalog / model-provider governance specs.
 *
 * The policy bundle is **instance-global**: there is no per-user or per-project
 * scope, so a spec that blocks a component blocks it for every worker sharing
 * that Langflow. That is why these specs are `@destructive` — and why every one
 * of them has to (a) refuse to run against an instance that already carries a
 * policy, and (b) put the instance back exactly as it found it.
 *
 * Both duties live here rather than in each spec, because getting either wrong
 * is not a local failure: a missed restore leaves the rest of the run staring at
 * a catalog with components missing.
 */

/** The three policy sets a spec can write, read back as one snapshot. */
export interface PolicySnapshot {
  revision: number;
  source: string;
  blockedComponents: string[];
  blockedTemplates: string[];
  approvedProviders: string[];
}

export interface PolicyBundleResponse {
  revision?: number;
  source?: string;
  initialized?: boolean;
  blocked_component_keys?: string[];
  blocked_template_keys?: string[];
  approved_provider_ids?: string[];
  // Carried by the bundle and writable through it, but with no dedicated
  // per-resource endpoint of its own — unlike the three above.
  blocked_model_keys?: string[];
  rollback_of_revision?: number | null;
  reason?: string | null;
  managed_externally?: boolean;
}

/**
 * True when nothing is blocked and no provider allowlist is set — the only
 * state in which a "blocked ⇒ absent" assertion can fail for the right reason.
 *
 * Pure on purpose: the skip decision is the part worth unit-testing, and it must
 * not need a running Langflow to be exercised.
 */
export function isPolicyPristine(bundle: PolicyBundleResponse): boolean {
  return (
    (bundle.blocked_component_keys?.length ?? 0) === 0 &&
    (bundle.blocked_template_keys?.length ?? 0) === 0 &&
    (bundle.approved_provider_ids?.length ?? 0) === 0
  );
}

/**
 * One-line description of a non-pristine bundle, for the skip message.
 *
 * The point is that the reason names what was found: "policy not pristine" sends
 * the reader to the instance, `blocked components: Agent` tells them what to
 * clear (#1012 — a skip without a stated cause reads like coverage).
 */
export function describePolicyState(bundle: PolicyBundleResponse): string {
  const parts: string[] = [];
  if (bundle.blocked_component_keys?.length) {
    parts.push(`blocked components: ${bundle.blocked_component_keys.join(", ")}`);
  }
  if (bundle.blocked_template_keys?.length) {
    parts.push(`blocked templates: ${bundle.blocked_template_keys.join(", ")}`);
  }
  if (bundle.approved_provider_ids?.length) {
    parts.push(`approved providers: ${bundle.approved_provider_ids.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "pristine";
}

async function okJson(
  request: APIRequestContext,
  method: "get" | "put",
  url: string,
  auth: string,
  data?: unknown,
): Promise<Record<string, unknown>> {
  const response =
    method === "get"
      ? await request.get(url, { headers: { Authorization: auth } })
      : await request.put(url, { headers: { Authorization: auth }, data });
  if (!response.ok()) {
    throw new Error(
      `${method.toUpperCase()} ${url} answered ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function readPolicyBundle(
  request: APIRequestContext,
  auth: string,
): Promise<PolicyBundleResponse> {
  return (await okJson(
    request,
    "get",
    "/api/v1/policy-bundle",
    auth,
  )) as PolicyBundleResponse;
}

export async function snapshotPolicy(
  request: APIRequestContext,
  auth: string,
): Promise<PolicySnapshot> {
  const bundle = await readPolicyBundle(request, auth);
  return {
    revision: bundle.revision ?? 0,
    source: bundle.source ?? "unknown",
    blockedComponents: bundle.blocked_component_keys ?? [],
    blockedTemplates: bundle.blocked_template_keys ?? [],
    approvedProviders: bundle.approved_provider_ids ?? [],
  };
}

/**
 * Put the instance back the way the snapshot found it.
 *
 * Writes all three sets unconditionally rather than diffing: the whole reason
 * this runs is that a test failed somewhere in the middle, so "what did I
 * actually change" is exactly the thing that cannot be trusted at that point.
 *
 * Throws on a failed write — the caller runs this from an `afterAll` that is
 * expected to fail the suite when restoration does not happen.
 */
export async function restorePolicy(
  request: APIRequestContext,
  auth: string,
  snapshot: PolicySnapshot,
): Promise<void> {
  await okJson(request, "put", "/api/v1/catalog-policy/components", auth, {
    blocked: snapshot.blockedComponents,
  });
  await okJson(request, "put", "/api/v1/catalog-policy/templates", auth, {
    blocked: snapshot.blockedTemplates,
  });
  await okJson(request, "put", "/api/v1/model-provider-policy", auth, {
    approved_provider_ids: snapshot.approvedProviders,
  });
}

/**
 * The keys of every top-level map in `/api/v1/all`, as a set.
 *
 * `/api/v1/all` is `category -> { type -> template }`; the specs assert over the
 * flattened type set because a blocked component is removed from its category,
 * and a category-level count would miss it (the same reason
 * `component-catalog-drift.ts` snapshots types rather than categories).
 *
 * It folds in `component_display_names`, which is a **metadata map and not a
 * category**, so the result is roughly twice the number of real types. That is
 * harmless for the membership and relative-size assertions the governance specs
 * make — its keys are lowercased display names, which collide with nothing —
 * and wrong for anything that compares this set against another catalog. Use
 * {@link readPaletteComponentTypes} for that.
 */
export async function readCatalogTypes(
  request: APIRequestContext,
  auth: string,
): Promise<Set<string>> {
  const catalog = await okJson(request, "get", "/api/v1/all", auth);
  const types = new Set<string>();
  for (const category of Object.values(catalog)) {
    if (category && typeof category === "object") {
      for (const type of Object.keys(category as Record<string, unknown>)) {
        types.add(type);
      }
    }
  }
  return types;
}

/** The one top-level key of `/api/v1/all` that is not a component category. */
const CATALOG_METADATA_KEY = "component_display_names";

/**
 * The component types the palette would render — and only those.
 *
 * The difference from {@link readCatalogTypes} is one excluded key and it
 * decides whether set algebra over this catalog means anything: on the
 * reference Enterprise instance the raw flatten yields 320 entries against 160
 * real types, because `component_display_names` maps every type again by its
 * lowercased display name. Comparing that against another catalog reports 160
 * phantom absences.
 *
 * Kept as a second function rather than a flag on the first: the existing
 * callers assert membership and relative size, where the metadata map costs
 * nothing, and silently changing what their baseline counts would be a change
 * to their meaning, not a fix to their helper.
 */
export async function readPaletteComponentTypes(
  request: APIRequestContext,
  auth: string,
): Promise<Set<string>> {
  const catalog = await okJson(request, "get", "/api/v1/all", auth);
  const types = new Set<string>();
  for (const [name, category] of Object.entries(catalog)) {
    if (name === CATALOG_METADATA_KEY) continue;
    if (category && typeof category === "object") {
      for (const type of Object.keys(category as Record<string, unknown>)) {
        types.add(type);
      }
    }
  }
  return types;
}

/** A minimal saveable flow carrying exactly one node of the given type. */
export function singleNodeFlow(name: string, componentType: string) {
  const nodeId = `${componentType}-spec`;
  return {
    name,
    description: "Created by the catalog-policy spec",
    data: {
      nodes: [
        {
          id: nodeId,
          type: "genericNode",
          position: { x: 0, y: 0 },
          data: {
            id: nodeId,
            type: componentType,
            node: { display_name: componentType, template: {} },
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
}
