/**
 * Recomputes the DERIVABLE half of the matrix and leaves the judged half untouched.
 *
 * The split is the whole point. Mitigation moves almost every working day — QA-CHECKLIST.md
 * changed on 76 of the 90 days to 2026-09-21 — so a matrix regenerated per release cycle is
 * stale on its most actionable axis within a day. Impact, fragility and the bug/churn quintiles
 * are judgement or an upstream measurement and are NOT refreshed: a quintile is relative to the
 * set, so re-running it daily would flip a whole probability step on one issue landing and show
 * re-quintiling as if it were the product moving.
 *
 * Pure. `scripts/refresh-coverage-matrix.ts` owns the I/O.
 */

/** Fields a refresh MAY rewrite. */
export const DERIVED_FIELDS = [
  "checklistBullets", "bulletStates", "mitigationBulletDerived", "mitigation",
  "testHealth", "specCounts", "residualRisk",
] as const;

/** Fields a refresh must NEVER touch. Each needs a human, or a full generation. */
export const JUDGED_FIELDS = [
  "probability", "impact", "inherentRisk", "inputs", "mitigationOverride",
  "judgementRationale", "upstreamBugsByYear", "upstreamBugCount", "previous",
] as const;

export interface RefreshArea {
  area: string;
  inherentRisk: number;
  mitigation: number;
  mitigationOverride?: number | null;
  mitigationBulletDerived?: number;
  checklistBullets: number;
  bulletStates?: Record<string, number>;
  testHealth?: { chronicHardFailures: number; chronicFlaky: number; stableSpecs: number; penalty: number } | null;
  specCounts?: { specs: number; stable: number } | null;
  residualRisk: number;
  [k: string]: unknown;
}

export interface Measured {
  bullets: Record<string, { bullets: number; states: Record<string, number>; mitigation: number }>;
  health: Record<string, { chronicHardFailures: number; chronicFlaky: number }>;
  specCounts: Record<string, { specs: number; stable: number }>;
}

export interface RefreshResult {
  areas: RefreshArea[];
  changes: { area: string; field: string; from: unknown; to: unknown }[];
  warnings: string[];
}

const penalty = (m: number, chronic: number, stable: number) =>
  !stable || !chronic ? 0 : +(m * 0.5 * Math.min(1, chronic / stable)).toFixed(3);

export function refreshAreas(areas: RefreshArea[], measured: Measured): RefreshResult {
  const changes: RefreshResult["changes"] = [];
  const warnings: string[] = [];

  const refreshed = areas.map(area => {
    const next: RefreshArea = { ...area };
    const b = measured.bullets[area.area];
    if (!b) {
      warnings.push(`${area.area}: no checklist sections matched — bullets and mitigation left at their previous values`);
      return next;
    }
    const specs = measured.specCounts[area.area] ?? null;
    const health = measured.health[area.area] ?? { chronicHardFailures: 0, chronicFlaky: 0 };
    const chronic = health.chronicHardFailures + health.chronicFlaky;
    const stableSpecs = specs?.stable ?? 0;

    // An override is a JUDGED absolute value: it does not follow the bullets. But an override
    // the bullets have overtaken is stale, and staying silent about that is how a judgement
    // outlives its reason — so it is reported rather than quietly kept or quietly dropped.
    const override = area.mitigationOverride ?? null;
    if (override !== null && b.mitigation > override) {
      warnings.push(
        `${area.area}: bullet-derived mitigation ${b.mitigation} now EXCEEDS the judged override ${override} — ` +
        `the override is stale and needs re-judging at the next full generation`,
      );
    }
    const gross = override ?? b.mitigation;
    const p = penalty(gross, chronic, stableSpecs);
    const effective = +(gross - p).toFixed(2);

    next.checklistBullets = b.bullets;
    next.bulletStates = b.states;
    next.mitigationBulletDerived = b.mitigation;
    next.mitigation = effective;
    next.specCounts = specs;
    next.testHealth = { ...health, stableSpecs, penalty: p };
    next.residualRisk = +(area.inherentRisk * (1 - effective)).toFixed(1);

    for (const f of DERIVED_FIELDS) {
      const before = JSON.stringify(area[f] ?? null), after = JSON.stringify(next[f] ?? null);
      if (before !== after) changes.push({ area: area.area, field: f, from: area[f] ?? null, to: next[f] ?? null });
    }
    return next;
  });

  // Ranking is derived, so a refresh re-sorts. Judged fields are asserted untouched rather than
  // trusted: this function is the only thing standing between a daily job and a judged number.
  for (let i = 0; i < areas.length; i++) {
    for (const f of JUDGED_FIELDS) {
      if (JSON.stringify(areas[i][f] ?? null) !== JSON.stringify(refreshed[i][f] ?? null)) {
        throw new Error(`refresh mutated the judged field "${f}" on "${areas[i].area}" — this is a bug, not a data change`);
      }
    }
  }

  refreshed.sort((a, b) => b.residualRisk - a.residualRisk);
  return { areas: refreshed, changes, warnings };
}
