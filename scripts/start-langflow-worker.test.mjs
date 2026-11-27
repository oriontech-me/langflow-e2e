// Unit tests for scripts/start-langflow-worker.sh and scripts/stop-langflow-worker.sh,
// the worker half of the background-worker lane (#2574). Run with: npm run test:scripts
//
// No real Langflow: a fake `langflow` writes the row a real worker writes into
// `worker_registry` (#15790) and then idles, so what is under test is the starter's
// contract — the database it points the worker at, what counts as ready, and what it
// refuses — not the product.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const START = join(HERE, "start-langflow-worker.sh");
const STOP = join(HERE, "stop-langflow-worker.sh");
const PORT = "7999";
const spawned = [];
after(() => {
  for (const p of spawned) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

/**
 * A state directory as scripts/start-langflow-source.sh leaves it: a live API PID (a
 * `sleep`), a SQLite database with a `worker_registry` table, and a fake langflow whose
 * `worker` subcommand behaves as `mode` says.
 *   register  writes a row stamped now, records its environment, then idles
 *   silent    idles and never registers
 *   crash     exits at once
 *   stale     the table already holds a row from an earlier worker; this one never registers
 */
function setup({ mode = "register", api = true } = {}) {
  const root = makeTempDir("worker-starter-");
  const state = join(root, `langflow-source-${PORT}`);
  mkdirSync(join(state, "data"), { recursive: true });
  const db = join(state, "data", "langflow.db");
  spawnSync("python3", ["-c", `import sqlite3; c=sqlite3.connect(${JSON.stringify(db)}); c.execute("CREATE TABLE worker_registry (owner TEXT PRIMARY KEY, pid INT, host TEXT, started_at TEXT, last_heartbeat TEXT, state TEXT, current_job_id TEXT)"); c.commit()`]);
  if (mode === "stale") {
    spawnSync("python3", ["-c", `import sqlite3; c=sqlite3.connect(${JSON.stringify(db)}); c.execute("INSERT INTO worker_registry VALUES ('worker:1:old', 1, 'h', '2026-01-01 00:00:00+00:00', '2026-01-01 00:00:00+00:00', 'idle', NULL)"); c.commit()`]);
  }
  if (api) {
    const sleeper = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    spawned.push(sleeper.pid);
    writeFileSync(join(state, "langflow.pid"), `${sleeper.pid}\n`);
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const envLog = join(root, "worker-env.log");
  const register = `python3 -c 'import sqlite3, os, datetime; c=sqlite3.connect(os.environ["LANGFLOW_DATABASE_URL"][len("sqlite:///"):]); now=datetime.datetime.now(datetime.timezone.utc).isoformat(sep=" "); c.execute("INSERT INTO worker_registry VALUES (?,?,?,?,?,?,NULL)", ("worker:%d:x" % os.getpid(), os.getpid(), "h", now, now, "idle")); c.commit()'`;
  writeFileSync(
    join(bin, "langflow"),
    `#!/usr/bin/env bash
[ "$1" = worker ] || { echo "fake langflow: $*" >&2; exit 3; }
printf 'BACKEND=%s CONFIG=%s DB=%s CWD=%s\\n' "$LANGFLOW_BACKGROUND_BACKEND" "$LANGFLOW_CONFIG_DIR" "$LANGFLOW_DATABASE_URL" "$PWD" > ${JSON.stringify(envLog)}
printf 'AUTO_LOGIN=%s SUPERUSER=%s PASSWORD=%s\\n' "$LANGFLOW_AUTO_LOGIN" "$LANGFLOW_SUPERUSER" "$LANGFLOW_SUPERUSER_PASSWORD" >> ${JSON.stringify(envLog)}
# A real worker runs the API's startup and refuses without a superuser's credentials.
[ -n "$LANGFLOW_SUPERUSER_PASSWORD" ] || { echo "ValueError: Username and password must be set" >&2; exit 1; }
case ${JSON.stringify(mode)} in
  register) sleep 1; ${register} ;;
  crash) echo "boom: no job table" >&2; exit 1 ;;
esac
exec sleep 300
`,
  );
  chmodSync(join(bin, "langflow"), 0o755);
  return { root, state, db, envLog, runCmd: `${join(bin, "langflow")} run` };
}

const run = (script, ctx, env = {}) =>
  spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, LANGFLOW_PORT: PORT, LANGFLOW_SRC_STATE_ROOT: ctx.root, LANGFLOW_SRC_RUN_CMD: ctx.runCmd, LANGFLOW_WORKER_READY_TIMEOUT_S: "10", LANGFLOW_WORKER_STOP_TIMEOUT_S: "5", ...env },
    timeout: 60_000,
  });
const pidOf = (ctx) => Number(readFileSync(join(ctx.state, "worker.pid"), "utf8").trim());
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a worker starts on the API's own database, in scaled mode, and is ready once it registers", () => {
  const ctx = setup();
  const r = run(START, ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Langflow worker ready after \d+s \(PID \d+, registered in worker_registry\)/);
  const pid = pidOf(ctx);
  spawned.push(pid);
  assert.ok(alive(pid), "the worker is running");
  // The same directory and database the source starter gives the API on this port.
  assert.equal(
    readFileSync(ctx.envLog, "utf8").trim(),
    `BACKEND=scaled CONFIG=${ctx.state}/data DB=sqlite:///${ctx.state}/data/langflow.db CWD=${ctx.state}\n` +
      // The source starter's identity defaults: the worker's startup needs them too.
      "AUTO_LOGIN=true SUPERUSER=langflow PASSWORD=langflow123",
  );
  // And a second start beside the same port is refused: two workers, one queue.
  const twice = run(START, ctx);
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /already running beside port 7999/);

  const stop = run(STOP, ctx);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /Worker beside port 7999 stopped/);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(join(ctx.state, "worker.pid")), false);
  assert.match(run(STOP, ctx).stdout, /No worker PID file/, "stopping twice is not an error");
});

test("no API on the port, or no way to derive the worker command, is refused before launching", () => {
  const noApi = setup({ api: false });
  const r = run(START, noApi);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no instance of scripts\/start-langflow-source\.sh is running on port 7999/);
  assert.equal(existsSync(noApi.envLog), false, "nothing was launched");

  const ctx = setup();
  const bad = run(START, ctx, { LANGFLOW_SRC_RUN_CMD: "uvx langflow serve" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot derive the worker command .* must end in ' run'/);
  // Named outright, it is used as given.
  const named = run(START, ctx, { LANGFLOW_SRC_RUN_CMD: "", LANGFLOW_SRC_WORKER_CMD: ctx.runCmd.replace(/ run$/, " worker") });
  assert.equal(named.status, 0, named.stderr);
  spawned.push(pidOf(ctx));
  run(STOP, ctx);

  assert.equal(run(START, setup(), { LANGFLOW_PORT: "" }).status, 2);
});

test("a worker that exits, never registers, or only finds an earlier worker's row is not ready", () => {
  const crash = setup({ mode: "crash" });
  const c = run(START, crash);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /exited after \d+s without registering/);
  assert.match(c.stderr, /boom: no job table/, "the worker's own reason reaches the caller");
  assert.equal(existsSync(join(crash.state, "worker.pid")), false);

  for (const mode of ["silent", "stale"]) {
    const ctx = setup({ mode });
    const r = run(START, ctx, { LANGFLOW_WORKER_READY_TIMEOUT_S: "3" });
    assert.equal(r.status, 1, `${mode}: ${r.stdout}`);
    assert.match(r.stderr, /did not register in 3s/, mode);
    assert.equal(existsSync(join(ctx.state, "worker.pid")), false, `${mode}: the worker it gave up on is stopped`);
  }
});

test("a worker that ignores SIGTERM is killed, and a PID file for a dead worker is just cleared", () => {
  const ctx = setup();
  // Double-forked, so it is adopted and reaped by init as a real worker is: a child of
  // this test runner would linger as a zombie after SIGKILL and still answer kill -0.
  const pid = Number(spawnSync("bash", ["-c", "( trap '' TERM; while true; do sleep 1; done ) > /dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
  spawned.push(pid);
  writeFileSync(join(ctx.state, "worker.pid"), `${pid}\n`);
  const r = run(STOP, ctx, { LANGFLOW_WORKER_STOP_TIMEOUT_S: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /did not exit in 1s; sending SIGKILL/);
  assert.match(r.stdout, /killed/);

  writeFileSync(join(ctx.state, "worker.pid"), "999999\n");
  assert.match(run(STOP, ctx).stdout, /already gone; clearing/);
  assert.equal(existsSync(join(ctx.state, "worker.pid")), false);
});

test("both scripts are self-contained: the VM lane pipes them to bash -s on the target", () => {
  for (const script of [START, STOP]) {
    const text = readFileSync(script, "utf8");
    assert.doesNotMatch(text, /\b(source|\.) +["']?\$\{?(REPO|HERE|SCRIPT_DIR)/, script);
    assert.doesNotMatch(text, /\$\(dirname/, `${script} must not read a file beside itself`);
  }
});

test("the worker's identity defaults are the source starter's, so the two never disagree", () => {
  const source = readFileSync(join(HERE, "start-langflow-source.sh"), "utf8");
  const worker = readFileSync(START, "utf8");
  for (const name of ["LANGFLOW_SUPERUSER", "LANGFLOW_SUPERUSER_PASSWORD", "LANGFLOW_DEACTIVATE_TRACING"]) {
    const re = new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"`, "m");
    const s = source.match(re);
    assert.ok(s, `the source starter no longer sets ${name} this way`);
    assert.equal(worker.match(re)?.[1], s[1], name);
  }
  assert.match(source, /^LANGFLOW_AUTO_LOGIN=true \\$/m);
  assert.match(worker, /^LANGFLOW_AUTO_LOGIN=true \\$/m);
});
