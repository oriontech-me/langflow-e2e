import { defineConfig } from "@playwright/test";

/**
 * Config used ONLY by `playwright merge-reports`, and only by the VM lane.
 *
 * ## Why it has to exist
 *
 * `scripts/run-e2e.sh` gives every shard its own working copy of the tree — a real
 * copy, not a symlink, because `collect-models` writes into it. Playwright therefore
 * records that copy's path as the blob's `testDir`, and four shards produce four
 * different ones. `merge-reports` refuses blobs whose `testDir` values differ:
 *
 *     Error: Blob reports being merged were recorded with different test
 *     directories, and merging cannot proceed.
 *
 * Passing a merge config is the remedy Playwright's own error names. This one exists
 * so that remedy is a reviewable file rather than a string generated at run time.
 *
 * The Actions lane never needed it: there each shard is its own runner, at the same
 * absolute path, so the recorded values coincide. The per-shard copy is a VM-side
 * construct, which makes this a difference in the instrument, not in the product.
 *
 * ## Why only `testDir`
 *
 * Merging needs to know where the tests actually live so the merged report's paths
 * are correct against the repository rather than against a per-shard copy. It does
 * not need projects, webServer, timeouts or globalSetup — and importing the full
 * `playwright.config.ts` here would evaluate all of that for a step that runs after
 * every test has finished.
 *
 * The value is duplicated from `playwright.config.ts` deliberately, and a test in
 * `scripts/run-e2e.test.mjs` fails if the two ever drift apart: a merge config
 * pointing somewhere else would not fail loudly, it would relabel every path in the
 * merged report.
 */
export default defineConfig({
  testDir: "./tests",
});
