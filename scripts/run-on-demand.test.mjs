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
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONDEMAND = join(ROOT, "ops", "vm", "run-on-demand.sh");
const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const TARGET_SHA = "b".repeat(40);
const IMAGE = `langflow-ondemand:${"b".repeat(12)}`;
const PUBLISHING = ["SOURCE_PUSH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "QA_E2E_AUTOMATION_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SLACK_WEBHOOK_URL"];
const GOOD_REQUEST = "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_PROVIDER=anthropic\nONDEMAND_REQUESTED_BY=victor\n";
// A Wednesday afternoon: outside the daily's window.
const OPEN = "3 1500";

const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const q = JSON.stringify;

/**
 * A clone whose one commit carries stub build, run-e2e and stop scripts, and a HOME
 * whose ~/.local/bin shadows docker, systemctl and flock. The run-e2e stub records the
 * environment it was given and appends a row to the ledger it was pointed at; the build
 * stub prints what the real one prints. Each knob is one way the machine can answer.
 */
function setup({
  request = GOOD_REQUEST,
  now = OPEN,
  states = {},
  lockBusy = false,
  buildExit = 0,
  buildOut = `target_ref=release-1.13.0\ntarget_sha=${TARGET_SHA}\ntarget_version=1.13.0\nimage=${IMAGE}\nbuild_s=300`,
  runExit = 0,
  writeResults = true,
  runSleep = 0,
  leftover = "",
  shadowRequest = false,
  answered = null,
} = {}) {
  const dir = makeTempDir("on-demand-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "ops", "vm"), { recursive: true });
  const envOut = join(dir, "run-e2e.env");
  const buildArgs = join(dir, "build.args");
  const stopLog = join(dir, "stop.log");
  writeFileSync(
    join(repo, "scripts", "run-e2e.sh"),
    `#!/usr/bin/env bash
env | sort > ${q(envOut)}
echo "cwd=$PWD head=$(git rev-parse HEAD)" >> ${q(envOut)}
echo "dotenv=$(readlink .env || echo none)" >> ${q(envOut)}
echo "fd9=$( { : >&9; } 2>/dev/null && echo open || echo closed)" >> ${q(envOut)}
echo "ledger_seen=$(cat "$LEDGER_DIR/daily-history.jsonl" 2>/dev/null | tr -d '\n')" >> ${q(envOut)}
echo '{"row":"on-demand"}' >> "$LEDGER_DIR/daily-history.jsonl"
sleep ${runSleep}
${writeResults ? 'mkdir -p "$RUNS_ROOT/$RUN_ID" && echo "{}" > "$RUNS_ROOT/$RUN_ID/results.json"' : ""}
exit ${runExit}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo, "ops", "vm", "build-target-image.sh"),
    `#!/usr/bin/env bash\necho "$* BUILD_ROOT=$BUILD_ROOT" > ${q(buildArgs)}\necho "fd9=$( { : >&9; } 2>/dev/null && echo open || echo closed)" >> ${q(buildArgs)}\necho "build-target-image: some refusal line" >&2\ncat ${q(join(dir, "build.out"))}\nexit ${buildExit}\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "build.out"), buildOut ? `${buildOut}\n` : "");
  writeFileSync(join(dir, "leftover"), leftover);
  writeFileSync(join(repo, "scripts", "stop-echo-source.sh"), `echo "echo $ECHO_PORT" >> ${q(stopLog)}\n`);
  writeFileSync(join(repo, "scripts", "stop-ollama-source.sh"), `echo "ollama $OLLAMA_PORT" >> ${q(stopLog)}\n`);
  const git = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "suite");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(repo, ".env"), "SOME_PROVIDER_API_KEY=from-dotenv\n");

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(dir, "docker.log");
  const systemctlLog = join(dir, "systemctl.log");
  stub(bin, "docker", `echo "$*" >> ${q(dockerLog)}
case "$1" in
  images) echo img-old ;;
  ps) cat ${q(join(dir, "leftover"))} ;;
esac
exit 0`);
  const stateCases = Object.entries(states).map(([u, s]) => `  *${u}*) echo ${q(s)} ;;`).join("\n");
  stub(bin, "systemctl", `echo "$*" >> ${q(systemctlLog)}
case "$*" in
${stateCases}
  *) echo inactive ;;
esac`);
  stub(bin, "flock", lockBusy ? "exit 1" : "exit 0");

  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, [...PUBLISHING.map((n) => `export ${n}=secret-${n}`), "export GH_ENTERPRISE_TOKEN=ghe", "export OPENAI_API_KEY=provider-key"].join("\n") + "\n");

  const official = join(dir, "official-ledger");
  mkdirSync(official);
  writeFileSync(join(official, "daily-history.jsonl"), '{"row":"daily"}\n');
  writeFileSync(join(official, "spec-durations.json"), "{}\n");

  const state = join(dir, "state");
  mkdirSync(join(state, "results"), { recursive: true });
  if (request !== null) writeFileSync(join(state, "request.env"), request);
  if (answered) writeFileSync(join(state, "results", `${answered}.env`), "STATUS=done\nORIGINAL=1\n");
  const shadowState = join(dir, "shadow-state");
  mkdirSync(shadowState);
  if (shadowRequest) writeFileSync(join(shadowState, "request.env"), "SHADOW_DATE=x\n");

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    E2E_ONDEMAND_REPO: repo,
    E2E_ONDEMAND_STATE: state,
    E2E_ONDEMAND_LOG_DIR: join(dir, "logs"),
    E2E_ONDEMAND_SECRETS: secrets,
    E2E_ONDEMAND_OFFICIAL_LEDGER: official,
    E2E_ONDEMAND_NOW: now,
    E2E_SHADOW_STATE: shadowState,
  };
  const collect = (status) => {
    const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    const results = readdirSync(join(state, "results")).filter((f) => f.endsWith(".env"));
    return {
      status,
      head,
      repo,
      state,
      official,
      log: readIf(join(dir, "logs", "latest.log")) ?? "",
      env: readIf(envOut),
      build: readIf(buildArgs),
      docker: readIf(dockerLog) ?? "",
      systemctl: readIf(systemctlLog) ?? "",
      stops: readIf(stopLog) ?? "",
      result: Object.fromEntries(results.map((f) => [f.slice(0, -4), kv(readFileSync(join(state, "results", f), "utf8"))])),
      requestLeft: existsSync(join(state, "request.env")),
      requests: existsSync(join(state, "requests")) ? readdirSync(join(state, "requests")) : [],
      wtLeft: existsSync(join(state, "wt")),
      ledgers: readdirSync(state).filter((f) => f.startsWith("ledger-")),
      worktrees: git("worktree", "list"),
    };
  };
  return { env, collect };
}

function onDemand(opts) {
  const { env, collect } = setup(opts);
  const r = spawnSync("bash", [ONDEMAND], { encoding: "utf8", env });
  return collect(r.status);
}

const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

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
  for (const k of ["CREATE_ISSUE", "AUTO_REMOVE", "NOTIFY_SLACK", "NOTIFY_SLACK_ALWAYS", "POST_QA_PLATFORM", "CHECK_MIRROR"]) {
    assert.equal(e[k], "0", `${k} is not off`);
  }
  for (const k of ["LANGFLOW_SRC_RUN_CMD", "LANGFLOW_SRC_FRONTEND_DIR", "TARGET_VENV", "PREPARE_TARGET"]) {
    assert.ok(!(k in e), `${k} reached an image run`);
  }
  assert.equal(r.build.split("\n")[0], `release-1.13.0 BUILD_ROOT=${join(r.state, "builds")}`);
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
    assert.deepEqual(r.result, {}, `${request}: a result was written for a request with no trustworthy id`);
    assert.equal(r.requestLeft, false, `${request}: the request was not consumed`);
    assert.ok(r.requests.some((f) => f.startsWith("unparsed-")), `${request}: the refused request was not kept`);
  }
  assert.equal(existsSync(pwned), false, "a value from the request was executed");
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

test("a shadow request waiting to be picked up refuses the run", () => {
  const r = onDemand({ shadowRequest: true });
  assert.equal(r.status, 2);
  assert.match(r.result["req-1"].REASON, /shadow request is waiting/);
});

test("a lock held by another run refuses without consuming the request", () => {
  const r = onDemand({ lockBusy: true });
  assert.equal(r.status, 2);
  assert.match(r.log, /another on-demand run holds/);
  assert.equal(r.requestLeft, true, "the next request was consumed by a start that could not run it");
  assert.deepEqual(r.result, {});
});

// ---------------------------------------------------------------------------
// The build's answer
// ---------------------------------------------------------------------------

test("each build status maps to its own outcome, and the suite never runs after one", () => {
  for (const [buildExit, status, exit] of [[2, "refused", 2], [3, "failed", 3], [7, "failed", 3], [4, "build_failed", 4], [5, "build_failed", 4], [6, "build_failed", 4]]) {
    const r = onDemand({ buildExit, buildOut: "" });
    assert.equal(r.status, exit, `build ${buildExit}: ${r.log}`);
    assert.equal(r.result["req-1"].STATUS, status, `build ${buildExit}`);
    assert.equal(r.env, null, `build ${buildExit}: run-e2e.sh ran`);
    assert.match(r.log, /some refusal line/, "the build's own reason did not reach the log");
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
    for (const port of [7890, 7891, 7892, 7893]) {
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

test("a container that survives removal is reported in the result, not hidden", () => {
  const r = onDemand({ leftover: "langflow-e2e-lane-7891\n" });
  assert.equal(r.result["req-1"].CLEANUP, "incomplete");
  assert.match(r.log, /still present after removal: langflow-e2e-lane-7891/);
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
  for (const other of ["official", "shadow"]) {
    assert.deepEqual(lanes.ondemand.filter((p) => lanes[other].includes(p)), [], `on-demand shares ports with ${other}: ${lanes.ondemand} / ${lanes[other]}`);
  }
  // The cleanup names the containers by port; it must name exactly the ones this lane uses.
  const text = read("ops/vm/run-on-demand.sh");
  const base = num(text, "BASE_PORT");
  assert.match(text, new RegExp(`for port in ${[0, 1, 2, 3].map((i) => base + i).join(" ")}; do`));
  assert.match(text, new RegExp(`ECHO_PORT=${num(text, "ECHO_PORT")} bash scripts/stop-echo-source\\.sh`));
  assert.match(text, /export WORKFLOW_ID=on-demand-stable\b/);
});
