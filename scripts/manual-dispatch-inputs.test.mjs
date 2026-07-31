// Structural guard: every `manual.yml` dispatch input reaches BOTH target jobs, or
// is refused out loud by the one that cannot honour it.
//
// `manual.yml` has two mutually exclusive run jobs — `e2e-docker` (a container this
// runner starts) and `e2e-url` (a Langflow we neither host nor share a network
// with) — but ONE dispatch form. Nothing in the form says which job an input
// applies to, so an input wired into one job and forgotten in the other is
// indistinguishable, from the dispatcher's side, from an input that did nothing.
//
// That is not hypothetical: #1187 added `any_completion_provider` and `retries` at
// the `e2e-docker` job level and `e2e-url` got neither. Routing was the visible
// half and was handled — the URL job FAILS when it is requested, because honouring
// it silently would run the routed specs on a hosted provider while the dispatch
// summary said `ollama`. `retries` was the invisible half: a dispatcher passing
// "0" to measure a candidate spec for the adoption gate would have got the config
// default (2 in CI) on an external target, and a run that retried its way to green
// is precisely the evidence the gate is designed to reject.
//
// So the rule this pins is the one that distinguishes the two: an input is either
// HONOURED or REFUSED, never ignored. Line-based rather than YAML-parsed, matching
// the gate-order guard in `wait-for-backend.test.mjs` — the repo ships no YAML
// parser, and what is under test is which text appears inside which job block.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW = path.resolve(
  import.meta.dirname,
  "..",
  ".github/workflows/manual.yml",
);

const text = fs.readFileSync(WORKFLOW, "utf-8");

/**
 * The body of a top-level job, from `  <id>:` to the next top-level job.
 *
 * Fails loudly on a job it cannot find rather than returning "" — an empty string
 * would make every `assert.match` below fail with a message about the assertion
 * instead of about the rename that actually broke it.
 */
function jobBlock(id) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${id}:`);
  assert.notEqual(
    start,
    -1,
    `job "${id}" not found in manual.yml — it was renamed or removed; update this guard together with the workflow`,
  );
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every `<name>:` declared under `on.workflow_dispatch.inputs`. */
function dispatchInputs() {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "inputs:");
  assert.notEqual(start, -1, "manual.yml declares no workflow_dispatch inputs");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^jobs:/.test(lines[i])) break;
    const m = /^ {6}([a-z0-9_]+):\s*$/.exec(lines[i]);
    if (m) names.push(m[1]);
  }
  return names;
}

test("the dispatch form still declares the inputs this guard is about", () => {
  const inputs = dispatchInputs();
  for (const name of [
    "langflow_target",
    "langflow_image",
    "test_tag",
    "test_grep",
    "any_completion_provider",
    "retries",
  ]) {
    assert.ok(inputs.includes(name), `input "${name}" is gone from manual.yml`);
  }
});

test("retries reaches BOTH run jobs — the input is target-kind agnostic", () => {
  for (const id of ["e2e-docker", "e2e-url"]) {
    assert.match(
      jobBlock(id),
      /PLAYWRIGHT_RETRIES: \$\{\{ github\.event\.inputs\.retries \}\}/,
      `job "${id}" does not pass the retries input to Playwright. An unwired ` +
        `retry count is silent: the dispatcher asked for an unamplified run and ` +
        `got the config default instead, with nothing in the log to say so.`,
    );
  }
});

test("a non-numeric retries value is rejected before either job runs", () => {
  // `Number("O")` is NaN and Playwright falls back to its own default, so the
  // validation cannot live in the config — it has to happen where the input is
  // still a string. `detect-target` is the only job both run jobs depend on.
  const block = jobBlock("detect-target");
  assert.match(block, /Validate the retries input/);
  assert.match(block, /\*\[!0-9\]\*/, "the guard must reject any non-digit");
  assert.match(block, /exit 1/);
});

test("the input e2e-url cannot honour is REFUSED there, not ignored", () => {
  // The asymmetry is deliberate and is the whole point of the rule: this job
  // targets a Langflow that is not on the runner's network, so it can never reach
  // the Ollama service container. Running the routed specs on a hosted provider
  // while the dispatch summary said `ollama` would be green, spend keys, and prove
  // nothing (#1012).
  const block = jobBlock("e2e-url");
  assert.match(block, /Reject local-model routing on an external target/);
  assert.match(
    block,
    /if: github\.event\.inputs\.any_completion_provider == 'ollama'/,
  );
  assert.match(block, /::error::/);
  assert.match(block, /exit 1/);

  // And it must refuse BEFORE doing any work, or the dispatcher pays for a
  // checkout, an npm ci and a browser install to be told no.
  const lines = block.split("\n");
  const reject = lines.findIndex((l) => /Reject local-model routing/.test(l));
  const checkout = lines.findIndex((l) => /actions\/checkout/.test(l));
  assert.ok(
    reject !== -1 && checkout !== -1 && reject < checkout,
    "the rejection must be the first step of e2e-url",
  );
});

test("routing is wired into e2e-docker, and 'hosted' maps to the empty string", () => {
  // The choice is worded for the dispatcher ("hosted"), the variable for the code
  // (empty = not routed, which is what `resolveTestTargets` reads). A literal
  // "hosted" reaching the resolver would be reported as an unknown provider and
  // skip every any-completion spec.
  const block = jobBlock("e2e-docker");
  assert.match(block, /ANY_COMPLETION_PROVIDER:/);
  assert.match(
    block,
    /any_completion_provider == 'ollama' && 'ollama' \|\| ''/,
    "the 'hosted' choice must resolve to an EMPTY ANY_COMPLETION_PROVIDER",
  );
});
