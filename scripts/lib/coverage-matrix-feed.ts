/**
 * Builds the dashboard feed from the coverage matrix.
 *
 * The feed is a CONTRACT consumed outside this repository (the QA platform dashboard),
 * so it is deliberately not `data.json` reshaped by the consumer: `data.json` is a working
 * file whose prose fields and nesting change every cycle, while this is flat, versioned and
 * keyed by an id that survives a QA-CHECKLIST.md renumbering.
 *
 * Pure: no I/O, no clock, no filesystem. `scripts/build-coverage-matrix-feed.ts` owns those.
 */

export const FEED_SCHEMA = "coverage-matrix-feed";
export const FEED_VERSION = 1;
/**
 * History lines are versioned separately from the feed.
 * v1 = one line per GENERATION, keyed by `generated`.
 * v2 = one line per REFRESH, keyed by `refreshed`, carrying `generation` alongside — because a
 *      daily refresh keyed on the generation date would overwrite its own line instead of forming
 *      a series. The two v1 lines on file stay as they are; a reader branches on `version`.
 */
export const HISTORY_VERSION = 2;

export type BulletStates = Record<string, number>;

export interface MatrixArea {
  area: string;
  residualRisk: number;
  inherentRisk: number;
  probability: number;
  impact: number;
  mitigation: number;
  mitigationBulletDerived?: number;
  mitigationOverride?: number | null;
  checklistBullets: number;
  bulletStates?: BulletStates;
  inputs: { bugQuintile: number; churnQuintile: number; fragility: number; weightedBugs: number; weightedChurn: number };
  testHealth?: { chronicHardFailures: number; chronicFlaky: number; stableSpecs: number; penalty: number };
  previous?: { residualRisk: number; inherentRisk: number; mitigation: number; checklistBullets: number } | null;
  judgementRationale?: string;
}

export interface FeedInput {
  data: { generated: string; refreshed?: string; refreshWindow?: Record<string, unknown>; previousGeneration?: string; corpus: Record<string, unknown>; churn?: Record<string, unknown>; instrumentRebuild?: Record<string, string>; formula: Record<string, string>; mitigationScale: Record<string, number>; areas: MatrixArea[] };
  keys: Record<string, string>;
  /** area -> upstream bug issue counts by year, from the same classifier that scored the axis */
  bugsByYear: Record<string, Record<string, number>>;
  /** area -> {specs, stable} counted from the regression tree */
  specCounts: Record<string, { specs: number; stable: number }>;
  /** area key -> platform checklist item friendly_ids that act on it */
  platformItems: Record<string, number[]>;
  /** area keys whose remaining bullets carry a recorded product limitation */
  cappedByProduct: string[];
  /** area key -> why this cycle's inherent-risk move is the instrument rather than the product */
  instrumentCaveats: Record<string, string>;
  actions: FeedAction[];
}

export interface FeedAction {
  id: string;
  areaKey: string;
  priority: "critical" | "high" | "medium" | "low";
  title: string;
  platformItemId: number | null;
}

/** `[x]`/`[-]`/`[~]`/`[!]`/`[ ]` are awkward JSON keys; the feed names them. */
export function nameBulletStates(states: BulletStates | undefined, total: number) {
  const s = states ?? {};
  const validated = s["x"] ?? 0, automatedUnwatched = s["-"] ?? 0;
  const partial = s["~"] ?? 0, flaky = s["!"] ?? 0, empty = s[" "] ?? 0;
  const named = { total, validated, automatedUnwatched, partial, flaky, empty };
  const summed = validated + automatedUnwatched + partial + flaky + empty;
  // A state the checklist grows that this mapping does not know must not vanish silently.
  return summed === total ? named : { ...named, unaccounted: total - summed };
}

export function buildFeed(input: FeedInput) {
  const { data, keys } = input;
  const ranked = [...data.areas].sort((a, b) => b.residualRisk - a.residualRisk);
  const prevRank = new Map<string, number>();
  [...data.areas].filter(a => a.previous).sort((a, b) => b.previous!.residualRisk - a.previous!.residualRisk)
    .forEach((a, i) => prevRank.set(a.area, i + 1));

  const areas = ranked.map((a, i) => {
    const key = keys[a.area];
    if (!key) throw new Error(`no stable key for area "${a.area}" — add it to scripts/lib/coverage-matrix-keys.json`);
    const pr = a.previous ? prevRank.get(a.area) ?? null : null;
    return {
      key,
      label: a.area,
      rank: i + 1,
      residualRisk: a.residualRisk,
      inherentRisk: a.inherentRisk,
      probability: a.probability,
      impact: a.impact,
      mitigation: a.mitigation,
      mitigationBulletDerived: a.mitigationBulletDerived ?? a.mitigation,
      mitigationOverride: a.mitigationOverride ?? null,
      axes: { ...a.inputs },
      bullets: nameBulletStates(a.bulletStates, a.checklistBullets),
      specs: input.specCounts[a.area] ?? null,
      testHealth: a.testHealth ?? null,
      upstreamBugsByYear: input.bugsByYear[a.area] ?? {},
      previous: a.previous ? { rank: pr, residualRisk: a.previous.residualRisk, inherentRisk: a.previous.inherentRisk, mitigation: a.previous.mitigation } : null,
      delta: a.previous
        ? { residualRisk: +(a.residualRisk - a.previous.residualRisk).toFixed(1), rank: pr === null ? null : pr - (i + 1),
            direction: a.residualRisk < a.previous.residualRisk ? "improved" : a.residualRisk > a.previous.residualRisk ? "worsened" : "flat" }
        : null,
      isNew: !a.previous,
      cappedByProduct: input.cappedByProduct.includes(key),
      instrumentCaveat: input.instrumentCaveats[key] ?? null,
      platformItems: input.platformItems[key] ?? [],
      rationale: a.judgementRationale ?? null,
    };
  });

  return {
    schema: FEED_SCHEMA,
    version: FEED_VERSION,
    /** The last full GENERATION: judged axes (impact, fragility, quintiles) date from here. */
    generated: data.generated,
    /** The last DERIVABLE recompute (mitigation, bullets, specs, test health). Never older than
     *  `generated`. Show both, or show this one and name the generation it belongs to. */
    refreshed: data.refreshed ?? data.generated,
    refreshWindow: data.refreshWindow ?? null,
    previousGeneration: data.previousGeneration ?? null,
    source: {
      repository: "oriontech-me/langflow-e2e",
      data: "docs/coverage-heatmap/data.json",
      rendered: "docs/coverage-heatmap/README.md",
      contract: "docs/coverage-heatmap/FEED.md",
    },
    model: { formula: data.formula, mitigationScale: data.mitigationScale },
    confidence: {
      unclassifiedPct: data.corpus.unclassifiedPct ?? null,
      churnUnmatchedPct: (data.churn as { unmatchedPct?: number } | undefined)?.unmatchedPct ?? null,
      bugAxis: data.instrumentRebuild?.bugAxis ?? null,
      churnAxis: data.instrumentRebuild?.churnAxis ?? null,
      errorBar: data.instrumentRebuild?.errorBar ?? null,
    },
    totals: {
      areas: areas.length,
      newThisGeneration: areas.filter(a => a.isNew).length,
      cappedByProduct: areas.filter(a => a.cappedByProduct).length,
      bullets: areas.reduce((s, a) => s + a.bullets.total, 0),
      bulletsAutomatedUnwatched: areas.reduce((s, a) => s + a.bullets.automatedUnwatched, 0),
      residualRiskTotal: +areas.reduce((s, a) => s + a.residualRisk, 0).toFixed(1),
    },
    areas,
    actions: input.actions,
  };
}

/** One line per refresh, for the dashboard's trend chart. Deliberately small. */
export function buildHistoryLine(feed: ReturnType<typeof buildFeed>, refreshed?: string) {
  return {
    version: HISTORY_VERSION,
    refreshed: refreshed ?? feed.generated,
    generation: feed.generated,
    generated: feed.generated,   // kept so a v1 reader still finds a date it understands
    areas: feed.areas.length,
    residualRiskTotal: feed.totals.residualRiskTotal,
    bulletsAutomatedUnwatched: feed.totals.bulletsAutomatedUnwatched,
    top: feed.areas.slice(0, 5).map(a => ({ key: a.key, residualRisk: a.residualRisk })),
    byArea: Object.fromEntries(feed.areas.map(a => [a.key, {
      rank: a.rank, residual: a.residualRisk, inherent: a.inherentRisk, mitigation: a.mitigation,
    }])),
  };
}
