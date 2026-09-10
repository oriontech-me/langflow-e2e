// Collection-gate guard for the daily's shard matrix (issue #1764).
// Run with: npm run test:scripts
//
// What this protects, and why review cannot be trusted with it:
//
// `daily-stable.yml` shards by FILE (#936): the `prep` job lists the suite once
// and hands each shard an explicit spec-file list. Some specs generate their tests
// at COLLECTION time from the environment — `provider-invalid-auth-error.spec.ts`
// iterates `keyedProviders` filtered by `hasProviderEnvKeys`. A listing process
// without those keys collects zero tests from such a file, so the file never enters
// the partition and is handed to no shard.
//
// The result is the silent shape: not skipped, not red, ABSENT. There is no row for
// it in any report, `--pass-with-no-tests` keeps the shard green, and the umbrella
// issue is built from what ran — so nothing in the day's output points at the loss.
// That is exactly why it survived from the lane's first day until a cross-lane
// comparison found it (#1764): three `@stable` tests asserting that an invalid API
// key surfaces its error to the user, never once executed.
//
// So the gate is asserted structurally rather than reviewed, and it is DERIVED from
// `providerConfigMap` rather than re-listed here: a provider added there with
// `credential: "api-key"` becomes a collection gate the moment a spec iterates it,
// and this guard must fail then, not after the next comparison.
//
// Deliberately NOT covered: a file gated entirely on `OLLAMA_BASE_URL`. Ollama is a
// keyless provider whose gate is a base URL the daily does not set anywhere, so
// there is nothing to keep in step; the day a whole spec file is ollama-gated, that
// file needs its own decision, not a mirrored secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW = ".github/workflows/daily-stable.yml";
const LISTING_STEP = "Compute duration-balanced shard matrix";
const SHARD_STEP = "Run @stable tests (shard ${{ matrix.shard }})";
const PROVIDER_CONFIG = "tests/helpers/provider-setup/provider-config.ts";

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * The env variable NAMES a step declares.
 *
 * Read from the step's own `env:` block and nowhere else: a name that moved to
 * `jobs.*.env` or onto a neighbouring step would still be "in the file", and the
 * listing process would still not see it — which is the whole failure being guarded.
 */
function stepEnvNames(workflowText, stepName) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex(
    (l) => l.trimStart().startsWith("- name:") && l.slice(l.indexOf("- name:") + 7).trim() === stepName,
  );
  assert.ok(start > -1, `${WORKFLOW} has no step named ${stepName} — this guard is reading the wrong file`);

  const stepIndent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= stepIndent) break;
    end++;
  }

  const body = lines.slice(start, end);
  const envAt = body.findIndex((l) => /^\s+env:\s*$/.test(l));
  if (envAt === -1) return [];
  const envIndent = body[envAt].length - body[envAt].trimStart().length;

  const names = [];
  for (const line of body.slice(envAt + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() === "") continue;
    if (indent <= envIndent) break; // dedent ends the block (`run: |`, next step, …)
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * The env keys that gate COLLECTION, derived from `providerConfigMap`.
 *
 * `hasProviderEnvKeys` reads `envKeys`, and only `credential: "api-key"` providers
 * are iterated by the key-subject specs — so this is the set whose absence at
 * listing time can empty a spec file.
 */
function collectionGateKeys() {
  const source = read(PROVIDER_CONFIG);
  const map = source.slice(source.indexOf("export const providerConfigMap = {"));
  const keys = [];
  for (const [, body] of map.matchAll(/^ {2}\w+: \{$([\s\S]*?)^ {2}\},$/gm)) {
    if (!/credential:\s*"api-key"/.test(body)) continue;
    const envKeys = body.match(/envKeys:\s*\[([^\]]*)\]/);
    assert.ok(envKeys, `a keyed provider in ${PROVIDER_CONFIG} declares no envKeys`);
    for (const [, name] of envKeys[1].matchAll(/"([^"]+)"/g)) keys.push(name);
  }
  return keys;
}

test("the derivation actually finds the keyed providers", () => {
  // Without this the two tests below pass vacuously the day the parse stops
  // matching — an empty expectation is met by every workflow, including one that
  // lost the keys again.
  const keys = collectionGateKeys();
  assert.ok(
    keys.length >= 3,
    `only ${keys.length} collection-gating env keys derived from ${PROVIDER_CONFIG} — the parse, not the config, is what changed`,
  );
  assert.ok(keys.includes("OPENAI_API_KEY"), `derived keys do not include OPENAI_API_KEY: ${keys.join(", ")}`);
});

test("the listing step carries every key that gates collection", () => {
  const workflow = read(WORKFLOW);
  const listing = stepEnvNames(workflow, LISTING_STEP);
  for (const key of collectionGateKeys()) {
    assert.ok(
      listing.includes(key),
      `${LISTING_STEP} does not carry ${key}: a spec file generated from it collects zero tests, leaves the matrix, and is run by no shard — silently (#1764)`,
    );
  }
});

test("the shard step carries them too, so the matrix describes the run", () => {
  // The listing decides which files exist; the shard decides which variants run.
  // A key on one side only means the matrix promises a file the run cannot fill,
  // or fills a file the matrix never listed. Both are the same drift.
  const workflow = read(WORKFLOW);
  const shard = stepEnvNames(workflow, SHARD_STEP);
  for (const key of collectionGateKeys()) {
    assert.ok(
      shard.includes(key),
      `${SHARD_STEP} does not carry ${key} — the shards would collect a different suite than the matrix was built from`,
    );
  }
});

test("the env block belongs to the step that actually lists the suite", () => {
  // Guards the move that looks harmless: keeping the keys in the file while the
  // `--list` command drifts to another step, which puts the environment back where
  // it cannot be read.
  const workflow = read(WORKFLOW);
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.trimStart() === `- name: ${LISTING_STEP}`);
  assert.ok(start > -1, `${WORKFLOW} has no step named ${LISTING_STEP}`);
  const stepIndent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const indent = lines[end].length - lines[end].trimStart().length;
    if (lines[end].trim() !== "" && indent <= stepIndent) break;
    end++;
  }
  assert.ok(
    lines.slice(start, end).some((l) => l.includes("--list")),
    `${LISTING_STEP} no longer runs \`--list\` — the provider keys are guarding a step that does not build the matrix`,
  );
});
