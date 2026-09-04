// Unit tests for scripts/lib/vm-env-parity.mjs and its CLI.
// Run with: npm run test:scripts
//
// What these protect. The guard's job is to fail when daily-stable.yml gains a service
// variable the VM lane neither carries nor classifies — and the reason it has to be a
// guard rather than a hand audit is that half of what it catches produces AGREEMENT
// rather than failure, so no run can find it (#1717). A guard for an invisible class is
// worth exactly what its own tests are worth, hence the shape below: every assertion is
// driven by a MUTATED source, never by the wording of a line.
//
// The failures this file is written against:
//   - a comment merely SPELLING a variable must not answer for a real setting, in
//     either direction — it must not mask one, and it must not fail a correct workflow
//     (#1300, and #1716's first draft reintroduced it)
//   - the read is scoped to the SERVICE block, because daily-stable.yml also sets
//     LANGFLOW_IMAGE and LANGFLOW_VERSION as step env in later jobs
//   - SHADOWING. The first version of this guard checked that the carrier file NAMED
//     the variable, and that let the starter overwrite a mirrored value with a literal
//     while every check stayed green. Found in review, reproduced here: it is the
//     silent half of #1717 one layer down
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readServiceEnv,
  readStarterLaunchEnv,
  readMirroredNames,
  checkVmEnvParity,
  CLASSIFICATION,
  WORKFLOW_PATH,
} from "./lib/vm-env-parity.mjs";
import { evaluateWorkflowValue } from "./lib/gh-expression.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI = join(HERE, "check-vm-env-parity.mjs");

/** A minimal workflow with the same shape as daily-stable.yml's service block. */
const workflowWith = (envLines, tail = "") =>
  [
    "name: Daily",
    "jobs:",
    "  test:",
    "    services:",
    "      langflow:",
    "        image: langflowai/langflow-nightly:latest",
    "        env:",
    ...envLines.map((l) => `          ${l}`),
    "        options: >-",
    '          --health-cmd "curl -f http://localhost:7860/health_check"',
    "      ollama:",
    "        image: ghcr.io/x/ollama-e2e:llama3.2-1b",
    tail,
  ].join("\n");

/** run-e2e.sh's composer, in the shape the reader expects. */
const orchestratorWith = (names, extra = "") =>
  [
    extra,
    "mirrored_target_env() {",
    "  printf '%s' \\",
    ...names.map((n) => `    "${n}=$(shq "$${n}") " \\`),
    "}",
  ].join("\n");

/** start-langflow-source.sh's launch block, ending at the command as the real one does. */
const starterWith = (assignments) =>
  [
    'cd "${REPO}"',
    ...assignments.map((a) => `${a} \\`),
    '  ${RUN_CMD} --host "${BIND_HOST}" --port "${PORT}" --no-open-browser \\',
    '  --workers "${LANGFLOW_WORKERS:-1}" < /dev/null &',
  ].join("\n");

const MINIMAL = ['LANGFLOW_AUTO_LOGIN: "true"', 'LANGFLOW_DEACTIVATE_TRACING: "false"'];
const CLASSES = {
  LANGFLOW_AUTO_LOGIN: { carrier: "starter", reason: "auto-login, and every starter does it" },
  LANGFLOW_DEACTIVATE_TRACING: { carrier: "orchestrator", reason: "chosen for this lane, not for a dev box" },
};
const STARTER_OK = starterWith([
  "LANGFLOW_AUTO_LOGIN=true",
  'LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-true}"',
]);
const check = (workflow, over = {}) =>
  checkVmEnvParity({
    workflow,
    orchestrator: orchestratorWith(["LANGFLOW_DEACTIVATE_TRACING"]),
    starter: STARTER_OK,
    classification: CLASSES,
    ...over,
  });

test("the repository as it stands passes, and the CLI agrees", () => {
  // Not a tautology: it is the assertion that keeps the three variables #1717 named
  // present. Delete one from mirrored_target_env() and this fails.
  const result = checkVmEnvParity();
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));

  const r = spawnSync(process.execPath, [CLI, "--mode=check"], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /VM env parity OK/);
});

test("a variable the workflow gains and nobody classified fails the guard", () => {
  // THE mutation this file exists for: the 11th variable the daily grows has to force
  // a decision when it is written, not whenever someone next notices an odd verdict.
  const result = check(workflowWith([...MINIMAL, 'LANGFLOW_BRAND_NEW_KNOB: "1"']));
  assert.equal(result.ok, false);
  const found = result.findings.find((f) => f.name === "LANGFLOW_BRAND_NEW_KNOB");
  assert.equal(found?.kind, "unclassified");
  // The message has to say what to DO: the reader meeting it is mid-edit on the
  // workflow and has no reason to know this file exists.
  assert.match(found.message, /run-e2e\.sh/);
  assert.match(found.message, /out of scope with a reason/);
});

test("the enumeration is not limited to the LANGFLOW_ namespace", () => {
  // The first version filtered `startsWith("LANGFLOW_")` with no comment, so a
  // DO_NOT_TRACK or a LANGSMITH_* configuring the instance under test read as clean —
  // and a fail-closed promise is what makes the next reader stop looking.
  const result = check(workflowWith([...MINIMAL, 'DO_NOT_TRACK: "1"']));
  assert.equal(result.ok, false);
  assert.equal(result.findings.find((f) => f.name === "DO_NOT_TRACK")?.kind, "unclassified");
});

test("a mirrored variable the starter overwrites with a literal fails", () => {
  // The gap found in review, reproduced. One line in the starter's launch block, in
  // the same shape LANGFLOW_AUTO_LOGIN=true is written two lines above it, and the
  // orchestrator's value never reaches the server: a prefix assignment on `uv run`
  // REPLACES the inherited value for that name rather than adding to it.
  const result = check(workflowWith(MINIMAL), {
    starter: starterWith(["LANGFLOW_AUTO_LOGIN=true", "LANGFLOW_DEACTIVATE_TRACING=true"]),
  });
  assert.equal(result.ok, false);
  const found = result.findings.find((f) => f.name === "LANGFLOW_DEACTIVATE_TRACING");
  assert.equal(found?.kind, "shadowed");
  // It has to name the fix, because the line looks correct to anyone reading the
  // starter alone — the whole point is that nothing else goes red.
  assert.match(found.message, /\$\{LANGFLOW_DEACTIVATE_TRACING:-…\}/);
});

test("the overridable shape is not shadowing, because the caller's value wins", () => {
  // `${NAME:-default}` is how the starter already carries tracing, and it must keep
  // passing: a guard that forbade it would push the value out of the starter and break
  // the parity with start-langflow-pip.sh that #1716 exists to protect.
  const result = check(workflowWith(MINIMAL));
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
});

test("naming a mirrored variable outside the composer does not count as carrying it", () => {
  // "The file names it somewhere" was the first version's test and it is not the
  // property: a mention in a string, or one left behind in a stale branch, would
  // satisfy it while nothing reached the target.
  const result = check(workflowWith(MINIMAL), {
    orchestrator: orchestratorWith([], 'echo "LANGFLOW_DEACTIVATE_TRACING is handled below"'),
  });
  assert.equal(result.ok, false);
  const found = result.findings.find((f) => f.name === "LANGFLOW_DEACTIVATE_TRACING");
  assert.equal(found?.kind, "not-carried");
  assert.match(found.message, /mirrored_target_env\(\)/);
});

test("a starter-carried variable its launch block does not set fails", () => {
  const result = check(workflowWith(MINIMAL), {
    starter: starterWith(['LANGFLOW_DEACTIVATE_TRACING="${LANGFLOW_DEACTIVATE_TRACING:-true}"']),
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.find((f) => f.name === "LANGFLOW_AUTO_LOGIN")?.kind, "not-carried");
});

test("a variable spent on a flag counts as carried, and its default is compared", () => {
  // LANGFLOW_WORKERS is set as env by the workflow and spent as `--workers` by the
  // starter. A name-only check would call it missing; a value check has to read the
  // flag's default, because the assignment it would otherwise look for does not exist.
  const classification = {
    ...CLASSES,
    LANGFLOW_WORKERS: { carrier: "starter", reason: "carried as the --workers flag, which is how langflow run takes it" },
  };
  assert.ok(check(workflowWith([...MINIMAL, 'LANGFLOW_WORKERS: "1"']), { classification }).ok);

  const drift = check(workflowWith([...MINIMAL, 'LANGFLOW_WORKERS: "4"']), { classification });
  assert.equal(drift.ok, false);
  const found = drift.findings.find((f) => f.name === "LANGFLOW_WORKERS");
  assert.equal(found?.kind, "value-drift");
  assert.match(found.message, /"4"[\s\S]*"1"/);
});

test("a starter default that drifts from the workflow's value fails", () => {
  // The residual the first version left open: change LANGFLOW_SUPERUSER_PASSWORD in
  // the workflow and the two lanes authenticate differently with the guard green.
  const result = check(workflowWith(['LANGFLOW_AUTO_LOGIN: "false"', 'LANGFLOW_DEACTIVATE_TRACING: "false"']));
  assert.equal(result.ok, false);
  const found = result.findings.find((f) => f.name === "LANGFLOW_AUTO_LOGIN");
  assert.equal(found?.kind, "value-drift");
  assert.match(found.message, /sameValue: false/);
});

test("sameValue: false records a deliberate difference instead of failing on it", () => {
  const result = check(workflowWith(['LANGFLOW_AUTO_LOGIN: "false"', 'LANGFLOW_DEACTIVATE_TRACING: "false"']), {
    classification: {
      ...CLASSES,
      LANGFLOW_AUTO_LOGIN: { carrier: "starter", sameValue: false, reason: "different on purpose, and here is the why" },
    },
  });
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
});

test("a comment naming a variable is not a setting, on either side", () => {
  // #1300's failure: a `#` line spelling a variable both masks a real setting and
  // FAILS A CORRECT WORKFLOW. In the workflow it would invent an unclassified
  // variable out of prose; in the starter it would report shadowing that is not there.
  assert.ok(
    check(
      workflowWith([...MINIMAL, "# LANGFLOW_BRAND_NEW_KNOB is deliberately not set here", "# LANGFLOW_ALSO_NOT: yes"]),
    ).ok,
  );
  const commented = check(workflowWith(MINIMAL), {
    starter: STARTER_OK.replace('cd "${REPO}"', '# LANGFLOW_DEACTIVATE_TRACING=true was removed in #1716\ncd "${REPO}"'),
  });
  assert.ok(commented.ok, commented.findings.map((f) => f.message).join("\n"));
});

test("a variable set outside the service block is not the service's", () => {
  // daily-stable.yml really does this: LANGFLOW_IMAGE and LANGFLOW_VERSION are step env
  // in the reporting jobs. Counted as service variables they would be permanent,
  // unfixable gaps — nothing can "carry" the name of an image to a source instance.
  const result = check(
    workflowWith(MINIMAL, ["  report:", "    steps:", "      - env:", "          LANGFLOW_IMAGE: langflow:latest"].join("\n")),
  );
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
  assert.equal(result.declared.has("LANGFLOW_IMAGE"), false);
});

test("out of scope without a reason is not out of scope", () => {
  // #1581's rule: the reason is the whole content of the entry, because it is what a
  // future reader acts on. An empty one is a decision nobody can review.
  const result = check(workflowWith(MINIMAL), {
    classification: { ...CLASSES, LANGFLOW_AUTO_LOGIN: { carrier: null } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.find((f) => f.name === "LANGFLOW_AUTO_LOGIN")?.kind, "no-reason");
});

test("out of scope WITH a reason passes, and is reported as out of scope", () => {
  const result = check(workflowWith(MINIMAL), {
    classification: { ...CLASSES, LANGFLOW_AUTO_LOGIN: { carrier: null, reason: "a container-only concept here" } },
  });
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
  assert.equal(result.carried.find((c) => c.name === "LANGFLOW_AUTO_LOGIN").carrier, null);
});

test("a classification for a variable the workflow dropped fails as stale", () => {
  // A reason that outlives its variable is worse than no reason: a future reader will
  // trust it about a decision that no longer exists.
  const result = check(workflowWith(MINIMAL), {
    classification: { ...CLASSES, LANGFLOW_LONG_GONE: { carrier: "starter", reason: "was a thing once, long ago" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.find((f) => f.name === "LANGFLOW_LONG_GONE")?.kind, "stale");
});

test("every finding is reported, not just the first", () => {
  // An enumeration guard that stops at one gap makes the reader run it once per
  // variable, and the second gap is found a day later than the first.
  const result = check(workflowWith([...MINIMAL, 'LANGFLOW_ONE: "1"', 'LANGFLOW_TWO: "2"']));
  assert.equal(result.findings.filter((f) => f.kind === "unclassified").length, 2);
});

test("a source this cannot read fails instead of reading as clean", () => {
  // #1012's rule: unevaluated is not clean. A shape the reader does not understand must
  // never come back as "no gaps found" — that is a green verdict nobody produced. All
  // three inputs, because each is a separate reader and each can go stale on its own.
  const cases = [
    { workflow: "name: no services here" },
    { workflow: workflowWith(MINIMAL).replace("        env:", "        # env:") },
    { starter: "echo there is no launch line here" },
    { starter: '  ${RUN_CMD} --host x\n' },
    { orchestrator: "echo there is no composer here" },
  ];
  for (const over of cases) {
    const result = check(over.workflow ?? workflowWith(MINIMAL), over);
    assert.equal(result.ok, false, `expected a refusal for: ${JSON.stringify(over).slice(0, 60)}`);
    assert.equal(result.findings[0].kind, "unreadable", `wrong kind for: ${JSON.stringify(over).slice(0, 60)}`);
  }
});

test("the same variable set twice in the service env is refused, not silently halved", () => {
  const result = check(workflowWith([...MINIMAL, 'LANGFLOW_AUTO_LOGIN: "false"']));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].kind, "unreadable");
  assert.match(result.findings[0].message, /set twice/);
});

test("the readers agree with the real files they were written for", () => {
  // The fixtures above are shapes; these are the files. A reader tested only against
  // its own fixtures is a reader that has not been tested.
  const launch = readStarterLaunchEnv(readFileSync(join(REPO_ROOT, "scripts/start-langflow-source.sh"), "utf8"));
  assert.equal(launch.assignments.get("LANGFLOW_AUTO_LOGIN").overridable, false);
  assert.equal(launch.assignments.get("LANGFLOW_DEACTIVATE_TRACING").overridable, true);
  assert.equal(launch.assignments.get("LANGFLOW_DEACTIVATE_TRACING").value, "true");
  assert.equal(launch.flags.get("LANGFLOW_WORKERS").value, "1");

  const mirrored = readMirroredNames(readFileSync(join(REPO_ROOT, "scripts/run-e2e.sh"), "utf8"));
  assert.ok(mirrored.has("LANGFLOW_SQLITE_PRAGMAS"), "the composer no longer carries the pragmas");
  assert.equal(mirrored.size, 4);
});

test("the CLI refuses a bad mode and lists what it knows", () => {
  // The person holding an odd verdict is on the QA VM, not in the unit lane. The same
  // code has to answer both, or the two answers can disagree.
  const cli = spawnSync(process.execPath, [CLI, "--mode=nonsense"], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(cli.status, 2);

  const list = spawnSync(process.execPath, [CLI, "--mode=list"], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /LANGFLOW_SQLITE_PRAGMAS/);
  assert.match(list.stdout, /carried by : orchestrator/);
});

test("the pragmas' value survives being read out of the workflow", () => {
  // The one declared value that is neither a bare word nor a quoted boolean: a
  // single-quoted YAML scalar holding JSON. run-e2e.test.mjs compares the script's
  // default against THIS, so a reader that mangled it would pin the wrong string.
  const declared = readServiceEnv(readFileSync(join(REPO_ROOT, WORKFLOW_PATH), "utf8"));
  const raw = declared.get("LANGFLOW_SQLITE_PRAGMAS");
  assert.ok(raw, "daily-stable.yml no longer sets LANGFLOW_SQLITE_PRAGMAS");
  assert.equal(JSON.parse(evaluateWorkflowValue(raw, {})).foreign_keys, "ON");
});

test("every classification entry carries a reason a human wrote", () => {
  // A one-word reason is the shape this decays into, and it is the shape that stops
  // being worth reading. Cheap to satisfy honestly, and it fails the copy-paste entry.
  for (const [name, entry] of Object.entries(CLASSIFICATION)) {
    assert.ok(entry.reason && entry.reason.length > 30, `${name}'s reason is too thin to act on: ${entry.reason}`);
    assert.ok(
      entry.carrier === null || ["orchestrator", "starter"].includes(entry.carrier),
      `${name} names an unknown carrier: ${entry.carrier}`,
    );
  }
});
