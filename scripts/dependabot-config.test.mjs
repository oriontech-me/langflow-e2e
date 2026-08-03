// Guards over .github/dependabot.yml (#1229).
//
// Unlike every other test in this directory, there is no script here whose output
// can be asserted — the artifact IS the declarative config, so these are structural
// guards over its text, in the style of the wait-for-backend adoption guard. That
// makes them spelling guards, and CLAUDE.md is right that a spelling guard does not
// pin a behaviour (#1226). They are still worth their line count, because both
// things they pin fail SILENTLY:
//
//   1. Majors back inside the `dev-dependencies` group. The symptom is not a red
//      guard, it is a grouped PR that dies at `npm ci` and takes its reviewable
//      minors down with it (PR #1204: six bumps, two majors, four fine minors
//      unverifiable because the install never completed).
//   2. The TEMPORARY @flakiness/playwright ignore outliving its own condition. It
//      exists only because every lane pins Node 20 while v2.x requires >= 22.9.0.
//      A comment cannot enforce its own removal — so the third test reads the
//      actual `node-version:` pins and fails when they no longer justify the entry.
//      That is the test that turns "remove this later" into something CI can say.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = fs.readFileSync(path.join(REPO_ROOT, ".github/dependabot.yml"), "utf8");

/**
 * Return the YAML block introduced by the line matching `header`, i.e. every
 * following line indented deeper than the header itself. Comment and blank lines
 * are kept — an entry's rationale lives in them.
 */
function blockUnder(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(header));
  assert.ok(start > -1, `no line matching \`${header}\` in .github/dependabot.yml`);
  const indent = lines[start].search(/\S/);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (line.search(/\S/) <= indent) break;
    out.push(line);
  }
  return out.join("\n");
}

/** The block of a single `ignore:` entry, from its `- dependency-name:` line. */
function ignoreEntry(name) {
  const lines = CONFIG.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- dependency-name: "${name}"`);
  assert.ok(start > -1, `no ignore entry for "${name}"`);
  const indent = lines[start].search(/\S/);
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    // A sibling entry starts at the same indent with its own `- `.
    if (line.search(/\S/) <= indent) break;
    out.push(line);
  }
  return out.join("\n");
}

// ── the group excludes majors ───────────────────────────────────────────────

test("the dev-dependencies group takes minor and patch only", () => {
  const group = blockUnder(CONFIG, "dev-dependencies:");

  assert.match(group, /update-types:/, "the group has no update-types limit — majors ride in with the minors (#1204)");
  assert.match(group, /^\s+- "minor"$/m);
  assert.match(group, /^\s+- "patch"$/m);
  // "major" must not appear as a listed update-type. Checked as a list item rather
  // than a substring so the word may still be used in the block's rationale.
  assert.doesNotMatch(group, /^\s+- "major"$/m, "majors are back in the group");
});

// ── the two ignores, and what distinguishes them ────────────────────────────

test("typescript majors are ignored, minors and patches still flow", () => {
  const entry = ignoreEntry("typescript");
  assert.match(entry, /version-update:semver-major/);
  // Scoping to majors is the whole point: an unscoped entry would freeze the 5.x
  // line too, and a security patch inside the current major would stop arriving.
  assert.doesNotMatch(entry, /version-update:semver-(minor|patch)/);
});

test("the @flakiness/playwright ignore is scoped to majors", () => {
  const entry = ignoreEntry("@flakiness/playwright");
  assert.match(entry, /version-update:semver-major/);
  assert.doesNotMatch(entry, /version-update:semver-(minor|patch)/);
});

test("each ignore entry carries a rationale in the file", () => {
  // Dependabot ignores are invisible at the point they act: the PR that would have
  // existed simply never appears. Whoever finds that surprising has only this file
  // to read, so an entry with no comment above it is a defect.
  const lines = CONFIG.split("\n");
  // One comment may cover a run of consecutive entries — @playwright/test and
  // playwright share theirs, and splitting it would duplicate the same 15 lines.
  // So walk up past sibling entry lines and require a comment before the run.
  const partOfEntry = (l) =>
    l.trim().startsWith("- dependency-name:") ||
    l.trim().startsWith("update-types:") ||
    l.trim().startsWith('- "version-update:');

  for (const [i, line] of lines.entries()) {
    if (!line.trim().startsWith("- dependency-name:")) continue;
    let j = i - 1;
    while (j >= 0 && (lines[j].trim() === "" || partOfEntry(lines[j]))) j--;
    assert.ok(j >= 0 && lines[j].trim().startsWith("#"), `no rationale comment above ${line.trim()}`);
  }
});

// ── the temporary ignore vs. the condition that removes it ──────────────────

test("the @flakiness/playwright ignore is removed once the lanes leave Node 20", () => {
  // @flakiness/playwright 2.x declares `engines.node: ">=22.9.0"`; 1.18.0 accepted
  // `^20.17.0 || >=22.9.0`. The ignore is justified by, and only by, the lanes still
  // pinning Node 20 — so read the pins rather than trusting the comment.
  const dirs = [".github/workflows", ".github/actions"];
  const files = [];
  for (const dir of dirs) {
    const root = path.join(REPO_ROOT, dir);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...fs.readdirSync(full).filter((f) => f.endsWith(".yml")).map((f) => path.join(full, f)));
      } else if (entry.name.endsWith(".yml")) {
        files.push(full);
      }
    }
  }

  const pins = files
    .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
    .map((l) => l.match(/node-version:\s*"?(\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  assert.ok(pins.length > 0, "no `node-version:` pin found — this guard would pass vacuously");

  const ignored = CONFIG.includes('- dependency-name: "@flakiness/playwright"');
  const stillOnNode20 = Math.min(...pins) < 22;

  if (stillOnNode20) {
    assert.ok(
      ignored,
      `a lane still pins Node ${Math.min(...pins)}, so @flakiness/playwright 2.x (engines: >=22.9.0) must stay ignored`,
    );
  } else {
    assert.ok(
      !ignored,
      "every lane now runs Node >= 22 — drop the TEMPORARY @flakiness/playwright ignore from .github/dependabot.yml",
    );
  }
});
