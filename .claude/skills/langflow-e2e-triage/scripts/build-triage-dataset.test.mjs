// CLI tests for build-triage-dataset.mjs — the two flags the VM lane depends on (#2031).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../../../scripts/lib/tmp-dir.mjs";

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
  const dir = makeTempDir("triage-dataset-");
  const history = join(dir, "h.jsonl");
  writeFileSync(history, `${JSON.stringify(ROW)}\n`);
  const results = join(dir, "results.json");
  writeFileSync(results, JSON.stringify(REPORT));
  // A `gh` that records being called, so --no-issues can be shown not to call it.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "gh-called");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '[]'\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, "--history", history, "--run", ROW.run_id, ...args.map((a) => (a === "@results" ? results : a))], {
    encoding: "utf8",
    env: { ...process.env, PATH: withGh ? `${bin}:${process.env.PATH}` : process.env.PATH },
  });
  const called = existsSync(marker);
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

// The VM lane opens its umbrella on the destination host, while a triage runs from
// here: without --issues-repo, `gh issue list` asks the checkout's own repository,
// which from a source clone is the wrong one, and the umbrella comes back null.
function runAgainstUmbrella(args) {
  const dir = makeTempDir("triage-dataset-");
  const history = join(dir, "h.jsonl");
  writeFileSync(history, `${JSON.stringify(ROW)}\n`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const argsFile = join(dir, "gh-args");
  const listing = JSON.stringify([
    {
      number: 7,
      title: "[Daily Failure] @stable tests failed on 2026-09-21 (1.13.0.dev19)",
      body: `Run \`${ROW.run_id}\` failed.`,
      url: "https://github.example.com/Org/dest/issues/7",
    },
  ]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\ncat <<'JSON'\n${listing}\nJSON\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, "--history", history, "--run", ROW.run_id, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const ghArgs = existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n") : null;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, ghArgs, dataset: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test("--issues-repo asks gh that repository, and the dataset carries the umbrella's URL", () => {
  const r = runAgainstUmbrella(["--issues-repo", "github.example.com/Org/dest"]);
  assert.equal(r.status, 0, r.stderr);
  const at = r.ghArgs.indexOf("-R");
  assert.ok(at !== -1 && r.ghArgs[at + 1] === "github.example.com/Org/dest", `gh was not pointed at the repo: ${r.ghArgs}`);
  assert.ok(r.ghArgs.join(" ").includes("number,title,body,url"), "the listing must ask for the URL");
  assert.equal(r.dataset.umbrella_issue, 7);
  assert.equal(r.dataset.umbrella_url, "https://github.example.com/Org/dest/issues/7");
});

test("without --issues-repo gh keeps asking the current repository, as the Actions lane needs", () => {
  const r = runAgainstUmbrella([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.ghArgs.includes("-R"), `no -R expected: ${r.ghArgs}`);
});

test("--issues-repo without a value is refused, never read as the checkout's own repository", () => {
  for (const args of [["--issues-repo", ""], ["--issues-repo"], ["--issues-repo", "--no-issues"], ["--issues-repo", "  "], ["--issues-repo=github.example.com/Org/dest"]]) {
    const r = runAgainstUmbrella(args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} exited ${r.status}`);
    assert.match(r.stderr, /--issues-repo/);
    assert.equal(r.ghArgs, null, `${JSON.stringify(args)} still called gh`);
  }
});
