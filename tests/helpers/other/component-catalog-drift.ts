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
 * Measured on `1.12.0.dev10`, and this is the rule the detector rests on: a
 * category appears in `GET /api/v1/all` **iff** it is core or its vendor
 * distribution is installed. All 20 installed vendor distributions map to a
 * present category, and no shim without an installed distribution has one.
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
 * keyed by the lowercased type name). Folding it into the snapshot would double
 * every component and make reparenting undetectable — a component would always
 * appear under both its real category and this map. It is excluded by name.
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
   * For a REMOVED category: how many of its components are absent from the new
   * catalog **entirely**, rather than having been reparented into a surviving
   * category. Always 0 for an added category.
   *
   * This distinction is the difference between a true and a false statement in
   * the report. A category can disappear with every one of its components
   * surviving elsewhere — the 1.12 migration does exactly that — and in that case
   * "every spec that places one of these will time out" is simply wrong. Only
   * `vanishedCount` justifies that claim.
   */
  vanishedCount: number;
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
    for (const [category, components] of Object.entries(
      registry as Record<string, unknown>,
    )) {
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

/** `type -> category` for every component in a snapshot. */
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
      vanishedCount: 0,
    }));
  const removedCategories: CategoryChange[] = [...baseCats]
    .filter((c) => !currCats.has(c))
    .sort()
    .map((category) => ({
      category,
      componentCount: baseline.categories[category].length,
      vanishedCount: baseline.categories[category].filter(
        (type) => !currIndex.has(type),
      ).length,
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
  for (const { category, componentCount, vanishedCount } of drift.removedCategories) {
    // The consequence is asserted only for components that are really gone. A
    // category can disappear with all of its components reparented — the 1.12
    // migration does that — and claiming a timeout there would be false.
    const consequence =
      vanishedCount === 0
        ? `all ${componentCount} reparented into surviving categories (see MOVED below) — no component lost`
        : `${vanishedCount} of ${componentCount} component(s) gone entirely — every spec that places one of THOSE will time out waiting for its sidebar card`;
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
