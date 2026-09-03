// Unit tests for scripts/run-e2e.sh, the VM orchestrator.
// Run with: npm run test:scripts
//
// What these protect. The orchestrator's whole reason to exist is producing a verdict
// that can be COMPARED with the Actions one, so the properties worth pinning are the
// ones where a wrong answer still looks like an answer:
//
//   - The exit-code contract. A run that executed zero tests, a run that lost a
//     shard, and a run whose report is partial all produce a report that opens fine.
//     Each of them must fail, and for its own stated reason — "green because nothing
//     ran" is the failure this lane cannot afford, since a missing run and a run with
//     no divergence are indistinguishable downstream.
//   - The publish switches are OFF. While the VM daily runs beside the Actions one,
//     only the Actions verdict has consequence; an issue or a Slack message from here
//     would be a second voice for one day's verdict. The defaults are the mechanism,
//     so they are tested rather than trusted.
//   - No internal hostname, ever. The target is named by the caller. A default here
//     would publish internal topology into a public repository.
//   - The Playwright pin agrees with the lane's browser image, which is what makes
//     "same suite, same browser" true rather than assumed.
//
// The phases are exercised by SOURCING the script, which its sourcing guard exists
// for: no machines, no ssh, no real run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BASH = execFileSync("/usr/bin/env", ["bash", "-c", "command -v bash"], { encoding: "utf8" }).trim();
const SCRIPT = join(HERE, "run-e2e.sh");

/** Sources the script and runs `body` with its functions in scope. */
function sourced(body, env = {}) {
  return spawnSync(BASH, ["-c", `source ${JSON.stringify(SCRIPT)}\n${body}`], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, TARGET_SSH: "unused-in-sourced-tests", ...env },
  });
}

/** Runs phase_verdict with a given run state and returns its exit code and stderr. */
function verdict({ empty = "false", partial = "false", complete = "true", failed = "0" }) {
  const r = sourced(
    [
      `RUN_EMPTY=${empty} RUN_PARTIAL=${partial} SHARD_COMPLETE=${complete} TEST_JOB_FAILED=${failed}`,
      `RUN_TESTS=7 RUN_ERRORS=2 RUN_FIRST_ERROR="a top-level error" RUN_DIR=/tmp/does-not-matter`,
      // `set +e` because sourcing brought `set -e` with it, and a phase that returns
      // non-zero would abort this harness before it could report the code — which is
      // the very thing under test.
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
    ].join("\n"),
  );
  const code = Number(r.stdout.match(/EXIT=(\d+)/)?.[1] ?? -1);
  return { code, stdout: r.stdout, stderr: r.stderr };
}

test("a clean run is green and exits 0", () => {
  const r = verdict({});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Green run/);
});

test("zero tests executed fails, and is named as an infrastructure abort", () => {
  // The one that would otherwise pass for the worst reason: an empty report renders
  // perfectly and reads as "nothing broke".
  const r = verdict({ empty: "true" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ZERO tests executed/);
  assert.match(r.stderr, /not a test failure/);
  // The cause travels with the verdict — triage that starts from "which test broke"
  // on an empty run spends its first hour in the wrong place.
  assert.match(r.stderr, /first error: a top-level error/);
});

test("a partial run fails, saying the totals are undercounted", () => {
  const r = verdict({ partial: "true" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PARTIAL run/);
  assert.match(r.stderr, /UNDERCOUNTED/);
});

test("a missing shard blob fails, even with every test that ran passing", () => {
  const r = verdict({ complete: "false" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INCOMPLETE report/);
});

test("a failing shard fails on its own", () => {
  const r = verdict({ failed: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /failing test/);
});

test("empty outranks partial in the explanation, and both still fail", () => {
  // Both flags can be set at once; the message has to lead with the one that explains
  // the other, or the reader chases a shard that never got to run.
  const r = verdict({ empty: "true", partial: "true" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ZERO tests executed/);
  assert.doesNotMatch(r.stderr, /PARTIAL run/);
});

test("an unreadable report defaults to empty, not to green", () => {
  // check-run-integrity.mjs may write nothing at all (it failed, the file is absent).
  // The default has to be the pessimistic one: `${RUN_EMPTY:-true}`.
  const r = sourced(`unset RUN_EMPTY; TEST_JOB_FAILED=0; set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`);
  assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 1);
  assert.match(r.stderr, /ZERO tests executed/);
});

test("gh_out reads plain and heredoc values, which the outage report needs", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-e2e-test-"));
  const file = join(dir, "outputs.txt");
  writeFileSync(file, ["empty=false", "summary_md<<EOF_MD", "| shard | down |", "| 1 | 4s |", "EOF_MD", "partial=true"].join("\n") + "\n");
  const r = sourced(`gh_out ${JSON.stringify(file)} empty; echo; gh_out ${JSON.stringify(file)} summary_md; echo; gh_out ${JSON.stringify(file)} partial`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "false\n| shard | down |\n| 1 | 4s |\npartial=true".replace("partial=true", "true"));
  rmSync(dir, { recursive: true, force: true });
});

test("the publish switches are OFF by default, all four of them", () => {
  // Not a preference: while both dailies run, only the Actions one has consequence.
  // A second issue or a second Slack message for one day's verdict is worse than
  // none, and this is where that decision is enforced.
  const r = sourced(`echo "$CREATE_ISSUE $NOTIFY_SLACK $POST_QA_PLATFORM $COMMIT_HISTORY"`);
  assert.equal(r.stdout.trim(), "0 0 0 0");
});

test("the version check is on by default, and enforcing it is not — yet", () => {
  // Detection before correction. While the clone is moved by hand, failing the run on
  // a version gap would throw away a day of otherwise usable comparison data; the gap
  // still has to be impossible to miss. REQUIRE flips once the run moves the clone.
  const r = sourced(`echo "$CHECK_TARGET_VERSION $REQUIRE_TARGET_VERSION"`);
  assert.equal(r.stdout.trim(), "1 0");
});

test("a version mismatch does not fail the run on its own", () => {
  const r = sourced(
    `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
      `TARGET_VERSION_MATCH=no TARGET_VERSION_REASON="expected 1.13.0.dev1, served 1.12.0"\n` +
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
  );
  assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 0);
});

test("REQUIRE_TARGET_VERSION=1 makes an AUTHORITATIVE mismatch fatal, naming what it costs", () => {
  const r = sourced(
    `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
      `TARGET_VERSION_MATCH=no TARGET_RESOLUTION=published-image TARGET_VERSION_REASON="expected 1.13.0.dev1, served 1.12.0"\n` +
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
    { REQUIRE_TARGET_VERSION: "1" },
  );
  assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 1);
  assert.match(r.stderr, /wrong Langflow/);
  // The reason a reader needs: not "versions differ" but what a comparison between
  // different products actually produces.
  assert.match(r.stderr, /describes the changelog, not the environments/);
});

test("a mismatch the REGISTRY did not establish still fails, but claims less", () => {
  // Chain the two failure modes: a registry blip drops the resolution to the git refs,
  // those legitimately run ahead of the published image, and the comparison then
  // reports a difference that may not exist between the lanes. It still fails under
  // REQUIRE — an expectation that cannot be trusted is not a guarantee — but asserting
  // "the target served the wrong Langflow" would assert what the source cannot support.
  const r = sourced(
    `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
      `TARGET_VERSION_MATCH=no TARGET_RESOLUTION=nightly-tag TARGET_VERSION_REASON="expected 1.13.0.dev1, served 1.13.0.dev0"\n` +
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
    { REQUIRE_TARGET_VERSION: "1" },
  );
  assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 1);
  assert.match(r.stderr, /could not be established authoritatively/);
  assert.match(r.stderr, /runs ahead of what shipped/);
  assert.doesNotMatch(r.stderr, /served the wrong Langflow/);
});

test("a matching version passes under REQUIRE, exactly or by cycle", () => {
  for (const match of ["yes", "cycle"]) {
    const r = sourced(
      `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
        `TARGET_VERSION_MATCH=${match}\n` +
        `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
      { REQUIRE_TARGET_VERSION: "1" },
    );
    assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 0, match);
  }
});

test("under REQUIRE, a check that could not RUN fails too", () => {
  // The gap that makes "require" not require: the registry unreachable, github
  // unreachable, the resolver erroring, or the target reporting no version all land
  // on unknown/unchecked. Passing green there is passing green in exactly the cases
  // where nobody can tell whether both lanes ran the same product.
  for (const match of ["unknown", "unchecked"]) {
    const r = sourced(
      `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
        `TARGET_VERSION_MATCH=${match}\n` +
        `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
      { REQUIRE_TARGET_VERSION: "1" },
    );
    assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 1, match);
    assert.match(r.stderr, /an unperformed check is/);
  }
});

test("without REQUIRE, none of the version states fail the run", () => {
  for (const match of ["yes", "cycle", "unknown", "unchecked", "no"]) {
    const r = sourced(
      `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
        `TARGET_VERSION_MATCH=${match}\n` +
        `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
    );
    assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 0, match);
  }
});

test("the tunnel probe leaves the shell's stderr alone", () => {
  // The bug this pins cost a whole run's diagnostics: the probe used to close its
  // descriptor with `exec 3>&- 2>/dev/null`, and `exec` with no command applies its
  // redirections to THE SHELL — so stderr went to /dev/null for the rest of the run.
  // Every warn and err after preflight disappeared, including the verdict explaining
  // why it failed. The exit code stayed correct and the reason stopped existing, which
  // is the shape of failure this lane exists to catch, turned on the lane itself.
  const r = sourced(
    // Port 9 (discard) is closed on these machines; any closed port exercises the
    // failure path, which is the one that used to do the damage.
    `ports_without_listener 9 > /dev/null; warn "STILL SPEAKING"`,
  );
  assert.match(r.stderr, /STILL SPEAKING/, "stderr was redirected away by the probe");
});

test("the tunnel probe reports the ports that have no listener", () => {
  const r = sourced(`ports_without_listener 9 65000 | tr '\\n' ' '`);
  assert.equal(r.stdout.trim(), "9 65000");
});

test("the tunnel is the default, and refusing it is opt-in", () => {
  const r = sourced(`echo "$LANGFLOW_TUNNEL $ALLOW_NO_TUNNEL"`);
  assert.equal(r.stdout.trim(), "1 0");
});

test("the browser platform override carries the architecture suffix", () => {
  // Without `-x64` the value matches no descriptor at all, and the override silently
  // does nothing — the install then fails on Ubuntu 26.04 and the run dies in
  // globalSetup, which reads as a product failure.
  const r = sourced(`echo "$PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"`);
  assert.match(r.stdout.trim(), /^ubuntu\d+\.\d+-x64$/);
});

test("TARGET_SSH has no default, and the run refuses without it", () => {
  const text = readFileSync(SCRIPT, "utf8");
  // A default here would publish an internal hostname into a public repository.
  assert.match(text, /TARGET_SSH="\$\{TARGET_SSH:-\}"/);
  const r = spawnSync(BASH, [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, TARGET_SSH: "" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TARGET_SSH is required/);
  // Refused before anything is installed or started: the check is the first one.
  assert.doesNotMatch(r.stdout, /npm ci/);
});

test("no internal hostname is written anywhere in the script", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(text, /\.fyre\./i, "an internal hostname reached a public file");
  assert.doesNotMatch(text, /langflow(bin|qa)\b/i, "an internal machine name reached a public file");
});

test("the Playwright pin agrees with the browser image the CI lane runs", () => {
  // The same guard the script enforces at runtime, checked here so a bump to one side
  // fails a PR instead of producing a VM verdict that differs from the CI's because
  // the browsers differ.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const pinned = (pkg.devDependencies?.["@playwright/test"] ?? pkg.dependencies?.["@playwright/test"] ?? "").replace(/^[^\d]*/, "");
  const lane = readFileSync(join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8")
    .match(/mcr\.microsoft\.com\/playwright:v([\d.]+)/)?.[1];
  assert.ok(lane, "daily-stable.yml has no Playwright image tag");
  assert.equal(pinned, lane);
});

test("the stop scripts run before the holders are killed", () => {
  // Killing a holder is what makes its Langflow die by hangup — the ungraceful path,
  // mid-write to the run's database. The order inside cleanup() is the whole
  // difference, so it is pinned by position rather than by comment.
  const text = readFileSync(SCRIPT, "utf8");
  const cleanup = text.slice(text.indexOf("cleanup() {"), text.indexOf("# HYGIENE"));
  assert.ok(cleanup.includes("stop-langflow-source.sh"), "cleanup does not stop the backends");
  assert.ok(
    cleanup.indexOf("stop-langflow-source.sh") < cleanup.indexOf('kill "$pid"'),
    "cleanup kills the holding sessions before asking the stop scripts to run",
  );
});
