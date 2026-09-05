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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluateWorkflowValue } from "./lib/gh-expression.mjs";
import { readServiceEnv, CLASSIFICATION } from "./lib/vm-env-parity.mjs";

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

test("the publish switches are OFF by default, all three of them", () => {
  // Not a preference: while both dailies run, only the Actions one has consequence.
  // A second issue or a second Slack message for one day's verdict is worse than
  // none, and this is where that decision is enforced.
  const r = sourced(`echo "$CREATE_ISSUE $NOTIFY_SLACK $POST_QA_PLATFORM"`);
  assert.equal(r.stdout.trim(), "0 0 0");
});

test("writing back to the repository is absent, not merely switched off", () => {
  // The fourth switch used to be COMMIT_HISTORY, and it gated an append that committed
  // nothing — so the series this lane has to keep was being held back by a decision
  // that belonged to a later etapa. Now the append happens and the COMMIT is what is
  // missing. Pinned by absence rather than by a default, because a variable set to
  // zero reads as "implemented, disabled" and invites someone to flip it on a machine
  // that has no write credentials and no review.
  // Comments are stripped first, for the reason #1716 paid for: a comment that merely
  // SPELLS the thing under test fails a correct file, and the paragraph explaining why
  // COMMIT_HISTORY was removed is exactly such a comment.
  const code = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  const writes = code.split("\n").filter((l) => /\bgit\s+(commit|push|add)\b/.test(l));
  assert.deepEqual(writes, [], "this lane must not write to the repository");
  assert.doesNotMatch(code, /COMMIT_HISTORY/, "the switch is gone, not renamed");
});

// daily-stable.yml's Langflow service environment, read once. The reader strips
// full-line comments for the reason watch-tokens.test.mjs already paid for at #1300 —
// a `#` line merely SPELLING a value both masks a real setting and fails a CORRECT
// workflow — and scopes the read to the SERVICE block, so the LANGFLOW_IMAGE and
// LANGFLOW_VERSION that later jobs set as step env cannot read as gaps in this lane.
const DECLARED = readServiceEnv(readFileSync(join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8"));

// The variables this script is the declared carrier for. DERIVED from the
// classification rather than listed here as well: a variable added there and given no
// default in the script would otherwise be pinned by nothing, which is the gap the
// classification exists to close.
const MIRRORED = Object.entries(CLASSIFICATION)
  .filter(([, entry]) => entry.carrier === "orchestrator" && entry.sameValue !== false)
  .map(([name]) => name);

// `sourced()` forwards process.env, so an exported LANGFLOW_* — on the VM, or in the
// shell of whoever was debugging #1714 — would answer for the default and let these
// tests pass with the line deleted. `:-` treats empty as unset, so blanking measures
// the default itself.
const BLANKED = Object.fromEntries(MIRRORED.map((name) => [name, ""]));

test("this lane mirrors the workflow's own values, read out of the workflow", () => {
  // What this pins cost nine @stable tests on 2026-09-04: the VM lane came back red
  // while the same day's Actions daily was green, because all three starters keep
  // tracing OFF and daily-stable.yml runs it ON (#1714). A literal here would drift
  // the moment the workflow changed, so every expectation is READ from the workflow,
  // never copied — and the loop is over the classification, so the next variable to be
  // mirrored is covered by this test on the day it is classified.
  assert.ok(MIRRORED.length >= 4, `expected the lane to mirror several variables, found ${MIRRORED.length}`);

  for (const name of MIRRORED) {
    const raw = DECLARED.get(name);
    assert.ok(raw !== undefined, `${name} is mirrored here, but daily-stable.yml's service does not set it`);

    // Evaluated rather than string-compared, for the day a value becomes an expression
    // — it already is one on pr-validation.yml. An expression this cannot evaluate
    // fails deliberately: a guard that cannot read the value is a guard that is not
    // checking it (#1226).
    let declared;
    try {
      declared = evaluateWorkflowValue(raw, {});
    } catch (err) {
      assert.fail(`cannot evaluate daily-stable.yml's ${name}, so it is unverified — ${err.message}`);
    }

    // Delimited, because an empty value and a value this failed to read are otherwise
    // the same empty string.
    const r = sourced(`printf '<<%s>>' "$${name}"`, BLANKED);
    const got = r.stdout.match(/<<([\s\S]*)>>/)?.[1];
    assert.equal(got, declared, `this lane has to run ${name} the way daily-stable.yml does`);
  }
});

test("a tracing value that is neither true nor false stops the run", () => {
  // The flag reads anything that is not "true" as false, so `0` or `FALSE` would mean
  // tracing OFF while looking deliberate — #1714's failure class, arriving through the
  // caller instead of the file.
  const r = sourced(`echo unreachable`, { LANGFLOW_DEACTIVATE_TRACING: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be exactly 'true' or 'false'/);
});

test("a custom-components value that is neither true nor false stops the run", () => {
  // Same reader, same class: `0` here would disable the feature while reading as a
  // deliberate setting, and the custom-component specs would fail against a disabled
  // surface rather than exercise it.
  const r = sourced(`echo unreachable`, { LANGFLOW_ALLOW_CUSTOM_COMPONENTS: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /LANGFLOW_ALLOW_CUSTOM_COMPONENTS must be exactly 'true' or 'false'/);
});

test("a worker timeout that is not a positive integer stops the run", () => {
  // gunicorn hands this to a watchdog. A non-numeric value is not a slow ceiling, it
  // is no ceiling — and #1048's whole point is bounding what one wedge costs.
  //
  // The empty string is NOT in this list, and both reviewers caught it there: the
  // first version wrote `bad || "x"`, which substituted "x" for it, so the empty case
  // was never sent while a failure would have printed `LANGFLOW_WORKER_TIMEOUT=""`
  // about a value it did not test. It also cannot belong here — `:-` treats empty as
  // unset, so empty legitimately takes the default. That is the test below.
  for (const bad of ["abc", "12s", "-5", "0", "1 2"]) {
    const r = sourced(`echo unreachable`, { LANGFLOW_WORKER_TIMEOUT: bad });
    assert.notEqual(r.status, 0, `LANGFLOW_WORKER_TIMEOUT=${JSON.stringify(bad)} should have been refused`);
    assert.match(r.stderr, /LANGFLOW_WORKER_TIMEOUT must be/);
  }
});

test("an empty override is an absent one, for every mirrored variable", () => {
  // The property the dead case was hiding, and it is worth pinning in its own right:
  // `${VAR:-default}` treats empty as unset, so a wrapper that exports a mirrored name
  // and leaves it blank gets the workflow's value rather than an empty one handed to
  // the server. It is also what makes every other test in this file honest, since they
  // all blank the environment to measure the defaults.
  for (const name of MIRRORED) {
    const raw = DECLARED.get(name);
    const r = sourced(`printf '<<%s>>' "$${name}"`, { ...BLANKED, [name]: "" });
    assert.equal(r.stdout.match(/<<([\s\S]*)>>/)?.[1], evaluateWorkflowValue(raw, {}), `${name} empty should take the default`);
  }
});

test("pragmas that are not a JSON object stop the run", () => {
  // Langflow falls back to its own defaults on a value it cannot parse, without saying
  // so — which is this variable's own failure mode (a silent loss of foreign_keys)
  // arriving through the caller.
  for (const bad of ["{oops", '["foreign_keys"]', '"ON"']) {
    const r = sourced(`echo unreachable`, { LANGFLOW_SQLITE_PRAGMAS: bad });
    assert.notEqual(r.status, 0, `LANGFLOW_SQLITE_PRAGMAS=${bad} should have been refused`);
    assert.match(r.stderr, /LANGFLOW_SQLITE_PRAGMAS/);
  }
});


test("the mirrored values cross the ssh boundary, which a default alone does not", () => {
  // The failure mode this catches LOOKS fixed: the values are set here, the shell that
  // runs the starter is on the other machine, and it inherits nothing from this one.
  // A variable that never crosses is a variable that never applied.
  const line = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .find((l) => l.includes("bash -s; sleep 86400"));
  assert.ok(line, "could not find the command that starts the backend on the target");
  assert.match(line, /\$\(mirrored_target_env\)/);

  // And what that composer would actually produce, rather than the fact that it is
  // called: a variable dropped from the function is invisible to the line above.
  const r = sourced(`mirrored_target_env`, BLANKED);
  for (const name of MIRRORED) {
    assert.match(r.stdout, new RegExp(`(^|\\s)${name}=`), `${name} never reaches the target's shell`);
  }
});

test("the remote quoting survives a value carrying a quote, which no current value does", () => {
  // The branch none of today's values reach, and therefore the one that will be wrong
  // when it is first needed — the day someone overrides a mirrored variable from the
  // qa wrapper. The first implementation was wrong here and passed every other test in
  // this file: `${1//\\'/…}` eats its backslashes twice inside double quotes and
  // produced a string that did not parse.
  const hostile = `it's {"a": "b"} and $x`;
  // Handed over through the ENVIRONMENT, not spelled into the body: a double-quoted
  // literal would let this shell expand the `$x` before shq ever saw it, and the test
  // would then be quoting a string it had already flattened.
  const r = sourced(
    [
      `q="$(shq "$HOSTILE")"`,
      `printf '%s\\n' 'printf "%s" "$X"' | env -u X bash -c "X=$q bash -s"`,
    ].join("\n"),
    { HOSTILE: hostile },
  );
  assert.equal(r.status, 0, r.stderr);
  // Not just "it parsed": `$x` must arrive unexpanded, which is the other half of what
  // quoting is for here.
  assert.equal(r.stdout, hostile);
});

test("a mirrored value survives the shell on the far side, spaces and quotes included", () => {
  // ssh joins its arguments and hands ONE string to a shell over there, so anything
  // unquoted is re-split on arrival. Every mirrored value used to be a bare word and
  // survived that by luck; LANGFLOW_SQLITE_PRAGMAS is a JSON object, and unquoted it
  // sets the variable to `{"synchronous":` and feeds five loose words to `bash -s`.
  //
  // `bash -c "$remote"` is the far side: same concatenated string, same re-split.
  //
  // Every mirrored name is UNSET for it, and that is the load-bearing half. ssh
  // forwards no environment, so the only way a value can arrive there is inside the
  // command string — while this test's own shell holds all of them, exported by the
  // harness. Without the `env -u` the far side would read them by inheritance and the
  // test would pass with the composer emptied, which is the exact failure the test
  // above exists for, reintroduced one layer down. Measured: dropping the pragmas from
  // the composer left this assertion green until the unsets were added.
  const unset = MIRRORED.map((name) => `-u ${name}`).join(" ");
  const r = sourced(
    [
      `remote="$(mirrored_target_env)LANGFLOW_PORT=7999 bash -s"`,
      `printf '%s\\n' 'printf "%s" "$LANGFLOW_SQLITE_PRAGMAS"' | env ${unset} bash -c "$remote"`,
    ].join("\n"),
    BLANKED,
  );
  assert.equal(r.status, 0, r.stderr);
  // Parsed, not string-matched: the property is that the far side can still READ it.
  const pragmas = JSON.parse(r.stdout);
  assert.equal(
    pragmas.foreign_keys,
    "ON",
    "the pragmas arrived unreadable, so the cascade class silently stops being compared",
  );
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

// ---------------------------------------------------------------------------
// THE LEDGER — the three series this lane has to keep
// ---------------------------------------------------------------------------
// reports/daily-history.jsonl, reports/token-history.jsonl and
// reports/spec-durations.json have exactly one writer today, the Actions daily, and the
// next etapa turns it off. What these tests protect is therefore a failure with no
// symptom: a lane that keeps the series in the wrong place, under the wrong label, or
// not at all still produces a green run and a report that opens fine, and the damage
// only shows up later, as a base that begins partial and a matrix balanced on nothing.

/** Runs `preflight_ledger` under a given environment. `die` exits, so status is the verdict. */
function preflightLedger(env = {}) {
  return sourced(`preflight_ledger`, env);
}

test("the ledger has a default, it sits outside the clone, and it names all three series", () => {
  const r = sourced(`echo "$LEDGER_DIR"; echo "$LEDGER_HISTORY"; echo "$LEDGER_TOKENS"; echo "$LEDGER_DURATIONS"`, {
    HOME: "/home/nobody",
    XDG_STATE_HOME: "",
    LEDGER_DIR: "",
  });
  const [dir, history, tokens, durations] = r.stdout.trim().split("\n");
  assert.equal(dir, "/home/nobody/.local/state/langflow-e2e");
  assert.equal(history, `${dir}/daily-history.jsonl`);
  assert.equal(tokens, `${dir}/token-history.jsonl`);
  assert.equal(durations, `${dir}/spec-durations.json`);
});

test("XDG_STATE_HOME wins over HOME, which is what makes the ledger relocatable per machine", () => {
  const r = sourced(`echo "$LEDGER_DIR"`, { HOME: "/home/nobody", XDG_STATE_HOME: "/srv/state", LEDGER_DIR: "" });
  assert.equal(r.stdout.trim(), "/srv/state/langflow-e2e");
});

test("a ledger inside the clone is refused, however the path is spelled", () => {
  // The one way this change defeats its own purpose. Each of these writes into the
  // working tree, and the cost is paid the NEXT morning, by a `git pull --ff-only`
  // that refuses for a reason nobody is watching at 08:00.
  const tmp = mkdtempSync(join(tmpdir(), "ledger-refuse-"));
  const sneaky = join(tmp, "looks-outside");
  symlinkSync(join(REPO_ROOT, "reports"), sneaky);
  const cases = [
    [REPO_ROOT, "the clone itself"],
    [join(REPO_ROOT, "reports"), "the tracked directory the series live in"],
    [join(REPO_ROOT, "runs/ledger"), "a path that does not exist yet"],
    ["runs/ledger", "a relative path, which resolves against the clone"],
    [sneaky, "a symlink that resolves back into the clone"],
  ];
  try {
    for (const [dir, why] of cases) {
      const r = sourced(`set +e; ledger_dir_is_outside_repo ${JSON.stringify(dir)}; echo "EXIT=$?"`);
      assert.match(r.stdout, /EXIT=1/, `${why} was accepted (${dir})`);
    }
    const ok = sourced(`set +e; ledger_dir_is_outside_repo ${JSON.stringify(tmp)}; echo "EXIT=$?"`);
    assert.match(ok.stdout, /EXIT=0/, "a directory genuinely outside the clone must be accepted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight refuses a ledger inside the clone, and creates nothing on the way out", () => {
  const inside = join(REPO_ROOT, "runs/ledger-should-not-exist");
  const r = preflightLedger({ LEDGER_DIR: inside });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside the clone/);
  assert.equal(existsSync(inside), false, "a refused ledger must not leave its own directory behind");
});

test("preflight refuses when there is nowhere to put the ledger, rather than skipping it", () => {
  // A scheduled run that quietly keeps no series is indistinguishable, months later,
  // from a machine that was down — which is the same confusion the watchdog exists to
  // remove, one layer down. (With HOME truly UNSET this script dies earlier still, on
  // the PATH export: that is #1715, and it is a different bug.)
  const r = preflightLedger({ LEDGER_DIR: "", HOME: "", XDG_STATE_HOME: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nowhere to keep the three series/);
  assert.match(r.stderr, /KEEP_LEDGER=0/, "the message has to name the way out it expects");
});

test("KEEP_LEDGER=0 passes preflight and says so, which is what a smoke needs", () => {
  const r = preflightLedger({ KEEP_LEDGER: "0", LEDGER_DIR: "", HOME: "", XDG_STATE_HOME: "" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ledger: not kept for this run/);
});

test("only a scheduled run keeps the series", () => {
  // Mirrors the workflow, where all three steps are on `github.event_name ==
  // 'schedule'`, for the reason #1183 gives for the token series: every reader of
  // these files assumes one full @stable sweep per entry, so a line from a run that
  // executed a grep does not read as noise — it reads as a bad day.
  const active = (env) => sourced(`set +e; ledger_active; echo "EXIT=$?"`, env).stdout.match(/EXIT=(\d)/)[1];
  assert.equal(active({ LEDGER_DIR: "/tmp/led", EVENT_NAME: "schedule" }), "0");
  assert.equal(active({ LEDGER_DIR: "/tmp/led", EVENT_NAME: "manual" }), "1");
  assert.equal(active({ LEDGER_DIR: "/tmp/led", KEEP_LEDGER: "0" }), "1");
  assert.equal(active({ LEDGER_DIR: "", HOME: "", XDG_STATE_HOME: "" }), "1");
});

test("the spend line carries its label, and the two outcomes cannot both happen", () => {
  // Without WORKFLOW the summarizer writes `workflow: "unknown"`, which in a merged
  // series reads as an Actions row that lost its label rather than as a VM one — and
  // the whole point of keeping a separate series is being able to tell the two eras
  // apart afterwards.
  const kept = sourced(`tokens_history_env`, { LEDGER_DIR: "/tmp/led", EVENT_NAME: "schedule" }).stdout.trim().split("\n");
  assert.deepEqual(kept, ["TOKENS_HISTORY=/tmp/led/token-history.jsonl", "WORKFLOW=daily-stable-vm"]);

  const suppressed = sourced(`tokens_history_env`, { EVENT_NAME: "manual" }).stdout.trim().split("\n");
  assert.deepEqual(suppressed, ["TOKENS_SUPPRESS_HISTORY=1"]);

  for (const out of [kept, suppressed]) {
    const names = out.map((kv) => kv.split("=")[0]);
    assert.ok(
      !(names.includes("TOKENS_HISTORY") && names.includes("TOKENS_SUPPRESS_HISTORY")),
      "a suppressed summary with a history path set would silently pick one and drop the other",
    );
  }
});

test("the ledger is seeded once from the Actions series, and an existing one is never overwritten", () => {
  // Day zero is not free: the durations file is what balances the matrix and the token
  // summary's anomaly baseline is a median over recent entries, and both answer badly
  // from three lines — badly in the direction of looking fine.
  const tmp = mkdtempSync(join(tmpdir(), "ledger-seed-"));
  try {
    const tracked = join(tmp, "tracked.jsonl");
    const ledger = join(tmp, "ledger.jsonl");
    writeFileSync(tracked, "from-actions\n");

    const first = sourced(`ledger_seed ${JSON.stringify(ledger)} ${JSON.stringify(tracked)}`);
    assert.equal(first.status, 0);
    assert.equal(readFileSync(ledger, "utf8"), "from-actions\n");

    writeFileSync(ledger, "from-the-vm\n");
    writeFileSync(tracked, "a-later-actions-run\n");
    const second = sourced(`ledger_seed ${JSON.stringify(ledger)} ${JSON.stringify(tracked)}`);
    assert.equal(second.status, 0);
    assert.equal(
      readFileSync(ledger, "utf8"),
      "from-the-vm\n",
      "re-seeding would replay the Actions series over the VM's own, every single day",
    );

    // A tracked file that does not exist is not an error: spec-durations.json has been
    // absent from the tree before (#1252).
    const missing = sourced(`ledger_seed ${JSON.stringify(join(tmp, "b.json"))} ${JSON.stringify(join(tmp, "nope.json"))}`);
    assert.equal(missing.status, 0);
    assert.equal(existsSync(join(tmp, "b.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a seed that cannot be copied warns, and does not take the day's verdict with it", () => {
  // phase_publish runs under `set -e`, so a bare `cp` failing here would abort the
  // whole phase — after the run, before the verdict. The series is worth less than the
  // day it would cost, and every other step in that phase already says so.
  const tmp = mkdtempSync(join(tmpdir(), "ledger-ro-"));
  try {
    const tracked = join(tmp, "tracked.jsonl");
    writeFileSync(tracked, "a line\n");
    const unwritable = join(tmp, "locked");
    mkdirSync(unwritable, { mode: 0o500 });
    const r = sourced(`ledger_seed ${JSON.stringify(join(unwritable, "ledger.jsonl"))} ${JSON.stringify(tracked)}; echo "EXIT=$?"`);
    assert.match(r.stdout, /EXIT=0/, "a failed seed must not fail the caller");
    assert.match(r.stderr, /starts from nothing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("asking for the ledger's durations and finding none is said out loud", () => {
  // Falling back in silence is how a run ends up balanced by numbers nobody chose,
  // and the symptom — shards of uneven length — reads as the suite's own drift.
  const tracked = "reports/spec-durations.json";
  const off = sourced(`durations_table`);
  assert.equal(off.stdout.trim(), tracked);
  assert.equal(off.stderr.trim(), "");

  const missing = sourced(`durations_table`, { USE_LEDGER_DURATIONS: "1", LEDGER_DIR: "/tmp/no-such-ledger-dir" });
  assert.equal(missing.stdout.trim(), tracked, "a missing table must not become an empty argument");
  assert.match(missing.stderr, /USE_LEDGER_DURATIONS=1 but the ledger has no durations table yet/);

  const tmp = mkdtempSync(join(tmpdir(), "ledger-dur-"));
  try {
    writeFileSync(join(tmp, "spec-durations.json"), "{}\n");
    const present = sourced(`durations_table`, { USE_LEDGER_DURATIONS: "1", LEDGER_DIR: tmp });
    assert.equal(present.stdout.trim(), join(tmp, "spec-durations.json"));
    assert.equal(present.stderr.trim(), "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("nothing in the publish phase writes into the tracked series", () => {
  // The three paths may appear there ONLY as the source ledger_seed copies FROM. A
  // write to any of them is the dirty tree this whole change exists to avoid, and it
  // would look exactly like a working run until the next morning's pull.
  const script = readFileSync(SCRIPT, "utf8");
  const publish = script.slice(script.indexOf("phase_publish() {"), script.indexOf("phase_verdict() {"));
  assert.ok(publish.length > 0, "could not isolate phase_publish");
  const TRACKED = ["reports/daily-history.jsonl", "reports/token-history.jsonl", "reports/spec-durations.json"];
  for (const line of publish.split("\n")) {
    const code = line.trim();
    if (code.startsWith("#")) continue;
    for (const path of TRACKED) {
      if (!code.includes(path)) continue;
      assert.ok(code.startsWith("ledger_seed "), `${path} is touched by something other than the seed: ${code}`);
    }
  }
  // And the appenders are pointed somewhere, rather than left on their defaults —
  // whose defaults are precisely the tracked paths above.
  assert.match(publish, /HISTORY_FILE="\$LEDGER_HISTORY"/);
  assert.match(publish, /mv "\$next" "\$LEDGER_DURATIONS"/);
});

test("the matrix still balances on the tracked durations while both dailies run", () => {
  // Turning this on early would move specs onto different shards than the Actions lane
  // puts them, so a failure's neighbours — and the load its backend was under —
  // would differ for a reason that has nothing to do with the product. The comparison
  // is the product of this etapa; the switch belongs to the one after it.
  const r = sourced(`echo "$USE_LEDGER_DURATIONS"`);
  assert.equal(r.stdout.trim(), "0");
});
