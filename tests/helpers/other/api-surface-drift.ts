/**
 * The OSS API surface: its inventory, and the drift verdict reported at the gate
 * (#1692).
 *
 * Why this exists at all: `/openapi.json` is **not** the API. Measured on
 * `langflowai/langflow-nightly:latest` (`1.13.0.dev0` and `1.13.0.dev1`, byte-
 * identical schemas), the document carries 86 paths / 120 operations while the
 * instance's own router table carries 249 — **137 of them hidden**
 * (`include_in_schema=False`). Three of those hidden families are already driven
 * by existing specs (`variables`, `api_key`, `custom_component`), so a schema-
 * derived denominator would report 100 % with tests this suite already has
 * sitting outside the count.
 *
 * The full measurement, the exclusions and their reasons:
 * `docs/api/api-surface-coverage-gauge.md`.
 *
 * Layering, copied from `component-catalog-drift.ts` because that split is what
 * made its guarantee testable rather than asserted: everything here is pure and
 * `apiSurfaceVerdict` **cannot throw**, so `globalSetup` holds nothing but I/O.
 */

/** One operation of the surface, keyed by `METHOD path`. */
export interface ApiOperation {
  method: string;
  /**
   * The path **as the router registered it**, trailing slash included when that
   * is the only registered spelling. Never normalised away — see
   * `normalizeRouteTable`.
   */
  path: string;
  /** Whether `/openapi.json` exposes it (`include_in_schema`). */
  inSchema: boolean;
}

/** A prefix taken out of the denominator, with the reason it was. */
export interface ApiScopeExclusion {
  prefix: string;
  reason: string;
}

/** The committed baseline — `tests/assets/api/api-surface-baseline.json`. */
export interface ApiSurfaceBaseline {
  /** Langflow version the table was extracted from, for the report line. */
  version?: string;
  exclusions: ApiScopeExclusion[];
  operations: ApiOperation[];
}

export interface ApiSurfaceVerdict {
  /**
   * `clean` — the schema-visible half matches. `drift` — it differs, with `lines`
   * naming how. `unknown` — no comparison was possible, with `reason` naming
   * why. There is no fourth state: an unevaluated surface is unknown, never
   * clean (#1012).
   */
  kind: "clean" | "drift" | "unknown";
  /** Report lines, removals first. Empty unless `kind === "drift"`. */
  lines: string[];
  /** Why no verdict was possible. Set iff `kind === "unknown"`. */
  reason?: string;
  /** Schema-visible operations compared. 0 when unknown. */
  schemaCount: number;
  /**
   * Hidden operations taken from the baseline without live verification.
   *
   * They are absent from `/openapi.json` by construction, so there is nothing to
   * compare them against over HTTP. The count is reported so a reader never
   * mistakes the comparison for the whole surface — only `npm run api:baseline`,
   * which reads the instance's own process, can refresh them.
   */
  hiddenCarried: number;
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

/** The stable key of an operation. */
export function opKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The operations `/openapi.json` exposes.
 *
 * `null` means **no signal** — the body was not an OpenAPI document — which the
 * verdict turns into UNKNOWN. An empty array is a different claim ("the schema
 * has no operations") and is also refused by the verdict, because a 200 carrying
 * no paths is what a still-starting instance answers, and diffing it would report
 * every schema-visible operation as removed.
 */
export function schemaOperations(
  openapi: unknown,
): Array<{ method: string; path: string }> | null {
  if (!isRecord(openapi)) return null;
  const paths = openapi.paths;
  if (!isRecord(paths)) return null;
  const out: Array<{ method: string; path: string }> = [];
  for (const [p, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const key of Object.keys(item)) {
      // A path item legally carries `parameters`, `summary`, `servers`, `$ref`.
      if (!HTTP_METHODS.has(key.toLowerCase())) continue;
      out.push({ method: key.toUpperCase(), path: p });
    }
  }
  return out;
}

/**
 * The router table, de-duplicated — and the one normalisation that is *not*
 * allowed here.
 *
 * FastAPI registers many paths twice, with and without a trailing slash; those
 * are one operation. The tempting rule — `rstrip("/")` — is **wrong**, measured:
 * `POST /api/v2/files/batch/` is registered ONLY with the slash, and the
 * slash-less spelling falls through to `/api/v2/files/{file_id}`, answering
 * `405` (and `422 uuid_parsing` on DELETE, with `input: "batch"`). Stripping it
 * would put a key in the baseline that no client can call.
 *
 * So: collapse a pair onto the slash-less form **only when the router registered
 * both**, per method; otherwise keep the spelling verbatim.
 *
 * Throws on a malformed table. This runs in the baseline refresh, never at the
 * gate: a silently skipped entry is an operation missing from the denominator
 * forever, which is the failure the catalog writer's `--min-categories` floor
 * exists to prevent.
 */
export function collapseSlashPairs<T extends { method: string; path: string }>(
  operations: T[],
): T[] {
  const registered = new Set(
    operations.map((o) => opKey(o.method, o.path)),
  );
  const byKey = new Map<string, T>();
  for (const op of operations) {
    const slashless =
      op.path.length > 1 ? op.path.replace(/\/+$/, "") : op.path;
    const bothRegistered =
      op.path !== slashless && registered.has(opKey(op.method, slashless));
    const canonical = bothRegistered ? slashless : op.path;
    const key = opKey(op.method, canonical);
    const existing = byKey.get(key);
    byKey.set(key, {
      ...(existing ?? op),
      ...op,
      method: op.method.toUpperCase(),
      path: canonical,
      // A pair disagreeing about `include_in_schema` counts as exposed: the
      // schema is what the drift comparison can see, and treating the exposed
      // half as hidden would drop it from the compared set.
      ...(("inSchema" in op)
        ? {
            inSchema:
              ((existing as { inSchema?: boolean } | undefined)?.inSchema ??
                false) || (op as { inSchema?: boolean }).inSchema === true,
          }
        : {}),
    } as T);
  }
  return [...byKey.values()].sort((a, b) =>
    opKey(a.method, a.path) < opKey(b.method, b.path) ? -1 : 1,
  );
}

export function normalizeRouteTable(raw: unknown): ApiOperation[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `the route table must be an array of {method, path, inSchema}, got ${typeof raw}`,
    );
  }
  const entries: ApiOperation[] = raw.map((e, i) => {
    if (
      !isRecord(e) ||
      typeof e.method !== "string" ||
      typeof e.path !== "string" ||
      !e.path.startsWith("/")
    ) {
      throw new Error(
        `malformed route entry at index ${i}: ${JSON.stringify(e)} — expected {method, path, inSchema}`,
      );
    }
    return {
      method: e.method.toUpperCase(),
      path: e.path,
      inSchema: e.inSchema === true,
    };
  });

  return collapseSlashPairs(entries);
}

/**
 * Why a baseline cannot be used, or `null` when it can.
 *
 * Deliberately structural and not a schema library: the failure this guards
 * against is a hand-repaired file, and the most natural hand repair is pasting
 * the wrong body in (the catalog baseline was aborted a whole run by exactly
 * that, #1040).
 */
export function describeBaselineDefect(baseline: unknown): string | null {
  if (!isRecord(baseline)) {
    return `the baseline is not an object (got ${baseline === null ? "null" : typeof baseline})`;
  }
  const { operations } = baseline;
  if (!Array.isArray(operations)) {
    return `the baseline has no \`operations\` array (got ${typeof operations})`;
  }
  if (operations.length === 0) {
    return "the baseline lists no operations at all";
  }
  for (const [i, op] of operations.entries()) {
    if (!isRecord(op) || typeof op.method !== "string") {
      return `operation ${i} has no \`method\` string: ${JSON.stringify(op)}`;
    }
    if (typeof op.path !== "string" || !op.path.startsWith("/")) {
      return `operation ${i} has no absolute \`path\`: ${JSON.stringify(op)}`;
    }
  }
  return null;
}

/**
 * The denominator: every operation the baseline lists, minus the excluded
 * prefixes.
 *
 * A family nobody classified stays **in** scope, so it surfaces as uncovered in
 * the report. Defaulting it out would hide a whole surface behind a decision
 * nobody made — the rule `--mode=check` already applies to the `lfx` subtrees in
 * `scripts/watch-upstream-areas.mjs`.
 */
export function inScopeOperations(baseline: ApiSurfaceBaseline): ApiOperation[] {
  const exclusions = Array.isArray(baseline?.exclusions)
    ? baseline.exclusions.filter(
        (e): e is ApiScopeExclusion =>
          isRecord(e) && typeof e.prefix === "string",
      )
    : [];
  return (baseline?.operations ?? []).filter(
    (op) => !exclusions.some((e) => op.path.startsWith(e.prefix)),
  );
}

/**
 * The whole comparison, as a pure function that **cannot throw**.
 *
 * Only the **schema-visible** half is compared: the hidden operations are absent
 * from `/openapi.json` by construction, so diffing them against it would report
 * all 90 as removed on every run. Both arguments are RAW — the baseline as parsed
 * off disk, `openapi` as the body of `GET /openapi.json`.
 */
export function apiSurfaceVerdict(
  baseline: unknown,
  openapi: unknown,
): ApiSurfaceVerdict {
  try {
    const defect = describeBaselineDefect(baseline);
    if (defect) {
      return {
        kind: "unknown",
        lines: [],
        schemaCount: 0,
        hiddenCarried: 0,
        reason: `the baseline is unusable — ${defect}`,
      };
    }
    const parsed = baseline as ApiSurfaceBaseline;
    const live = schemaOperations(openapi);
    if (live === null) {
      return {
        kind: "unknown",
        lines: [],
        schemaCount: 0,
        hiddenCarried: 0,
        reason:
          "GET /openapi.json did not answer an OpenAPI document (no `paths` object)",
      };
    }
    if (live.length === 0) {
      // A 200 is not a surface (#1012's floor). An instance whose routers are
      // still assembling answers an empty schema, and diffing it would claim
      // every schema-visible operation vanished.
      return {
        kind: "unknown",
        lines: [],
        schemaCount: 0,
        hiddenCarried: 0,
        reason:
          "GET /openapi.json answered a document with no operations — the surface is unknown, not empty",
      };
    }

    const expected = new Set(
      parsed.operations
        .filter((op) => op.inSchema)
        .map((op) => opKey(op.method, op.path)),
    );
    const hiddenCarried = parsed.operations.filter((op) => !op.inSchema).length;
    // The LIVE side gets the same collapse. `/openapi.json` exposes both
    // `/api/v2/files` and `/api/v2/files/` while the baseline holds one key for
    // the pair, so without this the twin is reported as ADDED on a surface that
    // did not change — a drift warning firing on every run, which is the noise
    // #1084 was raised about. Found by this very gate on its first real run.
    const actual = new Set(
      collapseSlashPairs(live).map((op) => opKey(op.method, op.path)),
    );

    const removed = [...expected].filter((k) => !actual.has(k)).sort();
    const added = [...actual].filter((k) => !expected.has(k)).sort();

    if (removed.length === 0 && added.length === 0) {
      return {
        kind: "clean",
        lines: [],
        schemaCount: actual.size,
        hiddenCarried,
      };
    }
    return {
      kind: "drift",
      // Removals first: a vanished operation is what breaks a spec, an added one
      // costs nobody a test (#980).
      lines: [
        ...removed.map((k) => `  REMOVED ${k}`),
        ...added.map((k) => `  ADDED   ${k}`),
      ],
      schemaCount: actual.size,
      hiddenCarried,
    };
  } catch (e) {
    return {
      kind: "unknown",
      lines: [],
      schemaCount: 0,
      hiddenCarried: 0,
      reason: `the comparison itself failed — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
