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
// A published version, as the worker writes it: every key, the ref empty.
export const VERSION = "1.13.1rc0";
export const VERSION_REQUEST = `ONDEMAND_ID=req-v\nONDEMAND_REF=\nONDEMAND_VERSION=${VERSION}\nONDEMAND_VERSION_FROM=pypi\nONDEMAND_PROVIDER=anthropic\nONDEMAND_REQUESTED_BY=victor\n`;
// A published image of the version, and the digest the fake registry gives it.
export const IMAGE_REQUEST = VERSION_REQUEST.replace("ONDEMAND_VERSION_FROM=pypi", "ONDEMAND_VERSION_FROM=docker");
export const PULLED_DIGEST = `langflowai/langflow@sha256:${"d".repeat(64)}`;
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
  // The run's model-used line as phase_merge writes it, "<provider>\t<model>" (\t
  // and \n are expanded); null writes none, as a run that never reached its merge.
  modelUsed = null,
  orphans = [],
  termOnConsume = false,
  // The provider pre-check's answer: its exit status and its JSON line; null leaves
  // the script out of the suite commit, as a commit from before it.
  probe = { exit: 0, out: '{"verdict":"usable","reason":"answered"}' },
  // A mirror for the suite ref: an origin holding `new-suite` (the clone's commit plus
  // one) and `old-suite` (a history without the clone's commit), with the clone's
  // commit as SUITE_FLOOR. Off, the clone has no origin, as no default run fetches.
  mirror = false,
  // Whether the suite's run-e2e.sh knows STABLE_AREAS: the executor refuses areas for
  // a suite that does not, which would run the whole @stable instead.
  suiteKnowsAreas = true,
  // The suite running past the run's deadline: timeout answers this status for
  // run-e2e.sh, 124 as coreutils' does once TERM stopped it, 137 once it needed the
  // KILL (after `sleep` seconds, so the deadline has passed); false runs it.
  suiteTimesOut = false,
  suiteTimeoutSleep = 0,
  // The least suite time the executor starts (E2E_ONDEMAND_MIN_SUITE_S); null is its own.
  minSuite = null,
  // The run's deadline in seconds (E2E_ONDEMAND_DEADLINE_S); null is the executor's own.
  deadline = null,
  // A version's install. PyPI answers `pypi` (an HTTP status, with `pypiFiles` as the
  // release's files; null is no answer at all), and scripts/prepare-target-dist.sh
  // exits `distExit`, prints `distOut` (null: what the real one prints for the version
  // it was given) and, failing, `distError` as its ERROR: line.
  pypi = 200,
  pypiFiles = [{ yanked: false }],
  // What PyPI's JSON says of the release: its version (null: the one asked for) and
  // requires_python; and the status for langflow-base and lfx at that version.
  pypiVersion = null,
  pypiRequires = ">=3.10,<3.15",
  siblings = { "langflow-base": 200, lfx: 200 },
  // A Langflow on one of the lane's ports that survives its stop (the stopper exits 1).
  stopFails = false,
  // A published image. Docker Hub answers each repository's tag (an HTTP status; null
  // is no answer); the image may be on the machine before the run; the pull exits
  // pullExit, or runs past its limit; docker names pulledDigest for it after (null:
  // none). Whether the suite can declare a published image (#2270).
  hub = { "langflowai/langflow": 200, "langflowai/langflow-nightly": 404 },
  imagePresent = false,
  pullExit = 0,
  pullTimesOut = false,
  pulledDigest = PULLED_DIGEST,
  // docker rmi of a pulled image failing while the image stays (a daemon hiccup).
  rmiFails = false,
  suiteKnowsImages = true,
  distExit = 0,
  distOut = null,
  distError = null,
  // uv's "No solution found" paragraph on the installer's stderr, as a resolver refusal.
  distNoSolution = false,
  // The install running past its limit: timeout answers this for prepare-target-dist.sh.
  installTimesOut = false,
  // Whether the suite's run-e2e.sh can declare a published version (#2261).
  suiteKnowsVersions = true,
} = {}) {
  const dir = makeTempDir("on-demand-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "ops", "vm"), { recursive: true });
  const envOut = join(dir, "run-e2e.env");
  const buildArgs = join(dir, "build.args");
  const stopLog = join(dir, "stop.log");
  const probeLog = join(dir, "probe.log");
  writeFileSync(
    join(repo, "scripts", "run-e2e.sh"),
    `#!/usr/bin/env bash
${suiteKnowsAreas ? "# knows STABLE_AREAS" : ""}
${suiteKnowsVersions ? "# knows target_is_declared" : ""}
${suiteKnowsImages ? "# knows declared_form" : ""}
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
${modelUsed !== null ? `mkdir -p "$RUNS_ROOT/$RUN_ID" && printf '%b' ${q(modelUsed)} > "$RUNS_ROOT/$RUN_ID/model-used"` : ""}
${verdict.length ? `printf '\\n\\033[1;36m==> %s\\033[0m\\n' Verdict\n${verdict.map((v) => `printf '\\033[1;31m::error:: %s\\033[0m\\n' ${q(v)} >&2`).join("\n")}` : ""}
exit ${runExit}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo, "ops", "vm", "build-target-image.sh"),
    `#!/usr/bin/env bash\necho "$* BUILD_ROOT=$BUILD_ROOT" > ${q(buildArgs)}\necho "$0" > ${q(join(dir, "build.script"))}\necho "fd9=$( { : >&9; } 2>/dev/null && echo open || echo closed)" >> ${q(buildArgs)}\necho "fd8=$( { : >&8; } 2>/dev/null && echo open || echo closed)" >> ${q(buildArgs)}\necho "build-target-image: building something; log: x" >&2\necho "noise from docker" >&2\necho "build-target-image: some refusal line" >&2\necho "::error:: an error line from before the run" >&2\ncat ${q(join(dir, "build.out"))}\nexit ${buildExit}\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "build.out"), buildOut ? `${buildOut}\n` : "");
  if (probe) {
    // What it was asked and with which keys, and whether the build had started yet.
    writeFileSync(
      join(repo, "scripts", "probe-declared-model.mjs"),
      `import { appendFileSync, existsSync, fstatSync, statSync } from "node:fs";
// Whether the fd is THAT lock, by inode: node opens low fds of its own.
const holds = (fd, path) => { try { return fstatSync(fd).ino === statSync(path).ino; } catch { return false; } };
appendFileSync(${q(probeLog)}, JSON.stringify({ script: process.argv[1], args: process.argv.slice(2), cwd: process.cwd(), keys: Object.keys(process.env).filter((k) => /KEY|TOKEN|WEBHOOK/.test(k)).sort(), built: existsSync(${q(buildArgs)}), fd8: holds(8, ${q(join(dir, "heavy.lock"))}), fd9: holds(9, ${q(join(dir, "state", "lock"))}) }) + "\\n");
process.stdout.write(${q(probe.out)} + "\\n");
process.exit(${probe.exit});
`,
    );
  }
  writeFileSync(join(dir, "leftover"), leftover);
  writeFileSync(join(repo, "scripts", "stop-echo-source.sh"), `echo "echo $ECHO_PORT" >> ${q(stopLog)}\n`);
  stub(join(repo, "scripts"), "stop-langflow-source.sh", `echo "langflow $LANGFLOW_PORT" >> ${q(stopLog)}${stopFails ? '\n[ "$LANGFLOW_PORT" = 7911 ] && { echo "ERROR: PID 1 survived SIGKILL; port 7911 may still be bound." >&2; exit 1; }' : ""}`);
  // The executor reads PyPI's answer with the clone's own module: the real one.
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  writeFileSync(join(repo, "scripts", "lib", "pypi-release.mjs"), readFileSync(join(ROOT, "scripts", "lib", "pypi-release.mjs")));
  const distLog = join(dir, "dist.log");
  // The installer: what it was given, and a venv with a langflow in it, as the real one.
  stub(
    join(repo, "scripts"),
    "prepare-target-dist.sh",
    `echo "TARGET_VERSION=$TARGET_VERSION LANGFLOW_DIST_VENV=$LANGFLOW_DIST_VENV LANGFLOW_DIST_PIN=$LANGFLOW_DIST_PIN LANGFLOW_DIST_PYTHON=$LANGFLOW_DIST_PYTHON script=$0" > ${q(distLog)}
echo "LANGFLOW_DIST_PRERELEASE=$LANGFLOW_DIST_PRERELEASE" >> ${q(distLog)}
echo "fd9=$( { : >&9; } 2>/dev/null && echo open || echo closed) fd8=$( { : >&8; } 2>/dev/null && echo open || echo closed)" >> ${q(distLog)}
echo "target: langflow==$TARGET_VERSION" >&2
${distExit === 0 ? `mkdir -p "$LANGFLOW_DIST_VENV/bin" "$LANGFLOW_DIST_VENV/lib/langflow/frontend" && printf '#!/bin/sh\n' > "$LANGFLOW_DIST_VENV/bin/langflow" && chmod +x "$LANGFLOW_DIST_VENV/bin/langflow"` : ""}
${distNoSolution ? `printf '  x No solution found when resolving dependencies:\\n  -> Because lfx==1.13.1rc0 depends on langflow-sdk==9.9 and it does not exist,\\n      we can conclude that your requirements are unsatisfiable.\\n' >&2` : ""}
${distError ? `echo ${q(`ERROR: ${distError}`)} >&2
echo "the second line of its reason" >&2` : ""}
${distOut === null ? `printf 'prepared_version=%s\nprepared_base_version=%s\nvenv=%s\npython=3.14\nfrontend_dir=%s\ninstall_s=95\ntotal_s=97\n' "$TARGET_VERSION" "$TARGET_VERSION" "$LANGFLOW_DIST_VENV" "$LANGFLOW_DIST_VENV/lib/langflow/frontend"` : `printf '%b\n' ${q(distOut)}`}
exit ${distExit}`,
  );
  writeFileSync(join(repo, "scripts", "stop-ollama-source.sh"), `echo "ollama $OLLAMA_PORT" >> ${q(stopLog)}\n`);
  const git = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "suite");
  const head = git("rev-parse", "HEAD");
  const suites = {};
  if (mirror) {
    const origin = join(dir, "origin.git");
    execFileSync(REAL_GIT, ["init", "-q", "--bare", origin]);
    git("remote", "add", "origin", origin);
    const id = ["-c", "user.email=t@example.invalid", "-c", "user.name=t"];
    git("checkout", "-q", "-b", "new-suite");
    writeFileSync(join(repo, "NEW_SUITE"), "1\n");
    git(...id, "add", "NEW_SUITE");
    git(...id, "commit", "-qm", "a newer suite");
    suites["new-suite"] = git("rev-parse", "HEAD");
    // An annotated tag of it: fetched, it is a tag object, and the run needs the commit.
    git(...id, "tag", "-a", "-m", "a suite tag", "suite-tag");
    git("checkout", "-q", "--orphan", "old-suite");
    git(...id, "commit", "-qm", "a suite older than the floor");
    suites["old-suite"] = git("rev-parse", "HEAD");
    git("push", "-q", "origin", "new-suite", "old-suite", "refs/tags/suite-tag");
    // Back on the clone's commit, with the two branches gone from the clone itself:
    // the executor must find them on the mirror, not locally.
    git("checkout", "-q", "-f", "-");
    git("branch", "-q", "-D", "new-suite", "old-suite");
    // The push left tracking refs; the real clone has none for these, and a test
    // checks the executor's fetch writes none.
    for (const b of ["new-suite", "old-suite"]) git("update-ref", "-d", `refs/remotes/origin/${b}`);
  }
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
  pull) touch ${q(join(dir, "image-pulled"))}; exit ${pullExit} ;;
  rmi) ${rmiFails ? 'case "$2" in langflowai/*) exit 1 ;; esac' : ""} ;;
  image)
    here=1; { [ -e ${q(join(dir, "image-pulled"))} ] || ${imagePresent ? "true" : "false"}; } || here=0
    # The digest docker names for the tag, in the tag's own repository.
    if [ "$3" = --format ]; then [ "$here" = 1 ] && ${pulledDigest === null ? ":" : `printf '%s@%s\\n' "\${5%%:*}" ${q(pulledDigest.split("@")[1])}`}; exit 0; fi
    [ "$here" = 1 ]; exit $? ;;
esac
exit 0`);
  const stateCases = Object.entries(states).map(([u, s]) => `  *${u}*) echo ${q(s)} ;;`).join("\n");
  stub(bin, "systemctl", `echo "$*" >> ${q(systemctlLog)}
case "$*" in
${stateCases}
  *) echo inactive ;;
esac`);
  // fd 8 is the heavy-lane lock shared with the routines, fd 9 this lane's own.
  // coreutils' timeout, which the VM has and macOS does not: runs the command as is.
  stub(bin, "timeout", `k=""; [ "$1" = "-k" ] && { k=" -k $2"; shift 2; }\necho "$1 $2 $3$k" >> ${q(join(dir, "timeout.log"))}\nshift\n${suiteTimesOut ? `case "$1" in *run-e2e.sh) sleep ${suiteTimeoutSleep}; exit ${suiteTimesOut === true ? 124 : suiteTimesOut} ;; esac\n` : ""}${installTimesOut ? `case "$1" in *prepare-target-dist.sh) exit ${installTimesOut === true ? 124 : installTimesOut} ;; esac\n` : ""}${pullTimesOut ? `case "$1 $2" in "docker pull") exit ${pullTimesOut === true ? 124 : pullTimesOut} ;; esac\n` : ""}exec "$@"`);
  stub(bin, "flock", `case "$*" in *8) exit ${heavyBusy ? 1 : 0} ;; *) exit ${lockBusy ? 1 : 0} ;; esac`);
  // PyPI's JSON API: the URL asked, then the status, with the release's files as the body.
  const pypiLog = join(dir, "pypi.log");
  stub(bin, "curl", `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$url" >> ${q(pypiLog)}
case "$url" in
  */repositories/langflowai/langflow-nightly/tags/*) ${hub["langflowai/langflow-nightly"] === null ? "exit 7" : `printf '%s' ${hub["langflowai/langflow-nightly"]}; exit 0`} ;;
  */repositories/langflowai/langflow/tags/*) ${hub["langflowai/langflow"] === null ? "exit 7" : `printf '%s' ${hub["langflowai/langflow"]}; exit 0`} ;;
esac
${pypi === null ? "exit 7" : ""}
case "$url" in
  */langflow-base/*) printf '%s' ${siblings["langflow-base"]} ;;
  */lfx/*) printf '%s' ${siblings.lfx} ;;
  */langflow/*)
    v="\${url%/json}"; v="\${v##*/}"
    [ "$out" != /dev/null ] && [ -n "$out" ] && printf '{"info":{"version":"%s","requires_python":%s},"urls":%s}' "${pypiVersion ?? "$v"}" ${q(JSON.stringify(pypiRequires))} ${q(JSON.stringify(pypiFiles))} > "$out"
    printf '%s' ${pypi} ;;
esac`);
  // The daily's `systemctl stop` landing the instant the request leaves the slot: mv
  // does the move, then signals the script that ran it.
  if (termOnConsume) stub(bin, "mv", `/bin/mv "$@"; rc=$?\ncase "$*" in *"/request.env "*) kill -TERM $PPID ;; esac\nexit $rc`);

  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, [...PUBLISHING.map((n) => `export ${n}=secret-${n}`), "export GH_ENTERPRISE_TOKEN=ghe", "export OPENAI_API_KEY=provider-key", "ANTHROPIC_API_KEY=unexported-provider-key"].join("\n") + "\n");

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
    ...(mirror ? { E2E_ONDEMAND_SUITE_FLOOR: head } : {}),
    ...(deadline !== null ? { E2E_ONDEMAND_DEADLINE_S: String(deadline) } : {}),
    ...(minSuite !== null ? { E2E_ONDEMAND_MIN_SUITE_S: String(minSuite) } : {}),
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
      probes: (readIf(probeLog) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
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
      suites,
      buildScript: readIf(join(dir, "build.script"))?.trim() ?? null,
      laneRef: (() => { try { return git("rev-parse", "--verify", "-q", "refs/on-demand/suite"); } catch { return null; } })(),
      cloneHead: git("rev-parse", "HEAD"),
      remoteRefs: git("for-each-ref", "--format=%(refname)", "refs/remotes"),
      timeouts: readIf(join(dir, "timeout.log")) ?? "",
      dist: readIf(distLog),
      pypiAsked: (readIf(pypiLog) ?? "").split("\n").filter(Boolean),
      venvLeft: existsSync(join(state, "venv")),
      pulledLeft: existsSync(join(state, "pulled-image")),
    };
  };
  return { env, collect };
}

export const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
