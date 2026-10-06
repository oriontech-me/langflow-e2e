// Unit tests for ops/vm/run-migration.sh, the migration routine (stage 3, task 5).
// Run with: npm run test:scripts
//
// The cells need the machine -- Langflow installs, containers, an ollama -- and are
// exercised there. What these pin is what a day on the machine would not show: how the
// cells add up to the routine's verdict, which failures are the product's and which the
// machine's, the #15326 note, the "red set changed" line inside an open issue, the target
// and the refusals. The machine is faked: uv, curl, docker and pkill are stubs, and
// ops/vm/migration/cell.py is replaced by a script that answers from a table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const q = JSON.stringify;
const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const kv = (text) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PYPI = { releases: { "1.12.3": [{ yanked: false }], "1.12.4": [{ yanked: false }], "1.13.0.dev33": [{ yanked: false }] } };
const ALL = [
  "sqlite-pip-fresh", "sqlite-pip-upgrade", "sqlite-pip-upgrade-autologin-off",
  "sqlite-docker-fresh", "sqlite-docker-upgrade", "sqlite-docker-upgrade-autologin-off",
  "postgres-pip-fresh", "postgres-pip-upgrade", "postgres-pip-upgrade-autologin-off",
  "postgres-docker-fresh", "postgres-docker-upgrade", "postgres-docker-upgrade-autologin-off",
];

/**
 * verify: { cell: "green" | "red:<check>" | "blocked" | "down" }   (default green)
 * install: { version: exitCode }   uv pip install outcome per version
 * seed:    { cell: exitCode }
 */
function migration({ target = "1.13.0.dev33", daily = null, dailyRuns = null, cells = "all", verify = {}, install = {}, installedBase = {}, seed = {}, previous = null, pypi = PYPI, healthDown = [] } = {}) {
  const dir = makeTempDir("run-migration-");
  const repo = join(dir, "repo");
  for (const rel of ["ops/vm/lib/routine.sh", "ops/vm/run-migration.sh", "scripts/resolve-migration-pair.mjs"]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(repo, rel));
  }
  mkdirSync(join(repo, "ops/vm/migration"), { recursive: true });
  mkdirSync(join(repo, "tests/github-workflows/migration"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts/start-ollama-source.sh"), "echo OLLAMA_HOST_IP=10.0.0.9\necho OLLAMA_PORT=$OLLAMA_PORT\n");
  writeFileSync(join(repo, "scripts/stop-ollama-source.sh"), `echo "stop $OLLAMA_PORT" >> ${q(join(dir, "ollama.log"))}\n`);
  writeFileSync(join(repo, "tests/github-workflows/migration/provider_credentials.py"), "import sys; sys.exit(0)\n");
  // The cell stub: seed writes a state file; verify answers from the table, by the port
  // the cell was given (7920 + index, in the wrapper's order).
  const table = Object.fromEntries(ALL.map((c, i) => [7920 + i, verify[c] ?? "green"]));
  const seeds = Object.fromEntries(ALL.map((c, i) => [7920 + i, seed[c] ?? 0]));
  writeFileSync(
    join(repo, "ops/vm/migration/cell.py"),
    `import sys, json, re
args = sys.argv[1:]
port = int(re.search(r":(\\d+)$", args[args.index("--url") + 1]).group(1))
state = args[args.index("--state") + 1]
login = args[args.index("--login") + 1] if "--login" in args else "auto"
import os
leaked = [k for k in ("GH_TOKEN", "GITHUB_TOKEN", "SOURCE_PUSH_TOKEN", "SLACK_WEBHOOK_URL") if os.environ.get(k)]
open(${q(join(dir, "calls.log"))}, "a").write(f"{args[0]} {port} {login} leaked={','.join(leaked)}\\n")
if args[0] == "seed":
    rc = ${q(seeds)}[str(port)]
    if rc: print("SEED fail boom"); sys.exit(rc)
    open(state, "w").write("{}"); print("SEED ok"); sys.exit(0)
v = ${q(table)}[str(port)]
if v == "down": print("CHECK reachable fail gone"); sys.exit(3)
print("CHECK projects pass kept")
if v.startswith("red:"): print(f"CHECK {v[4:]} fail lost"); sys.exit(1)
if v == "blocked": print("CHECK credential blocked probe says billing"); sys.exit(0)
print("CHECK credential pass ok"); sys.exit(0)
`,
  );

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const pypiFile = join(dir, "pypi.json");
  writeFileSync(pypiFile, JSON.stringify(pypi));
  // uv: `venv` makes a venv whose langflow sleeps; `pip install` answers per version.
  const installCases = Object.entries(install).map(([v, rc]) => `  *"==${v}"*) rc=${rc} ;;`).join("\n");
  // A venv whose python answers the langflow-base version uv "installed" (or a forced
  // one), and whose langflow records its environment and serves that version on its port.
  const served = join(dir, "served");
  mkdirSync(served);
  const baseCases = Object.entries(installedBase).map(([v, b]) => `  *"==${v}"*) inst=${q(b)} ;;`).join("\n");
  stub(bin, "uv", `echo "$*" >> ${q(join(dir, "uv.log"))}
case "$1" in
  venv) v="\${@: -1}"; mkdir -p "$v/bin"
    printf '#!/usr/bin/env bash\\ncat "%s/installed"\\n' "$v" > "$v/bin/python"
    printf '#!/usr/bin/env bash\\nenv | sort > %s/langflow-env.$$\\nport=$(echo "$*" | sed -n "s/.*--port \\\\([0-9]*\\\\).*/\\\\1/p")\\ncp "%s/installed" %s/$port\\nsleep 30\\n' ${q(dir)} "$v" ${q(served)} > "$v/bin/langflow"
    chmod +x "$v/bin/python" "$v/bin/langflow"; exit 0 ;;
  pip) rc=0
    case "$*" in
${installCases}
    esac
    [ "$rc" = 0 ] || exit "$rc"
    py="$(echo "$*" | sed -n 's/.*-p \\([^ ]*\\)\\/bin\\/python.*/\\1/p')"
    ver="$(echo "$*" | sed -n 's/.*langflow\\[postgresql\\]==\\([^ ]*\\).*/\\1/p')"
    inst="$ver"
    case "$*" in
${baseCases}
    esac
    echo "$inst" > "$py/installed"; exit 0 ;;
esac`);
  stub(bin, "curl", `case "$*" in
  *pypi.org*) cp ${q(pypiFile)} "$(echo "$*" | sed -n 's/.*-o \\([^ ]*\\).*/\\1/p')" ;;
  *api/v1/version*) port="$(echo "$*" | sed -n 's/.*:\\([0-9]*\\)\\/api.*/\\1/p')"; [ -f ${q(served)}/$port ] && printf '{"version": "%s"}' "$(cat ${q(served)}/$port)" ;;
  *health_check*) case "$*" in ${healthDown.map((p) => `*:${p}/*`).join("|") || "__none__"}) exit 7 ;; esac; exit 0 ;;
  *docker-compose.yml*) out="$(echo "$*" | sed -n 's/.*-o \\([^ ]*\\).*/\\1/p')"; echo "services: {}" > "$out" ;;
  *) exit 22 ;;
esac`);
  stub(bin, "docker", `echo "$*" >> ${q(join(dir, "docker.log"))}
case "$1" in
  ps|volume|network) exit 0 ;;
  inspect) exit 1 ;;
  run) case "$*" in *postgres*) exit 0 ;; esac
    port="$(echo "$*" | sed -n 's/.*127\\.0\\.0\\.1:\\([0-9]*\\):7860.*/\\1/p')"
    echo "\${@: -1}" | sed 's/.*://' > ${q(served)}/$port ;;
  compose) case "$*" in *" up "*)
    ov="$(echo "$*" | sed -n 's/.*-f \\([^ ]*override\\.yml\\).*/\\1/p')"
    port="$(sed -n 's/.*"127\\.0\\.0\\.1:\\([0-9]*\\):7860".*/\\1/p' "$ov")"
    sed -n 's/^ *image: .*:\\(.*\\)$/\\1/p' "$ov" | head -1 > ${q(served)}/$port ;;
  esac ;;
esac
exit 0`);
  stub(bin, "flock", "exit 0");
  stub(bin, "systemctl", "echo inactive");
  stub(bin, "pkill", "exit 0");

  const state = join(dir, "state");
  mkdirSync(join(state, "migration", "results"), { recursive: true });
  if (previous) writeFileSync(join(state, "migration", "results", "20200101T000000Z.env"), previous);
  const runs = join(dir, "runs");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const [stamp, version] of dailyRuns ?? (daily ? [["080028Z", daily]] : [])) {
    mkdirSync(join(runs, `${today}T${stamp}`), { recursive: true });
    writeFileSync(join(runs, `${today}T${stamp}`, "run-metadata.json"), JSON.stringify({ langflow_version: version }));
  }
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, "export OPENAI_API_KEY=sk-test\nexport GH_TOKEN=must-not-leak\n");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    E2E_ROUTINE_REPO: repo,
    E2E_ROUTINE_STATE_ROOT: state,
    E2E_ROUTINE_LOG_ROOT: join(dir, "log"),
    E2E_ROUTINE_SECRETS: secrets,
    E2E_ROUTINE_LANE: "/dev/null",
    E2E_HEAVY_LOCK: join(dir, "heavy.lock"),
    E2E_SHADOW_STATE: join(dir, "shadow"),
    E2E_ROUTINE_NOW: "3 1500",
    E2E_ROUTINE_POLL_S: "0",
    MIGRATION_DAILY_RUNS: runs,
    MIGRATION_CELLS: cells,
    MIGRATION_UP_WAIT_S: "4",
  };
  if (target) env.MIGRATION_TARGET = target;
  const r = spawnSync("bash", [join(repo, "ops/vm/run-migration.sh")], { encoding: "utf8", env, timeout: 120_000 });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const last = kv(readIf(join(state, "migration", "last.env")));
  return {
    status: r.status,
    last,
    detail: last.DETAIL ? readIf(last.DETAIL) : "",
    log: readIf(join(dir, "log", "e2e-migration", "latest.log")) || `${r.stdout}${r.stderr}`,
    calls: readIf(join(dir, "calls.log")),
    docker: readIf(join(dir, "docker.log")),
    ollama: readIf(join(dir, "ollama.log")),
    uv: readIf(join(dir, "uv.log")),
    langflowEnvs: readdirSync(dir).filter((f) => f.startsWith("langflow-env.")).map((f) => readIf(join(dir, f))),
  };
}

test("twelve cells, in a fixed order, each on its own port; all green is green, exit 0", () => {
  const r = migration();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.equal(r.last.CELLS_GREEN, "12/12");
  assert.equal(r.last.SOURCE, "1.12.4");
  assert.equal(r.last.TARGET, "1.13.0.dev33");
  assert.equal(r.last.TARGET_IMAGE, "langflowai/langflow-nightly:1.13.0.dev33");
  const seeds = r.calls.split("\n").filter((l) => l.startsWith("seed")).map((l) => l.split(" ")[1]);
  assert.deepEqual(seeds, ALL.map((_, i) => String(7920 + i)));
  for (const c of ALL) assert.match(r.detail, new RegExp(`\\| ${c} \\| green \\|`));
});

test("the AUTO_LOGIN-off cells verify by adopting the default account; the others log in automatically", () => {
  const r = migration();
  const verifies = r.calls.split("\n").filter((l) => l.startsWith("verify")).map((l) => l.split(" ").slice(0, 3).join(" "));
  for (const [i, c] of ALL.entries()) {
    const want = c.endsWith("autologin-off") ? "adopt" : "auto";
    assert.ok(verifies.includes(`verify ${7920 + i} ${want}`), `${c}: not verified with ${want}`);
  }
});

test("a failed check is red, and red wins over failed and blocked", () => {
  const r = migration({ verify: { "sqlite-pip-upgrade": "red:file", "postgres-pip-fresh": "blocked" }, seed: { "sqlite-docker-upgrade": 1 } });
  assert.equal(r.status, 1, r.log);
  assert.equal(r.last.STATUS, "red");
  assert.equal(r.last.RED_CELLS, "sqlite-pip-upgrade");
  assert.equal(r.last.FAILED_CELLS, "sqlite-docker-upgrade");
  assert.equal(r.last.BLOCKED_CELLS, "postgres-pip-fresh");
  assert.match(r.last.REASON, /^1 of 12 cells red: sqlite-pip-upgrade$/);
  assert.match(r.detail, /\| sqlite-pip-upgrade \| red \| failed: file \|/);
});

test("an instance that stops answering during the checks is red: the product, not the machine", () => {
  const r = migration({ verify: { "postgres-docker-upgrade": "down" } });
  assert.equal(r.last.STATUS, "red");
  assert.match(r.detail, /postgres-docker-upgrade \| red \| .*stopped answering/);
});

test("an install that fails is the machine's: failed, never red", () => {
  const r = migration({ cells: "sqlite-pip-upgrade", install: { "1.12.4": 1 } });
  assert.equal(r.status, 3, r.log);
  assert.equal(r.last.REASON, "1 of 1 cells could not run: sqlite-pip-upgrade", r.log);
  assert.equal(r.last.STATUS, "failed");
  assert.match(r.detail, /sqlite-pip-upgrade \| failed \| 1\.12\.4: pip install failed/);
});

test("a source that does not start is the machine's; a fresh target that does not start is red", () => {
  const up = migration({ cells: "postgres-pip-upgrade", healthDown: ["7927"] });
  assert.equal(up.last.STATUS, "failed", up.log);
  assert.match(up.detail, /postgres-pip-upgrade \| failed \| 1\.12\.4: did not answer/);
  const fresh = migration({ cells: "postgres-pip-fresh", healthDown: ["7926"] });
  assert.equal(fresh.last.STATUS, "red", fresh.log);
});

test("Postgres pip cells install a psycopg driver beside the extra; SQLite cells do not", () => {
  const r = migration({ cells: "postgres-pip-fresh sqlite-pip-fresh" });
  const installs = r.uv.split("\n").filter((l) => l.startsWith("pip install"));
  assert.equal(installs.filter((l) => l.includes("psycopg[binary]")).length, 1, r.uv);
});

test("docker cells with auto-login on say so: the images default to off", () => {
  const r = migration({ cells: "sqlite-docker-fresh" });
  assert.match(r.docker, /run -d --name e2e-migration-sqlite-docker-fresh .*-e LANGFLOW_AUTO_LOGIN=true/);
});

test("a seed that fails on the source is the machine's; on a fresh target it is the product's", () => {
  const up = migration({ cells: "sqlite-pip-upgrade", seed: { "sqlite-pip-upgrade": 3 } });
  assert.equal(up.last.STATUS, "failed");
  const fresh = migration({ cells: "sqlite-pip-fresh", seed: { "sqlite-pip-fresh": 3 } });
  assert.equal(fresh.last.STATUS, "red");
});

test("only blocked cells make the day blocked, exit 4: not red, not green", () => {
  const r = migration({ cells: "sqlite-pip-fresh sqlite-pip-upgrade", verify: { "sqlite-pip-upgrade": "blocked" } });
  assert.equal(r.status, 4, r.log);
  assert.equal(r.last.STATUS, "blocked");
});

test("a red AUTO_LOGIN-off cell on a target before 1.13 names #15326; on 1.13 it does not", () => {
  const old = migration({ target: "1.12.5rc1", cells: "postgres-pip-upgrade-autologin-off", verify: { "postgres-pip-upgrade-autologin-off": "red:default-user-kept" } });
  assert.match(old.detail, /predates langflow-ai\/langflow#15326/);
  const now = migration({ cells: "postgres-pip-upgrade-autologin-off", verify: { "postgres-pip-upgrade-autologin-off": "red:default-user-kept" } });
  assert.doesNotMatch(now.detail, /15326/);
});

test("on Postgres the AUTO_LOGIN-off seed is adversarial: last_login_at cleared before the upgrade", () => {
  const r = migration({ cells: "postgres-pip-upgrade-autologin-off sqlite-pip-upgrade-autologin-off" });
  const updates = r.docker.split("\n").filter((l) => l.includes("last_login_at = NULL"));
  assert.equal(updates.length, 1, r.docker);
  assert.match(updates[0], /e2e-migration-postgres-pip-upgrade-autologin-off-pg/);
});

test("a red set that changed since the last red day is said in the detail", () => {
  const prev = "ROUTINE=migration\nSTATUS=red\nRED_CELLS=sqlite-pip-upgrade\n";
  const changed = migration({ cells: "postgres-pip-upgrade", verify: { "postgres-pip-upgrade": "red:messages" }, previous: prev });
  assert.match(changed.detail, /The red cells changed since the last red day\*\* \(were: `sqlite-pip-upgrade`\)/);
  const same = migration({ cells: "sqlite-pip-upgrade", verify: { "sqlite-pip-upgrade": "red:messages" }, previous: prev });
  assert.doesNotMatch(same.detail, /changed since/);
});

test("the target is the version today's daily served when none is asked for", () => {
  const r = migration({ target: null, daily: "1.13.0.dev34", cells: "sqlite-pip-fresh" });
  assert.equal(r.last.TARGET, "1.13.0.dev34");
});

test("no daily today and no target: skipped, exit 2, before anything is installed", () => {
  const r = migration({ target: null, daily: null });
  assert.equal(r.status, 2, r.log);
  assert.equal(r.last.STATUS, "skipped");
  assert.match(r.last.REASON, /no daily ran today/);
  assert.equal(r.calls, "");
});

test("no stable release below the target is failed, with the resolver's words", () => {
  const r = migration({ pypi: { releases: { "1.13.0.dev33": [{}] } } });
  assert.equal(r.status, 3);
  assert.match(r.last.REASON, /no migration pair for 1\.13\.0\.dev33: no stable release below/);
});

test("no publishing token reaches the cells or the Langflow they start", () => {
  // The first version asserted only on the log, and a routine that exported the whole
  // secrets file still passed (review of #2194).
  const r = migration({ cells: "sqlite-pip-upgrade" });
  assert.equal(r.status, 0, r.log);
  for (const line of r.calls.split("\n").filter(Boolean)) assert.match(line, / leaked=$/, line);
  assert.ok(r.langflowEnvs.length >= 2, "the pip Langflow never started");
  for (const env of r.langflowEnvs) assert.doesNotMatch(env, /^(GH_TOKEN|GITHUB_TOKEN)=/m);
});

test("the pip Langflow gets no OPENAI_API_KEY: the credential must come from the database", () => {
  // With the key in the environment, an api_key that failed to decrypt fell back to it
  // silently, and the decrypt check passed with nothing decrypted (review of #2194).
  const r = migration({ cells: "sqlite-pip-upgrade" });
  assert.ok(r.langflowEnvs.length >= 2);
  for (const env of r.langflowEnvs) assert.doesNotMatch(env, /^OPENAI_API_KEY=/m);
});

test("pre-releases are allowed for the target only, never for the source", () => {
  // On the source, --prerelease=allow resolved langflow==1.12.4 to langflow-base 1.12.5rc1.
  const r = migration({ cells: "sqlite-pip-upgrade" });
  const installs = r.uv.split("\n").filter((l) => l.startsWith("pip install"));
  const src = installs.find((l) => l.includes("==1.12.4"));
  const tgt = installs.find((l) => l.includes("==1.13.0.dev33"));
  assert.ok(src && tgt, r.uv);
  assert.doesNotMatch(src, /--prerelease/);
  assert.match(tgt, /--prerelease=allow/);
});

test("a source whose backend is not the asked release is failed, not tested", () => {
  const r = migration({ cells: "sqlite-pip-upgrade", installedBase: { "1.12.4": "1.12.5rc1" } });
  assert.equal(r.last.STATUS, "failed", r.log);
  assert.match(r.detail, /langflow==1\.12\.4 installed langflow-base 1\.12\.5rc1, not 1\.12\.4/);
});

test("an instance is up only when it serves the asked version, whatever answers on the port", () => {
  // Docker: the target image's tag is what the stub serves; asking for another fails.
  const ok = migration({ cells: "sqlite-docker-upgrade postgres-docker-upgrade" });
  assert.equal(ok.status, 0, ok.log);
  assert.match(ok.log, /up: 1\.12\.4 after/);
  assert.match(ok.log, /up: 1\.13\.0\.dev33 after/);
  const wrong = migration({ cells: "sqlite-pip-fresh", installedBase: { "1.13.0.dev33": "1.13.0.dev32" } });
  assert.notEqual(wrong.last.STATUS, "green", wrong.log);
});

test("the target is the last non-empty version among today's daily runs", () => {
  const r = migration({ target: null, dailyRuns: [["080028Z", "1.13.0.dev34"], ["093000Z", ""]], cells: "sqlite-pip-fresh" });
  assert.equal(r.last.TARGET, "1.13.0.dev34", r.log);
});

test("everything the routine names is cleared on exit, and its ollama stopped", () => {
  const r = migration({ cells: "sqlite-pip-fresh" });
  assert.match(r.docker, /ps -aq --filter name=\^e2e-migration-/);
  assert.match(r.docker, /volume ls -q --filter name=\^e2e-migration-/);
  assert.match(r.ollama, /^stop 11464$/m);
});
