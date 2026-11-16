import type { APIRequestContext } from "@playwright/test";
import { tierGateCause } from "../enterprise/tier-gate";

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
  // 1.13 (langflow-ai/langflow#14947): integration policy rides the same bundle.
  // A bundle write that omits them RESETS them to empty, so any caller writing
  // the whole bundle must carry them through.
  approved_integration_provider_ids?: string[];
  blocked_integration_action_keys?: string[];
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
    const text = await response.text();
    // OSS never answers the licence 503; an Enterprise 1.13+ instance does when
    // its tier gates are closed, and naming the flag beats quoting the body.
    const cause = tierGateCause(response.status(), text);
    throw new Error(
      `${method.toUpperCase()} ${url} answered ${response.status()}: ${text}` +
        (cause ? ` — ${cause}` : ""),
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

/**
 * The six policy sets `PUT /api/v1/policy-bundle` writes, in one place.
 *
 * That endpoint is a FULL replacement (#2299): a set the body leaves out is
 * stored as `[]`, so a write that carried only the integration fields would
 * silently clear a component block someone else set. Every bundle write here
 * therefore sends all six.
 */
export const POLICY_BUNDLE_SETS = [
  "approved_provider_ids",
  "blocked_component_keys",
  "blocked_template_keys",
  "blocked_model_keys",
  "approved_integration_provider_ids",
  "blocked_integration_action_keys",
] as const;

export type PolicyBundleSetName = (typeof POLICY_BUNDLE_SETS)[number];
export type PolicyBundleSets = Record<PolicyBundleSetName, string[]>;

/** The six sets of a bundle read, an absent one read as `[]`. */
export function bundleSets(bundle: PolicyBundleResponse): PolicyBundleSets {
  const sets = {} as PolicyBundleSets;
  for (const name of POLICY_BUNDLE_SETS) sets[name] = [...(bundle[name] ?? [])];
  return sets;
}

/**
 * True when all six sets are empty. Unlike {@link isPolicyPristine}, this one
 * also reads the model and integration sets: a leftover integration block makes
 * every "blocked ⇒ absent" assertion of the integration spec unfalsifiable.
 */
export function isBundlePristine(bundle: PolicyBundleResponse): boolean {
  return POLICY_BUNDLE_SETS.every((name) => (bundle[name]?.length ?? 0) === 0);
}

/** Names every non-empty set, for a skip message that says what to clear (#1012). */
export function describeBundleSets(bundle: PolicyBundleResponse): string {
  const parts = POLICY_BUNDLE_SETS.filter((name) => (bundle[name]?.length ?? 0) > 0).map(
    (name) => `${name}: ${(bundle[name] ?? []).join(", ")}`,
  );
  return parts.length > 0 ? parts.join("; ") : "pristine";
}

/** Same members, order ignored — the server sorts what it stores. */
export function sameBundleSets(a: PolicyBundleSets, b: PolicyBundleSets): boolean {
  return POLICY_BUNDLE_SETS.every((name) => {
    const left = [...a[name]].sort();
    const right = [...b[name]].sort();
    return left.length === right.length && left.every((value, i) => value === right[i]);
  });
}

/**
 * The body of a `PUT /api/v1/policy-bundle`: the current bundle's six sets with
 * `overrides` applied, and the current revision as `expected_revision`, which
 * the endpoint requires (a write without it is refused `422`; a stale one `409`).
 */
export function buildBundleWrite(
  current: PolicyBundleResponse,
  overrides: Partial<PolicyBundleSets>,
  reason: string,
): PolicyBundleSets & { expected_revision: number; reason: string } {
  return {
    ...bundleSets(current),
    ...overrides,
    expected_revision: current.revision ?? 0,
    reason,
  };
}

/**
 * Put the six sets back as `snapshot` had them, through the bundle itself.
 *
 * {@link restorePolicy} cannot do this: the catalog and model-provider writers
 * carry the integration sets forward unchanged, so it would leave an integration
 * block in place. Reads the active bundle first and writes only when it differs,
 * so a clean teardown costs no revision. Throws when the write fails or when the
 * active bundle still differs afterwards — the caller runs this from `afterAll`,
 * where a bundle left blocked must fail the suite.
 */
export async function restorePolicyBundle(
  request: APIRequestContext,
  auth: string,
  snapshot: PolicyBundleSets,
  reason = "Restored by the e2e suite",
): Promise<void> {
  const current = await readPolicyBundle(request, auth);
  if (sameBundleSets(bundleSets(current), snapshot)) return;
  await okJson(request, "put", "/api/v1/policy-bundle", auth, buildBundleWrite(current, snapshot, reason));
  const after = bundleSets(await readPolicyBundle(request, auth));
  if (!sameBundleSets(after, snapshot)) {
    throw new Error(
      `policy bundle not restored: expected ${describeBundleSets(snapshot)}, found ${describeBundleSets(after)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// API v2 (#2451): `/api/v2/policy-bundle`, where two sets are tri-state.
// ---------------------------------------------------------------------------

/**
 * How API v1 spells "deny every integration". v1 reads an unrestricted
 * (`null`) integration set as `[]`, so deny-all needs a value of its own there;
 * v2 refuses this marker with a `422` and spells deny-all as `[]`.
 */
export const INTEGRATION_DENY_ALL_MARKER = "langflow-reserved.integration-policy.deny-all";

/** The v2 sets that are plain lists: absent or empty both mean "nothing set". */
export const POLICY_BUNDLE_V2_LIST_SETS = [
  "approved_provider_ids",
  "blocked_component_keys",
  "blocked_template_keys",
  "blocked_model_keys",
  "blocked_integration_action_keys",
] as const;

/**
 * The v2 sets that are tri-state: `null` is unrestricted, `[]` denies every
 * provider or trigger kind, and a list approves exactly those.
 */
export const POLICY_BUNDLE_V2_NULLABLE_SETS = ["approved_integration_provider_ids", "approved_trigger_kinds"] as const;

export type PolicyBundleV2ListSet = (typeof POLICY_BUNDLE_V2_LIST_SETS)[number];
export type PolicyBundleV2NullableSet = (typeof POLICY_BUNDLE_V2_NULLABLE_SETS)[number];
export type PolicyBundleV2Sets = Record<PolicyBundleV2ListSet, string[]> &
  Record<PolicyBundleV2NullableSet, string[] | null>;

export interface PolicyBundleV2Response extends Partial<PolicyBundleV2Sets> {
  revision?: number;
  source?: string;
  initialized?: boolean;
  content_hash?: string;
  reason?: string | null;
  rollback_of_revision?: number | null;
  managed_externally?: boolean;
}

/**
 * The seven sets of a v2 read. An absent list reads `[]`; an absent tri-state
 * set reads `null`, because a server that does not send it has no such
 * restriction.
 */
export function bundleV2Sets(bundle: PolicyBundleV2Response): PolicyBundleV2Sets {
  const sets = {} as PolicyBundleV2Sets;
  for (const name of POLICY_BUNDLE_V2_LIST_SETS) sets[name] = [...(bundle[name] ?? [])];
  for (const name of POLICY_BUNDLE_V2_NULLABLE_SETS) {
    const value = bundle[name];
    sets[name] = value === null || value === undefined ? null : [...value];
  }
  return sets;
}

/**
 * True when no list is populated and both tri-state sets are `null`. Unlike
 * {@link isBundlePristine}, `[]` in a tri-state set is NOT pristine: it denies
 * every integration or every trigger kind.
 */
export function isBundleV2Pristine(bundle: PolicyBundleV2Response): boolean {
  const sets = bundleV2Sets(bundle);
  return (
    POLICY_BUNDLE_V2_LIST_SETS.every((name) => sets[name].length === 0) &&
    POLICY_BUNDLE_V2_NULLABLE_SETS.every((name) => sets[name] === null)
  );
}

/** Names every set that is not pristine, for a skip message that says what to clear (#1012). */
export function describeBundleV2(bundle: PolicyBundleV2Response): string {
  const sets = bundleV2Sets(bundle);
  const parts: string[] = [];
  for (const name of POLICY_BUNDLE_V2_LIST_SETS) {
    if (sets[name].length > 0) parts.push(`${name}: ${sets[name].join(", ")}`);
  }
  for (const name of POLICY_BUNDLE_V2_NULLABLE_SETS) {
    const value = sets[name];
    if (value !== null) parts.push(`${name}: ${value.length > 0 ? value.join(", ") : "[] (denies all)"}`);
  }
  return parts.length > 0 ? parts.join("; ") : "pristine";
}

const sortedEqual = (left: string[], right: string[]) => {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
};

/** Same members, order ignored, and `null` never equal to `[]`. */
export function sameBundleV2Sets(a: PolicyBundleV2Sets, b: PolicyBundleV2Sets): boolean {
  return (
    POLICY_BUNDLE_V2_LIST_SETS.every((name) => sortedEqual(a[name], b[name])) &&
    POLICY_BUNDLE_V2_NULLABLE_SETS.every((name) => {
      const left = a[name];
      const right = b[name];
      if (left === null || right === null) return left === right;
      return sortedEqual(left, right);
    })
  );
}

/**
 * The body of a `PUT /api/v2/policy-bundle`: every set of the current bundle
 * with `overrides` applied, and the current revision as `expected_revision`.
 * The tri-state sets are always sent, so a write can never fall back to "keep
 * the active value" by omission.
 */
export function buildBundleV2Write(
  current: PolicyBundleV2Response,
  overrides: Partial<PolicyBundleV2Sets>,
  reason: string,
): PolicyBundleV2Sets & { expected_revision: number; reason: string } {
  return {
    ...bundleV2Sets(current),
    ...overrides,
    expected_revision: current.revision ?? 0,
    reason,
  };
}

export async function readPolicyBundleV2(request: APIRequestContext, auth: string): Promise<PolicyBundleV2Response> {
  return (await okJson(request, "get", "/api/v2/policy-bundle", auth)) as PolicyBundleV2Response;
}

/** Write the current v2 bundle with `overrides` applied. Throws on a non-2xx answer. */
export async function writePolicyBundleV2(
  request: APIRequestContext,
  auth: string,
  overrides: Partial<PolicyBundleV2Sets>,
  reason: string,
): Promise<PolicyBundleV2Response> {
  const current = await readPolicyBundleV2(request, auth);
  return (await okJson(
    request,
    "put",
    "/api/v2/policy-bundle",
    auth,
    buildBundleV2Write(current, overrides, reason),
  )) as PolicyBundleV2Response;
}

/**
 * Put all seven sets back as `snapshot` had them, through v2.
 *
 * {@link restorePolicyBundle} cannot undo a v2 write: v1 reads an unrestricted
 * integration set and a deny-all one differently, and a v1 write that leaves
 * `approved_trigger_kinds` out keeps the active value. Writes only when the
 * active bundle differs, and throws when it still differs afterwards.
 */
export async function restorePolicyBundleV2(
  request: APIRequestContext,
  auth: string,
  snapshot: PolicyBundleV2Sets,
  reason = "Restored by the e2e suite",
): Promise<void> {
  const current = await readPolicyBundleV2(request, auth);
  if (sameBundleV2Sets(bundleV2Sets(current), snapshot)) return;
  await okJson(request, "put", "/api/v2/policy-bundle", auth, buildBundleV2Write(current, snapshot, reason));
  const after = await readPolicyBundleV2(request, auth);
  if (!sameBundleV2Sets(bundleV2Sets(after), snapshot)) {
    throw new Error(
      `policy bundle not restored: expected ${describeBundleV2(snapshot)}, found ${describeBundleV2(after)}`,
    );
  }
}
