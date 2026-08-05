/**
 * Detects drift in Langflow's component catalog between the image we last
 * accepted and the one under test (#1040).
 *
 * ## Why this exists
 *
 * Since 1.12, **which components exist is a packaging decision, per image.** Most
 * component families moved out of `lfx.components.*` into per-vendor
 * distributions (`lfx_openai`, `lfx_anthropic`, `lfx_google`, …) plus an aggregate
 * `lfx-bundles` that the nightly image does **not** install. So a component's
 * presence in the sidebar no longer follows from "Langflow supports it" — it
 * follows from which `lfx_*` distribution the image ships.
 *
 * The rule the detector rests on, in the direction that actually holds: **no
 * category appears for a family the image does not ship.** Measured on
 * `1.12.0.dev10` against `origin/release-1.12.0` — every shim directory with a
 * category has its distribution installed (10 of 10), and the other 69 shims have
 * none.
 *
 * The converse is false and stating it that way would mislead: 11 of the 27 core
 * directories produce no category at all, and three installed distributions have
 * no category of their own (`lfx_datastax` supplies two, `lfx_vllm` and
 * `lfx_openai_compatible` ship no components). A directory count does not predict
 * a catalog, which is the same lesson as `knowledge_bases` below.
 *
 * The cost of that being invisible is not a missed test — it is a **misattributed**
 * one. A vanished family surfaces as a generic `waitForSelector` timeout 30 s deep
 * in a spec, and it has already been diagnosed wrongly twice: #898 and #907 were
 * both attributed to missing `langchain-*` extras when the packaging split was at
 * least as much of the cause (#1039 corrected the record). This runs in
 * `globalSetup` — the pre-flight gate that exists to remove exactly that
 * misclassification tax (#884) — so the cause is named before the first spec runs.
 *
 * ## What it compares, and why not just the category list
 *
 * #1040 asks for "the category list". That alone would miss a component being
 * **reparented** from one category to another, which the migration does routinely
 * and which breaks a spec just as thoroughly as a family disappearing: the
 * component is still "there", under a name the spec does not look under. So the
 * snapshot is `category -> component type keys` — 36 categories and 189 component
 * types on `1.12.0.dev10`, a ~5 KB baseline — and a reparented component is
 * reported as **moved**, not as one removal plus one unrelated addition.
 *
 * ## `component_display_names` is not a category
 *
 * `GET /api/v1/all` carries one key that is a metadata map rather than a component
 * family: `component_display_names`, holding one entry per component (189 of them,
 * keyed by the lowercased type name). Folding it into the snapshot would add a
 * 37th pseudo-category of 189 entries — every component listed a second time, and
 * every one of them then permanently "reparented" the moment a real category
 * changes. It is excluded by name.
 *
 * The keys are **lowercased**, so they do not collide with the real cased type
 * names (measured: exactly 1 of the 189 real type names, `policies`, is already
 * all-lowercase). That is worth stating precisely, because the tempting stronger
 * claim — that folding the map in would make reparenting undetectable outright —
 * is false: it would mask reparenting only for that one already-lowercase
 * component. The exclusion is right; its blast radius is a spurious category, not
 * a blind detector.
 *
 * (Worth recording because the sibling probe does *not* exclude it:
 * `isProviderComponentAvailable` iterates every value of the registry. That is
 * harmless there — the extra keys are the same component types lowercased, and the
 * probe lowercases before matching, so the duplicate matches the same set — but it
 * is harmless by luck, not by design.)
 */

/** Keys of `GET /api/v1/all` that are metadata, not component families. */
const NON_CATEGORY_KEYS = new Set(["component_display_names"]);

export interface CatalogSnapshot {
  /**
   * Langflow version the snapshot came from. Reporting only — a diff is never
   * suppressed because the version matches, since a rebuilt image can change the
   * catalog without changing the version string.
   */
  version?: string;
  /** category -> its component type keys, sorted. */
  categories: Record<string, string[]>;
}

export interface CategoryChange {
  category: string;
  /** How many component types the category holds/held. */
  componentCount: number;
  /**
   * For a REMOVED category: the component types absent from the new catalog
   * **entirely**, rather than reparented into another category. Always empty for
   * an added category.
   *
   * This distinction is the difference between a true and a false statement in
   * the report. A category can disappear with every one of its components
   * surviving elsewhere — the 1.12 migration does exactly that — and in that case
   * "every spec that places one of these will time out" is simply wrong. Only a
   * non-empty `vanishedTypes` justifies that claim.
   *
   * It is the type **names**, not a count, because the whole point of this
   * mechanism is that the cause is named before the first spec runs. A reader told
   * "2 of 3 gone" still has to hand-diff the baseline to learn *which* two, which
   * is the work this exists to remove.
   */
  vanishedTypes: string[];
}

export interface ComponentChange {
  type: string;
  category: string;
}

export interface ComponentMove {
  type: string;
  from: string;
  to: string;
}

export interface CatalogDrift {
  addedCategories: CategoryChange[];
  removedCategories: CategoryChange[];
  /**
   * Components gained/lost by a category that exists in BOTH snapshots.
   *
   * Deliberately excludes components belonging to a category that was itself
   * added or removed: reporting `groq` disappearing as one category removal plus
   * every one of its components would bury the one line that explains the rest.
   * The category entry carries the count instead.
   */
  addedComponents: ComponentChange[];
  removedComponents: ComponentChange[];
  /** Present in both snapshots, under a different category. */
  movedComponents: ComponentMove[];
  hasDrift: boolean;
}

/**
 * Builds a snapshot from a raw `GET /api/v1/all` body.
 *
 * Tolerant by design: a value that is not an object is skipped rather than
 * throwing. This runs in `globalSetup`, where a throw would abort the whole suite
 * over a reporting feature — the caller reports "no verdict" instead (#1012).
 */
export function snapshotCatalog(
  registry: unknown,
  version?: string,
): CatalogSnapshot {
  const categories: Record<string, string[]> = {};
  if (registry && typeof registry === "object" && !Array.isArray(registry)) {
    // Category keys are sorted, not merely inserted in the order the API
    // happened to emit them. Two reasons, and the second is a correctness one:
    // the baseline is reviewed as a diff, and `componentIndex` is last-wins over
    // a relation that is not guaranteed 1:1 — so with insertion order, one type
    // registered by two distributions would resolve to a different category per
    // snapshot and report a phantom MOVED on an *identical* catalog. A warning
    // that no `catalog:baseline` refresh can silence is exactly how this gate
    // would train readers to ignore it.
    for (const [category, components] of Object.entries(
      registry as Record<string, unknown>,
    ).sort(([a], [b]) => a.localeCompare(b))) {
      if (NON_CATEGORY_KEYS.has(category)) continue;
      if (!components || typeof components !== "object") continue;
      if (Array.isArray(components)) continue;
      categories[category] = Object.keys(
        components as Record<string, unknown>,
      ).sort();
    }
  }
  return version === undefined ? { categories } : { version, categories };
}

/**
 * Names why `value` is not a usable snapshot, or `null` when it is.
 *
 * Exists because the two sides of the comparison arrive by different routes and
 * only one of them is normalised. The **current** catalog goes through
 * `snapshotCatalog`, which is tolerant by construction. The **baseline** is a
 * hand-reviewable file read straight off disk, and `JSON.parse` succeeding says
 * nothing about its shape: the most natural wrong repair is pasting the raw
 * `GET /api/v1/all` body, whose values are `{type: template}` objects rather than
 * arrays of type names. That parses, and it used to reach `diffCatalogSnapshots`,
 * where iterating a non-array throws — out of `globalSetup`, aborting the run with
 * **zero tests executed**. A reporting feature must not be able to cost a day of
 * coverage (#980), so the shape is checked here and reported as "no verdict"
 * (#1012) with the actual defect named.
 */
export function describeSnapshotDefect(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "it does not hold a JSON object";
  }
  const categories = (value as { categories?: unknown }).categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) {
    return "it has no `categories` object";
  }
  const entries = Object.entries(categories as Record<string, unknown>);
  if (entries.length === 0) {
    return "its `categories` object is empty — an empty baseline reports the whole real catalog as new";
  }
  for (const [category, types] of entries) {
    if (!Array.isArray(types)) {
      return (
        `category \`${category}\` maps to ${types === null ? "null" : typeof types}, not an array of ` +
        "component type names — that is the raw `GET /api/v1/all` shape, not a snapshot of it"
      );
    }
    if (types.some((type) => typeof type !== "string")) {
      return `category \`${category}\` holds a component type that is not a string`;
    }
  }
  return null;
}

/**
 * `type -> category` for every component in a snapshot.
 *
 * Last-wins if a type somehow appears under two categories. Zero such duplicates
 * exist on `1.12.0.dev10` (189 types, 189 unique), but an aggregate `lfx-bundles`
 * image invites them, so the winner is made deterministic by sorting the category
 * keys in `snapshotCatalog` — see the note there. The residual limitation is
 * benign and worth stating: a duplicated type's second home is invisible to the
 * diff, so moving it *between* those two homes reports nothing.
 */
function componentIndex(snapshot: CatalogSnapshot): Map<string, string> {
  const index = new Map<string, string>();
  for (const [category, types] of Object.entries(snapshot.categories)) {
    for (const type of types) index.set(type, category);
  }
  return index;
}

export function diffCatalogSnapshots(
  baseline: CatalogSnapshot,
  current: CatalogSnapshot,
): CatalogDrift {
  const baseCats = new Set(Object.keys(baseline.categories));
  const currCats = new Set(Object.keys(current.categories));

  const baseIndex = componentIndex(baseline);
  const currIndex = componentIndex(current);

  const addedCategories: CategoryChange[] = [...currCats]
    .filter((c) => !baseCats.has(c))
    .sort()
    .map((category) => ({
      category,
      componentCount: current.categories[category].length,
      vanishedTypes: [],
    }));
  const removedCategories: CategoryChange[] = [...baseCats]
    .filter((c) => !currCats.has(c))
    .sort()
    .map((category) => ({
      category,
      componentCount: baseline.categories[category].length,
      vanishedTypes: baseline.categories[category].filter(
        (type) => !currIndex.has(type),
      ),
    }));

  const movedComponents: ComponentMove[] = [];
  const addedComponents: ComponentChange[] = [];
  const removedComponents: ComponentChange[] = [];

  for (const [type, category] of currIndex) {
    const was = baseIndex.get(type);
    if (was === undefined) {
      // Suppressed when the whole category is new — the category line says it.
      if (currCats.has(category) && baseCats.has(category)) {
        addedComponents.push({ type, category });
      }
      continue;
    }
    if (was !== category) movedComponents.push({ type, from: was, to: category });
  }

  for (const [type, category] of baseIndex) {
    if (currIndex.has(type)) continue;
    // Same suppression: a component lost with its entire category is explained
    // by the `removedCategories` entry and its count.
    if (baseCats.has(category) && currCats.has(category)) {
      removedComponents.push({ type, category });
    }
  }

  const bySortKey = (a: { type: string }, b: { type: string }) =>
    a.type.localeCompare(b.type);
  addedComponents.sort(bySortKey);
  removedComponents.sort(bySortKey);
  movedComponents.sort(bySortKey);

  return {
    addedCategories,
    removedCategories,
    addedComponents,
    removedComponents,
    movedComponents,
    hasDrift:
      addedCategories.length > 0 ||
      removedCategories.length > 0 ||
      addedComponents.length > 0 ||
      removedComponents.length > 0 ||
      movedComponents.length > 0,
  };
}

export interface CatalogVerdict {
  /**
   * `clean` — the catalog matches. `drift` — it differs, with `lines` naming how.
   * `unknown` — no comparison was possible, with `reason` naming why. There is no
   * fourth state: an unevaluated catalog is unknown, never clean (#1012).
   */
  kind: "clean" | "drift" | "unknown";
  /** Report lines, removals first. Empty unless `kind === "drift"`. */
  lines: string[];
  /** Why no verdict was possible. Set iff `kind === "unknown"`. */
  reason?: string;
  /** Categories in the catalog under test; 0 when unknown. */
  categoryCount: number;
}

/**
 * The whole comparison, as a pure function that **cannot throw**.
 *
 * This is deliberately not inlined in `globalSetup`. A throw there aborts the run
 * with zero tests executed, which is a day of coverage lost to a reporting
 * feature (#980) — and the version of this that lived inline was reachable in
 * exactly that way, because it validated the baseline only far enough to know it
 * was an object. Keeping the logic here leaves `globalSetup` holding nothing but
 * I/O, and makes the property that matters — *any* input yields a verdict and
 * never an exception — something a unit test can actually pin, rather than a
 * comment claiming it.
 *
 * Both arguments are RAW: `baseline` as parsed off disk, `registry` as the body of
 * `GET /api/v1/all`. Normalising them is part of what is being tested.
 */
export function catalogVerdict(
  baseline: unknown,
  registry: unknown,
): CatalogVerdict {
  try {
    const defect = describeSnapshotDefect(baseline);
    if (defect) {
      return { kind: "unknown", lines: [], categoryCount: 0, reason: `the baseline is unusable — ${defect}` };
    }
    const current = snapshotCatalog(registry);
    const categoryCount = Object.keys(current.categories).length;
    // A 200 is not a catalog. An empty registry is what an instance whose
    // component registry is still building answers (~11 s after
    // `/api/v1/version` starts answering), and `snapshotCatalog` is tolerant by
    // design — so `{}`, `null` and an error envelope all normalise to zero
    // categories. Diffing that reports EVERY category as gone: the loudest and
    // most false verdict this mechanism can emit, and the fastest way to train
    // readers to ignore it. The writer already refuses this state
    // (`--min-categories`); the reader had no floor at all.
    //
    // The floor is 0 here and 20 there on purpose. Writing a wrong baseline is
    // permanent and silent; a real-but-small catalog is drift a human should
    // still see reported.
    if (categoryCount === 0) {
      return {
        kind: "unknown",
        lines: [],
        categoryCount: 0,
        reason:
          "the catalog response carried no component categories at all — the registry may still be building, or the body was not a registry",
      };
    }
    const drift = diffCatalogSnapshots(baseline as CatalogSnapshot, current);
    return drift.hasDrift
      ? { kind: "drift", lines: formatCatalogDrift(drift), categoryCount }
      : { kind: "clean", lines: [], categoryCount };
  } catch (e) {
    // Unreachable by construction above; kept because "this block never aborts a
    // run" must hold for every future edit to the diff or its rendering too.
    return {
      kind: "unknown",
      lines: [],
      categoryCount: 0,
      reason: `the comparison itself failed (${String(e)})`,
    };
  }
}

/**
 * Component type names for one log line: all of them up to a point, then a count.
 *
 * Capped because a dropped aggregate bundle removes whole families at once, and a
 * 60-name line buries the category line above it — the #1226 ordering rule again.
 * The cap is generous enough that the realistic case (a vendor family of 2–8
 * components) always prints in full.
 */
function namesForLog(types: string[], cap = 8): string {
  if (types.length <= cap) return types.join(", ");
  return `${types.slice(0, cap).join(", ")}, and ${types.length - cap} more`;
}

/**
 * Renders a drift for the pre-flight log.
 *
 * Removals come **first**: an added category costs nobody a test, while a removed
 * one is the failure this exists to attribute. Same ordering rule as the impacted
 * summary (#1226) — put the line a reader opened the log for above the rest.
 */
export function formatCatalogDrift(drift: CatalogDrift): string[] {
  if (!drift.hasDrift) return [];
  const lines: string[] = [];
  for (const { category, componentCount, vanishedTypes } of drift.removedCategories) {
    // The consequence is asserted only for components that are really gone. A
    // category can disappear with all of its components reparented — the 1.12
    // migration does that — and claiming a timeout there would be false.
    //
    // "elsewhere", never "into surviving categories": the target of a reparent is
    // routinely a category that is itself brand new, which did not survive
    // anything.
    const consequence =
      vanishedTypes.length === 0
        ? `all ${componentCount} reparented elsewhere (see MOVED below) — no component lost`
        : `${vanishedTypes.length} of ${componentCount} component(s) gone entirely (${namesForLog(vanishedTypes)}) — every spec that places one of THOSE will time out waiting for its sidebar card`;
    lines.push(`  - category GONE: ${category} — ${consequence}`);
  }
  for (const { type, category } of drift.removedComponents) {
    lines.push(`  - component GONE: ${type} (was in ${category})`);
  }
  for (const { type, from, to } of drift.movedComponents) {
    lines.push(`  - component MOVED: ${type}: ${from} -> ${to}`);
  }
  for (const { category, componentCount } of drift.addedCategories) {
    lines.push(`  + category NEW: ${category} (${componentCount} component(s))`);
  }
  for (const { type, category } of drift.addedComponents) {
    lines.push(`  + component NEW: ${type} (in ${category})`);
  }
  return lines;
}
