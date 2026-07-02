/**
 * Node-only regression test for `scripts/remove-stable-from-failures.ts`.
 *
 * This is NOT a browser test: it exercises a build/CI script, so it imports
 * `test`/`expect` directly from `@playwright/test` rather than from
 * `../fixtures/fixtures` (the fixtures wrapper adds page-based backend-error
 * monitoring that is meaningless here and requires a running Langflow).
 *
 * Guards the path-resolution contract that broke in #476: the Playwright JSON
 * reporter emits `spec.file` relative to the Playwright `rootDir`
 * (`<repo>/tests`), NOT the repo root. The old code resolved against
 * `REPO_ROOT`, so every hard failure was silently skipped as "spec file not
 * found" and the auto-remove feature never removed a single tag.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { collectHardFailures } from "../../scripts/remove-stable-from-failures";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const FIXTURE_TITLE = "auto-remove fixture: sample stable test";

const FIXTURE_SOURCE = `import { test } from "@playwright/test";

test(
  "${FIXTURE_TITLE}",
  { tag: ["@release", "@stable"] },
  async () => {
    // Fixture for scripts/remove-stable-from-failures — never run as a real test.
  },
);
`;

/**
 * Absolute path to this test's throwaway spec. Placed under `tests/` so the
 * script's relative-path resolution can find it, and keyed to `testInfo.testId`
 * so the fullyParallel tests never share (and race on) the same file. Matches
 * the `.auto-remove-fixture-*.ts` pattern git-ignored at the repo root.
 */
function fixturePath(testInfo: TestInfo): string {
  return path.join(__dirname, `.auto-remove-fixture-${testInfo.testId}.ts`);
}

/** Write the fixture spec for this test and return { abs, rel } (rel = reporter-style). */
function writeFixture(testInfo: TestInfo): { abs: string; rel: string } {
  const abs = fixturePath(testInfo);
  fs.writeFileSync(abs, FIXTURE_SOURCE);
  return { abs, rel: path.relative(TESTS_ROOT, abs) };
}

/** Build a minimal Playwright JSON report carrying one hard failure for FIXTURE. */
function makeReport(specFile: string, opts?: { rootDir?: string }): unknown {
  return {
    config: opts?.rootDir ? { rootDir: opts.rootDir } : {},
    suites: [
      {
        specs: [
          {
            title: FIXTURE_TITLE,
            file: specFile,
            line: 3,
            tests: [{ status: "unexpected" }],
          },
        ],
        suites: [],
      },
    ],
  };
}

function writeReport(report: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-remove-"));
  const p = path.join(dir, "results.json");
  fs.writeFileSync(p, JSON.stringify(report));
  return p;
}

test.afterEach(({}, testInfo) => {
  const abs = fixturePath(testInfo);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
});

test.describe("remove-stable-from-failures path resolution (@stable auto-remove, #476)", () => {
  test("resolves rootDir-relative report paths against tests/, not repo root", ({}, testInfo) => {
    const { abs, rel } = writeFixture(testInfo);

    // No config.rootDir → must fall back to <repo>/tests (the regression from #476).
    const reportPath = writeReport(makeReport(rel));
    const failures = collectHardFailures(reportPath);

    expect(failures).toHaveLength(1);
    expect(path.isAbsolute(failures[0].file)).toBe(true);
    expect(failures[0].file).toBe(abs);
    expect(fs.existsSync(failures[0].file)).toBe(true);
  });

  test("prefers the report's config.rootDir when present", ({}, testInfo) => {
    const { abs, rel } = writeFixture(testInfo);

    const reportPath = writeReport(makeReport(rel, { rootDir: TESTS_ROOT }));
    const failures = collectHardFailures(reportPath);

    expect(failures).toHaveLength(1);
    expect(failures[0].file).toBe(abs);
  });

  test("end-to-end: hard failure is resolved and @stable is spliced out", ({}, testInfo) => {
    const { abs, rel } = writeFixture(testInfo);

    const reportPath = writeReport(makeReport(rel));
    const stdout = execFileSync(
      "npx",
      ["ts-node", "scripts/remove-stable-from-failures.ts"],
      { cwd: REPO_ROOT, env: { ...process.env, PLAYWRIGHT_JSON: reportPath }, encoding: "utf8" },
    );

    const result = JSON.parse(stdout);
    expect(result.status).toBe("removed");
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].title).toBe(FIXTURE_TITLE);
    expect(result.skipped).toHaveLength(0);

    // @stable removed, sibling @release preserved.
    const after = fs.readFileSync(abs, "utf8");
    expect(after).not.toContain("@stable");
    expect(after).toContain("@release");
  });
});
