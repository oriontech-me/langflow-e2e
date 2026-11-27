#!/usr/bin/env node
// What a scheduled lane of the VM daily runs (#2142), decided here so scripts/run-e2e.sh
// only orchestrates: the lane logic lives in a script whose tests assert on its output,
// not inline in shell (#1226).
//
//   node scripts/lane-selection.mjs filter <lane> [--grep=<areas filter>]
//       the one --grep the lane lists and runs with: @stable AND the lane tag (AND the
//       run's areas, when it narrows), composed by build-grep-filter.mjs.
//
//   node scripts/lane-selection.mjs flag <lane>
//       the environment flag the lane's run is listed and run under (PW_DESTRUCTIVE).
//
//   node scripts/lane-selection.mjs select <lane> <listing.json> <declared.json>
//       the lane's verdict, as JSON on stdout: what it selects (tests, files, and for a
//       lane with variants, which files run under which variant), and whether its
//       listing holds every spec file that declares a test for it (missing/unexpected,
//       as scripts/partition-shards.mjs answers for the shards). Always exits 0 with a
//       verdict; one it could not reach says `verified: false` and why.
//
//   node scripts/lane-selection.mjs runs <verdict.json>
//       one tab-separated line per run to make: name, the instance environment
//       (K=V, space-separated; empty for a lane with no variants), the spec files.
//
// A lane selects NOTHING until its tests are promoted to @stable, and that is a normal
// state, not a broken one: an empty declaration against an empty listing is verified
// and costs no backend. That is the one place this differs from the shards' check,
// which refuses an empty declaration because the shards' never is.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULED_LANES } from "./lib/scheduled-lanes.mjs";
import { buildGrepFilter } from "./build-grep-filter.mjs";
import { compareListing } from "./partition-shards.mjs";

/** The lane's definition, or a thrown error naming the lanes there are. */
export function laneOf(name) {
  const lane = SCHEDULED_LANES[name];
  if (!lane) throw new Error(`no scheduled lane named '${name}' (there are: ${Object.keys(SCHEDULED_LANES).join(", ")})`);
  return lane;
}

/** The lane's --grep: @stable and its tag, and the run's area filter when given. */
export function laneFilter(name, grep = "") {
  const lane = laneOf(name);
  return buildGrepFilter({ require: [lane.tag], tag: "@stable", grep });
}

/**
 * The listing's tests that belong to the lane, per file, from a Playwright `--list`
 * JSON report. Counted by TAG (both `stable` and the lane's), as the partitioner counts
 * the shards' — the --grep that produced the listing also matches titles.
 */
export function laneTestsByFile(report, name) {
  const want = laneOf(name).tag.replace(/^@/, "");
  const perFile = new Map();
  const walk = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      const tags = spec.tags || [];
      if (!tags.includes("stable") || !tags.includes(want)) continue;
      const f = spec.file || file;
      perFile.set(f, (perFile.get(f) || 0) + (spec.tests || []).length);
    }
    for (const child of suite.suites || []) walk(child, file);
  };
  for (const s of report?.suites || []) walk(s, s.file);
  return perFile;
}

/** The lane's verdict from its listing report and its declaration (either may be null). */
export function selectLane(name, report, declared) {
  const lane = laneOf(name);
  const base = { version: 1, lane: name, tag: lane.tag, flag: lane.flag, tests: 0, files: [], missing: [], unexpected: [], unmapped: [], runs: [] };
  const root = report?.config?.rootDir;
  if (!report || typeof root !== "string" || !root) {
    return { ...base, verified: false, reason: "the lane's listing could not be read, or carries no config.rootDir" };
  }
  const perFile = laneTestsByFile(report, name);
  const files = [...perFile.keys()].sort();
  const tests = [...perFile.values()].reduce((a, b) => a + b, 0);

  let listing;
  if (declared && Array.isArray(declared.files) && declared.files.length === 0 && files.length === 0) {
    // Nothing promoted yet: nothing declared, nothing listed. Verified, and empty.
    listing = { verified: true, reason: "", missing: [], unexpected: [] };
  } else if (declared && Array.isArray(declared.files) && declared.files.length === 0) {
    // compareListing refuses an empty declaration; here it is legitimate, and every
    // listed file is simply one the declaration does not know.
    listing = { verified: typeof declared.root === "string" && !!declared.root, reason: declared.root ? "" : "the declared-spec set carries no root", missing: [], unexpected: files };
  } else {
    listing = compareListing({ root, files }, declared);
  }

  // Which variant each listed file runs under. A lane without variants is one run.
  const runs = [];
  const unmapped = [];
  if (!lane.variants) {
    if (files.length) runs.push({ name, env: {}, files, tests });
  } else {
    const abs = (f) => path.resolve(root, f);
    const owner = new Map();
    for (const v of lane.variants) for (const s of v.specs) owner.set(abs(s), v.name);
    for (const v of lane.variants) {
      const mine = files.filter((f) => owner.get(abs(f)) === v.name);
      if (mine.length) runs.push({ name: v.name, env: v.env, files: mine, tests: mine.reduce((a, f) => a + perFile.get(f), 0) });
    }
    for (const f of files) if (!owner.has(abs(f))) unmapped.push(f);
  }

  const reasons = [listing.reason, unmapped.length ? `${unmapped.length} listed spec file(s) map to no ${name} variant` : ""].filter(Boolean);
  return {
    ...base,
    verified: listing.verified && unmapped.length === 0,
    reason: reasons.join("; "),
    tests,
    files,
    missing: listing.missing,
    unexpected: listing.unexpected,
    unmapped,
    runs,
  };
}

/** The `runs` lines: name, env (K=V ...), files (space-separated). */
export function runLines(verdict) {
  return (verdict?.runs || []).map((r) =>
    [r.name, Object.entries(r.env || {}).map(([k, v]) => `${k}=${v}`).join(" "), r.files.join(" ")].join("\t"),
  );
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const isMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "flag") {
      process.stdout.write(`${laneOf(rest[0]).flag}\n`);
    } else if (mode === "filter") {
      const grep = (rest.find((a) => a.startsWith("--grep=")) || "").slice("--grep=".length);
      process.stdout.write(`${laneFilter(rest[0], grep)}\n`);
    } else if (mode === "select") {
      const [name, listingPath, declaredPath] = rest;
      process.stdout.write(`${JSON.stringify(selectLane(name, readJson(listingPath), readJson(declaredPath)), null, 2)}\n`);
    } else if (mode === "runs") {
      const lines = runLines(readJson(rest[0]));
      if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    } else {
      throw new Error(`unknown mode '${mode ?? ""}' (flag, filter, select or runs)`);
    }
  } catch (err) {
    process.stderr.write(`[lane-selection] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
