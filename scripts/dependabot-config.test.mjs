// Guards over .github/dependabot.yml (#1229).
//
// Unlike most tests here there is no script whose output can be asserted — the
// artifact IS the declarative config, so these are structural guards over its text,
// in the style of scripts/manual-dispatch-inputs.test.mjs. Text is the available
// instrument: no YAML parser is declared in package.json, and adding a dependency
// to lint one 100-line config is a worse trade than the parsing below.
//
// CLAUDE.md is right that a guard pinning a SPELLING does not pin a BEHAVIOUR
// (#1226), and the first version of this file proved the point: `- major` without
// quotes walked straight past it while it reported 5/5. So nothing here matches a
// literal. Values are extracted (quotes stripped, block and flow sequences alike)
// and compared as sets or as numbers.
//
// What is worth guarding, and what is not, moved once already. The first version
// tied the @flakiness/playwright ignore to the repo's `node-version:` pins, on the
// premise that 2.x required Node >= 22.9.0 — which review showed was false by the
// time it was written (2.0.1, `latest` since 2026-07-30, restored
// `^20.17.0 || >=22.9.0`). A guard enforcing a condition that is not the real one is
// worse than no guard: it would have failed every PR that removed the entry, which
// was the correct change. The entry and its guard are both gone; the lesson kept is
// that a guard must encode the reason, not a proxy for it.
//
// So the two things pinned here are the two whose failure is SILENT:
//
//   1. Majors back inside the `dev-dependencies` group. The symptom is not a red
//      guard, it is a grouped PR that dies at `npm ci` and takes its reviewable
//      minors with it (PR #1204: six bumps, two majors, four fine minors that could
//      not be verified because the install never completed).
//   2. An `ignore` widening past its own rationale. `ignore` suppresses SECURITY
//      updates too, so an over-broad entry does not merely delay a bump — it can
//      leave an advisory with no PR at all, and nothing about that is visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = ".github/dependabot.yml";
const CONFIG = fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH), "utf8");
const LINES = CONFIG.split("\n");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

const indentOf = (line) => line.search(/\S/);
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

/**
 * Every line indented deeper than the line at `start` (blank lines included — a
 * blank line inside a block is legal YAML and must not truncate it).
 */
function blockAt(lines, start) {
  const indent = indentOf(lines[start]);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

function blockUnder(header) {
  const start = LINES.findIndex((l) => l.includes(header));
  assert.ok(start > -1, `no line matching \`${header}\` in ${CONFIG_PATH}`);
  return blockAt(LINES, start);
}

/**
 * The values of a YAML list `key:` inside `lines`, as a Set of unquoted strings.
 * Handles both a block sequence and the flow form `key: ["a", "b"]`; returns null
 * when the key is absent, so "missing" and "empty" stay distinguishable.
 */
function listValues(lines, key) {
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (at === -1) return null;

  const inline = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (inline.startsWith("[")) {
    return new Set(
      inline
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(unquote)
        .filter(Boolean),
    );
  }

  return new Set(
    blockAt(lines, at)
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => unquote(l.trim().slice(2))),
  );
}

/**
 * The `ignore:` entries, parsed rather than string-matched: an entry is a
 * `- dependency-name:` line plus everything indented under it. Quoting of the name
 * is normalised, so an unquoted entry is found and a duplicate is detectable.
 */
function ignoreEntries() {
  const entries = [];
  for (const [i, line] of LINES.entries()) {
    const m = line.match(/^(\s*)- dependency-name:\s*(.+)$/);
    if (!m) continue;
    entries.push({
      name: unquote(m[2].replace(/\s+#.*$/, "")),
      line: i,
      indent: m[1].length,
      body: blockAt(LINES, i),
    });
  }
  return entries;
}

const ENTRIES = ignoreEntries();

function entryFor(name) {
  const found = ENTRIES.filter((e) => e.name === name);
  // Exactly one: a second, wider entry for the same package later in the list would
  // silently take effect while a positional lookup kept reading the first.
  assert.equal(found.length, 1, `expected exactly 1 ignore entry for "${name}", found ${found.length}`);
  return found[0];
}

// ── the group excludes majors ───────────────────────────────────────────────

test("the dev-dependencies group takes minor and patch only", () => {
  const group = blockUnder("dev-dependencies:");
  const types = listValues(group, "update-types");

  assert.ok(types, "the group has no update-types limit — majors ride in with the minors (#1204)");
  // Compared as a set, so `- major` in any quoting fails and a pure reformat
  // (flow style, unquoted items) does not.
  assert.deepEqual(types, new Set(["minor", "patch"]));
});

// ── the typescript ignore stays as narrow as its evidence ───────────────────

test("the typescript ignore blocks 7.x and up, not every major", () => {
  const entry = entryFor("typescript");
  const versions = listValues(entry.body, "versions");

  assert.ok(versions, "the typescript ignore lost its versions: range");
  // `update-types: semver-major` is the tempting shorthand and it is wrong here: it
  // would also block TS 6, against which this repo has no evidence — the JS compiler
  // API is intact there, ts-node runs, and typescript-eslint's peer range admits it.
  assert.equal(
    listValues(entry.body, "update-types"),
    null,
    "scoped by update-types instead of a version range — that blocks TS 6 too, which the file's own rationale does not justify",
  );

  const bounds = [...versions].map((v) => {
    const m = v.match(/^>=?\s*(\d+)/);
    assert.ok(m, `\`${v}\` is not a lower-bound range this guard can read`);
    return Number(m[1]);
  });
  assert.deepEqual(bounds, [7], "the ignore no longer starts at the major the rationale is about");
});

test("no ignore range can block the major this repo is actually on", () => {
  // The failure this catches: package.json moves to a new major while an ignore
  // still starts at or below it, so the line the repo depends on stops receiving
  // updates — including security ones — with the config looking untouched.
  for (const entry of ENTRIES) {
    const versions = listValues(entry.body, "versions");
    if (!versions) continue;

    const declared = PKG.devDependencies?.[entry.name] ?? PKG.dependencies?.[entry.name];
    assert.ok(declared, `${CONFIG_PATH} ignores "${entry.name}", which package.json does not declare`);
    const onMajor = Number(declared.match(/(\d+)/)[1]);

    for (const v of versions) {
      const lower = Number(v.match(/^>=?\s*(\d+)/)[1]);
      assert.ok(
        lower > onMajor,
        `the ignore for "${entry.name}" starts at ${lower}, but package.json is on ${onMajor} — it would block the current line`,
      );
    }
  }
});

// ── every entry says why ────────────────────────────────────────────────────

test("each ignore entry carries a rationale in the file", () => {
  // A Dependabot ignore is invisible at the point it acts: the PR that would have
  // existed simply never appears, and for a security advisory that means an alert
  // with nothing attached to it. Whoever finds that surprising has only this file to
  // read, so an entry with no comment above it is a defect.
  //
  // One comment may cover a run of consecutive entries — @playwright/test and
  // playwright share theirs. The walk-up therefore skips anything indented deeper
  // than the entry (whatever keys a future entry gains) plus sibling entry lines,
  // rather than enumerating the keys known today.
  for (const entry of ENTRIES) {
    let j = entry.line - 1;
    while (j >= 0) {
      const line = LINES[j];
      const isDeeper = line.trim() !== "" && indentOf(line) > entry.indent;
      const isSibling = /^\s*- dependency-name:/.test(line) && indentOf(line) === entry.indent;
      if (line.trim() === "" || isDeeper || isSibling) {
        j--;
        continue;
      }
      break;
    }
    assert.ok(j >= 0 && LINES[j].trim().startsWith("#"), `no rationale comment above the ignore entry for "${entry.name}"`);
  }
});
