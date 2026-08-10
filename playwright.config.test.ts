// Unit test for the Playwright config's STDOUT contract (issue #1024).
// Run with: npm run test:units
//
// Nothing in this module may write to stdout. It is imported by every
// `playwright` invocation, and one of them has a machine-readable stdout:
// `daily-stable.yml`'s `prep` job runs
//
//   npx playwright test --grep "@stable" --list --reporter=json > /tmp/stable-list.json
//
// and feeds that file to `partition-shards.mjs matrix`. PR #1021 added a
// `console.log` announcing the `@destructive` lane exclusion — a good idea on the
// wrong channel: the line landed ahead of the JSON, the partitioner exited 1, and
// the daily would have died at `prep` with zero tests executed. No PR check could
// catch it, because `pr-validation.yml` uses `--reporter=github` and `line`.
//
// This is the cheap check that closes that gap. stderr is deliberately NOT
// asserted on: keeping the exclusion visible in the log is the point of #1010, it
// just has to happen off the data path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = __dirname;
/** The local CLI entrypoint. NOT `npx`, which downloads from the registry when the
 *  binary is missing instead of failing — a test must not be able to reach the network. */
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js");

/**
 * Import the config in a FRESH process and hand back what each stream received.
 * A fresh process matters twice: this file's own runner has already loaded
 * modules that could mask a write, and the top-level `if (!DESTRUCTIVE_LANE)`
 * only runs on first import — a cached module would make the test vacuous.
 *
 * Hermetic against the developer's environment on purpose, in two ways:
 *  - `PW_DESTRUCTIVE` is stripped from the inherited env. The very notice these
 *    tests assert on tells the reader to run `PW_DESTRUCTIVE=1 npx playwright
 *    test --grep @destructive`; exporting it and then running the lane in the
 *    same shell would fail with a message blaming the config, not the shell.
 *  - the child runs from an EMPTY cwd, because `playwright.config.ts` calls
 *    `dotenv.config()`, which reads `.env` relative to cwd — and `.env` is
 *    developer-local and git-ignored, so it could inject the same variable
 *    invisibly. That means requiring the config by absolute path and pointing
 *    ts-node at the repo tsconfig explicitly, since it resolves from cwd too.
 */
function importConfig(
  env: Record<string, string> = {},
  { allowFailure = false }: { allowFailure?: boolean } = {},
): { stdout: string; stderr: string; status: number | null } {
  const base = { ...process.env };
  delete base.PW_DESTRUCTIVE;
  // Same hermetic reason as PW_DESTRUCTIVE: the locale override (#1400) is an
  // exported variable a developer may well have set in the shell that runs these.
  delete base.PW_LOCALE;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "config-1024-"));
  try {
    // spawnSync, not execFileSync: the two streams must be read from ONE run and
    // kept apart, so a noisy stderr can never be mistaken for a stdout write.
    const run = spawnSync(
      process.execPath,
      [
        "--require",
        // Absolute: a bare specifier would be resolved against the empty cwd.
        require.resolve("ts-node/register"),
        "-e",
        `require(${JSON.stringify(path.join(REPO_ROOT, "playwright.config.ts"))});`,
      ],
      {
        cwd,
        encoding: "utf-8",
        env: {
          ...base,
          ...env,
          TS_NODE_PROJECT: path.join(REPO_ROOT, "tsconfig.json"),
        },
      },
    );
    if (!allowFailure) {
      assert.equal(run.status, 0, `importing the config failed: ${run.stderr}`);
    }
    return { stdout: run.stdout, stderr: run.stderr, status: run.status };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The resolved `use.locale` of a real config import (#1400).
 *
 * Reads the value the runner would actually consume rather than re-deriving it
 * from `resolveRunLocale` — `locale.test.ts` already covers the resolution, and
 * what is unproven without this is the WIRING: that the config still puts it in
 * `use`, under the key Playwright reads.
 */
function configLocale(env: Record<string, string> = {}): string {
  const base = { ...process.env };
  delete base.PW_DESTRUCTIVE;
  delete base.PW_LOCALE;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "config-1400-"));
  try {
    return execFileSync(
      process.execPath,
      [
        "--require",
        require.resolve("ts-node/register"),
        "-e",
        `const c = require(${JSON.stringify(path.join(REPO_ROOT, "playwright.config.ts"))});` +
          `process.stdout.write(String((c.default ?? c).use.locale));`,
      ],
      {
        cwd,
        encoding: "utf-8",
        env: { ...base, ...env, TS_NODE_PROJECT: path.join(REPO_ROOT, "tsconfig.json") },
        // stderr piped and dropped: the config announces the @destructive
        // exclusion on every import, and this reader is only after the value.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("importing playwright.config.ts writes NOTHING to stdout", () => {
  const { stdout } = importConfig();
  assert.equal(
    stdout,
    "",
    `playwright.config.ts wrote to stdout, which breaks the JSON contract the ` +
      `daily's shard matrix depends on (#1024). Move it to console.error. Got: ${JSON.stringify(stdout)}`,
  );
});

test("the destructive-lane notice still reaches stderr", () => {
  // The exclusion must not become a silent cap (#1010) — it just has to announce
  // itself off the data path.
  const { stderr } = importConfig();
  assert.match(stderr, /@destructive tests are excluded/);
  assert.match(stderr, /PW_DESTRUCTIVE=1/);
});

test("stdout stays clean in the destructive lane too", () => {
  const { stdout, stderr } = importConfig({ PW_DESTRUCTIVE: "1" });
  assert.equal(stdout, "");
  // Inside the lane there is nothing to announce — the tests are running.
  assert.doesNotMatch(stderr, /@destructive tests are excluded/);
});

// --- Browser locale (#1400) -------------------------------------------------
// The suite's default must survive the parameterisation: every English-string
// assertion depends on `use.locale` still being en-US when nothing asks otherwise.

test("the default run is still pinned to en-US", () => {
  assert.equal(configLocale(), "en-US");
});

test("PW_LOCALE reaches use.locale", () => {
  // Canonicalised on the way through, so a lowercase dispatch value works.
  assert.equal(configLocale({ PW_LOCALE: "pt-br" }), "pt-BR");
});

test("an override announces itself on stderr, and stdout stays clean", () => {
  // Same contract as the @destructive notice (#1010/#1024): visible in the log,
  // off the data path the daily's shard matrix parses.
  const { stdout, stderr } = importConfig({ PW_LOCALE: "pt-BR" });
  assert.equal(
    stdout,
    "",
    `the locale notice must not reach stdout — it would break the shard-matrix ` +
      `JSON contract. Got: ${JSON.stringify(stdout)}`,
  );
  assert.match(stderr, /browser locale overridden to pt-BR/);
  assert.match(stderr, /PW_LOCALE/);
});

test("a run at the default locale says nothing about locale at all", () => {
  const { stderr } = importConfig();
  assert.doesNotMatch(stderr, /browser locale overridden/);
});

test("an unusable PW_LOCALE aborts the config with the cause named", () => {
  // Fail-closed: the alternative is the whole suite silently running in en-US
  // under a command line that asked for something else.
  const { status, stderr } = importConfig({ PW_LOCALE: "pt_BR" }, { allowFailure: true });
  assert.notEqual(status, 0, "an invalid locale must abort, not fall back");
  assert.match(stderr, /PW_LOCALE/);
  assert.match(stderr, /pt_BR/);
});

test("the daily's prep command produces parseable JSON", () => {
  // The end-to-end assertion, run exactly as `daily-stable.yml`'s `prep` job does
  // (line 81) rather than trusting the unit checks above to imply it. Kept to
  // `--list`, so nothing executes and no backend is needed.
  const listed = execFileSync(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", "--grep", "@stable", "--list", "--reporter=json"],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );

  const report = JSON.parse(listed) as { suites?: unknown[] };
  assert.ok(Array.isArray(report.suites), "the listed report has no suites array");
  assert.ok(report.suites.length > 0, "no @stable specs were listed");

  // And the consumer itself: `partition-shards.mjs matrix` is what actually dies
  // on a polluted stdout, so run it over this output and require a usable matrix.
  // Through a real file, exactly as the workflow does (`> /tmp/stable-list.json`),
  // rather than `/dev/stdin` — the script reads its argument with readFileSync.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-1024-"));
  try {
    const listPath = path.join(dir, "stable-list.json");
    fs.writeFileSync(listPath, listed);
    const matrix = execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts", "partition-shards.mjs"),
        "matrix",
        listPath,
        path.join(REPO_ROOT, "reports", "spec-durations.json"),
        "4",
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );

    const parsed = JSON.parse(matrix) as { include?: Array<{ shard: number; files: string }> };
    assert.ok(Array.isArray(parsed.include), "the matrix has no include array");
    assert.equal(parsed.include!.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
