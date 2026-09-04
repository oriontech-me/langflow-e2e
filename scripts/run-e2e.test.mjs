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
import { evaluateWorkflowValue } from "./lib/gh-expression.mjs";

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
      // The version dimension is neutralised on purpose. With enforcement on by
      // default, leaving this unset makes it "unchecked" — fatal — so every case
      // below would fail for the version reason instead of its own, and the ones
      // that EXPECT a failure would pass for the wrong reason. The version states
      // have their own tests.
      `TARGET_VERSION_MATCH=yes`,
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

// Comment lines go before anything is matched, for the reason watch-tokens.test.mjs
// already paid for at #1300: a `#` line merely SPELLING the old value could both mask
// a real setting and fail a CORRECT workflow — and the failure message would then
// invite the next reader to "fix" this lane by restoring the value that caused #1714.
const stripComments = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("the lane runs tracing the way the workflow does, read out of the workflow", () => {
  // What this pins cost nine @stable tests on 2026-09-04: the VM lane came back red
  // while the same day's Actions daily was green, because all three starters keep
  // tracing OFF and daily-stable.yml runs it ON. A literal here would drift the moment
  // the workflow changed, so the expectation is READ from the workflow, never copied.
  const wf = stripComments(readFileSync(join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8"));

  // EVERY occurrence, not the first: a second setting further down the file would
  // otherwise pass unnoticed while this lane mirrored only one of them.
  const settings = [...wf.matchAll(/LANGFLOW_DEACTIVATE_TRACING:\s*(.+)/g)].map((m) => m[1].trim());
  assert.equal(
    settings.length,
    1,
    `daily-stable.yml must set the tracing flag exactly once for this to be readable; found ${settings.length}`,
  );

  // Evaluated rather than string-compared, for the day the value becomes an
  // expression — it already is one on pr-validation.yml. An expression this cannot
  // evaluate fails here deliberately: a guard that cannot read the value is a guard
  // that is not checking it.
  let declared;
  try {
    declared = evaluateWorkflowValue(settings[0], {});
  } catch (err) {
    assert.fail(`cannot evaluate daily-stable.yml's tracing setting, so it is unverified — ${err.message}`);
  }

  // The environment is blanked, not inherited. `sourced()` forwards process.env, so an
  // exported LANGFLOW_DEACTIVATE_TRACING — on the VM, or in the shell of whoever was
  // debugging #1714 — would answer for the default and let this test pass with the
  // line deleted. `:-` treats empty as unset, so this measures the default itself.
  const r = sourced(`echo "$LANGFLOW_DEACTIVATE_TRACING"`, { LANGFLOW_DEACTIVATE_TRACING: "" });
  assert.equal(
    r.stdout.trim(),
    declared,
    `this lane has to trace the way daily-stable.yml does (${declared})`,
  );
});

test("a tracing value that is neither true nor false stops the run", () => {
  // The flag reads anything that is not "true" as false, so `0` or `FALSE` would mean
  // tracing OFF while looking deliberate — #1714's failure class, arriving through the
  // caller instead of the file.
  const r = sourced(`echo unreachable`, { LANGFLOW_DEACTIVATE_TRACING: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be exactly 'true' or 'false'/);
});

test("the lane does not append to the daily's token series", () => {
  // With tracing ON this lane has spend to record, and the summarizer's default is to
  // append one line to reports/token-history.jsonl — a git-tracked file, in a clone
  // this run does not own, whose `git pull --ff-only` would then refuse every day.
  const line = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .find((l) => l.includes("watch-tokens.mjs --summarize"));
  assert.ok(line, "could not find the token summary invocation");
  assert.match(line, /TOKENS_SUPPRESS_HISTORY=1/);
});

test("the tracing value crosses the ssh boundary, which a default alone does not", () => {
  // The failure mode this catches LOOKS fixed: the value is set here, the shell that
  // runs the starter is on the other machine, and it inherits nothing from this one.
  // A variable that never crosses is a variable that never applied.
  const line = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .find((l) => l.includes("bash -s; sleep 86400"));
  assert.ok(line, "could not find the command that starts the backend on the target");
  assert.match(line, /LANGFLOW_DEACTIVATE_TRACING=\$LANGFLOW_DEACTIVATE_TRACING/);
});

test("the version check is on by default, and so is enforcing it", () => {
  // Enforcement waited for two things, and both arrived on 2026-09-03: the run now
  // places the clone itself, so a mismatch is no longer somebody forgetting to move
  // it; and a smoked source instance at v1.13.0.dev1 reports `1.13.0.dev1`, the exact
  // string the published-image strategy expects — so the gate cannot fail a correctly
  // placed clone over a formatting difference.
  const r = sourced(`echo "$CHECK_TARGET_VERSION $REQUIRE_TARGET_VERSION"`);
  assert.equal(r.stdout.trim(), "1 1");
});

test("by default, a version mismatch now fails the run", () => {
  const r = sourced(
    `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
      `TARGET_VERSION_MATCH=no TARGET_VERSION_REASON="expected 1.13.0.dev1, served 1.12.0"\n` +
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
  );
  assert.equal(Number(r.stdout.match(/EXIT=(\d+)/)?.[1]), 1);
});

test("the run moves the clone by default, and demands the stamp because of it", () => {
  // The second half of step 16. Detection alone left the operator to move the clone,
  // and a lane that depends on someone remembering is a lane that reports changelog
  // as environment difference on the day they forget.
  const r = sourced(`echo "$PREPARE_TARGET $PREPARE_TARGET_SKIP_BUILD $STAMP_REQUIRED"`);
  assert.equal(r.stdout.trim(), "1 0 1");
});

test("the stamp is demanded only when this run is what wrote it", () => {
  // Both exceptions are deliberate. With preparation off, or with the build skipped,
  // no stamp exists and refusing over its absence would break the hand-driven path
  // that has to keep working while this is adopted.
  assert.equal(sourced(`echo "$STAMP_REQUIRED"`, { PREPARE_TARGET: "0" }).stdout.trim(), "0");
  assert.equal(sourced(`echo "$STAMP_REQUIRED"`, { PREPARE_TARGET_SKIP_BUILD: "1" }).stdout.trim(), "0");
});

// The decision that says whether this run places the clone. Behavioural rather than a
// regex over the file: phase_preflight around it fetches, curls and runs `npm ci`, so
// a spelling guard was the only reachable alternative and #1226 established that such
// a guard passes the mutations it exists to catch.
const plan = (env) => sourced(`echo "$(target_preparation_plan)"`, env).stdout.trim();

test("a resolved commit is what makes this run place the clone", () => {
  assert.equal(plan({ TARGET_EXPECTED_SHA: "a".repeat(40), TARGET_EXPECTED_VERSION: "1.13.0.dev1" }), "prepare");
  assert.equal(plan({ PREPARE_TARGET: "0", TARGET_EXPECTED_SHA: "a".repeat(40) }), "off");
  // Placement obeys a resolution. Turning the resolution off turns placement off with
  // it, and says so as configuration rather than warning about an absent answer nobody
  // asked for.
  assert.equal(plan({ CHECK_TARGET_VERSION: "0" }), "off");
});

test("a resolved VERSION with no commit does not place the clone, and does not kill the run", () => {
  // The regression this guards. resolve-target-version.mjs returns ok:true with an
  // EMPTY sha in two routine states — the github ref listing unreachable or partial,
  // and the nightly tag deleted and not yet recreated, which upstream does routinely —
  // while still reporting `ref: v1.13.0.dev1`. Gating on `sha || ref` passed on the
  // ref, handed the preparer a tag name the resolver had just failed to find, and the
  // preparer correctly refused: `die "target preparation failed"` in phase_preflight,
  // upstream of phase_publish, so zero tests AND no report. The version gate at the end
  // produces the same red with the evidence attached, which is why this must skip.
  assert.equal(plan({ TARGET_EXPECTED_VERSION: "1.13.0.dev1", TARGET_EXPECTED_REF: "v1.13.0.dev1", TARGET_EXPECTED_SHA: "" }), "skip-no-commit");
  // And "nothing resolved at all" stays a distinct answer: it sends the reader to the
  // resolver rather than to the ref listing.
  assert.equal(plan({}), "skip-unresolved");
});

test("the stamp is demanded only by a run that actually wrote one", () => {
  // Derived from what preparation DID, not from the configuration. The two diverge on
  // the skip paths, and demanding the stamp there fails the START with "no build stamp"
  // over a cause that belonged to the resolver — sending the operator to the wrong
  // machine, on a day the run could still have produced its comparison.
  const demand = (arg, env = {}) => sourced(`stamp_demand_for_plan ${arg}`, env).stdout.trim();
  assert.equal(demand("prepare"), "1");
  assert.equal(demand("prepare", { PREPARE_TARGET_SKIP_BUILD: "1" }), "0");
  for (const p of ["skip-no-commit", "skip-unresolved", "off"]) assert.equal(demand(p), "0", p);
});

test("preparation is driven by the resolved COMMIT, and its failure stops the run", () => {
  const text = readFileSync(SCRIPT, "utf8");
  // The commit, not the branch or the tag name: upstream recreates nightly tag names,
  // so the tag-name lookup that produces the sha can point somewhere new — and when it
  // finds nothing the resolver reports an empty sha rather than a wrong one.
  assert.match(text, /TARGET_SHA=\$\{TARGET_EXPECTED_SHA\}/);
  assert.match(text, /prepare-target-source\.sh/);
  assert.match(text, /LANGFLOW_REQUIRE_BUILD_STAMP=\$STAMP_REQUIRED/);
  // A stray untracked file on a shared VM must not cost the placement its only escape
  // hatch being PREPARE_TARGET=0, which switches the whole thing off.
  assert.match(text, /PREPARE_ALLOW_DIRTY=\$\{PREPARE_TARGET_ALLOW_DIRTY\}/);

  const block = text.match(/# --- Obey the resolution[\s\S]*?\n  log "Installing dependencies/)?.[0];
  assert.ok(block, "the preparation block is not where this test expects it");
  // A placement that was ATTEMPTED and failed must not continue: its verdict would be
  // about a different product, and that is worth less than no verdict.
  assert.match(block, /die "target preparation failed"/);
  // The preparer's own summary is filed before that die, so the log the operator is
  // pointed at has no path on which it is silently short (Copilot, PR #1701).
  const failurePath = block.indexOf('die "target preparation failed"');
  assert.ok(
    block.lastIndexOf('>> "$prep_log"', failurePath) > block.indexOf("prep_out=\"$(target_ssh"),
    "prep_out must be appended to the log before the failure path exits",
  );
  assert.doesNotMatch(block, /\|\| true/, "the preparation must not be allowed to fail silently");

  // And what it did is recorded, because nobody recovers it afterwards.
  assert.match(text, /langflow_prepared_sha/);
  assert.match(text, /langflow_prepare_seconds/);
});

test("with enforcement off, a version mismatch does not fail the run on its own", () => {
  // The diagnosing path: pointed at a deliberately mismatched target, the run still
  // produces its verdict and says what differed.
  const r = sourced(
    `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
      `TARGET_VERSION_MATCH=no TARGET_VERSION_REASON="expected 1.13.0.dev1, served 1.12.0"\n` +
      `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
    { REQUIRE_TARGET_VERSION: "0" },
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

test("with REQUIRE explicitly off, none of the version states fail the run", () => {
  for (const match of ["yes", "cycle", "unknown", "unchecked", "no"]) {
    const r = sourced(
      `RUN_EMPTY=false RUN_PARTIAL=false SHARD_COMPLETE=true TEST_JOB_FAILED=0\n` +
        `TARGET_VERSION_MATCH=${match}\n` +
        `set +e; phase_verdict; code=$?; set -e; echo "EXIT=$code"`,
      { REQUIRE_TARGET_VERSION: "0" },
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
