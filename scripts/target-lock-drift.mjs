#!/usr/bin/env node
/**
 * Compares what the VM target venv holds against the `uv.lock` of the Langflow it
 * installed, and renders the difference as a section of the run's evidence (#2063).
 *
 *   node scripts/target-lock-drift.mjs --freeze <freeze.txt> --lock <uv.lock> --ref <ref>
 *                                                                   → markdown on stdout
 *
 * ## Why this exists
 *
 * The two daily lanes test two surfaces of one release. The Actions lane runs the
 * published image, which is built from the lock: on 2026-09-25 all 446 distributions
 * in `langflow-nightly:1.13.0.dev22` sat at a `uv.lock` version. The VM installs
 * `langflow==X` into a fresh venv with no constraints, as `pip install langflow` does,
 * so every range resolves to the newest release of the day: 190 of its 444 were off
 * the lock, never behind it, 31 of them across a major.
 *
 * That difference is kept on purpose. It is the surface a pip user gets, and nothing
 * else tests it. What it costs is attribution: a red on this lane and not on the image
 * lane can come from a dependency that moved, and the same Langflow version on two
 * days can be two products. This section is what makes that visible on the run.
 *
 * ## What it decides, and what it does not
 *
 * Nothing about the verdict. It never fails the run and never blocks. It ALWAYS
 * renders a section: when an input is missing it says the drift was not computed and
 * why, because an absent section reads as "no drift" (#1012).
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** How many drifted distributions are listed before the full table. */
export const DRIFT_LISTED = 15;

/** Backticks would close the code span a value is printed in. */
const safe = (text) => String(text ?? "").replaceAll("`", "'");

/** PEP 503 normalisation: the lock, the freeze and a dist-info dir spell names apart. */
export const normalizeName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");

/**
 * `uv pip freeze` output as `{ name: version }`.
 *
 * Only `name==version` lines are versions. A direct-URL or editable line is kept with
 * its raw text as the "version", so it lands in the drift instead of disappearing: a
 * distribution installed from somewhere other than the index is exactly the kind of
 * difference this exists to show.
 */
export function parseFreeze(text) {
  const installed = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pinned = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/);
    if (pinned) {
      installed[normalizeName(pinned[1])] = pinned[2];
      continue;
    }
    const direct = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*@\s*(.+)$/);
    if (direct) installed[normalizeName(direct[1])] = line;
  }
  return installed;
}

/**
 * The versions `uv.lock` pins, as `{ name: Set<version> }`.
 *
 * A set, because a lock can resolve one name twice — a fork per platform or per
 * Python — and an installed version matching either is at the lock. Read line by
 * line rather than with a TOML parser the repository does not carry: uv writes every
 * `[[package]]` table with `name` and `version` as its first keys. A workspace member
 * with no `version` is skipped; it is the project itself, not a dependency.
 */
export function parseLockVersions(text) {
  const pinned = {};
  let name = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      name = line === "[[package]]" ? "" : null;
      continue;
    }
    if (name === null) continue;
    const kv = line.match(/^(name|version)\s*=\s*"([^"]*)"$/);
    if (!kv) continue;
    if (kv[1] === "name") name = normalizeName(kv[2]);
    else if (name) (pinned[name] ??= new Set()).add(kv[2]);
  }
  return pinned;
}

/** The numeric release segments of a version, enough to tell a major move apart. */
const release = (version) => {
  const head = String(version).match(/^\d+(?:\.\d+)*/)?.[0];
  return head ? head.split(".").map(Number) : [];
};

/**
 * Whether moving from `from` to `to` crosses a major — or a minor below 1.0, where
 * semver-minded projects put their breaking changes. Unparseable is not a jump; it is
 * still listed as drift.
 */
export function crossesMajor(from, to) {
  const [a, b] = [release(from), release(to)];
  if (!a.length || !b.length) return false;
  if (a[0] !== b[0]) return true;
  return a[0] === 0 && (a[1] ?? 0) !== (b[1] ?? 0);
}

/**
 * Every installed distribution not at a lock version.
 *
 * `drifted` holds the ones the lock names at another version, major jumps first;
 * `unlocked` the ones the lock does not name at all. A lock entry nothing installed is
 * not reported: the lock carries every extra and every platform, so "absent from the
 * venv" would be mostly noise about extras this lane never asked for.
 */
export function diffAgainstLock(installed, pinned) {
  const drifted = [];
  const unlocked = [];
  let atLock = 0;
  for (const name of Object.keys(installed).sort()) {
    const version = installed[name];
    const locked = pinned[name];
    if (!locked) unlocked.push({ name, installed: version });
    else if (locked.has(version)) atLock += 1;
    else {
      const lock = [...locked].sort();
      drifted.push({ name, installed: version, lock, major: lock.every((l) => crossesMajor(l, version)) });
    }
  }
  drifted.sort((x, y) => Number(y.major) - Number(x.major) || x.name.localeCompare(y.name));
  return { total: Object.keys(installed).length, atLock, drifted, unlocked };
}

const HEADING = "### Target dependencies against the lock";

/**
 * The section when the drift could not be computed. Says so; never renders as clean.
 * `reason` is this file's own sentence, markdown included; callers sanitise the values
 * they interpolate into it.
 */
export function renderNotComputed(reason) {
  return [
    HEADING,
    "",
    `_Not computed on this run: ${reason}. Whether a dependency moved off the lock is unknown — which is not the same as no._`,
  ].join("\n");
}

/** The section for a computed drift. */
export function renderDrift(diff, ref) {
  const lines = [HEADING, ""];
  const where = `the \`uv.lock\` of \`${safe(ref)}\``;
  if (diff.total === 0) return renderNotComputed("the freeze listed no installed distribution");

  lines.push(
    "This lane resolves the target's dependencies at install time, as `pip install langflow` does. " +
      "The image lane runs the lock (#2063).",
    "",
  );
  const off = diff.drifted.length + diff.unlocked.length;
  if (off === 0) {
    lines.push(`All **${diff.total}** installed distributions are at the version pinned by ${where}.`);
    return lines.join("\n");
  }

  const majors = diff.drifted.filter((d) => d.major).length;
  lines.push(
    `**${off} of ${diff.total}** installed distributions are not at the version pinned by ${where}` +
      (majors ? `, ${majors} of them across a major (or a minor below 1.0)` : "") +
      ". A failure on this lane and not on the image lane can come from one of them.",
  );

  if (diff.drifted.length) {
    lines.push("");
    for (const d of diff.drifted.slice(0, DRIFT_LISTED)) {
      lines.push(`- \`${safe(d.name)}\` ${safe(d.lock.join(" / "))} → ${d.major ? `**${safe(d.installed)}**` : safe(d.installed)}`);
    }
    if (diff.drifted.length > DRIFT_LISTED) lines.push(`- …and ${diff.drifted.length - DRIFT_LISTED} more below.`);
  }

  if (diff.unlocked.length) {
    lines.push(
      "",
      `Installed and absent from the lock: ${diff.unlocked.map((u) => `\`${safe(u.name)}\` ${safe(u.installed)}`).join(", ")}.`,
    );
  }

  if (diff.drifted.length > DRIFT_LISTED) {
    lines.push("", `<details><summary>All ${diff.drifted.length} off the lock</summary>`, "", "| distribution | lock | installed |", "|---|---|---|");
    for (const d of diff.drifted) lines.push(`| \`${safe(d.name)}\` | ${safe(d.lock.join(" / "))} | ${safe(d.installed)} |`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

/** Reads a file, or `null` when it is absent or empty — the caller names which. */
function readOrNull(path) {
  if (!path) return null;
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The whole section from the three inputs the orchestrator has. Never throws. */
export function renderSection({ freezePath, lockPath, ref }) {
  const freeze = readOrNull(freezePath);
  if (freeze === null) return renderNotComputed("the target venv's freeze could not be read");
  if (!ref) return renderNotComputed("neither a served nor an installed Langflow version is known, so there is no lock to compare against");
  const lock = readOrNull(lockPath);
  if (lock === null) return renderNotComputed(`no \`uv.lock\` could be fetched for \`${safe(ref)}\``);
  const pinned = parseLockVersions(lock);
  if (!Object.keys(pinned).length) return renderNotComputed(`the \`uv.lock\` fetched for \`${safe(ref)}\` names no package`);
  return renderDrift(diffAgainstLock(parseFreeze(freeze), pinned), ref);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  process.stdout.write(`${renderSection({ freezePath: opt("--freeze"), lockPath: opt("--lock"), ref: opt("--ref") })}\n`);
}
