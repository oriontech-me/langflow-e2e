// Unit tests for the image shadow (#2093): ops/vm/request-shadow.sh, which the daily
// calls to ask for it, and ops/vm/run-shadow.sh, which e2e-shadow.service runs.
// Run with: npm run test:scripts
//
// The shadow's happy path needs the machine -- docker, the image, four backends -- and
// is exercised there. What these pin is what the machine would not report: a shadow
// that could publish, a shadow on the official lane's ports or ledger, a shadow that
// ran another day's request or another suite, and a request that could fail the daily.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST = join(ROOT, "ops", "vm", "request-shadow.sh");
const SHADOW = join(ROOT, "ops", "vm", "run-shadow.sh");
const DAILY = join(ROOT, "ops", "vm", "run-daily.sh");
const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const TODAY = new Date().toISOString().slice(0, 10);
const SHA = "a".repeat(40);
const PUBLISHING = ["SOURCE_PUSH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "QA_E2E_AUTOMATION_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SLACK_WEBHOOK_URL"];

const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

// ---------------------------------------------------------------------------
// request-shadow.sh
// ---------------------------------------------------------------------------

function request({ version = "1.13.0.dev26", sha = SHA, installed = true, startFails = false } = {}) {
  const dir = makeTempDir("shadow-request-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "systemctl.log");
  stub(bin, "systemctl", `echo "$*" >> ${JSON.stringify(calls)}
case "$1" in
  cat) ${installed ? "exit 0" : "exit 1"} ;;
  start) ${startFails ? "exit 1" : "exit 0"} ;;
esac`);
  const state = join(dir, "state");
  const r = spawnSync("bash", [REQUEST], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, E2E_SHADOW_STATE: state, SHADOW_VERSION: version, SHADOW_SUITE_SHA: sha },
  });
  const out = {
    status: r.status,
    stdout: r.stdout,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    request: existsSync(join(state, "request.env")) ? readFileSync(join(state, "request.env"), "utf8") : null,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("the request names today, the version and the suite commit, and queues the unit without waiting", () => {
  const r = request();
  assert.equal(r.status, 0);
  assert.equal(r.request, `SHADOW_DATE=${TODAY}\nSHADOW_VERSION=1.13.0.dev26\nSHADOW_SUITE_SHA=${SHA}\n`);
  assert.ok(r.calls.includes("start --no-block e2e-shadow.service"), `calls: ${r.calls}`);
  assert.match(r.stdout, /shadow: requested for 1\.13\.0\.dev26 at aaaaaaaaaaaa/);
});

test("a request that cannot be made asks for nothing and still exits 0", () => {
  // The daily ignores the status anyway; this pins that nothing half-written is left
  // for a shadow to read, and that each refusal says why in the daily's log.
  for (const [opts, why] of [
    [{ version: "" }, /no usable version/],
    [{ version: "1.13; rm -rf /" }, /no usable version/],
    [{ sha: "abc123" }, /no full suite commit/],
    [{ installed: false }, /is not installed/],
  ]) {
    const r = request(opts);
    assert.equal(r.status, 0, JSON.stringify(opts));
    assert.equal(r.request, null, `${JSON.stringify(opts)}: a request was written`);
    assert.ok(!r.calls.some((c) => c.startsWith("start")), `${JSON.stringify(opts)}: the unit was started`);
    assert.match(r.stdout, why);
  }
});

test("a unit that does not start is said, and the daily is still not failed", () => {
  const r = request({ startFails: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /did not start/);
});

// ---------------------------------------------------------------------------
// run-shadow.sh
// ---------------------------------------------------------------------------

/**
 * A clone whose one commit carries stub run-e2e / comparator / backup scripts, a HOME
 * whose ~/.local/bin shadows docker, and a secrets file that holds every publishing
 * credential. The run-e2e stub records the environment it was given and exits 3, so
 * the test reads what the real run would have received and that its status is kept.
 */
function shadow({ date = TODAY, sha = null, version = "1.13.0.dev26", noRequest = false, bogusWorktree = false, repoEnv = false } = {}) {
  const dir = makeTempDir("shadow-run-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const envOut = join(dir, "run-e2e.env");
  const cmpOut = join(dir, "compare.log");
  const bakOut = join(dir, "backup.env");
  writeFileSync(join(repo, "scripts", "run-e2e.sh"), `#!/usr/bin/env bash\nenv | sort > ${JSON.stringify(envOut)}\necho "cwd=$PWD head=$(git rev-parse HEAD)" >> ${JSON.stringify(envOut)}\necho "dotenv=$(readlink .env || echo none)" >> ${JSON.stringify(envOut)}\nexit 3\n`, { mode: 0o755 });
  writeFileSync(join(repo, "scripts", "compare-lane-verdicts.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(cmpOut)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  writeFileSync(join(repo, "scripts", "backup-ledger.sh"), `#!/usr/bin/env bash\necho "LEDGER_DIR=$LEDGER_DIR BACKUP_DEST=$BACKUP_DEST" > ${JSON.stringify(bakOut)}\n`, { mode: 0o755 });
  const git = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "suite");
  const head = git("rev-parse", "HEAD");
  // Untracked, as on the machine: the clone's .env is never committed.
  if (repoEnv) writeFileSync(join(repo, ".env"), "SOME_PROVIDER_API_KEY=from-dotenv\n");

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  stub(bin, "docker", `echo "docker $*" >> ${JSON.stringify(join(dir, "docker.log"))}`);

  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, [...PUBLISHING.map((n) => `export ${n}=secret-${n}`), "export OPENAI_API_KEY=provider-key"].join("\n") + "\n");
  const lane = join(dir, "lane.env");
  writeFileSync(lane, "BACKUP_DEST=local:/backups/ledger\n");

  const state = join(dir, "state");
  mkdirSync(state);
  // A directory that is not a worktree of the clone, as a clone rebuilt under it leaves.
  if (bogusWorktree) {
    mkdirSync(join(state, "wt"));
    writeFileSync(join(state, "wt", "leftover.txt"), "from an older clone\n");
  }
  if (!noRequest) {
    writeFileSync(join(state, "request.env"), `SHADOW_DATE=${date}\nSHADOW_VERSION=${version}\nSHADOW_SUITE_SHA=${sha ?? head}\n`);
  }
  const logs = join(dir, "logs");
  const ledger = join(dir, "shadow-ledger");
  const r = spawnSync("bash", [SHADOW], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      E2E_SHADOW_REPO: repo,
      E2E_SHADOW_STATE: state,
      E2E_SHADOW_LOG_DIR: logs,
      E2E_SHADOW_SECRETS: secrets,
      E2E_SHADOW_LANE: lane,
      E2E_SHADOW_LEDGER: ledger,
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const out = {
    status: r.status,
    head,
    ledger,
    state,
    log: readIf(join(logs, "latest.log")) ?? "",
    env: readIf(envOut),
    compare: readIf(cmpOut),
    backup: readIf(bakOut),
    requestLeft: existsSync(join(state, "request.env")),
    hosts: readIf(join(state, "hosts")),
    repo,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const envOf = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

test("the shadow's containers resolve localhost to both loopbacks, as on a host with IPv6 (#2159)", () => {
  const r = shadow();
  assert.ok(r.env, `run-e2e.sh was not reached:\n${r.log}`);
  const e = envOf(r.env);
  assert.equal(e.LANGFLOW_HOSTS_FILE, join(r.state, "hosts"));
  assert.match(r.hosts, /^127\.0\.0\.1\tlocalhost$/m);
  assert.match(r.hosts, /^::1\tlocalhost( |$)/m);
});

test("the shadow runs the image of the requested version, isolated, with every publisher off", () => {
  const r = shadow();
  assert.ok(r.env, `run-e2e.sh was not reached:\n${r.log}`);
  const e = envOf(r.env);
  assert.equal(e.TARGET_SSH, "local");
  assert.equal(e.TARGET_KIND, "image");
  assert.equal(e.LANGFLOW_IMAGE, "langflowai/langflow-nightly:1.13.0.dev26");
  assert.equal(e.WORKFLOW_ID, "daily-stable-vm-image");
  assert.equal(e.LEDGER_DIR, r.ledger);
  assert.equal(e.RUNS_ROOT, join(r.state, "runs"));
  for (const k of ["CREATE_ISSUE", "AUTO_REMOVE", "NOTIFY_SLACK", "NOTIFY_SLACK_ALWAYS", "POST_QA_PLATFORM", "CHECK_MIRROR"]) {
    assert.equal(e[k], "0", `${k} is not off`);
  }
  for (const k of ["LANGFLOW_SRC_RUN_CMD", "LANGFLOW_SRC_FRONTEND_DIR", "TARGET_VENV", "PREPARE_TARGET"]) {
    assert.ok(!(k in e), `${k} reached an image run`);
  }
});

test("the publishing credentials never reach the shadow's run, and the provider keys do", () => {
  // Unset, not only switched off: a switch flipped by mistake must then fail for want
  // of a credential instead of publishing for a run with no consequence.
  const e = envOf(shadow().env);
  for (const k of PUBLISHING) assert.ok(!(k in e), `${k} reached the shadow`);
  assert.equal(e.OPENAI_API_KEY, "provider-key");
});

test("the shadow runs the official run's commit, in its own worktree, and keeps its exit status", () => {
  const r = shadow();
  const e = envOf(r.env);
  const [, cwd, head] = r.env.match(/cwd=(\S+) head=(\S+)/);
  assert.equal(head, r.head);
  assert.equal(cwd, join(r.state, "wt"), "the suite ran somewhere other than the shadow's own worktree");
  assert.equal(r.status, 3, "the run's status must be the unit's");
  assert.ok(e);
});

test("both comparisons are recorded, with the pairs named for what they compare", () => {
  const r = shadow();
  const lines = r.compare.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`--date ${TODAY} --ci-workflow daily-stable-vm --ci-label VM\\+wheel --vm-workflow daily-stable-vm-image --vm-label VM\\+image`));
  assert.match(lines[1], /--ci-workflow daily-stable --ci-label Actions\+image --vm-workflow daily-stable-vm-image --vm-label VM\+image/);
  assert.match(lines[0], new RegExp(`--history ${r.ledger}/daily-history\\.jsonl`));
});

test("the shadow's ledger is backed up beside the official one, never into it", () => {
  const r = shadow();
  assert.equal(r.backup.trim(), `LEDGER_DIR=${r.ledger} BACKUP_DEST=local:/backups/ledger-shadow`);
});

test("the shadow refuses a missing, stale or malformed request, before anything runs", () => {
  for (const [opts, why] of [
    [{ noRequest: true }, /no request at/],
    [{ date: "2026-01-01" }, /not today/],
    [{ sha: "abc" }, /no full suite commit/],
    [{ version: "" }, /no usable version/],
  ]) {
    const r = shadow(opts);
    assert.equal(r.status, 1, JSON.stringify(opts));
    assert.match(r.log, why, JSON.stringify(opts));
    assert.equal(r.env, null, `${JSON.stringify(opts)}: run-e2e.sh ran`);
  }
});

test("a request is consumed when it is read, so a second start does not re-measure the day", () => {
  const r = shadow();
  assert.equal(r.requestLeft, false);
});

// ---------------------------------------------------------------------------
// The two lanes share nothing a run owns
// ---------------------------------------------------------------------------

test("the shadow's ports, ledger and workflow are disjoint from the official lane's", () => {
  // There is no lock between the lanes and each run's hygiene clears only its own kind
  // (#2089), so disjoint ports are what keep a killed run's leftovers off the other lane.
  const read = (p) => readFileSync(p, "utf8");
  const num = (text, key, fallback) => {
    const m = text.match(new RegExp(`\\b${key}=(\\d+)`));
    return m ? Number(m[1]) : fallback;
  };
  const daily = read(DAILY);
  const shadowText = read(SHADOW);
  // The official lane leaves echo and ollama at run-e2e.sh's defaults.
  const runE2e = read(join(ROOT, "scripts", "run-e2e.sh"));
  const dflt = (key) => Number(runE2e.match(new RegExp(`^${key}="\\$\\{${key}:-(\\d+)\\}"`, "m"))[1]);
  const ports = (text, fb) => {
    const base = num(text, "BASE_PORT", fb.BASE_PORT);
    const shards = num(text, "SHARDS", fb.SHARDS);
    return [...Array.from({ length: shards }, (_, i) => base + i), num(text, "ECHO_PORT", fb.ECHO_PORT), num(text, "OLLAMA_PORT", fb.OLLAMA_PORT)];
  };
  const fb = { BASE_PORT: dflt("BASE_PORT"), SHARDS: dflt("SHARDS"), ECHO_PORT: dflt("ECHO_PORT"), OLLAMA_PORT: dflt("OLLAMA_PORT") };
  const official = ports(daily, fb);
  const theShadow = ports(shadowText, fb);
  assert.deepEqual(official.filter((p) => theShadow.includes(p)), [], `shared ports: official ${official}, shadow ${theShadow}`);
  assert.match(shadowText, /export WORKFLOW_ID=daily-stable-vm-image\b/);
  assert.doesNotMatch(daily, /WORKFLOW_ID=/, "the official lane must keep run-e2e.sh's default id");
  assert.match(shadowText, /langflow-e2e-shadow\}/, "the shadow's ledger is not its own directory");
});

// ---------------------------------------------------------------------------
// The daily's side of it
// ---------------------------------------------------------------------------

test("the daily asks for the shadow after its own run and backup, and never lets it change its status", () => {
  const daily = readFileSync(DAILY, "utf8");
  const at = (s) => {
    const i = daily.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  const sha = at('SUITE_SHA="$(git rev-parse HEAD)"');
  const run = at("./scripts/run-e2e.sh\n");
  const backup = at("./scripts/backup-ledger.sh || true");
  const ask = at('SHADOW_VERSION="$WANT" SHADOW_SUITE_SHA="$SUITE_SHA" ./ops/vm/request-shadow.sh || true');
  const ret = at('return "$code"');
  assert.ok(sha < run, "the suite commit must be read before the run moves HEAD");
  assert.ok(run < backup && backup < ask && ask < ret, "the shadow must be asked for after the run and the backup, before the return");
  assert.match(daily, /if \[ "\$\{IMAGE_SHADOW:-1\}" = "1" \] && \[ "\$\{DRY_RUN:-0\}" != "1" \]; then/);
});

// ---------------------------------------------------------------------------
// #2094 review
// ---------------------------------------------------------------------------

test("a directory that is not the clone's worktree is replaced, not a FATAL every weekday", () => {
  const r = shadow({ bogusWorktree: true });
  assert.ok(r.env, `run-e2e.sh was not reached:\n${r.log}`);
  assert.match(r.log, /is not a worktree of .* removing it and creating it again/);
  const [, , head] = r.env.match(/cwd=(\S+) head=(\S+)/);
  assert.equal(head, r.head);
});

test("the shadow reads the clone's .env when there is one, and none when there is none", () => {
  // The provider keys that decide which spec files enter the suite come from the
  // working copy's .env; a worktree has none of its own.
  const linked = shadow({ repoEnv: true });
  assert.equal(linked.env.match(/dotenv=(\S+)/)[1], join(linked.repo, ".env"));
  const none = shadow();
  assert.equal(none.env.match(/dotenv=(\S+)/)[1], "none");
});

test("gh's stored login cannot reach the shadow's run either", () => {
  // Without a token the issue creator falls back to `gh issue create`, which uses the
  // login under ~/.config/gh or GH_ENTERPRISE_TOKEN; unsetting the tokens alone left
  // that path open behind CREATE_ISSUE=0.
  const r = shadow();
  const e = envOf(r.env);
  assert.equal(e.GH_CONFIG_DIR, join(r.state, "no-gh-login"));
  assert.ok(!("GH_ENTERPRISE_TOKEN" in e));
  assert.ok(!("GITHUB_ENTERPRISE_TOKEN" in e));
});

test("the official lane stops an active shadow before it runs, and only an active one", () => {
  // No lock between the lanes: a daily re-run by hand while the shadow is still going
  // would otherwise run two suites at once, with the verdict that matters absorbing it.
  const daily = readFileSync(DAILY, "utf8");
  const stop = daily.indexOf("systemctl stop e2e-shadow.service");
  assert.ok(stop > 0, "the daily does not stop the shadow");
  assert.ok(stop < daily.indexOf("./scripts/run-e2e.sh\n"), "the shadow must be stopped before the official run");
  const block = daily.slice(daily.lastIndexOf("case ", stop), stop);
  // The behaviour, state by state, is run-daily-wrapper.test.mjs's; this pins placement.
  assert.match(block, /case "\$shadow_state" in/);
  assert.match(daily, /systemctl stop e2e-shadow\.service \|\| echo "WARNING/, "a failed stop must not end the daily");
});
