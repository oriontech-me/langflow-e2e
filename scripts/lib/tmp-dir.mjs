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
// WHY THIS IS THE ONLY COPY
//
// The first version of this shipped a `tmp-dir.ts` twin, justified with a claim
// that is FALSE: "the root tsconfig is `"module": "commonjs"` and Node 20 cannot
// `require()` an ESM `.mjs`". Node can, unflagged, since 20.19 — measured on this
// repo's 20.20.2, and CI pins `node-version: "20"`, which resolves to the newest
// 20.x. What actually stood in the way was TYPES, and types cost a declaration
// file (`tmp-dir.d.mts`) rather than a fork of the implementation.
//
// The distinction was not pedantry. A second copy meant the `.ts` lane's helper
// had **no behavioural coverage at all**: deleting its `process.on("exit")` would
// have leaked every directory `test:units` creates — including the suite's worst
// offender, 4480 directories — with every test, this file's guard included, still
// green. One implementation is one thing to test.
//
// The cost is explicit rather than latent: `require(esm)` puts a floor under the
// `ts-node` lane, so `package.json` now declares `"engines": {"node": ">=20.19"}`.
//
// WHY THE SWEEP IS `exit` AND NOT ALSO `SIGINT`
//
// Interrupting a 50 s lane is routine, and `exit` does not fire for it — so
// Ctrl-C still leaks, which is a real gap and is stated rather than hidden. A
// `SIGINT` listener is not a free fix: registering one SUPPRESSES Node's default
// terminate-on-interrupt for every module that imports this, which is a semantic
// change no test asked for. Handling it correctly means re-raising with the right
// exit code, and that belongs in a runner, not in a fifteen-line helper.

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
