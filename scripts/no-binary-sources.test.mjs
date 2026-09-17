// No source file in this repo may contain a NUL byte (#1763).
//
// WHY THIS IS A GUARD AND NOT A CONVENTION. Three modules here build a join key
// out of a NUL separator (`report-backend-outages.mjs`,
// `remove-stable-from-failures.ts`, `lib/outage-overlap.mjs`), and spelling it as
// the BYTE instead of the `\u0000` escape compiles, passes `tsc`, passes ESLint
// and passes `node --test` — it shipped that way in the first version of #1763's
// module and was caught by a human reading the diff, which is the review this
// repo keeps trying to stop depending on.
//
// What it costs is exactly the things that make a defect findable:
//   - git classifies the file as BINARY, so the PR renders "Binary file not
//     shown" — on, in that instance, the one file holding the whole join and its
//     three-state logic. Blame and conflict resolution degrade the same way.
//   - `grep` silently finds nothing in it without `-a`, and this repo has
//     structural guards built on shell `grep` over `scripts/**`. A guard that
//     reports no match on an unreadable file is a guard that went quiet.
//
// Scope is the source trees the unit lanes already own. Fixtures are not exempt:
// a NUL in one is just as invisible, and a test that needs the byte can build it
// with `String.fromCharCode(0)`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TREES = ["scripts", "tests/helpers", "tests/fixtures", ".claude/skills"];
const EXTENSIONS = /\.(ts|mts|mjs|js|json|md|yml|yaml)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "test-results", "playwright-report"]);

function* sources(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (EXTENSIONS.test(entry.name)) yield full;
  }
}

test("no tracked source file contains a NUL byte", () => {
  const offenders = [];
  let scanned = 0;
  for (const tree of TREES) {
    for (const file of sources(join(ROOT, tree))) {
      scanned += 1;
      if (readFileSync(file).includes(0)) offenders.push(relative(ROOT, file));
    }
  }
  // A floor, for the reason every other verdict in this repo carries one: a walk
  // that silently found nothing would pass forever (#1012).
  assert.ok(scanned > 200, `expected to scan the source trees, only reached ${scanned} files`);
  assert.deepEqual(
    offenders,
    [],
    `NUL byte in source — git will treat these as binary and the PR diff will not render them. Spell the separator as \\u0000:\n  ${offenders.join("\n  ")}`,
  );
});
