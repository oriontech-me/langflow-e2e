// Unit tests for the @instance-migration lane scripts (#2347):
// start-langflow-instance-migration.sh, reset-langflow-instance-migration.sh and
// stop-langflow-instance-migration.sh.
// Run with: npm run test:scripts
//
// What these protect are the properties that fail SILENTLY:
//
//   - The source's environment matches every other lane's. Read out of
//     start-langflow-docker.sh at test time rather than copied here, so a variable
//     added there fails this file instead of making this lane quietly different.
//   - The source publishes on loopback by default: it runs auto-login with a known
//     superuser AND a known secret key, on a shared VM.
//   - Only the lane's own containers are ever removed — never `langflow-e2e-runner`,
//     which is how a parallel session's instance and its database get destroyed.
//   - One worker is refused to be overridden, because the feature keeps destination
//     secrets in that worker's memory.
//   - The reset stops a live run BEFORE removing the record and emptying the target,
//     and verifies each part rather than trusting its own commands.
//
// docker, curl and sleep are stubbed through a PATH shim, so nothing is pulled, built
// or started; the assertions read what the scripts would have run. The live behaviour
// (a full migration through all three copies, then a reset with a copy still running)
// was measured against the real lane and is recorded in the lane doc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const START = join(HERE, "start-langflow-instance-migration.sh");
const RESET = join(HERE, "reset-langflow-instance-migration.sh");
const STOP = join(HERE, "stop-langflow-instance-migration.sh");
const DOCKER_START = join(HERE, "start-langflow-docker.sh");

const DOCKER_STUB = `#!/usr/bin/env bash
# One line per call, even for the reset's multi-line \`sh -c\` script.
printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$FAKE_LOG"
args="$*"
case "$1" in
  ps) [ -n "\${FAKE_SIBLINGS:-}" ] && printf '%s\\n' $FAKE_SIBLINGS; exit 0 ;;
  network) [ "$2" = "inspect" ] && [ "\${FAKE_NETWORK:-absent}" = "absent" ] && exit 1; exit 0 ;;
  container) [ "$2" = "inspect" ] && case " \${FAKE_ABSENT:-} " in *" $3 "*) exit 1 ;; esac; exit 0 ;;
  inspect)
    name="\${@: -1}"
    case " \${FAKE_NOT_RUNNING:-} " in *" $name "*) echo false ;; *) echo true ;; esac
    exit 0 ;;
  build) cat > /dev/null; exit 0 ;;
  exec)
    case "$args" in
      *"weed shell"*)
        input="$(cat)"
        case "$input" in *"s3.bucket.create -name "*)
          echo "created bucket \${input##*s3.bucket.create -name }" | head -n 1 ;;
        esac
        case "$input" in *"s3.bucket.list"*) printf '  %s\\tsize:0\\n' "\${FAKE_BUCKET:-langflow-migration}" ;; esac
        case "$input" in *"fs.ls"*) [ -n "\${FAKE_OBJECTS:-}" ] && echo "\${FAKE_OBJECTS}" ;; esac
        exit 0 ;;
      *"python - "*) cat > /dev/null; echo "SEEDED \${FAKE_SEEDED:-3}"; exit 0 ;;
      *"importlib.metadata"*) echo "\${FAKE_CONTAINER_VERSION:-1.14.0.dev99}"; exit 0 ;;
      *"information_schema.tables"*) echo "\${FAKE_TABLES:-0}"; exit 0 ;;
      *"pg_extension"*) echo "\${FAKE_EXTENSION:-1}"; exit 0 ;;
      *" test ! -e "*) [ "\${FAKE_RECORD_LEFT:-0}" = "1" ] && exit 1; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

const CURL_STUB = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
url="\${@: -1}"
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
code_only=0
for a in "$@"; do [ "$a" = "%{http_code}" ] && code_only=1; done
case "$url" in
  */health_check) exit 0 ;;
  */api/v1/version) echo "{\\"version\\":\\"\${FAKE_HTTP_VERSION:-1.14.0.dev99}\\",\\"package\\":\\"Langflow Nightly\\"}"; exit 0 ;;
  */api/v1/auto_login) echo '{"access_token":"tok"}'; exit 0 ;;
  */api/v1/migration)
    if [ $code_only = 1 ]; then printf '%s' "\${FAKE_MIGRATION_STATUS:-200}"; exit 0; fi
    echo "{\\"instance\\":{\\"database\\":{\\"path\\":\\"/app/x/langflow.db\\"}},\\"steps\\":[{\\"id\\":\\"copy_files\\",\\"state\\":\\"\${FAKE_COPY_FILES_STATE:-locked}\\"}]}"
    exit 0 ;;
  */api/v1/flows/ | */api/v2/files | */api/v1/knowledge_bases/) printf '201'; exit 0 ;;
esac
exit 0
`;

function run(script, { env = {} } = {}) {
  const dir = makeTempDir("im-lane-test-");
  const log = join(dir, "docker.log");
  const curlLog = join(dir, "curl.log");
  writeFileSync(join(dir, "docker"), DOCKER_STUB);
  writeFileSync(join(dir, "curl"), CURL_STUB);
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["docker", "curl", "sleep"]) chmodSync(join(dir, f), 0o755);

  let out = "";
  let status = 0;
  try {
    out = execFileSync("bash", [script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANGFLOW_WORKERS: "",
        LANGFLOW_BIND_HOST: "",
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_CURL_LOG: curlLog,
      },
    });
  } catch (err) {
    status = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const read = (p) => {
    try {
      return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const calls = read(log);
  const curls = read(curlLog);
  rmSync(dir, { recursive: true, force: true });
  return { out, status, calls, curls };
}

const runOf = (calls, name) => calls.find((c) => c.startsWith("run ") && c.includes(`--name ${name} `));

/** The `-e` lines of the first `docker run` block in a script's source. */
function envLines(path) {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("docker run -d");
  const block = text.slice(start, text.indexOf('"${IMAGE}"', start));
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-e "))
    .map((l) => l.replace(/ \\$/, ""));
}

/** The `-e` lines of the SOURCE container's run block in this lane's script. */
function sourceEnvLines() {
  const text = readFileSync(START, "utf8");
  const start = text.indexOf('--name "${IM_SOURCE_CONTAINER}"');
  const end = text.indexOf('"${DERIVED_IMAGE}"', start);
  return text
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-e "))
    .map((l) => l.replace(/ \\$/, ""));
}

test("the source's environment carries every variable start-langflow-docker.sh sets, verbatim", () => {
  const theirs = envLines(DOCKER_START);
  const ours = sourceEnvLines();
  // A parse that found nothing would make this vacuous.
  assert.ok(theirs.length >= 10, `parsed ${theirs.length} -e line(s) out of start-langflow-docker.sh`);
  for (const line of theirs) {
    // Two are this lane's on purpose: the port is the lane's own, and one worker is a
    // requirement of the feature rather than an overridable default.
    if (line.startsWith("-e LANGFLOW_PORT=") || line.startsWith("-e LANGFLOW_WORKERS=")) continue;
    assert.ok(ours.includes(line), `missing or different here: ${line}`);
  }
  assert.ok(ours.includes('-e LANGFLOW_PORT="${IM_PORT}"'));
  assert.ok(ours.includes("-e LANGFLOW_WORKERS=1"));
});

test("a start runs the feature on, one worker, the known key, on loopback, with every container on the lane's network", () => {
  const r = run(START);
  assert.equal(r.status, 0, r.out);
  const source = runOf(r.calls, "langflow-instance-migration");
  assert.ok(source, "the source was not started");
  assert.match(source, /-p 127\.0\.0\.1:7895:7895 /);
  assert.match(source, /LANGFLOW_PORT=7895 /);
  assert.match(source, /LANGFLOW_FEATURE_INSTANCE_MIGRATION=true /);
  assert.match(source, /LANGFLOW_WORKERS=1 /);
  assert.match(source, /LANGFLOW_SECRET_KEY=ZTJlLWltLXNlbnRpbmVsLXNlY3JldC1rZXktZmFrZSE= /);
  assert.match(source, /LANGFLOW_CONFIG_DIR=\/app\/data\/\.cache\/langflow /);
  // The derived image (base + pgvector), not the nightly itself: the nightly lacks the
  // package and the knowledge base copy could never run.
  assert.ok(source.trim().endsWith("langflow-instance-migration:local"), source);
  assert.ok(r.calls.some((c) => c.startsWith("build ") && c.includes("BASE=langflowai/langflow-nightly:latest")));
  for (const name of ["langflow-instance-migration-pg", "langflow-instance-migration-s3", "langflow-instance-migration"]) {
    assert.match(runOf(r.calls, name), /--network langflow-instance-migration-net /, name);
  }
  // The destinations are loopback-only whatever the source's bind is.
  assert.match(runOf(r.calls, "langflow-instance-migration-pg"), /-p 127\.0\.0\.1:55895:5432 /);
  assert.match(runOf(r.calls, "langflow-instance-migration-s3"), /-p 127\.0\.0\.1:58895:8333 /);
  assert.match(r.out, /PW_INSTANCE_MIGRATION=1 npx playwright test --grep @instance-migration/);
});

test("LANGFLOW_BIND_HOST opts the source out of loopback, and the probe follows", () => {
  const r = run(START, { env: { LANGFLOW_BIND_HOST: "0.0.0.0" } });
  assert.equal(r.status, 0, r.out);
  assert.match(runOf(r.calls, "langflow-instance-migration"), /-p 0\.0\.0\.0:7895:7895 /);
  assert.ok(r.curls.some((c) => c.includes("http://localhost:7895/health_check")));
  assert.match(runOf(r.calls, "langflow-instance-migration-pg"), /-p 127\.0\.0\.1:55895:5432 /);
});

test("a second worker is refused before anything starts", () => {
  const r = run(START, { env: { LANGFLOW_WORKERS: "2" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /needs ONE worker/);
  assert.deepEqual(r.calls, []);
});

test("a start removes only the lane's own containers, never the shared runner", () => {
  const r = run(START, { env: { FAKE_SIBLINGS: "langflow-e2e-runner" } });
  assert.equal(r.status, 0, r.out);
  const removed = r.calls.filter((c) => c.startsWith("rm ")).map((c) => c.split(/\s+/).pop());
  assert.deepEqual(removed.sort(), [
    "langflow-instance-migration",
    "langflow-instance-migration-pg",
    "langflow-instance-migration-s3",
    "langflow-instance-migration-target",
  ]);
  assert.match(r.out, /other Langflow containers are already running/);
});

test("a port answered by another Langflow fails the start, naming both readings", () => {
  const r = run(START, { env: { FAKE_HTTP_VERSION: "1.12.0" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /SHADOWED/);
  assert.match(r.out, /1\.14\.0\.dev99/);
  assert.match(r.out, /1\.12\.0/);
});

test("routes that are not mounted fail the start instead of seeding an instance nothing can migrate", () => {
  const r = run(START, { env: { FAKE_MIGRATION_STATUS: "404" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /GET \/api\/v1\/migration answered 404/);
  assert.ok(!r.curls.some((c) => c.includes("/api/v1/flows/")), "seeded after the check failed");
});

test("a seed that leaves a copy step skipped fails the start", () => {
  const r = run(START, { env: { FAKE_COPY_FILES_STATE: "skipped" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /still skipped: copy_files/);
});

test("a vector seed that did not confirm its count fails the start", () => {
  const r = run(START, { env: { FAKE_SEEDED: "0" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /did not confirm 3 vectors/);
});

test("a reset stops a live run before it removes the record and empties the target, then verifies", () => {
  const r = run(RESET);
  assert.equal(r.status, 0, r.out);
  const idx = (pred) => r.calls.findIndex(pred);
  const kill = idx((c) => c.startsWith("exec langflow-instance-migration sh -c") && c.includes("kill -TERM"));
  const rm = idx((c) => c.includes("rm -rf /app/data/.cache/langflow/migrations"));
  const drop = idx((c) => c.includes("DROP DATABASE IF EXISTS langflow_target WITH (FORCE)"));
  const ext = idx((c) => c.includes("-d langflow_target") && c.includes("CREATE EXTENSION IF NOT EXISTS vector"));
  const bucket = idx((c) => c.startsWith("exec -i langflow-instance-migration-s3 weed shell"));
  // The new instance a spec started on the copy goes first: it holds connections to the
  // database the reset drops (#2354).
  const target = idx((c) => c === "rm -f langflow-instance-migration-target");
  for (const [name, i] of Object.entries({ target, kill, rm, drop, ext, bucket })) assert.ok(i >= 0, `${name} never ran`);
  assert.ok(
    target < kill && kill < rm && rm < drop && drop < ext && ext < bucket,
    `order: ${[target, kill, rm, drop, ext, bucket]}`,
  );
  assert.match(r.out, /Reset the instance migration lane/);
});

test("a reset with no new instance left running removes nothing but the migration's own state", () => {
  const r = run(RESET, { env: { FAKE_ABSENT: "langflow-instance-migration-target" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.includes("container inspect langflow-instance-migration-target"), "never looked for the new instance");
  assert.deepEqual(r.calls.filter((c) => c.startsWith("rm ")), []);
});

test("a reset refuses a lane that is not running, and touches nothing", () => {
  const r = run(RESET, { env: { FAKE_NOT_RUNNING: "langflow-instance-migration-pg" } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /langflow-instance-migration-pg is not running/);
  assert.ok(!r.calls.some((c) => c.startsWith("exec ")), "ran a command against a half-started lane");
});

test("a reset that left anything behind fails, naming what", () => {
  for (const [env, said] of [
    [{ FAKE_TABLES: "64" }, /still holds 64 table/],
    [{ FAKE_EXTENSION: "0" }, /vector extension is missing/],
    [{ FAKE_RECORD_LEFT: "1" }, /migration record is still there/],
    [{ FAKE_BUCKET: "other" }, /was not recreated/],
    [{ FAKE_OBJECTS: "langflow/x/file.txt" }, /still lists 1 entr/],
  ]) {
    const r = run(RESET, { env });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.match(r.out, said, JSON.stringify(env));
  }
});

test("a stop removes the lane's containers, a left-over new instance and the network, and says which were not there", () => {
  const r = run(STOP, { env: { FAKE_ABSENT: "langflow-instance-migration-s3", FAKE_NETWORK: "present" } });
  assert.equal(r.status, 0, r.out);
  const removed = r.calls.filter((c) => c.startsWith("rm ")).map((c) => c.split(/\s+/).pop());
  assert.deepEqual(removed.sort(), [
    "langflow-instance-migration",
    "langflow-instance-migration-pg",
    "langflow-instance-migration-target",
  ]);
  assert.match(r.out, /langflow-instance-migration-s3: no such container/);
  assert.ok(r.calls.includes("network rm langflow-instance-migration-net"));
  assert.ok(!r.calls.some((c) => c.includes("langflow-e2e-runner")));
});
