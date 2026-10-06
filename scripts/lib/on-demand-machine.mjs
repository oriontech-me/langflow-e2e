// The machine run-on-demand.sh expects, faked: a clone whose one commit carries stub
// build, run-e2e and stop scripts, and a HOME whose ~/.local/bin shadows docker,
// systemctl and flock. Shared by the executor's tests and the worker's, so the worker
// is exercised against the real executor rather than a copy of what it writes.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./tmp-dir.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ONDEMAND = join(ROOT, "ops", "vm", "run-on-demand.sh");
export const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
export const TARGET_SHA = "b".repeat(40);
export const IMAGE = `langflow-ondemand:${"b".repeat(12)}`;
export const PUBLISHING = ["SOURCE_PUSH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "QA_E2E_AUTOMATION_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SLACK_WEBHOOK_URL"];
export const GOOD_REQUEST = "ONDEMAND_ID=req-1\nONDEMAND_REF=release-1.13.0\nONDEMAND_PROVIDER=anthropic\nONDEMAND_REQUESTED_BY=victor\n";
// A Wednesday afternoon: outside the daily's window.
export const OPEN = "3 1500";

export const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
export const q = JSON.stringify;

/**
 * A clone whose one commit carries stub build, run-e2e and stop scripts, and a HOME
 * whose ~/.local/bin shadows docker, systemctl and flock. The run-e2e stub records the
 * environment it was given and appends a row to the ledger it was pointed at; the build
 * stub prints what the real one prints. Each knob is one way the machine can answer.
 */
export function setup({
  request = GOOD_REQUEST,
  now = OPEN,
  states = {},
  lockBusy = false,
  heavyBusy = false,
  buildExit = 0,
  buildOut = `target_ref=release-1.13.0\ntarget_sha=${TARGET_SHA}\ntarget_version=1.13.0\nimage=${IMAGE}\nbuild_s=300`,
  runExit = 0,
  writeResults = true,
  runSleep = 0,
  leftover = "",
  shadowRequest = false,
  answered = null,
  psFails = false,
  shadowDate = null,
  leftovers = false,
  verdict = [],
  preError = null,
  modelRefused = null,
  orphans = [],
  termOnConsume = false,
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
echo "fd8=$( { : >&8; } 2>/dev/null && echo open || echo closed)" >> ${q(envOut)}
echo "ledger_seen=$(cat "$LEDGER_DIR/daily-history.jsonl" 2>/dev/null | tr -d '\n')" >> ${q(envOut)}
echo '{"row":"on-demand"}' >> "$LEDGER_DIR/daily-history.jsonl"
sleep ${runSleep}
${preError ? `printf '\\033[1;31m::error:: %s\\033[0m\\n' ${q(preError)} >&2` : ""}
${writeResults ? 'mkdir -p "$RUNS_ROOT/$RUN_ID" && echo "{}" > "$RUNS_ROOT/$RUN_ID/results.json"' : ""}
${modelRefused ? `mkdir -p "$RUNS_ROOT/$RUN_ID/logs" && echo ${q(modelRefused)} > "$RUNS_ROOT/$RUN_ID/logs/shard-2.model-refused"` : ""}
${verdict.length ? `printf '\\n\\033[1;36m==> %s\\033[0m\\n' Verdict\n${verdict.map((v) => `printf '\\033[1;31m::error:: %s\\033[0m\\n' ${q(v)} >&2`).join("\n")}` : ""}
exit ${runExit}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo, "ops", "vm", "build-target-image.sh"),
    `#!/usr/bin/env bash\necho "$* BUILD_ROOT=$BUILD_ROOT" > ${q(buildArgs)}\necho "fd9=$( { : >&9; } 2>/dev/null && echo open || echo closed)" >> ${q(buildArgs)}\necho "fd8=$( { : >&8; } 2>/dev/null && echo open || echo closed)" >> ${q(buildArgs)}\necho "build-target-image: building something; log: x" >&2\necho "noise from docker" >&2\necho "build-target-image: some refusal line" >&2\necho "::error:: an error line from before the run" >&2\ncat ${q(join(dir, "build.out"))}\nexit ${buildExit}\n`,
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
  ps) ${psFails ? "exit 1" : `cat ${q(join(dir, "leftover"))}`} ;;
  builder) cp "$E2E_ONDEMAND_STATE"/results/*.env ${q(dir)}/at-prune.env 2>/dev/null ;;
esac
exit 0`);
  const stateCases = Object.entries(states).map(([u, s]) => `  *${u}*) echo ${q(s)} ;;`).join("\n");
  stub(bin, "systemctl", `echo "$*" >> ${q(systemctlLog)}
case "$*" in
${stateCases}
  *) echo inactive ;;
esac`);
  // fd 8 is the heavy-lane lock shared with the routines, fd 9 this lane's own.
  stub(bin, "flock", `case "$*" in *8) exit ${heavyBusy ? 1 : 0} ;; *) exit ${lockBusy ? 1 : 0} ;; esac`);
  // The daily's `systemctl stop` landing the instant the request leaves the slot: mv
  // does the move, then signals the script that ran it.
  if (termOnConsume) stub(bin, "mv", `/bin/mv "$@"; rc=$?\ncase "$*" in *"/request.env "*) kill -TERM $PPID ;; esac\nexit $rc`);

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
  if (shadowRequest) writeFileSync(join(shadowState, "request.env"), `SHADOW_DATE=${shadowDate ?? new Date().toISOString().slice(0, 10)}\nSHADOW_VERSION=1\n`);
  if (orphans.length) {
    mkdirSync(join(state, "requests"), { recursive: true });
    writeFileSync(join(state, "requests", "unparsed-20260101T000000Z-1.env"), "ONDEMAND_ID=../x\n");
  }
  for (const [id, answered] of orphans) {
    mkdirSync(join(state, "requests"), { recursive: true });
    writeFileSync(join(state, "requests", `${id}.env`), `ONDEMAND_ID=${id}\nONDEMAND_REF=x\n`);
    if (answered) writeFileSync(join(state, "results", `${id}.env`), "STATUS=done\nORIGINAL=1\n");
  }
  if (leftovers) {
    mkdirSync(join(state, "builds", "src-aaaaaaaaaaaa-XYZ"), { recursive: true });
    mkdirSync(join(state, "ledger-killed-run"), { recursive: true });
  }

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
    E2E_HEAVY_LOCK: join(dir, "heavy.lock"),
  };
  const collect = (status) => {
    const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    const results = readdirSync(join(state, "results")).filter((f) => f.endsWith(".env"));
    return {
      status,
      head,
      repo,
      state,
      atPrune: readIf(join(dir, "at-prune.env")),
      allLogs: existsSync(join(dir, "logs")) ? readdirSync(join(dir, "logs")).filter((f) => f !== "latest.log").map((f) => readFileSync(join(dir, "logs", f), "utf8")).join("") : "",
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
      hosts: readIf(join(state, "hosts")),
      ledgers: readdirSync(state).filter((f) => f.startsWith("ledger-")),
      worktrees: git("worktree", "list"),
      heavyHolder: readIf(join(dir, "heavy.lock.holder")),
    };
  };
  return { env, collect };
}

export const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
