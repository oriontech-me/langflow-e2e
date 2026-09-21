#!/usr/bin/env ts-node
/**
 * Emits the dashboard feed and appends one history line per generation.
 *
 *   npm run coverage:feed          # write docs/coverage-heatmap/dashboard-feed.json (+ history)
 *   npm run coverage:feed -- --check   # verify the committed feed matches data.json, exit 1 if not
 *
 * All I/O lives here; the shape lives in scripts/lib/coverage-matrix-feed.ts, which is pure
 * and unit-tested. The feed is REGENERATED, never hand-edited — a hand-edited feed is how the
 * dashboard and the matrix start disagreeing, which is the rot this whole exercise paid for once.
 */
import fs from "node:fs";
import path from "node:path";
import { buildFeed, buildHistoryLine } from "./lib/coverage-matrix-feed";

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "docs/coverage-heatmap/data.json");
const FEED = path.join(ROOT, "docs/coverage-heatmap/dashboard-feed.json");
const HISTORY = path.join(ROOT, "docs/coverage-heatmap/history.jsonl");
const KEYS = path.join(ROOT, "scripts/lib/coverage-matrix-keys.json");
const ANNOTATIONS = path.join(ROOT, "scripts/lib/coverage-matrix-annotations.json");

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const stripComments = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const data = readJson(DATA);
  const keys = stripComments(readJson(KEYS)) as Record<string, string>;
  const ann = readJson(ANNOTATIONS);

  const feed = buildFeed({
    data,
    keys,
    bugsByYear: Object.fromEntries(data.areas.map((a: Record<string, unknown>) => [a.area, a.upstreamBugsByYear ?? {}])),
    specCounts: Object.fromEntries(data.areas.filter((a: Record<string, unknown>) => a.specCounts).map((a: Record<string, unknown>) => [a.area, a.specCounts])),
    platformItems: ann.platformItems ?? {},
    cappedByProduct: ann.cappedByProduct ?? [],
    instrumentCaveats: ann.instrumentCaveats ?? {},
    actions: ann.actions ?? [],
  });
  const rendered = JSON.stringify(feed, null, 1) + "\n";

  if (check) {
    if (!fs.existsSync(FEED)) { console.error("dashboard-feed.json is missing — run `npm run coverage:feed`"); return 1; }
    const committed = fs.readFileSync(FEED, "utf8");
    if (committed !== rendered) { console.error("dashboard-feed.json disagrees with data.json — run `npm run coverage:feed` and commit the result"); return 1; }
    console.log(`feed is in sync (${feed.areas.length} areas, generated ${feed.generated})`);
    return 0;
  }

  fs.writeFileSync(FEED, rendered);

  // History is append-only and keyed by REFRESH date: re-running on the same day REPLACES that
  // day's line rather than appending a duplicate, so a trend never double-counts, while a refresh
  // on a new day extends the series. Keying on the generation date instead would make every daily
  // refresh overwrite the same line and the series would never grow (history v2).
  const line = buildHistoryLine(feed, data.refreshed ?? feed.generated);
  const existing = fs.existsSync(HISTORY)
    ? fs.readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];
  const keyOf = (l: { refreshed?: string; generated?: string }) => l.refreshed ?? l.generated ?? "";
  const merged = [...existing.filter(l => keyOf(l) !== keyOf(line)), line]
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  fs.writeFileSync(HISTORY, merged.map(l => JSON.stringify(l)).join("\n") + "\n");

  console.log(`wrote dashboard-feed.json (${feed.areas.length} areas, ${feed.actions.length} actions)`);
  console.log(`history.jsonl now holds ${merged.length} point(s): ${merged.map(keyOf).join(", ")}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
export { main };
