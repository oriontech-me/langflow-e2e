// CLI tests for build-triage-dataset.mjs — the two flags the VM lane depends on (#2031).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "build-triage-dataset.mjs");

const ROW = {
  date: "2026-09-21",
  run_id: "20260921T080025Z",
  workflow: "daily-stable-vm",
  totals: { passed: 1, failed: 1, flaky: 0, skipped: 1 },
  failures: [{ test: "breaks", file: "a.spec.ts", line: 3, error_signature: "Error: boom", infra_signature: null }],
  flaky: [],
};

const REPORT = {
  suites: [
    {
      file: "b.spec.ts",
      specs: [{ title: "skipped one", tests: [{ annotations: [{ type: "skip", description: "no key" }], results: [{ status: "skipped" }] }] }],
    },
  ],
};

function run(args, { withGh = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "triage-dataset-"));
  const history = join(dir, "h.jsonl");
  writeFileSync(history, `${JSON.stringify(ROW)}\n`);
  const results = join(dir, "results.json");
  writeFileSync(results, JSON.stringify(REPORT));
  // A `gh` that records being called, so --no-issues can be shown not to call it.
  const bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  const marker = join(dir, "gh-called");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '[]'\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, "--history", history, "--run", ROW.run_id, ...args.map((a) => (a === "@results" ? results : a))], {
    encoding: "utf8",
    env: { ...process.env, PATH: withGh ? `${bin}:${process.env.PATH}` : process.env.PATH },
  });
  const called = spawnSync("test", ["-e", marker]).status === 0;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, called, dataset: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test("--no-issues asks gh nothing, and the dataset is still built", () => {
  const r = run(["--no-issues"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.called, false, "gh was called although --no-issues was given");
  assert.equal(r.dataset.umbrella_issue, null);
  assert.equal(r.dataset.hard_failures[0].test, "breaks");
  // Without the flag the same call does go to gh — the flag is what changed.
  assert.equal(run([]).called, true);
});

test("skips_read says whether the report was read, and [] from an unread report is not 'none'", () => {
  const unread = run(["--no-issues"]);
  assert.equal(unread.dataset.skips_read, false);
  assert.deepEqual(unread.dataset.skips, [], "every existing reader keeps its array");

  const read = run(["--no-issues", "--results", "@results"]);
  assert.equal(read.dataset.skips_read, true);
  assert.deepEqual(read.dataset.skips, [{ test: "skipped one", file: "b.spec.ts", reason: "no key" }]);

  const broken = run(["--no-issues", "--results", "/nonexistent/results.json"]);
  assert.equal(broken.dataset.skips_read, false, "an unreadable report was reported as read");
});
