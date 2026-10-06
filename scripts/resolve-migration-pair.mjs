#!/usr/bin/env node
/**
 * Decides the two versions a migration run moves between: the TARGET (what the daily
 * judged, or a version asked for), and the SOURCE, the latest stable Langflow published
 * below it.
 *
 * ## Why the latest stable below the target
 *
 * It is the upgrade most users make: from the release they run to the next one. The two
 * real migration damages Langflow has had were both on that path. 1.7.0 was yanked from
 * PyPI on 2025-12-18 because, coming from 1.6.8 or 1.6.9, flows, projects and variables
 * became unreachable (the default SQLite path moved, langflow-ai/langflow#11107). And
 * #15326: turning AUTO_LOGIN off deleted the default superuser and everything it owned on
 * Postgres. The three Actions workflows this replaces ran `latest -> nightly` on Postgres
 * with auto-login on, and saw neither.
 *
 * ## The rule
 *
 * Stable means a final X.Y.Z release: no rc, no dev, no post. Below means its X.Y.Z is
 * strictly below the target's, so for 1.13.0.dev33, 1.12.5rc1 or 1.12.5 alike the answer
 * is the newest final under that triple. A release whose every file is yanked is not a
 * release anyone upgrades from, and is skipped (1.7.0 is exactly that).
 *
 * ## Images
 *
 * The docker cells run the published images of the same versions: langflowai/langflow:S
 * for the source, and for the target langflowai/langflow-nightly:V when V is a dev build
 * (the image the shadow serves for the daily's version) or langflowai/langflow:V
 * otherwise. Whether each tag exists is the wrapper's to check: this script reads files
 * and decides, so its decisions are tested without a network.
 *
 * Usage:
 *   resolve-migration-pair.mjs --target <version> --pypi-json <file>
 * Prints one JSON object: { ok, target, source, target_image, source_image, skipped, error }.
 * Exit 0 when ok, 1 otherwise.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** PEP 440 enough for Langflow's versions: X.Y.Z, then rcN | aN | bN | .devN | .postN. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? [m[4], Number(m[5])] : null,
    post: m[6] !== undefined ? Number(m[6]) : null,
    dev: m[7] !== undefined ? Number(m[7]) : null,
  };
}

const cmpTriple = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const isFinal = (p) => p && !p.pre && p.post === null && p.dev === null;
export const isDev = (v) => parseVersion(v)?.dev !== null && parseVersion(v)?.dev !== undefined;

/** A release whose every file is yanked, or that has no files at all, is not one. */
function published(files) {
  return Array.isArray(files) && files.length > 0 && files.some((f) => !f.yanked);
}

export function previousStable(target, pypi) {
  const t = parseVersion(target);
  if (!t) return { error: `the target '${target}' is not a version this script can read` };
  const releases = pypi?.releases;
  if (!releases || typeof releases !== "object") return { error: "the PyPI document has no releases" };
  const skipped = [];
  let best = null;
  for (const [v, files] of Object.entries(releases)) {
    const p = parseVersion(v);
    if (!isFinal(p) || cmpTriple(p.release, t.release) >= 0) continue;
    if (!published(files)) {
      skipped.push({ v, p, why: Array.isArray(files) && files.length ? "yanked" : "no files" });
      continue;
    }
    if (!best || cmpTriple(p.release, best.p.release) > 0) best = { v, p };
  }
  // Only what would have been chosen: a yanked release above the source is the news
  // (1.7.0 for a 1.7.x target), one from years before it is noise.
  const passedOver = skipped
    .filter((s) => !best || cmpTriple(s.p.release, best.p.release) > 0)
    .sort((a, b) => cmpTriple(a.p.release, b.p.release))
    .map((s) => `${s.v} (${s.why})`);
  if (!best) return { error: `no stable release below ${target} on PyPI`, skipped: passedOver };
  return { source: best.v, skipped: passedOver };
}

export function imageFor(version) {
  return isDev(version) ? `langflowai/langflow-nightly:${version}` : `langflowai/langflow:${version}`;
}

export function resolveMigrationPair(target, pypi) {
  const r = previousStable(target, pypi);
  if (r.error) return { ok: false, target, source: null, target_image: null, source_image: null, skipped: r.skipped ?? [], error: r.error };
  return { ok: true, target, source: r.source, target_image: imageFor(target), source_image: imageFor(r.source), skipped: r.skipped, error: null };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!args["--target"] || !args["--pypi-json"]) {
    console.error("usage: resolve-migration-pair.mjs --target <version> --pypi-json <file>");
    return 2;
  }
  let pypi;
  try {
    pypi = JSON.parse(readFileSync(args["--pypi-json"], "utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, target: args["--target"], error: `cannot read the PyPI document: ${e.message}` }));
    return 1;
  }
  const out = resolveMigrationPair(args["--target"], pypi);
  console.log(JSON.stringify(out));
  return out.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
