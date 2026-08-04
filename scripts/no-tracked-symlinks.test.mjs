// A tracked symlink is a machine-specific absolute path committed into the repo.
// Run with: npm run test:scripts
//
// WHY THIS EXISTS
//
// PR #1253 merged a `node_modules` symlink into main pointing at
// `/Users/<someone>/Documents/langflow-e2e/node_modules`. It got there because a
// git worktree symlinked the repo's own install to avoid a second `npm ci`, and
// `git add -A` picked it up: `.gitignore`'s `node_modules/` matches a DIRECTORY,
// and a symlink is a blob (mode 120000), so the ignore rule never applied.
//
// Nothing caught it. Every PR check passed — `npm ci` deletes and recreates the
// path, so CI was green while the committed tree carried a link that resolves to
// nothing on any other machine. The `.gitignore` fix beside this file closes the
// one entry point that was used; this closes the class.
//
// Scoped to symlinks, not to "unexpected files": the repo legitimately gains
// files all the time, and a guard that argues about which ones belong would be
// noise. A tracked symlink has no legitimate use here today, so the rule can be
// absolute — and if one is ever wanted, this test is the place to state why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("no symlink is tracked in git", () => {
  // `git ls-files -s` prints the mode as the first field; 120000 is a symlink.
  // Reading the index rather than the working tree on purpose: an untracked
  // symlink (a worktree's own convenience link) is fine and must not fail this.
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-s"], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch (error) {
    // Not a git checkout (a tarball, a vendored copy): the guard cannot reach a
    // verdict, and an unreachable verdict is not a pass (#1012). Skip loudly
    // rather than assert on nothing.
    assert.fail(`could not read the git index to check for tracked symlinks: ${error?.message || error}`);
  }

  const symlinks = out
    .split("\n")
    .filter((line) => line.startsWith("120000 "))
    .map((line) => line.split("\t").slice(1).join("\t"));

  assert.deepEqual(
    symlinks,
    [],
    `tracked symlink(s) found: ${symlinks.join(", ")}. A symlink in the index is an ` +
      "absolute path from one machine committed for everyone — it resolves to nothing " +
      "on a fresh clone and on every CI runner. Remove it with `git rm --cached <path>` " +
      "and add the path to .gitignore.",
  );
});
