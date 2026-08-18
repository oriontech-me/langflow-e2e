import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import type { CodeIndex } from "./hydrate-fixture-code";

// `type -> installed component source`, read from the running image (#1478).
//
// `GET /api/v1/all` is the component registry:
//   { category: { ComponentType: { template: { code: { value: "<python>" } } } } }
// A fixture node's `data.type` matches those second-level keys (measured on
// 1.12.0.dev31), which is what lets a fixture's frozen source be replaced by the
// image's.
//
// One request per PROCESS: globalSetup already fetches this same endpoint for
// catalog drift (70-85ms / 524KB), and a second fetch per spec would be waste.

/** Not a category: 189 entries keyed by the lowercased type name. */
const NON_CATEGORY_KEYS = new Set(["component_display_names"]);

const ALL_COMPONENTS_PATH = "/api/v1/all";

let cached: CodeIndex | undefined;

/**
 * Builds the index from a raw `GET /api/v1/all` body.
 *
 * Throws when the body yields ZERO component types. `snapshotCatalog` learned
 * this the hard way: a tolerant reader turns `{}`, `null` and
 * `{"detail": "Not authenticated"}` into "no components exist", which downstream
 * reads as "every fixture node is missing from the image" — blaming the fixture
 * for an instance that is still starting.
 */
export function buildCodeIndex(catalog: unknown): CodeIndex {
  const index: CodeIndex = {};
  if (catalog && typeof catalog === "object") {
    for (const [category, components] of Object.entries(
      catalog as Record<string, unknown>,
    )) {
      if (NON_CATEGORY_KEYS.has(category)) continue;
      if (!components || typeof components !== "object") continue;
      for (const [type, entry] of Object.entries(
        components as Record<string, unknown>,
      )) {
        const value = (
          entry as { template?: { code?: { value?: unknown } } } | undefined
        )?.template?.code?.value;
        if (typeof value === "string" && value.length > 0) index[type] = value;
      }
    }
  }
  if (Object.keys(index).length === 0) {
    throw new Error(
      `GET ${ALL_COMPONENTS_PATH} yielded no component types with source code — ` +
        `the catalog is unreadable (backend still starting, or an auth failure ` +
        `answered as 200). Refusing to treat an empty catalog as "no drift".`,
    );
  }
  return index;
}

/** Fetches and caches the index for this process. */
export async function getComponentCodeIndex(
  request: APIRequestContext,
  options?: { headers?: Record<string, string> },
): Promise<CodeIndex> {
  if (cached) return cached;

  const headers = { ...(options?.headers ?? {}) };
  if (!headers.Authorization) {
    const authHeader = await getAuthToken(request);
    if (authHeader) headers.Authorization = authHeader;
  }

  const res = await request.get(ALL_COMPONENTS_PATH, { headers });
  if (res.status() !== 200) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(
      `GET ${ALL_COMPONENTS_PATH} answered ${res.status()} — cannot hydrate ` +
        `fixture component code. Body: ${body}`,
    );
  }
  cached = buildCodeIndex(await res.json());
  return cached;
}

/** Test-only: clears the per-process cache. */
export function resetComponentCodeIndexCache(): void {
  cached = undefined;
}
