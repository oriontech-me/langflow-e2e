#!/usr/bin/env ts-node
/**
 * Recomputes the derivable half of the matrix from this repository's own files, rewrites
 * data.json, regenerates the feed, and appends a history line.
 *
 * Runs once a weekday in CI, after the daily — NOT on every push, because sharing a trigger with
 * `update-coverage-summary.yml` would race it on the commit back to main. See the workflow's
 * `on:` block.
 *
 *   npm run coverage:refresh              # refresh and write
 *   npm run coverage:refresh -- --check   # exit 1 if a refresh WOULD change anything
 *
 * The cadence argument rests on how often the checklist moves. Measured on `main` 2026-09-21:
 * 681 commits touching QA-CHECKLIST.md across 76 distinct days in the trailing 90. The DELTA
 * between "almost every working day" and "once per release cycle" is the point; the absolute
 * figures move. Re-measure:
 *   git log --since=90.days --oneline -- QA-CHECKLIST.md | wc -l
 *   git log --since=90.days --format=%ad --date=short -- QA-CHECKLIST.md | sort -u | wc -l
 *
 * Judged values (impact, fragility, quintiles, overrides, annotations) are never touched —
 * `refreshAreas` throws rather than let that happen. A full generation, which re-measures the
 * upstream axes and re-judges impact, is a separate and deliberately human exercise.
 */
import fs from "node:fs";
import path from "node:path";
import { parseChecklistSections, bulletsForArea, areaForSpec, declaresStable, measureTestHealth, AREA_SECTIONS } from "./lib/coverage-matrix-measure";
import { refreshAreas, type Measured } from "./lib/coverage-matrix-refresh";

const ROOT = path.resolve(__dirname, "..");
const P = (rel: string) => path.join(ROOT, rel);
const HEALTH_WINDOW_DAYS = 45;

function collectSpecCounts(): Record<string, { specs: number; stable: number }> {
  const root = P("tests/tests-automations/regression");
  const out: Record<string, { specs: number; stable: number }> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.spec\.m?ts$/.test(e.name)) continue;
      const area = areaForSpec("/" + path.relative(ROOT, full));
      if (!area) continue;
      out[area] ??= { specs: 0, stable: 0 };
      out[area].specs++;
      if (declaresStable(fs.readFileSync(full, "utf8"))) out[area].stable++;
    }
  };
  walk(root);
  return out;
}

export function main(argv: string[]): number {
  const check = argv.includes("--check");
  const data = JSON.parse(fs.readFileSync(P("docs/coverage-heatmap/data.json"), "utf8"));

  const sections = parseChecklistSections(fs.readFileSync(P("QA-CHECKLIST.md"), "utf8"));
  const bullets: Measured["bullets"] = {};
  for (const area of Object.keys(AREA_SECTIONS)) bullets[area] = bulletsForArea(sections, area);

  const since = new Date(Date.now() - HEALTH_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const runs = fs.readFileSync(P("reports/daily-history.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const health = measureTestHealth(runs, since);

  const { areas, changes, warnings } = refreshAreas(data.areas, { bullets, health, specCounts: collectSpecCounts() });
  for (const w of warnings) console.warn(`::warning::${w}`);

  if (check) {
    if (!changes.length) { console.log("matrix is current — no derivable value moved"); return 0; }
    console.error(`${changes.length} derivable value(s) moved — run \`npm run coverage:refresh\``);
    for (const c of changes.slice(0, 20)) console.error(`  ${c.area} · ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
    return 1;
  }

  data.areas = areas;
  data.refreshed = new Date().toISOString().slice(0, 10);
  data.refreshWindow = { testHealthSince: since, days: HEALTH_WINDOW_DAYS };
  fs.writeFileSync(P("docs/coverage-heatmap/data.json"), JSON.stringify(data, null, 1) + "\n");

  console.log(`refreshed ${areas.length} areas · ${changes.length} value(s) moved · generation ${data.generated}, refreshed ${data.refreshed}`);
  for (const c of changes) console.log(`  ${c.area} · ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  if (!changes.length) console.log("  (nothing moved — the feed and history are still rewritten so `refreshed` advances)");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
