// Unit tests for ops/vm/run-on-demand.sh, which e2e-on-demand.service runs.
// Run with: npm run test:scripts
//
// The happy path needs the machine -- docker, a five-minute build, four backends -- and
// is exercised there. What these pin is what the machine would not report: a request
// that ran as a command, a run that could publish or write the official ledger, a run
// on another lane's ports, a run that started inside the daily's window, a cleanup
// that did not happen, and a result that said the wrong thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { ROOT, ONDEMAND, TARGET_SHA, IMAGE, PUBLISHING, GOOD_REQUEST, stub, q, setup, kv } from "./lib/on-demand-machine.mjs";

function onDemand(opts) {
  const { env, collect } = setup(opts);
  const r = spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  return collect(r.status);
}


// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

test("a request becomes a declared image run of that branch's commit, isolated, with every publisher off", () => {
  const r = onDemand();
  assert.ok(r.env, `run-e2e.sh was not reached:\n${r.log}`);
  const e = kv(r.env);
  assert.equal(e.TARGET_SSH, "local");
  assert.equal(e.TARGET_KIND, "image");
  assert.equal(e.LANGFLOW_IMAGE, IMAGE);
  assert.equal(e.TARGET_DECLARED_SHA, TARGET_SHA);
  assert.equal(e.TARGET_DECLARED_VERSION, "1.13.0");
  assert.equal(e.TARGET_DECLARED_REF, "release-1.13.0");
  assert.equal(e.DECLARED_MODEL_PROVIDER, "anthropic");
  assert.equal(e.DECLARED_MODEL_ID, "");
  assert.equal(e.WORKFLOW_ID, "on-demand-stable");
  assert.equal(e.RUNS_ROOT, join(r.state, "runs"));
  for (const k of ["CREATE_ISSUE", "AUTO_REMOVE", "HISTORY_TO_SOURCE", "NOTIFY_SLACK", "NOTIFY_SLACK_ALWAYS", "POST_QA_PLATFORM", "CHECK_MIRROR"]) {
    assert.equal(e[k], "0", `${k} is not off`);
  }
  for (const k of ["LANGFLOW_SRC_RUN_CMD", "LANGFLOW_SRC_FRONTEND_DIR", "TARGET_VENV", "PREPARE_TARGET"]) {
    assert.ok(!(k in e), `${k} reached an image run`);
  }
  assert.equal(r.build.split("\n")[0], `release-1.13.0 BUILD_ROOT=${join(r.state, "builds")}`);
});

test("the run's containers resolve localhost to both loopbacks, as the shadow's do (#2181)", () => {
  // The QA VM boots with ipv6.disable=1, so docker writes 127.0.0.1 alone into each
  // container's /etc/hosts, and model-provider-base-url-ssrf, which requires the
  // loopback refusal to name ::1 too, failed on every on-demand run.
  const r = onDemand();
  assert.ok(r.env, `run-e2e.sh was not reached:\n${r.log}`);
  assert.equal(kv(r.env).LANGFLOW_HOSTS_FILE, join(r.state, "hosts"));
  assert.match(r.hosts, /^127\.0\.0\.1\tlocalhost$/m);
  assert.match(r.hosts, /^::1\tlocalhost( |$)/m);
});

test("the publishing credentials and gh's login never reach the run, and the provider keys do", () => {
  const r = onDemand();
  const e = kv(r.env);
  for (const k of [...PUBLISHING, "GH_ENTERPRISE_TOKEN"]) assert.ok(!(k in e), `${k} reached the on-demand run`);
  assert.equal(e.OPENAI_API_KEY, "provider-key");
  assert.equal(e.GH_CONFIG_DIR, join(r.state, "no-gh-login"));
});

test("the suite is the clone's commit, in a worktree of its own that reads the clone's .env, removed afterwards", () => {
  const r = onDemand();
  const [, cwd, head] = r.env.match(/cwd=(\S+) head=(\S+)/);
  assert.equal(cwd, join(r.state, "wt"));
  assert.equal(head, r.head);
  assert.equal(r.env.match(/dotenv=(\S+)/)[1], join(r.repo, ".env"));
  assert.equal(r.wtLeft, false, "the worktree was left behind");
  assert.doesNotMatch(r.worktrees, /\/wt\b/, "the clone still lists the worktree");
});

test("the run writes into a fresh copy of the official ledger, never into it, and the copy goes", () => {
  // The triage summary reads recurrence against the daily's history, so the run needs
  // it; the official file must never carry a row from a run that is not the daily.
  const r = onDemand();
  const e = kv(r.env);
  assert.equal(e.LEDGER_DIR, join(r.state, "ledger-req-1"));
  assert.equal(readFileSync(join(r.official, "daily-history.jsonl"), "utf8"), '{"row":"daily"}\n', "the official ledger was written");
  assert.equal(r.env.match(/ledger_seen=(.*)/)[1], '{"row":"daily"}', "the copy did not carry the daily's history");
  assert.deepEqual(r.ledgers, [], "the ledger copy was left behind");
});

test("the lock's descriptor reaches neither the build nor the run", () => {
  // A daemon the run leaves behind (echo, ollama) inherits what the run inherits; with
  // the lock's descriptor it would hold the lock after this run and refuse every next.
  const r = onDemand();
  assert.match(r.build, /^fd9=closed$/m, "the build inherited the lock");
  assert.match(r.env, /^fd9=closed$/m, "run-e2e.sh inherited the lock");
  // The heavy-lane lock too: an ollama holding it would make every routine wait for
  // nothing until its budget ran out.
  assert.match(r.build, /^fd8=closed$/m, "the build inherited the heavy-lane lock");
  assert.match(r.env, /^fd8=closed$/m, "run-e2e.sh inherited the heavy-lane lock");
});

test("a routine holding the heavy-lane lock refuses the run, names the holder, and touches nothing", () => {
  const { env, collect } = setup({ heavyBusy: true });
  writeFileSync(`${env.E2E_HEAVY_LOCK}.holder`, "migration (pid 4242) since 20261006T091500Z\n");
  const r = collect(spawnSync("bash", [ONDEMAND], { encoding: "utf8", env }).status);
  assert.equal(r.status, 2, r.log);
  assert.equal(r.result["req-1"].STATUS, "refused");
  assert.match(r.result["req-1"].REASON, /the machine is busy: migration \(pid 4242\)/);
  assert.equal(r.build, null, "a build ran beside a routine");
  assert.equal(r.docker, "", "docker was touched while refusing");
  // Refused, it must not erase the holder's line.
  assert.match(r.heavyHolder ?? "", /^migration \(pid 4242\)/);
});

test("a run takes the heavy-lane lock, names itself as holder, and clears only its own line", () => {
  const r = onDemand();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.heavyHolder, null, "the run left its holder line behind");
});

// PROVIDER and MODEL are what the run USED, in the queue contract's words (#2226):
// with nothing declared that is the day's rotation, which only the run resolves.
const ROTATION = "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_REQUESTED_BY=victor\n";

test("a run on the day's rotation reports the provider and model the run used, not the request's ''", () => {
  const r = onDemand({ request: ROTATION, modelUsed: "google\tgemini-2.5-flash\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.result["req-1"].PROVIDER, "google");
  assert.equal(r.result["req-1"].MODEL, "gemini-2.5-flash");
});

test("a declared provider is reported with the model the run resolved for it", () => {
  const r = onDemand({ modelUsed: "anthropic\tclaude-sonnet-5\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.result["req-1"].PROVIDER, "anthropic");
  assert.equal(r.result["req-1"].MODEL, "claude-sonnet-5");
});

test("more than one provider is reported in run-e2e.sh's words, all or mixed, with no model", () => {
  for (const word of ["all", "mixed"]) {
    const r = onDemand({ request: ROTATION, modelUsed: `${word}\t\n` });
    assert.equal(r.status, 0, r.log);
    assert.equal(r.result["req-1"].PROVIDER, word);
    assert.equal(r.result["req-1"].MODEL, "");
  }
});

test("a run that left no model-used line keeps what was requested", () => {
  const rotation = onDemand({ request: ROTATION });
  assert.equal(rotation.result["req-1"].PROVIDER, "");
  assert.equal(rotation.result["req-1"].MODEL, "");
  // A refused declaration never pins, so it never writes one: the result names what
  // was refused.
  const refused = onDemand({ modelRefused: 'the declared provider "anthropic" is not usable', runExit: 1 });
  assert.equal(refused.result["req-1"].STATUS, "refused");
  assert.equal(refused.result["req-1"].PROVIDER, "anthropic");
});

test("a model-used line outside the request's shapes is not reported, so the result stays one the platform takes", () => {
  for (const line of ["Anthropic;x\tclaude\n", "anthropic\tclaude sonnet\n", "anthropic\n", "\tclaude\n", `${"a".repeat(41)}\tm\n`]) {
    const r = onDemand({ request: ROTATION, modelUsed: line });
    assert.equal(r.status, 0, r.log);
    assert.equal(r.result["req-1"].PROVIDER, "", `reported ${JSON.stringify(line)}`);
    assert.equal(r.result["req-1"].MODEL, "");
  }
});

test("a green run is done/green, exit 0, and the result names the run and the target", () => {
  const r = onDemand();
  assert.equal(r.status, 0, r.log);
  const res = r.result["req-1"];
  assert.equal(res.STATUS, "done");
  assert.equal(res.VERDICT, "green");
  assert.equal(res.EXIT, "0");
  assert.match(res.RUN_ID, /^\d{8}T\d{6}Z$/);
  assert.equal(res.TARGET_REF, "release-1.13.0");
  assert.equal(res.TARGET_SHA, TARGET_SHA);
  assert.equal(res.TARGET_VERSION, "1.13.0");
  assert.equal(res.BUILD_S, "300");
  assert.equal(res.SUITE_SHA, r.head);
  assert.equal(res.PROVIDER, "anthropic");
  assert.equal(res.REQUESTED_BY, "victor");
  assert.equal(res.CLEANUP, "ok");
  assert.deepEqual(r.requests, ["req-1.env"], "the request was not kept under its id");
  assert.equal(r.requestLeft, false, "the request was not consumed");
});

test("a red run is done/red, exit 1; a run with no results.json is failed, exit 3", () => {
  const red = onDemand({ runExit: 1 });
  assert.equal(red.status, 1);
  assert.equal(red.result["req-1"].STATUS, "done");
  assert.equal(red.result["req-1"].VERDICT, "red");
  // run-e2e.sh exits 1 for a red day and for a run that died in preflight alike.
  const died = onDemand({ runExit: 1, writeResults: false });
  assert.equal(died.status, 3);
  assert.equal(died.result["req-1"].STATUS, "failed");
  assert.equal(died.result["req-1"].VERDICT, "");
  assert.match(died.result["req-1"].REASON, /without a results\.json/);
});

test("the result carries run-e2e.sh's own verdict lines, and green says green", () => {
  const green = onDemand();
  assert.equal(green.result["req-1"].REASON, "the suite ran green");
  const red = onDemand({ runExit: 1, preError: "a warning-level error before the verdict", verdict: ["at least one shard had a failing test."] });
  assert.equal(red.result["req-1"].STATUS, "done");
  assert.equal(red.result["req-1"].REASON, "the suite ran red: at least one shard had a failing test.", "only the verdict's lines, without ANSI");
});

test("a declared provider run-e2e.sh refused is the request's fault: refused, even after the build", () => {
  // A typo passes the shape check; collect-models finds no such provider active.
  const r = onDemand({ runExit: 1, writeResults: false, modelRefused: "antropic is not active (probed: openai, anthropic, google)", verdict: ["the declared provider could not be used: antropic is not active"] });
  assert.equal(r.status, 2, r.log);
  assert.equal(r.result["req-1"].STATUS, "refused");
  assert.match(r.result["req-1"].REASON, /declared provider could not be used.*antropic is not active/);
  // Even with a report: no agent spec ran, so it is not a product verdict.
  const withReport = onDemand({ runExit: 1, modelRefused: "antropic is not active" });
  assert.equal(withReport.result["req-1"].STATUS, "refused");
});

// The provider pre-check: asked before the build, so a dry key does not hold the slot
// through five to eight minutes of build to be refused by collect-models after it.
const DRY = { exit: 2, out: JSON.stringify({ verdict: "refused", provider: "anthropic", model: null, reason: "anthropic turned down every candidate the same way: HTTP 400: Your credit balance is too low" }) };

test("a declared provider is asked before the build, from the suite's worktree, with the provider keys and no publisher", () => {
  const r = onDemand({ request: "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_PROVIDER=anthropic\nONDEMAND_MODEL=claude-haiku-4-5\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.probes.length, 1, r.log);
  const [p] = r.probes;
  assert.deepEqual(p.args, ["--provider", "anthropic", "--model", "claude-haiku-4-5"]);
  // Gone after the run, so the state directory is what resolves (macOS: /private/var).
  assert.equal(p.cwd, join(realpathSync(r.state), "wt"));
  assert.equal(p.built, false, "the pre-check ran after the build");
  assert.ok(p.keys.includes("OPENAI_API_KEY"), "the provider keys did not reach the pre-check");
  // A line of the secrets file with no `export` reaches the run no more than the probe:
  // the two must see one key, or the probe judges a key the run never uses.
  assert.ok(!p.keys.includes("ANTHROPIC_API_KEY"), "an unexported key reached the pre-check, and it does not reach the run");
  assert.ok(!("ANTHROPIC_API_KEY" in kv(r.env)), "an unexported key reached the run");
  assert.equal(p.fd8, false, "the pre-check held the heavy-lane lock");
  assert.equal(p.fd9, false, "the pre-check held the run's lock");
  for (const k of [...PUBLISHING, "GH_ENTERPRISE_TOKEN"]) assert.ok(!p.keys.includes(k), `${k} reached the pre-check`);
  assert.match(r.log, /provider pre-check \(exit 0\)/);
});

test("with no model declared, the pre-check is asked for the provider alone", () => {
  const r = onDemand();
  assert.deepEqual(r.probes[0].args, ["--provider", "anthropic"]);
});

test("the day's rotation has nothing to pre-check", () => {
  const r = onDemand({ request: "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\n" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.probes, []);
});

test("a provider the pre-check turned down is refused before the build, in the provider's words, and cleaned up", () => {
  const r = onDemand({ probe: DRY });
  assert.equal(r.status, 2, r.log);
  const res = r.result["req-1"];
  assert.equal(res.STATUS, "refused");
  assert.equal(res.EXIT, "2");
  assert.equal(res.REASON, "the declared provider cannot be used, checked before the build: anthropic turned down every candidate the same way: HTTP 400: Your credit balance is too low");
  assert.equal(r.build, null, "the build ran after a refusal");
  assert.equal(r.env, null, "the suite ran after a refusal");
  assert.equal(res.CLEANUP, "ok");
  assert.equal(r.wtLeft, false, "the worktree was left behind");
  assert.equal(r.heavyHolder, null, "the refused run left its holder line");
});

test("a pre-check with no certain answer, or none at all, lets the run go on to the build", () => {
  const undecided = onDemand({ probe: { exit: 3, out: '{"verdict":"undecided","reason":"no answer from anthropic: fetch failed"}' } });
  assert.equal(undecided.status, 0, undecided.log);
  assert.ok(undecided.env, "an undecided pre-check stopped the run");
  // A suite commit from before the pre-check: node cannot find the script.
  const missing = onDemand({ probe: null });
  assert.equal(missing.status, 0, missing.log);
  assert.ok(missing.env, "a missing pre-check stopped the run");
  // A refusal exit with output that is not its JSON still refuses, with a reason.
  const garbled = onDemand({ probe: { exit: 2, out: "not json" } });
  assert.equal(garbled.result["req-1"].STATUS, "refused");
  assert.match(garbled.result["req-1"].REASON, /checked before the build: the pre-check said no without a reason/);
});

test("a run that served another version is failed, never done/red, whatever its report says", () => {
  for (const line of ["the target served the wrong Langflow — exact: served 1.12.4, declared 1.13.0.", "the version check could not be performed (unchecked)."]) {
    const r = onDemand({ runExit: 1, verdict: ["at least one shard had a failing test.", line] });
    assert.equal(r.status, 3, line);
    assert.equal(r.result["req-1"].STATUS, "failed", line);
    assert.equal(r.result["req-1"].VERDICT, "", `${line}: a verdict was given for a target the run did not measure`);
    assert.match(r.result["req-1"].REASON, /says nothing about release-1\.13\.0 @ bbbbbbbbbbbb/);
  }
});

test("a run with no results.json says why in run-e2e.sh's words: the verdict's, else its last error", () => {
  const merge = onDemand({ runExit: 1, writeResults: false, verdict: ["the shards RAN and the MERGE failed — there is no report to read, and the tests are not what broke."] });
  assert.equal(merge.result["req-1"].STATUS, "failed");
  assert.match(merge.result["req-1"].REASON, /the MERGE failed/);
  const preflight = onDemand({ runExit: 1, writeResults: false, preError: "only 12 GB free here, and a run needs at least 20" });
  assert.match(preflight.result["req-1"].REASON, /only 12 GB free here/);
  // Only this run's lines: the build, before it, wrote one of its own to the same log.
  const silent = onDemand({ runExit: 1, writeResults: false });
  assert.doesNotMatch(silent.result["req-1"].REASON, /from before the run/);
  assert.match(silent.result["req-1"].REASON, /no reason given/);
});

test("a SIGTERM the instant the request leaves the slot still answers it", () => {
  // #2127 review: the request used to move before any trap existed, and bash's default
  // action for SIGTERM ends the script without running one.
  for (const request of [GOOD_REQUEST, "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nPATH=/evil\n"]) {
    const r = onDemand({ termOnConsume: true, request });
    assert.equal(r.requestLeft, false, "the request was not consumed, so the stub never fired");
    assert.ok(r.result["req-1"], `${request}: consumed, signalled, and never answered:\n${r.log}`);
    assert.equal(r.status, r.result["req-1"].STATUS === "refused" ? 2 : 3, r.log);
  }
});

test("a SIGTERM between any two parts of an outcome still answers a result the platform accepts", () => {
  // ondemand_finish classifies only an exit with no STATUS. A STATUS set before its
  // EXIT left EXIT empty; a VERDICT set before a STATUS that never came left
  // failed/green. The platform refuses both (EXIT must match STATUS, and VERDICT is
  // set exactly when STATUS is done), and the request is never answered. A DEBUG trap
  // sends the signal right after the k-th assignment of STATUS, VERDICT, EXIT or
  // REASON once signals are caught, for every k an outcome has.
  const EXPECTED_EXIT = { "done/green": "0", "done/red": "1", "refused/": "2", "failed/": "3", "build_failed/": "4" };
  const cases = {
    "done/green": {},
    "done/red": { runExit: 1 },
    "refused (window)": { now: "3 0800" },
    "refused (provider)": { runExit: 1, writeResults: false, modelRefused: "antropic is not active" },
    "failed (build)": { buildExit: 3, buildOut: "" },
    "build_failed": { buildExit: 5, buildOut: "" },
    "failed (wrong version)": { runExit: 1, verdict: ["the target served the wrong Langflow — exact: served 1.12.4, declared 1.13.0."] },
    "failed (no results.json)": { runExit: 1, writeResults: false },
  };
  for (const [name, opts] of Object.entries(cases)) {
    for (const k of [1, 2, 3, 4]) {
      const { env, collect } = setup(opts);
      const harness = join(env.E2E_ONDEMAND_STATE, "..", "term-after-assignment.sh");
      writeFileSync(harness, [
        "od_term() {",
        '  case "$od_prev" in',
        "    \"trap 'exit 143' TERM\") od_armed=1 ;;",
        "    *'=\"\"') ;;",
        '    OD_STATUS=* | OD_VERDICT=* | OD_EXIT=* | OD_REASON=*)',
        `      if [ "$od_armed" = 1 ]; then od_n=$((od_n + 1)); [ "$od_n" = ${k} ] && kill -TERM $$; fi ;;`,
        "  esac",
        '  od_prev="$BASH_COMMAND"',
        "}",
        'set -T; od_prev=""; od_armed=0; od_n=0; trap od_term DEBUG',
        `source ${q(ONDEMAND)}`,
      ].join("\n") + "\n");
      const r = collect(spawnSync("bash", [harness], { encoding: "utf8", env }).status);
      const res = r.result["req-1"];
      const at = `${name}, signal after assignment ${k}`;
      assert.ok(res, `${at}: no result:\n${r.log}`);
      assert.equal(res.STATUS === "done", res.VERDICT !== "", `${at}: ${res.STATUS} with VERDICT='${res.VERDICT}'`);
      assert.equal(res.EXIT, EXPECTED_EXIT[`${res.STATUS}/${res.VERDICT}`], `${at}: ${res.STATUS}/${res.VERDICT} answered EXIT='${res.EXIT}'`);
      assert.notEqual(res.REASON, "", `${at}: no REASON`);
      assert.equal(String(r.status), res.EXIT, `${at}: the exit status does not follow the result`);
    }
  }
});

test("a request a killed run consumed and never answered is answered failed by the next start", () => {
  // SIGKILL, an OOM kill or a reboot never run the EXIT trap that writes the result.
  const r = onDemand({ orphans: [["killed-1", false], ["answered-1", true]] });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.result["killed-1"].STATUS, "failed");
  assert.match(r.result["killed-1"].REASON, /^interrupted/);
  assert.equal(r.result["answered-1"].ORIGINAL, "1", "an answered request was answered again");
  assert.equal(r.result["req-1"].STATUS, "done", "the start's own request was not served");
  // Not an orphan of its own making, and a kept unparsed copy is never one.
  assert.ok(!Object.keys(r.result).some((k) => k.startsWith("unparsed-")));
});

// ---------------------------------------------------------------------------
// The request is data
// ---------------------------------------------------------------------------

test("a malformed request is refused before anything runs, and its contents never execute", () => {
  const dir = makeTempDir("on-demand-pwn-");
  const pwned = join(dir, "pwned");
  for (const [request, why] of [
    [`ONDEMAND_ID=req-1\nONDEMAND_REF=$(touch ${pwned})\n`, /ONDEMAND_REF has characters/],
    [`ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\ntouch ${pwned}\n`, /not KEY=VALUE/],
    [`ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nPATH=/evil\n`, /unknown key 'PATH'/],
    [`ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_REF=main\n`, /given twice/],
    ["ONDEMAND_REF=release-1.13.0\n", /ONDEMAND_ID is missing/],
    ["ONDEMAND_ID=req-1\n", /ONDEMAND_REF is missing/],
    ["ONDEMAND_ID=../../etc\nONDEMAND_REF=release-1.13.0\n", /ONDEMAND_ID must be/],
    ["ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_MODEL=claude-x\n", /needs ONDEMAND_PROVIDER/],
    ["ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_PROVIDER=Anthropic;x\n", /ONDEMAND_PROVIDER has characters/],
  ]) {
    const r = onDemand({ request });
    assert.equal(r.status, 2, `${request}\n${r.log}`);
    assert.match(r.log, why, request);
    assert.equal(r.build, null, `${request}: a build ran`);
    assert.equal(r.env, null, `${request}: run-e2e.sh ran`);
    assert.equal(r.requestLeft, false, `${request}: the request was not consumed`);
    // Answered under its id when it names a usable one, once; kept unparsed otherwise.
    const id = (request.match(/^ONDEMAND_ID=([A-Za-z0-9._-]{1,64})$/m) || [])[1];
    if (id && (request.match(/^ONDEMAND_ID=/gm) || []).length === 1) {
      assert.equal(r.result[id]?.STATUS, "refused", `${request}: no result for a usable id`);
      assert.match(r.result[id].REASON, why);
      assert.ok(r.requests.includes(`${id}.env`), request);
    } else {
      assert.deepEqual(r.result, {}, `${request}: a result was written for a request with no usable id`);
      assert.ok(r.requests.some((f) => f.startsWith("unparsed-")), `${request}: the refused request was not kept`);
    }
  }
  assert.equal(existsSync(pwned), false, "a value from the request was executed");
});

test("two refusals in the same second keep both refused requests", () => {
  // Found on the qa (2026-10-01): the kept copy was named by the second-resolution
  // stamp alone, and the second refusal replaced the first's.
  const { env, collect } = setup({ request: "ONDEMAND_ID=../a\nONDEMAND_REF=x\n" });
  spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  writeFileSync(join(env.E2E_ONDEMAND_STATE, "request.env"), "ONDEMAND_ID=../b\nONDEMAND_REF=x\n");
  spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  const r = collect(2);
  const kept = r.requests.filter((f) => f.startsWith("unparsed-"));
  assert.equal(kept.length, 2, `kept: ${kept}`);
  const bodies = kept.map((f) => readFileSync(join(r.state, "requests", f), "utf8")).sort();
  assert.match(bodies[0], /ONDEMAND_ID=\.\.\/a/);
  assert.match(bodies[1], /ONDEMAND_ID=\.\.\/b/);
});

test("comments, blank lines and CRLF line ends are accepted", () => {
  const r = onDemand({ request: "# by hand\r\n\r\nONDEMAND_ID=req-1\r\nONDEMAND_REF=release-1.13.0\r\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(kv(r.env).TARGET_DECLARED_REF, "release-1.13.0");
});

test("an id already answered is refused, and the first answer is left as it was", () => {
  const r = onDemand({ answered: "req-1" });
  assert.equal(r.status, 2);
  assert.match(r.log, /already answered/);
  assert.equal(r.result["req-1"].ORIGINAL, "1", "the earlier result was replaced");
  assert.equal(r.build, null);
});

// ---------------------------------------------------------------------------
// The daily has priority
// ---------------------------------------------------------------------------

test("no run starts on a weekday between 07:30 and 08:40 UTC, and the refusal is the result", () => {
  for (const [now, refused] of [
    ["1 0730", true], ["3 0759", true], ["5 0839", true],
    ["3 0729", false], ["3 0840", false], ["6 0745", false], ["7 0800", false],
  ]) {
    const r = onDemand({ now });
    if (refused) {
      assert.equal(r.status, 2, `${now}: ${r.log}`);
      assert.equal(r.result["req-1"].STATUS, "refused", now);
      assert.match(r.result["req-1"].REASON, /window is closed/, now);
      assert.equal(r.build, null, `${now}: a build ran in the window`);
      assert.equal(r.docker, "", `${now}: docker was touched while refusing`);
    } else {
      assert.equal(r.status, 0, `${now}: ${r.log}`);
    }
  }
});

test("no run starts beside the daily or the shadow, whatever state systemd names them by", () => {
  for (const unit of ["e2e-daily.service", "e2e-shadow.service"]) {
    for (const state of ["activating", "active", "deactivating", "reloading"]) {
      const r = onDemand({ states: { [unit]: state } });
      assert.equal(r.status, 2, `${unit} ${state}`);
      assert.match(r.result["req-1"].REASON, new RegExp(`${unit.replace(".", "\\.")} is ${state}`));
      assert.equal(r.build, null);
      assert.equal(r.docker, "", "docker was touched while the daily lane runs");
    }
  }
  for (const state of ["inactive", "failed", ""]) {
    assert.equal(onDemand({ states: { "e2e-daily.service": state } }).status, 0, state);
  }
});

test("today's shadow request waiting to be picked up refuses the run; a stale one does not", () => {
  const r = onDemand({ shadowRequest: true });
  assert.equal(r.status, 2);
  assert.match(r.result["req-1"].REASON, /shadow request for today is waiting/);
  // The shadow refuses another day's request itself; one left by a start that failed
  // must not block this lane until the next daily.
  const stale = onDemand({ shadowRequest: true, shadowDate: "2026-01-02" });
  assert.equal(stale.status, 0, stale.log);
});

test("a lock held by another run refuses without consuming the request", () => {
  const r = onDemand({ lockBusy: true });
  assert.equal(r.status, 2);
  // Its own log, not latest.log: that one stays with the run holding the lock.
  assert.match(r.allLogs, /another on-demand run holds/);
  assert.equal(r.requestLeft, true, "the next request was consumed by a start that could not run it");
  assert.deepEqual(r.result, {});
});

// ---------------------------------------------------------------------------
// The build's answer
// ---------------------------------------------------------------------------

test("each build status maps to its own outcome, and the suite never runs after one", () => {
  for (const [buildExit, status, exit] of [[2, "refused", 2], [3, "failed", 3], [7, "failed", 3], [4, "build_failed", 4], [5, "build_failed", 4], [6, "build_failed", 4], [1, "failed", 3], [126, "failed", 3], [127, "failed", 3]]) {
    const r = onDemand({ buildExit, buildOut: "" });
    assert.equal(r.status, exit, `build ${buildExit}: ${r.log}`);
    assert.equal(r.result["req-1"].STATUS, status, `build ${buildExit}`);
    assert.equal(r.env, null, `build ${buildExit}: run-e2e.sh ran`);
    assert.match(r.log, /some refusal line/, "the build's own reason did not reach the log");
    assert.match(r.result["req-1"].REASON, /: some refusal line$/, `build ${buildExit}: the build's own reason did not reach the result`);
    if (buildExit === 1 || buildExit > 7) assert.match(r.result["req-1"].REASON, /not the branch/, `build ${buildExit} was charged to the branch`);
  }
});

test("the build's output is read by name, never evaluated, and an answer for another branch is refused", () => {
  const dir = makeTempDir("on-demand-pwn-");
  const pwned = join(dir, "pwned");
  const evil = onDemand({ buildOut: `target_ref=release-1.13.0\ntarget_sha=${TARGET_SHA}\ntarget_version=1.13.0\nimage=$(touch ${pwned})\nbuild_s=1` });
  assert.equal(evil.status, 4);
  assert.match(evil.result["req-1"].REASON, /incomplete/);
  assert.equal(existsSync(pwned), false);
  const other = onDemand({ buildOut: `target_ref=main\ntarget_sha=${TARGET_SHA}\ntarget_version=1\nimage=${IMAGE}\nbuild_s=1` });
  assert.equal(other.status, 4);
  assert.match(other.result["req-1"].REASON, /answered for 'main'/);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("cleanup removes this lane's containers, images and build cache, and only those", () => {
  for (const opts of [{}, { runExit: 1 }, { buildExit: 5, buildOut: "" }]) {
    const r = onDemand(opts);
    for (const port of [7910, 7911, 7912, 7913]) {
      assert.match(r.docker, new RegExp(`^rm -f langflow-e2e-lane-${port}$`, "m"), `${JSON.stringify(opts)}: ${port}`);
    }
    assert.doesNotMatch(r.docker, /langflow-e2e-lane-78[78]\d/, "another lane's container was touched");
    assert.match(r.docker, /^images -q langflow-ondemand$/m);
    assert.match(r.docker, /^rmi -f img-old$/m);
    assert.match(r.docker, /^builder prune -af$/m);
    assert.doesNotMatch(r.docker, /system prune/, "system prune takes the other lanes' images");
    assert.match(r.stops, /^echo 8100$/m);
    assert.match(r.stops, /^ollama 11454$/m);
    assert.equal(r.wtLeft, false);
  }
});

test("build logs older than a month are removed, and recent ones kept", () => {
  const { env, collect } = setup();
  const builds = join(env.E2E_ONDEMAND_STATE, "builds");
  mkdirSync(builds, { recursive: true });
  writeFileSync(join(builds, "build-old.log"), "x");
  writeFileSync(join(builds, "build-new.log"), "x");
  execFileSync("touch", ["-t", "202001010000", join(builds, "build-old.log")]);
  spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  const r = collect(0);
  assert.equal(existsSync(join(builds, "build-old.log")), false, "a build log older than a month was kept");
  assert.equal(existsSync(join(builds, "build-new.log")), true, "a recent build log was removed");
  assert.ok(r.result["req-1"]);
});

test("a container that survives removal is reported in the result, not hidden", () => {
  const r = onDemand({ leftover: "langflow-e2e-lane-7911\n" });
  assert.equal(r.result["req-1"].CLEANUP, "incomplete");
  assert.match(r.log, /still present after removal: langflow-e2e-lane-7911/);
});

test("a run stopped by SIGTERM -- the daily starting -- still cleans up and answers failed", async () => {
  const { env, collect } = setup({ runSleep: 2 });
  const child = spawn("bash", [ONDEMAND], { env, stdio: "ignore" });
  await new Promise((res) => setTimeout(res, 1000));
  child.kill("SIGTERM");
  const status = await new Promise((res) => child.on("exit", (code) => res(code)));
  const r = collect(status);
  assert.equal(r.status, 3, r.log);
  assert.equal(r.result["req-1"].STATUS, "failed");
  assert.match(r.result["req-1"].REASON, /SIGTERM/);
  assert.match(r.docker, /^builder prune -af$/m);
  assert.equal(r.wtLeft, false);
});

test("the result is on disk, cleanup pending, before the cleanup starts", () => {
  // systemd SIGKILLs at TimeoutStopSec; a cleanup cut short must not leave the request
  // unanswered.
  const r = onDemand();
  assert.ok(r.atPrune, "no result existed while the cleanup ran");
  assert.match(r.atPrune, /^STATUS=done$/m);
  assert.match(r.atPrune, /^CLEANUP=pending$/m);
  assert.equal(r.result["req-1"].CLEANUP, "ok");
});

test("a docker that cannot list containers is an unconfirmed cleanup, not an ok one", () => {
  const r = onDemand({ psFails: true });
  assert.equal(r.result["req-1"].CLEANUP, "unconfirmed");
  assert.match(r.log, /docker ps failed/);
});

test("what a SIGKILLed run left -- its source tree, its ledger copy -- is cleared by the next", () => {
  const r = onDemand({ leftovers: true });
  assert.equal(r.status, 0, r.log);
  assert.equal(existsSync(join(r.state, "builds", "src-aaaaaaaaaaaa-XYZ")), false);
  assert.deepEqual(r.ledgers, []);
});

test("a start refused by the lock does not take latest.log from the running run", () => {
  const { env, collect } = setup({ lockBusy: true });
  mkdirSync(env.E2E_ONDEMAND_LOG_DIR, { recursive: true });
  writeFileSync(join(env.E2E_ONDEMAND_LOG_DIR, "running.log"), "the running run\n");
  execFileSync("ln", ["-sfn", join(env.E2E_ONDEMAND_LOG_DIR, "running.log"), join(env.E2E_ONDEMAND_LOG_DIR, "latest.log")]);
  spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  const r = collect(2);
  assert.equal(r.log, "the running run\n");
});

// ---------------------------------------------------------------------------
// No lane shares what a run owns
// ---------------------------------------------------------------------------

test("the on-demand lane's ports and workflow are disjoint from the official lane's and the shadow's", () => {
  // run-e2e.sh's hygiene clears only its own ports, and the backend containers are
  // named by port alone: a shared port is a shared container name.
  const read = (p) => readFileSync(join(ROOT, p), "utf8");
  const runE2e = read("scripts/run-e2e.sh");
  const dflt = (key) => Number(runE2e.match(new RegExp(`^${key}="\\$\\{${key}:-(\\d+)\\}"`, "m"))[1]);
  const num = (text, key) => {
    const m = text.match(new RegExp(`\\b${key}=(\\d+)`));
    return m ? Number(m[1]) : dflt(key);
  };
  const ports = (text) => [
    ...Array.from({ length: num(text, "SHARDS") }, (_, i) => num(text, "BASE_PORT") + i),
    num(text, "ECHO_PORT"),
    num(text, "OLLAMA_PORT"),
  ];
  const lanes = { official: ports(read("ops/vm/run-daily.sh")), shadow: ports(read("ops/vm/run-shadow.sh")), ondemand: ports(read("ops/vm/run-on-demand.sh")) };
  // And every default port a starter in this repository binds: 7890-7893 were this
  // lane's first choice and are the Enterprise and serving-identity defaults (#2127).
  const starters = readdirSync(join(ROOT, "scripts")).filter((f) => /^start-.*\.sh$/.test(f));
  lanes.starters = starters.flatMap((f) => [...read(join("scripts", f)).matchAll(/PORT:-(\d+)\}/g)].map((m) => Number(m[1])));
  assert.ok(lanes.starters.includes(7890) && lanes.starters.includes(7893), `the starters' defaults were not read: ${lanes.starters}`);
  for (const other of ["official", "shadow", "starters"]) {
    assert.deepEqual(lanes.ondemand.filter((p) => lanes[other].includes(p)), [], `on-demand shares ports with ${other}: ${lanes.ondemand} / ${lanes[other]}`);
  }
  // The cleanup names the containers by port; it must name exactly the ones this lane uses.
  const text = read("ops/vm/run-on-demand.sh");
  const base = num(text, "BASE_PORT");
  assert.match(text, new RegExp(`for port in ${[0, 1, 2, 3].map((i) => base + i).join(" ")}; do`));
  assert.match(text, new RegExp(`ECHO_PORT=${num(text, "ECHO_PORT")} bash scripts/stop-echo-source\\.sh`));
  assert.match(text, /export WORKFLOW_ID=on-demand-stable\b/);
});
