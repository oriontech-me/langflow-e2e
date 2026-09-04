// Unit tests for scripts/lib/vm-env-parity.mjs and its CLI.
// Run with: npm run test:scripts
//
// What these protect. The guard's job is to fail when daily-stable.yml gains a service
// variable the VM lane neither carries nor classifies — and the reason it has to be a
// guard rather than a hand audit is that half of what it catches produces AGREEMENT
// rather than failure, so no run can find it (#1717). A guard for an invisible class
// is worth exactly what its own tests are worth, hence the shape below: every
// assertion is driven by a MUTATED workflow, never by the wording of a line.
//
// The two failures this file is written against, both learned in #1716's review:
//   - a comment merely SPELLING a variable must not answer for a real setting, in
//     either direction — it must not mask one, and it must not fail a correct workflow
//   - the read is scoped to the SERVICE block, because daily-stable.yml also sets
//     LANGFLOW_IMAGE and LANGFLOW_VERSION as step env in later jobs, where they name
//     the image to report rather than configure the instance under test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readServiceEnv, checkVmEnvParity, CLASSIFICATION, WORKFLOW_PATH } from "./lib/vm-env-parity.mjs";
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

const MINIMAL = ["LANGFLOW_AUTO_LOGIN: \"true\"", "LANGFLOW_DEACTIVATE_TRACING: \"false\""];
const CLASSES = {
  LANGFLOW_AUTO_LOGIN: { carrier: "starter", reason: "auto-login" },
  LANGFLOW_DEACTIVATE_TRACING: { carrier: "orchestrator", reason: "tracing" },
};
const check = (workflow, over = {}) =>
  checkVmEnvParity({
    workflow,
    orchestrator: "LANGFLOW_DEACTIVATE_TRACING=x",
    starter: "LANGFLOW_AUTO_LOGIN=true",
    classification: CLASSES,
    ...over,
  });

test("the repository as it stands passes, and the CLI agrees", () => {
  // Not a tautology: it is the assertion that keeps the three variables #1717 named
  // present. Delete one from run-e2e.sh and this fails.
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
  assert.ok(found, `expected a finding for the new variable, got: ${JSON.stringify(result.findings)}`);
  assert.equal(found.kind, "unclassified");
  // The message has to say what to DO, because the reader meeting it is mid-edit on
  // the workflow and has no reason to know this file exists.
  assert.match(found.message, /run-e2e\.sh/);
  assert.match(found.message, /out of scope with a reason/);
});

test("a comment naming a variable is not a setting", () => {
  // #1300's failure, and #1716's first draft reintroduced it: a `#` line spelling a
  // variable both masks a real setting and FAILS A CORRECT WORKFLOW. Here it would
  // invent an unclassified variable out of prose.
  const result = check(
    workflowWith([...MINIMAL, "# LANGFLOW_BRAND_NEW_KNOB is deliberately not set here", "# LANGFLOW_ALSO_NOT_SET: yes"]),
  );
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
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

test("a variable classified as carried, that its carrier never names, fails", () => {
  // The half a classification table cannot promise on its own: an entry saying
  // run-e2e.sh carries a value is a claim about another file, and claims rot.
  const result = check(workflowWith(MINIMAL), { orchestrator: "# the tracing line was deleted here" });
  assert.equal(result.ok, false);
  const found = result.findings.find((f) => f.name === "LANGFLOW_DEACTIVATE_TRACING");
  assert.equal(found?.kind, "not-carried");
  assert.match(found.message, /scripts\/run-e2e\.sh/);
});

test("a carrier's own comments do not count as carrying", () => {
  // Same asymmetry as the workflow side. A script that only MENTIONS a variable in a
  // comment — "we deliberately do not set LANGFLOW_X" — has not carried it, and the
  // most likely way this guard would be defeated is by satisfying it with prose.
  const result = check(workflowWith(MINIMAL), {
    orchestrator: "# LANGFLOW_DEACTIVATE_TRACING is handled elsewhere\necho hi",
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.find((f) => f.name === "LANGFLOW_DEACTIVATE_TRACING")?.kind, "not-carried");
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
    classification: { ...CLASSES, LANGFLOW_AUTO_LOGIN: { carrier: null, reason: "a container-only concept" } },
  });
  assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
  assert.equal(result.carried.find((c) => c.name === "LANGFLOW_AUTO_LOGIN").carrier, null);
});

test("a classification for a variable the workflow dropped fails as stale", () => {
  // A reason that outlives its variable is worse than no reason: a future reader will
  // trust it about a decision that no longer exists.
  const result = check(workflowWith(MINIMAL), {
    classification: { ...CLASSES, LANGFLOW_LONG_GONE: { carrier: "starter", reason: "was a thing once" } },
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

test("a workflow this cannot read fails instead of reading as clean", () => {
  // #1012's rule: unevaluated is not clean. A shape the reader does not understand
  // must never come back as "no gaps found" — that is a green verdict nobody produced.
  for (const broken of ["name: no services here", workflowWith([]).replace("        env:", "        # env:")]) {
    const result = check(broken);
    assert.equal(result.ok, false, `expected a refusal for: ${broken.slice(0, 40)}`);
    assert.equal(result.findings[0].kind, "unreadable");
  }
});

test("the same variable set twice in the service env is refused, not silently halved", () => {
  const result = check(workflowWith([...MINIMAL, 'LANGFLOW_AUTO_LOGIN: "false"']));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].kind, "unreadable");
  assert.match(result.findings[0].message, /set twice/);
});

test("the CLI exits 1 on a gap and names it, so the lane and a terminal agree", () => {
  // The person holding an odd verdict is on the QA VM, not in the unit lane. Same code
  // has to answer both, or the two answers can disagree.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { checkVmEnvParity } from ${JSON.stringify(join(HERE, "lib/vm-env-parity.mjs"))};
    const r = checkVmEnvParity({
      workflow: ${JSON.stringify(workflowWith([...MINIMAL, 'LANGFLOW_SURPRISE: "1"']))},
      orchestrator: "LANGFLOW_DEACTIVATE_TRACING", starter: "LANGFLOW_AUTO_LOGIN",
      classification: ${JSON.stringify(CLASSES)},
    });
    process.stdout.write(JSON.stringify(r.findings.map((f) => f.name)));
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["LANGFLOW_SURPRISE"]);

  const cli = spawnSync(process.execPath, [CLI, "--mode=nonsense"], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(cli.status, 2);
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
