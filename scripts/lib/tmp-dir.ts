// A temp directory that removes itself — the `ts-node` lane's copy (issue #1732).
//
// THIS IS A DELIBERATE COPY OF `tmp-dir.mjs`, NOT AN OVERSIGHT.
//
// The root `tsconfig.json` is `"module": "commonjs"`, so `npm run test:units`
// (`node --require ts-node/register`) emits `require()` for every import — and
// `require()` of an ESM `.mjs` is not loadable on Node 20. A `.ts` test therefore
// cannot reach the `.mjs` helper at all, and the fifteen lines below are the price
// of the module boundary the tsconfig sets. `tmp-dir.test.mjs` asserts the two
// stay in step, so the copy cannot drift silently.
//
// The full argument for the helper — 26 403 leaked directories across 25 test
// files, why the lifetime belongs here rather than in 25 `after()` hooks, and why
// best-effort is the right guarantee — is at the top of `tmp-dir.mjs`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory this process created, so exit can sweep them. */
const created = new Set<string>();
let sweepRegistered = false;

/**
 * `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, plus the removal.
 *
 * @param prefix the same prefix the direct call used, so a leftover directory
 *   from an older run is still attributable to its test file.
 */
export function makeTempDir(prefix: string): string {
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
 * Never throws: a directory the sweep cannot remove is a leaked directory, which
 * is where this started — not a reason to fail a run that otherwise passed.
 */
export function removeAllTempDirs(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort by design — see `tmp-dir.mjs`.
    }
  }
  created.clear();
}
