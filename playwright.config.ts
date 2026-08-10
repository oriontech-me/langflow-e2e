import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";
import { resolveRunLocale } from "./tests/fixtures/locale";

dotenv.config();

/**
 * Base URL of the Langflow instance to test against.
 * Override via env var:
 *   PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860";

/**
 * Destructive lane (#1010).
 *
 * A `@destructive` test mutates account-wide state — today
 * `folder-deletion-integrity.spec.ts` deleting EVERY project of the shared
 * superuser to reach the empty-project screen. Under `fullyParallel` that is a
 * cross-test wiper: it emptied the account under its own file-siblings and under
 * folder-crud / bulk-actions / flow-navigation-between-folders, whose bootstrap
 * then took the empty-instance branch and burned a 30s poll on a welcome overlay
 * that state never produces.
 *
 * So the tag is a LANE SELECTOR, not a severity: every normal run excludes it,
 * and `PW_DESTRUCTIVE=1` runs it alone. Two details are deliberate:
 *  - the exclusion uses `grepInvert`, not `grep`. A CLI `--grep` (the daily's
 *    `@stable`, nightly's optional filter) OVERRIDES `config.grep` but leaves
 *    `config.grepInvert` in place — so no caller can bypass the exclusion by
 *    passing a filter of its own.
 *  - the lane pins `workers: 1` / `fullyParallel: false` HERE rather than relying
 *    on the command line, so a caller cannot forget and let two destructive tests
 *    wipe each other.
 */
const DESTRUCTIVE_LANE = !!process.env.PW_DESTRUCTIVE;

if (!DESTRUCTIVE_LANE) {
  // Never let the exclusion become a silent cap: say it on every run, with the
  // exact command that runs what was left out.
  //
  // stderr, NOT stdout (#1024). This module is imported by every `playwright`
  // invocation, including `--list --reporter=json`, whose STDOUT is a machine
  // contract: `daily-stable.yml`'s `prep` job redirects it into a file and feeds
  // that to `partition-shards.mjs matrix`. One line ahead of the JSON made the
  // file unparseable, the partitioner exited 1, and the daily died before a
  // single test ran. stderr keeps the line just as visible in the Actions log —
  // and `playwright-config.test.ts` now asserts stdout stays clean.
  console.error(
    "[lane] @destructive tests are excluded from this run — run them with: PW_DESTRUCTIVE=1 npx playwright test --grep @destructive",
  );
}

/**
 * Browser locale for this run (#1400). `en-US` unless PW_LOCALE asks otherwise;
 * an unusable value throws here instead of falling back to English, and a real
 * override announces itself — on stderr, never stdout (#1024, see the notice's
 * doc in `tests/fixtures/locale.ts`).
 */
const RUN_LOCALE = resolveRunLocale();
if (RUN_LOCALE.notice) {
  console.error(RUN_LOCALE.notice);
}

export default defineConfig({
  testDir: "./tests",
  // The destructive lane runs account-wide wipers, so it must never schedule two
  // tests at once (see DESTRUCTIVE_LANE above).
  grepInvert: DESTRUCTIVE_LANE ? undefined : /@destructive/,
  // Playwright's default testMatch is `**/*.@(spec|test).?(c|m)[jt]s`, which also
  // collects the `*.test.ts` unit tests living next to the helpers they cover
  // (issue #1017) — those run under `node --test` (`npm run test:units`), need no
  // browser and no backend, and would fail on the Playwright fixtures they never
  // import. Dropping only `test` from the pattern keeps `npx playwright test`,
  // `--grep`, the tag counters and the impacted-specs pathspec seeing exactly the
  // same file set. A RegExp rather than a glob so the extension alternation is
  // unambiguous: every spec is `.spec.ts` today, but a future `.spec.mts` stays
  // collected instead of silently dropping out of the suite.
  testMatch: /\.spec\.[cm]?[jt]s$/,
  // File-level sharding for the daily's sharded run keeps every test() of a spec
  // file in one shard (so @database state-sharing holds). The sharded job sets
  // PW_SHARD_FILE_LEVEL=1; local dev / nightly / manual keep test-level parallelism.
  fullyParallel:
    DESTRUCTIVE_LANE || process.env.PW_SHARD_FILE_LEVEL ? false : true,
  forbidOnly: !!process.env.CI,
  // PLAYWRIGHT_RETRIES overrides the retry count when set (e.g. a manual
  // validation dispatch passing 0 for a fast, unamplified signal); empty/unset
  // falls back to the default (2 in CI, 3 locally).
  retries:
    process.env.PLAYWRIGHT_RETRIES !== undefined &&
    process.env.PLAYWRIGHT_RETRIES !== ""
      ? Number(process.env.PLAYWRIGHT_RETRIES)
      : process.env.CI
        ? 2
        : 3,
  // 2 workers in CI (sharded or not). The #817 contention was 2 workers hitting
  // ONE langflow that served the whole 353-test suite; with a dedicated langflow
  // per shard (~90 tests each) the 2nd worker is a net win — benchmarked at ~28min
  // (workers=2) vs ~39min (workers=1) at N=4, correctness identical. See
  // ISSUE-833-SHARDING-DESIGN.md §"workers per shard".
  workers: DESTRUCTIVE_LANE ? 1 : process.env.CI ? 2 : undefined,
  timeout: 5 * 60 * 1000, // 5 minutes per test
  // Reporters run side by side. The Flakiness.io reporter MUST live here, not on
  // the CLI `--reporter` flag, because its `flakinessProject` option (required for
  // GitHub OIDC upload) cannot be passed via the command line. It uploads per-run
  // in its onExit() hook, so under sharding each shard uploads its own slice — no
  // merge of Flakiness reports is needed (the merge job only recombines Playwright
  // blobs).
  //
  // Three reporter shapes:
  // - Sharded CI (PW_SHARD_FILE_LEVEL set by the daily's shard step): `blob` (the
  //   merge job rebuilds html/github/json from the combined blobs) + Flakiness.io.
  //   `blob` MUST be configured here rather than via `--reporter=blob` on the CLI,
  //   which would replace the whole list and drop the Flakiness reporter.
  // - Non-sharded CI (nightly / manual): html + github + json + Flakiness.io.
  // - Local: html + Flakiness.io.
  reporter: process.env.CI
    ? process.env.PW_SHARD_FILE_LEVEL
      ? [
          ["blob"],
          ["@flakiness/playwright", { flakinessProject: "Orion/langflow-e2e" }],
        ]
      : [
          ["html"],
          ["github"],
          ["json"],
          ["@flakiness/playwright", { flakinessProject: "Orion/langflow-e2e" }],
        ]
    : [
        ["html"],
        ["@flakiness/playwright", { flakinessProject: "Orion/langflow-e2e" }],
      ],

  use: {
    baseURL: BASE_URL,
    // The browser context locale (and the document `Accept-Language`), pinned so
    // the English-string assertions throughout the suite stay stable regardless
    // of host machine or CI runner settings (#225). It is a resolved value rather
    // than a literal since #1400: a spec opts out per describe with
    // `test.use(withLocale("pt-BR"))`, and a whole run with PW_LOCALE. It does
    // NOT decide the language Langflow renders — that comes from
    // localStorage.languagePreference; `tests/fixtures/locale.ts` has the
    // measurement and the other two axes.
    locale: RUN_LOCALE.locale,
    actionTimeout: 20000,
    trace: "on-first-retry",
    screenshot: process.env.CI ? "only-on-failure" : "off",
    video: process.env.CI ? "on-first-retry" : "off",
  },

  globalSetup: require.resolve("./tests/globalSetup.ts"),
  globalTeardown: require.resolve("./tests/globalTeardown.ts"),

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        contextOptions: {
          permissions: ["clipboard-read", "clipboard-write"],
        },
      },
    },
  ],
});
