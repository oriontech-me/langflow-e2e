/**
 * Measures the DERIVABLE half of the coverage matrix from this repository's own files:
 * checklist bullet states, spec counts, and test health. No network, no upstream clone.
 *
 * The other half — impact, fragility, the bug/churn quintiles and every annotation — is
 * judgement or an upstream measurement, and is NOT computed here. See `coverage-matrix-refresh.ts`
 * for which fields a refresh is allowed to touch.
 *
 * Pure except for the explicit `readFile` callbacks the caller supplies.
 */

/** Mitigation weight per checklist bullet marker. Mirrors `data.json`'s `mitigationScale`. */
export const BULLET_WEIGHT: Record<string, number> = { x: 0.8, "-": 0.4, "~": 0.25, "!": 0.25, " ": 0 };

export interface SectionTally { bullets: number; states: Record<string, number> }

/**
 * Parses Part II of QA-CHECKLIST.md into per-section bullet tallies.
 * Part II runs from the first `## api/ ` module heading to `## Coverage Summary`; the generated
 * blocks below it echo every @stable basename and would double-count.
 */
export function parseChecklistSections(markdown: string): Record<string, SectionTally> {
  const lines = markdown.split("\n");
  let start = lines.findIndex(l => /^## api\/ /.test(l));
  let end = lines.findIndex(l => /^## Coverage Summary/.test(l));
  if (start < 0) start = 0;
  if (end < 0) end = lines.length;
  const out: Record<string, SectionTally> = {};
  let current: string | null = null;
  for (let i = start; i < end; i++) {
    const heading = lines[i].match(/^#{3,4}\s+(\d+(?:\.\d+)*)\s/);
    if (heading) { current = heading[1]; out[current] ??= { bullets: 0, states: {} }; continue; }
    const bullet = lines[i].match(/^\s*[-*]\s\[([x\-~! ])\]/);
    if (bullet && current) {
      const tally = out[current];
      tally.bullets++;
      tally.states[bullet[1]] = (tally.states[bullet[1]] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Which checklist sections roll up into which matrix area.
 *
 * Verified against the 2026-08-06 generation: this map reproduces EVERY recorded bullet count
 * exactly on that revision of QA-CHECKLIST.md (23 areas existed then; 26 do now). That exactness
 * is what makes mitigation a measurement rather than an estimate, so it is worth re-checking
 * whenever a section is renumbered. Re-measure:
 *   node -e 'require("ts-node/register");
 *     const {execSync}=require("child_process");
 *     const {parseChecklistSections,bulletsForArea}=require("./scripts/lib/coverage-matrix-measure.ts");
 *     const md=execSync("git show 2afac9d6:QA-CHECKLIST.md",{encoding:"utf8",maxBuffer:64e6});
 *     const d=JSON.parse(execSync("git show 2afac9d6:docs/coverage-heatmap/data.json",{encoding:"utf8"}));
 *     const sec=parseChecklistSections(md);
 *     console.log(d.areas.filter(a=>bulletsForArea(sec,a.area).bullets===a.checklistBullets).length+"/"+d.areas.length);' Areas deliberately overlap where the product does
 * (§9.6 is both Playground and HITL; §1.3.1 is both REST API and Projects).
 */
export const AREA_SECTIONS: Record<string, (section: string) => boolean> = {
  "1 REST API / endpoints":      s => /^1\./.test(s),
  "2 Component config":          s => /^2\./.test(s) || ["3.2", "3.7", "3.10"].includes(s),
  "3.3 API Request / Webhook":   s => ["3.3", "3.4"].includes(s),
  "3.6 Loop / control flow":     s => ["3.6", "3.8"].includes(s),
  "3.9 HITL":                    s => ["3.9", "9.6"].includes(s),
  "4 Auth / users":              s => ["4.1", "4.2"].includes(s),
  "4.3 Global variables":        s => s === "4.3",
  "5 Knowledge / files":         s => /^5\./.test(s),
  "6 Agents / LLM execution":    s => /^6\./.test(s) || s === "3.5",
  "7 Model providers":           s => /^7\./.test(s) && s !== "7.7",
  "7.7 Model parameters":        s => s === "7.7",
  "8 Observability":             s => /^8\./.test(s),
  "9 Playground / chat":         s => /^9\./.test(s) || s === "3.1",
  "10 Projects / folders":       s => /^10\./.test(s) || s === "1.3.1",
  "11 Templates / starter":      s => /^11\./.test(s),
  "12 Flow lifecycle":           s => /^12\.[1-5]$/.test(s),
  "12.6 Build / graph engine":   s => s === "12.6",
  "13/14 MCP":                   s => /^1[34]\./.test(s),
  "15 Canvas / UI":              s => /^15\./.test(s),
  "16 A2A":                      s => /^16\./.test(s),
  "NEW security":                s => /^17\./.test(s),
  "NEW i18n / localization":     s => /^18\./.test(s),
  "20 Memory Base":              s => /^20\./.test(s),
  "21 Governance / policy":      s => /^21\./.test(s),
  "22 Enterprise / authz":       s => /^22\./.test(s),
  "23 Serving / end-user id":    s => /^23\./.test(s),
};

export interface AreaBullets { bullets: number; states: Record<string, number>; mitigation: number }

export function bulletsForArea(sections: Record<string, SectionTally>, area: string): AreaBullets {
  const match = AREA_SECTIONS[area];
  if (!match) throw new Error(`no checklist sections mapped for area "${area}" — add it to AREA_SECTIONS`);
  let bullets = 0, weighted = 0;
  const states: Record<string, number> = {};
  for (const [section, tally] of Object.entries(sections)) {
    if (!match(section)) continue;
    bullets += tally.bullets;
    for (const [marker, n] of Object.entries(tally.states)) {
      weighted += (BULLET_WEIGHT[marker] ?? 0) * n;
      states[marker] = (states[marker] ?? 0) + n;
    }
  }
  return { bullets, states, mitigation: bullets ? +(weighted / bullets).toFixed(2) : 0 };
}

/** Spec directory per area. Sub-areas that share their parent's directory are absent by design. */
export const AREA_SPEC_DIRS: Record<string, RegExp> = {
  "13/14 MCP": /\/mcp\//, "16 A2A": /\/a2a\//, "20 Memory Base": /\/memory\//,
  "NEW security": /\/security\//, "NEW i18n / localization": /\/i18n\//,
  "21 Governance / policy": /\/governance\//, "22 Enterprise / authz": /\/enterprise\//,
  "23 Serving / end-user id": /\/serving\//, "6 Agents / LLM execution": /\/llm-agents\//,
  "7 Model providers": /\/model-provider\//, "9 Playground / chat": /\/playground\//,
  "8 Observability": /\/observability-monitoring\//, "5 Knowledge / files": /\/knowledge-ingestion-management\//,
  "4 Auth / users": /\/auth\//, "10 Projects / folders": /\/project-management\//,
  "11 Templates / starter": /\/templates\//, "1 REST API / endpoints": /\/api\//,
  "12 Flow lifecycle": /\/flow-functionality\//, "2 Component config": /\/core-components\//,
  "15 Canvas / UI": /\/ui-ux\//,
};

export const areaForSpec = (p: string): string | null =>
  Object.entries(AREA_SPEC_DIRS).find(([, re]) => re.test(p))?.[0] ?? null;

/** `@stable` read from a `tag:` array, never as a loose substring (that overcounts by 8 files). */
export const declaresStable = (source: string): boolean =>
  /tag:\s*\[[^\]]*["'`]@stable["'`]/.test(source);

export interface HealthRow { file?: string; spec?: string; test?: string; title?: string }
export interface HistoryRun { date: string; failures?: HealthRow[]; flaky?: HealthRow[] }
export interface AreaHealth { chronicHardFailures: number; chronicFlaky: number }

/**
 * A spec is CHRONIC when it failed or flaked on at least `minDays` distinct days in the window.
 * One bad day is a flake; three is a test nobody can read any more (the design's 0.8 -> ~0.4).
 */
export function measureTestHealth(runs: HistoryRun[], since: string, minDays = 3): Record<string, AreaHealth> {
  const seen = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.date < since) continue;
    for (const [kind, rows] of [["hard", run.failures ?? []], ["flaky", run.flaky ?? []]] as const) {
      for (const row of rows) {
        const file = row.file ?? row.spec ?? "";
        const area = areaForSpec("/" + file);
        if (!area) continue;
        const key = `${area}\u0000${kind}\u0000${file}::${row.test ?? row.title ?? ""}`;
        (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(run.date);
      }
    }
  }
  const out: Record<string, AreaHealth> = {};
  for (const [key, days] of seen) {
    if (days.size < minDays) continue;
    const [area, kind] = key.split("\u0000");
    out[area] ??= { chronicHardFailures: 0, chronicFlaky: 0 };
    if (kind === "hard") out[area].chronicHardFailures++; else out[area].chronicFlaky++;
  }
  return out;
}

/** A chronically red @stable spec mitigates about half of what its bullet claims. */
export function healthPenalty(mitigation: number, chronic: number, stableSpecs: number): number {
  if (!stableSpecs || !chronic) return 0;
  return +(mitigation * 0.5 * Math.min(1, chronic / stableSpecs)).toFixed(3);
}
