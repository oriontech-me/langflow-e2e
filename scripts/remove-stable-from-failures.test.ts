// Unit tests for the @stable auto-removal script (issue #1017).
// Run with: npm run test:units
//
// This is the only script in the repo that EDITS SPEC FILES AND COMMITS THEM TO
// `main` with no human review (leadership decision — restoring a tag is the
// human-gated step, removing one is not). Its mass-failure guard is the last
// thing between an infra-red day and the whole stable suite being quarantined
// at once, and until now nothing asserted that the guard fires.
//
// The tests drive the REAL script as a subprocess, through the contract
// `.github/actions/auto-remove-stable/action.yml` uses (`PLAYWRIGHT_JSON` +
// `MAX_AUTO_REMOVE` in, one JSON object on stdout), against throwaway spec
// files in a temp dir. Anything less would test a reimplementation of the guard
// rather than the guard: `main()` reads its threshold at module scope and writes
// to disk, so the file mutation IS the behaviour under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectHardFailures } from "./remove-stable-from-failures";

const SCRIPT = path.join(__dirname, "remove-stable-from-failures.ts");

interface Result {
  status: "removed" | "none" | "guard_tripped";
  threshold: number;
  hardFailures: number;
  removed: Array<{ file: string; title: string; line: number; soleTag: boolean }>;
  skipped: Array<{ file: string; title: string; line: number; reason: string }>;
}

/** A minimal spec carrying one `@stable` test per title, plus decoy prose. */
function specSource(titles: string[]): string {
  return [
    "import { test } from '../fixtures/fixtures';",
    "",
    "// Promoted to @stable in the 1.10.x cycle — this comment is not a tag.",
    ...titles.flatMap((t) => [
      `test("${t}", { tag: ["@stable", "@regression"] }, async ({ page }) => {`,
      "  await page.goto('/');",
      "});",
      "",
    ]),
  ].join("\n");
}

/**
 * Run the real script over a temp workspace. `specs` maps a spec filename to
 * the titles it declares; `failures` names the (file, title) pairs the report
 * marks `unexpected`. Returns the parsed stdout plus the on-disk sources after,
 * so a test can assert that NOTHING was rewritten.
 */
function runScript(opts: {
  specs: Record<string, string[]>;
  failures?: Array<{ file: string; title: string; status?: string }>;
  maxAutoRemove?: string;
  reportPath?: string;
  reportBody?: string;
}): { result: Result; after: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-"));
  try {
    for (const [file, titles] of Object.entries(opts.specs)) {
      fs.writeFileSync(path.join(dir, file), specSource(titles));
    }

    // Playwright's JSON reporter emits `spec.file` relative to its rootDir, and
    // records the absolute rootDir in `config` — the shape #476 taught the
    // script to resolve. Reproduce it rather than shortcutting to absolute paths.
    const report = {
      config: { rootDir: dir },
      suites: (opts.failures ?? []).map((f, i) => ({
        title: f.file,
        file: f.file,
        specs: [
          {
            title: f.title,
            file: f.file,
            line: 4 + i,
            tests: [{ status: f.status ?? "unexpected" }],
          },
        ],
      })),
    };

    const reportPath = path.join(dir, opts.reportPath ?? "results.json");
    if (opts.reportBody !== undefined) {
      fs.writeFileSync(reportPath, opts.reportBody);
    } else if (opts.reportPath !== "missing.json") {
      fs.writeFileSync(reportPath, JSON.stringify(report));
    }

    const stdout = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          PLAYWRIGHT_JSON: reportPath,
          MAX_AUTO_REMOVE: opts.maxAutoRemove ?? "5",
          TS_NODE_PROJECT: path.join(__dirname, "..", "tsconfig.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const after: Record<string, string> = {};
    for (const file of Object.keys(opts.specs)) {
      after[file] = fs.readFileSync(path.join(dir, file), "utf-8");
    }
    return { result: JSON.parse(stdout) as Result, after };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── The mass-failure guard ──────────────────────────────────────────────────

test("guard trips above the threshold and rewrites NOTHING", () => {
  // A red day where everything fails is almost always infra (container did not
  // boot, provider outage) — not per-test rot. Removing @stable from all of it
  // would quarantine the stable suite in one unreviewed commit.
  const titles = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "a.spec.ts", title })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  assert.equal(result.threshold, 5);
  assert.deepEqual(result.removed, []);
  // The assertion that matters: the file on disk is byte-identical.
  assert.equal(after["a.spec.ts"], before);
});

test("exactly at the threshold still proceeds (the guard is strictly greater-than)", () => {
  const titles = ["t1", "t2", "t3", "t4", "t5"];
  const { result, after } = runScript({
    specs: { "a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "a.spec.ts", title })),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "removed");
  assert.equal(result.removed.length, 5);
  // No `tag` array still holds it. (The prose mention in the header comment is
  // expected to survive — that is the point of the AST-located edit.)
  assert.equal(after["a.spec.ts"].includes('"@stable"'), false);
  assert.match(after["a.spec.ts"], /Promoted to @stable in the 1\.10\.x cycle/);
  // Every other tag survives — removal is per-element, not per-array.
  assert.equal(after["a.spec.ts"].match(/@regression/g)?.length, 5);
});

test("the threshold is read from MAX_AUTO_REMOVE, not hardcoded", () => {
  // The workflow passes it as an input (default 5); a stricter day can lower it.
  const titles = ["t1", "t2"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "a.spec.ts": titles },
    failures: titles.map((title) => ({ file: "a.spec.ts", title })),
    maxAutoRemove: "1",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.threshold, 1);
  assert.equal(after["a.spec.ts"], before);
});

test("guard counts failures ACROSS files, not per file", () => {
  // Three files failing twice each is still a six-failure day.
  const titles = ["t1", "t2"];
  const before = specSource(titles);
  const { result, after } = runScript({
    specs: { "a.spec.ts": titles, "b.spec.ts": titles, "c.spec.ts": titles },
    failures: ["a.spec.ts", "b.spec.ts", "c.spec.ts"].flatMap((file) =>
      titles.map((title) => ({ file, title })),
    ),
    maxAutoRemove: "5",
  });

  assert.equal(result.status, "guard_tripped");
  assert.equal(result.hardFailures, 6);
  for (const file of ["a.spec.ts", "b.spec.ts", "c.spec.ts"]) {
    assert.equal(after[file], before);
  }
});

// ─── Nothing to do ───────────────────────────────────────────────────────────

test("a green report removes nothing", () => {
  const before = specSource(["t1"]);
  const { result, after } = runScript({ specs: { "a.spec.ts": ["t1"] }, failures: [] });

  assert.equal(result.status, "none");
  assert.equal(result.hardFailures, 0);
  assert.equal(after["a.spec.ts"], before);
});

test("a missing report removes nothing", () => {
  // The suite never really ran — same conclusion as the guard, reached earlier.
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "a.spec.ts": ["t1"] },
    reportPath: "missing.json",
  });

  assert.equal(result.status, "none");
  assert.equal(after["a.spec.ts"], before);
});

test("an unparseable report removes nothing", () => {
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "a.spec.ts": ["t1"] },
    reportBody: "{ this is not json",
  });

  assert.equal(result.status, "none");
  assert.equal(after["a.spec.ts"], before);
});

test("a FLAKY test keeps @stable", () => {
  // Triage policy: passing on a retry is a flake, tracked by an issue, not a
  // reason to drop the tag. Only status "unexpected" counts.
  const before = specSource(["t1"]);
  const { result, after } = runScript({
    specs: { "a.spec.ts": ["t1"] },
    failures: [{ file: "a.spec.ts", title: "t1", status: "flaky" }],
  });

  assert.equal(result.status, "none");
  assert.equal(result.hardFailures, 0);
  assert.equal(after["a.spec.ts"], before);
});

// ─── Splicing ────────────────────────────────────────────────────────────────

test("removes only the @stable element, preserving comments and the other tags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-splice-"));
  try {
    const source = [
      "import { test } from '../fixtures/fixtures';",
      "",
      "/**",
      " * Promoted to @stable after the 1.10.x validation run.",
      " */",
      'test("middle", { tag: ["@release", "@stable", "@agents"] }, async () => {});',
      "",
      '// tag: ["@stable"] <- do not touch',
      'test("last", { tag: ["@release", "@stable"] }, async () => {});',
      "",
      'test("sole", { tag: ["@stable"] }, async () => {});',
      "",
      'test("untouched", { tag: ["@stable"] }, async () => {});',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "a.spec.ts"), source);
    const report = {
      config: { rootDir: dir },
      suites: [
        {
          file: "a.spec.ts",
          specs: ["middle", "last", "sole"].map((title, i) => ({
            title,
            file: "a.spec.ts",
            line: 6 + i,
            tests: [{ status: "unexpected" }],
          })),
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(report));

    const stdout = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON: path.join(dir, "results.json"), MAX_AUTO_REMOVE: "5" },
      },
    );
    const result = JSON.parse(stdout) as Result;
    const after = fs.readFileSync(path.join(dir, "a.spec.ts"), "utf-8");

    assert.equal(result.status, "removed");
    assert.equal(result.removed.length, 3);
    assert.match(after, /test\("middle", \{ tag: \["@release", "@agents"\] \}/);
    assert.match(after, /test\("last", \{ tag: \["@release"\] \}/);
    assert.match(after, /test\("sole", \{ tag: \[\] \}/);
    // The prose survives untouched — the edit is AST-located, not textual.
    assert.match(after, / \* Promoted to @stable after the 1\.10\.x validation run\./);
    assert.match(after, /\/\/ tag: \["@stable"\] <- do not touch/);
    // A test that did not fail keeps its tag.
    assert.match(after, /test\("untouched", \{ tag: \["@stable"\] \}/);
    // `soleTag` is reported so the caller can flag an emptied array for review.
    // Sorted by title on purpose: the script splices back-to-front, so
    // `removed[]` comes out in reverse source order — an ordering the issue body
    // does not depend on and this test should not freeze.
    assert.deepEqual(
      result.removed
        .map((r) => ({ title: r.title, soleTag: r.soleTag }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      [
        { title: "last", soleTag: false },
        { title: "middle", soleTag: false },
        { title: "sole", soleTag: true },
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolvable spec path is reported, not silently swallowed", () => {
  // The #476 failure mode: every failure skipped as "spec file not found" while
  // the script exits with a clean `none`. It must surface a warning annotation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-missing-"));
  try {
    const report = {
      config: { rootDir: dir },
      suites: [
        {
          file: "ghost.spec.ts",
          specs: [
            { title: "t1", file: "ghost.spec.ts", line: 4, tests: [{ status: "unexpected" }] },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(report));

    const proc = execFileSync(
      process.execPath,
      ["--require", "ts-node/register", SCRIPT],
      {
        encoding: "utf-8",
        env: { ...process.env, PLAYWRIGHT_JSON: path.join(dir, "results.json"), MAX_AUTO_REMOVE: "5" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(proc) as Result;

    assert.equal(result.status, "none");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "spec file not found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── The report parser (exported, so tested directly) ────────────────────────

test("collectHardFailures reads nested suites and counts only 'unexpected'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-parse-"));
  try {
    fs.writeFileSync(path.join(dir, "deep.spec.ts"), specSource(["hard", "flaky"]));
    const reportPath = path.join(dir, "results.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        config: { rootDir: dir },
        suites: [
          {
            file: "deep.spec.ts",
            suites: [
              {
                file: "deep.spec.ts",
                specs: [
                  { title: "hard", file: "deep.spec.ts", line: 4, tests: [{ status: "unexpected" }] },
                  { title: "flaky", file: "deep.spec.ts", line: 8, tests: [{ status: "flaky" }] },
                  { title: "ok", file: "deep.spec.ts", line: 12, tests: [{ status: "expected" }] },
                ],
              },
            ],
          },
        ],
      }),
    );

    const failures = collectHardFailures(reportPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].title, "hard");
    assert.equal(failures[0].file, path.join(dir, "deep.spec.ts"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectHardFailures returns [] for a missing or unparseable report", () => {
  assert.deepEqual(collectHardFailures(path.join(os.tmpdir(), "does-not-exist-1017.json")), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoremove-bad-"));
  try {
    const bad = path.join(dir, "results.json");
    fs.writeFileSync(bad, "{ nope");
    assert.deepEqual(collectHardFailures(bad), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
