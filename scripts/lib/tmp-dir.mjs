// A temp directory that removes itself (issue #1732).
//
// WHY THIS EXISTS
//
// 25 of the 36 unit-test files that called `mkdtempSync` never removed what they
// created. Measured 2026-09-05 on one developer machine: **26 403 of the 29 887
// entries in `$TMPDIR`, 1.4 GB**, left by this repo's own unit lanes — the worst
// single file at 4448 directories, and `watch-upstream-areas.test.mjs` creating
// real git repositories 16 at a time, every run.
//
// CI never showed it. Runners are ephemeral, so both lanes are green and stay
// green; the cost lands entirely on whoever runs the unit lanes locally and
// repeatedly, which is the person iterating on the code they cover. That is the
// same asymmetry #1012 keeps naming — a cost no dashboard shows is not a cost
// nobody pays.
//
// WHY A HELPER RATHER THAN 25 `after()` HOOKS
//
// Because 25 files each remembering to clean up is precisely the state that
// produced this. The lifetime belongs to whatever created the directory, so a
// caller cannot forget it: registration happens on the first call, and the
// removal runs on process exit. `node --test` gives each test file its own child
// process, so "process exit" is "this file is done".
//
// It is best-effort by construction — a `SIGKILL`ed run still leaks, and that is
// accepted. A test that wants the directory gone mid-run may still `rmSync` it;
// the exit sweep uses `force: true`, so removing it twice is a no-op.
//
// WHY THERE ARE TWO COPIES OF FIFTEEN LINES
//
// `tmp-dir.ts` is the same helper for the `ts-node` lane, and it is a copy rather
// than an import because the root `tsconfig.json` is `"module": "commonjs"`:
// `require()` of an ESM `.mjs` is not loadable on Node 20, so a `.ts` test cannot
// reach this file at all. The duplication is deliberate and pinned — the guard in
// `tmp-dir.test.mjs` asserts the two exports stay in step — rather than left to
// look like an oversight.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory this process created, so exit can sweep them. */
const created = new Set();
let sweepRegistered = false;

/**
 * `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, plus the removal.
 *
 * @param {string} prefix the same prefix the direct call used, so a leftover
 *   directory from an older run is still attributable to its test file.
 * @returns {string} the created directory
 */
export function makeTempDir(prefix) {
  if (!sweepRegistered) {
    // `exit` handlers must be synchronous, which `rmSync` is. Registered lazily
    // so importing this module costs nothing to a caller that never uses it.
    process.on("exit", removeAllTempDirs);
    sweepRegistered = true;
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/**
 * Remove everything `makeTempDir` created, best effort.
 *
 * Exported so a test can prove the sweep works without exiting the process, and
 * so a long file can reclaim space mid-run. Never throws: a directory the sweep
 * cannot remove is a leaked directory, which is where this started — it is not a
 * reason to fail a run that otherwise passed.
 */
export function removeAllTempDirs() {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort by design — see above.
    }
  }
  created.clear();
}
