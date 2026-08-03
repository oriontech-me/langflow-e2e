// Guards over .github/dependabot.yml (#1229).
//
// Unlike most tests here there is no script whose output can be asserted — the
// artifact IS the declarative config, so these are structural guards over its text,
// in the style of scripts/manual-dispatch-inputs.test.mjs. Text is the available
// instrument: no YAML parser is declared in package.json, and adding a dependency
// to lint one 90-line config is a worse trade than the parsing below.
//
// CLAUDE.md is right that a guard pinning a SPELLING does not pin a BEHAVIOUR
// (#1226), and the first version of this file proved the point: `- major` without
// quotes, and a commented-out `# node-version: "20"`, both walked straight past it
// while it reported 5/5. So nothing here matches a literal any more. Values are
// extracted (quotes stripped, block and flow sequences alike) and compared as sets,
// and every scan is anchored to a real YAML key so a comment cannot impersonate one.
//
// Two things this file exists to catch, both of which fail SILENTLY:
//
//   1. Majors back inside the `dev-dependencies` group. The symptom is not a red
//      guard, it is a grouped PR that dies at `npm ci` and takes its reviewable
//      minors with it (PR #1204: six bumps, two majors, four fine minors that could
//      not be verified because the install never completed).
//   2. The TEMPORARY @flakiness/playwright ignore outliving its condition. It exists
//      only because the lanes pin Node 20 while v2.x requires >= 22.9.0. A comment
//      cannot enforce its own removal, so the last test reads the actual pins and
//      fails when they stop justifying the entry.
//
// Where a pin cannot be read (an expression, a `node-version-file:`), the guard
// FAILS naming the file and line rather than dropping it from the minimum — the
// undecidable-is-not-clean rule this repo applies in provider-dependent-specs.mjs
// and #1012. Silently ignoring an unreadable pin is how the temporary ignore would
// get deleted while a lane is still on Node 20.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = ".github/dependabot.yml";
const CONFIG = fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH), "utf8");
const LINES = CONFIG.split("\n");

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

// ── the two ignores, and what distinguishes them ────────────────────────────

for (const name of ["typescript", "@flakiness/playwright"]) {
  test(`the ${name} ignore is scoped to majors, and to nothing else`, () => {
    const entry = entryFor(name);

    assert.deepEqual(listValues(entry.body, "update-types"), new Set(["version-update:semver-major"]));
    // `versions:` is the other key that can freeze a dependency, and it would do so
    // without touching update-types — leaving the entry looking correctly scoped
    // while security patches inside the current major stop arriving.
    assert.equal(listValues(entry.body, "versions"), null, `${name} carries a versions: range — patches inside the current major would stop`);
  });
}

test("each ignore entry carries a rationale in the file", () => {
  // A Dependabot ignore is invisible at the point it acts: the PR that would have
  // existed simply never appears. Whoever finds that surprising has only this file
  // to read, so an entry with no comment above it is a defect.
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

// ── the temporary ignore vs. the condition that removes it ──────────────────

/** Every .yml/.yaml under .github, at any depth. */
function ciFiles(dir = path.join(REPO_ROOT, ".github")) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...ciFiles(full));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Node pins across CI, as { satisfied, undecidable }. A pin satisfies the
 * requirement when it is >= 22.9.0 — the floor @flakiness/playwright 2.x declares.
 * A bare major ("22") is treated as satisfying: setup-node resolves it to the
 * latest 22.x, which is past 22.9.0.
 */
function readNodePins() {
  const satisfied = [];
  const undecidable = [];

  for (const file of ciFiles()) {
    const rel = path.relative(REPO_ROOT, file);
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // Anchored at the start of the line: a `#` before the key kills the match,
        // so a commented-out pin and prose mentioning one are both excluded.
        const m = line.match(/^\s*(node-version|node-version-file):\s*(.+)$/);
        if (!m) return;
        const where = `${rel}:${i + 1}`;
        if (m[1] === "node-version-file") {
          undecidable.push(`${where} — pinned via node-version-file, which this guard cannot resolve`);
          return;
        }
        const value = unquote(m[2].replace(/\s+#.*$/, ""));
        const parsed = value.match(/^(\d+)(?:\.(\d+))?/);
        if (!parsed) {
          undecidable.push(`${where} — \`${value}\` is not a literal version`);
          return;
        }
        const [major, minor] = [Number(parsed[1]), parsed[2] === undefined ? null : Number(parsed[2])];
        const ok = major > 22 || (major === 22 && (minor === null || minor >= 9));
        satisfied.push({ where, value, ok });
      });
  }

  return { satisfied, undecidable };
}

test("the @flakiness/playwright ignore is removed once the lanes leave Node 20", () => {
  const { satisfied, undecidable } = readNodePins();

  assert.ok(satisfied.length > 0 || undecidable.length > 0, "no `node-version:` pin found anywhere under .github — this guard would pass vacuously");
  // Fail loud rather than quietly shrinking the sample: an unreadable pin dropped
  // from the minimum is how this guard would tell you to delete an ignore that a
  // Node 20 lane still needs.
  assert.deepEqual(undecidable, [], `unreadable Node pin(s); teach this guard to read them before trusting its verdict:\n  ${undecidable.join("\n  ")}`);

  const behind = satisfied.filter((p) => !p.ok);
  // Read from the parsed entries, not a substring: a commented-out entry is not an
  // ignore, and must not read as one.
  const ignored = ENTRIES.some((e) => e.name === "@flakiness/playwright");

  if (behind.length > 0) {
    assert.ok(
      ignored,
      `${behind.length} lane(s) pin Node below 22.9.0 (e.g. ${behind[0].where} → ${behind[0].value}), so @flakiness/playwright 2.x (engines: >=22.9.0) must stay ignored`,
    );
  } else {
    assert.ok(
      !ignored,
      `every Node pin is now >= 22.9.0 — drop the TEMPORARY @flakiness/playwright ignore from ${CONFIG_PATH}`,
    );
  }
});
