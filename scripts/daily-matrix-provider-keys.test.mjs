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
// Deliberately NOT covered, and hypothetical today rather than a live gap: a file
// gated entirely on `OLLAMA_BASE_URL`. Measured — `ollama-provider.spec.ts` gates at
// RUN time (`test.skip(!probe.reachable, …)`) and lists unconditionally, so no spec
// file is ollama-gated at collection. Ollama is a keyless provider whose gate is a
// base URL the daily does not set anywhere, so there is nothing to keep in step; the
// day a whole spec file IS ollama-gated, that file needs its own decision, not a
// mirrored secret.

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
 * The lines of one named step, and the indent its own keys sit at.
 *
 * Anchored on the exact `- name: <literal>` line, so a step whose name contains a
 * `${{ }}` expression (the shard step does) is matched as written.
 */
function stepBody(workflowText, stepName) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((l) => l.trimStart() === `- name: ${stepName}`);
  assert.ok(
    start > -1,
    `${WORKFLOW} has no step named ${stepName} — this guard is reading the wrong file`,
  );
  const stepIndent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= stepIndent) break;
    end++;
  }
  // `- name:` sits at `stepIndent`; the step's own keys (`env:`, `run:`) are two
  // further in, past the list marker.
  return { lines: lines.slice(start, end), keyIndent: stepIndent + 2 };
}

/**
 * `NAME -> value` for one `env:` block, read at an EXACT indent.
 *
 * Two traps, both borrowed from `scripts/token-sidecar-knobs.test.mjs`, which caught
 * the second one on itself:
 *
 *  - A block scalar's body is indented deeper, and its lines can look like entries.
 *    A `run: |` script containing `OPENAI_API_KEY: unset` would otherwise be read as
 *    a declaration — measured: with that line present and the real keys deleted, the
 *    loose version of this parser passed.
 *  - The block ends at an OUTDENT, never at the first line that is not an entry.
 *    Stopping early reports every later entry as missing, a false red on a lane that
 *    is correctly wired.
 *
 * Comments are skipped rather than parsed, so commenting a key out removes it.
 */
function envEntries(lines, keyIndent) {
  const open = new RegExp(`^ {${keyIndent}}env:\\s*$`);
  const entry = new RegExp(`^ {${keyIndent + 2}}([A-Za-z_][A-Za-z0-9_]*):(.*)$`);
  const outdent = new RegExp(`^ {0,${keyIndent + 1}}\\S`);
  // `run: |`, `if: >-`, … — everything under one is DATA, not YAML, and a shell
  // heredoc inside it can print a line reading `env:`. Measured: with such a line in
  // the listing step's script and the real block moved below `run:`, the scan locked
  // onto the heredoc and reported the correctly-wired keys as absent — a false red
  // naming #1764 on a workflow that does not have it.
  const blockScalar = new RegExp(`^ {${keyIndent}}[A-Za-z_][A-Za-z0-9_-]*:\\s*[|>][-+0-9]*\\s*$`);
  const deeper = new RegExp(`^ {${keyIndent + 1},}\\S`);

  const found = new Map();
  let inside = false;
  let inBlockScalar = false;
  for (const line of lines) {
    if (inBlockScalar) {
      if (line.trim() === "" || deeper.test(line)) continue;
      inBlockScalar = false; // outdented back out — fall through and read this line
    }
    if (blockScalar.test(line)) {
      inBlockScalar = true;
      inside = false;
      continue;
    }
    if (open.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = entry.exec(line);
    if (m) {
      found.set(m[1], m[2].trim());
      continue;
    }
    if (outdent.test(line)) inside = false;
  }
  return found;
}

/**
 * Where a step's environment can legitimately come from: its own `env:`, or the
 * enclosing job's.
 *
 * Job-level `env:` **is** inherited by every step, and an earlier version of this
 * guard asserted the opposite in its own comment and failed a workflow that had
 * hoisted the keys there. That is not a hypothetical shape in this repo — the
 * `test` job carries a job-level block for exactly that reason, and
 * `token-sidecar-knobs.test.mjs` is a guard that REQUIRES job level. A guard that
 * reddens the repo-sanctioned move, naming an issue the workflow does not have, is
 * one a maintainer learns to edit around.
 */
function effectiveEnv(workflowText, stepName) {
  const { lines, keyIndent } = stepBody(workflowText, stepName);
  const own = envEntries(lines, keyIndent);

  const all = workflowText.split("\n");
  const at = all.findIndex((l) => l.trimStart() === `- name: ${stepName}`);
  let jobStart = at;
  while (jobStart >= 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(all[jobStart])) jobStart--;
  let jobEnd = jobStart + 1;
  while (jobEnd < all.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(all[jobEnd])) jobEnd++;
  const job = envEntries(all.slice(jobStart, jobEnd), 4);

  return new Map([...job, ...own]);
}

/**
 * The env keys that gate COLLECTION, derived from `providerConfigMap`.
 *
 * `hasProviderEnvKeys` reads `envKeys`, and only `credential: "api-key"` providers
 * are iterated by the key-subject specs — so this is the set whose absence at
 * listing time can empty a spec file. `declared` is counted without the entry-shape
 * regex, so the vacuity check can compare the parse against the config itself.
 */
function collectionGateKeys() {
  const source = read(PROVIDER_CONFIG);
  const map = source.slice(source.indexOf("export const providerConfigMap = {"));
  const keys = [];
  let parsed = 0;
  for (const [, body] of map.matchAll(/^ {2}\w+: \{$([\s\S]*?)^ {2}\},$/gm)) {
    if (!/credential:\s*"api-key"/.test(body)) continue;
    parsed++;
    const envKeys = body.match(/envKeys:\s*\[([^\]]*)\]/);
    assert.ok(envKeys, `a keyed provider in ${PROVIDER_CONFIG} declares no envKeys`);
    for (const [, name] of envKeys[1].matchAll(/"([^"]+)"/g)) keys.push(name);
  }
  const declared = (map.match(/credential:\s*"api-key"/g) ?? []).length;
  return { keys, parsed, declared };
}

/** The `run:` script of a step, with comment lines dropped. */
function runScript(lines, keyIndent) {
  const at = lines.findIndex((l) => new RegExp(`^ {${keyIndent}}run:`).test(l));
  if (at === -1) return "";
  const outdent = new RegExp(`^ {0,${keyIndent}}\\S`);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && outdent.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    body.push(line);
  }
  return body.join("\n");
}

test("the derivation reads every keyed provider the config declares", () => {
  // Without this the tests below pass vacuously the day the parse stops matching —
  // an empty expectation is met by every workflow, including one that lost the keys
  // again. Compared against the file's OWN count rather than a floor of three: with
  // a constant, adding a fourth keyed provider and reformatting one existing entry
  // left the parse at three, the floor satisfied, and a live collection gate
  // unguarded (measured).
  const { keys, parsed, declared } = collectionGateKeys();
  assert.equal(
    parsed,
    declared,
    `parsed ${parsed} of ${declared} keyed providers in ${PROVIDER_CONFIG} — the parse, not the config, is what changed`,
  );
  assert.ok(declared >= 3, `only ${declared} keyed providers declared — is this the right file?`);
  assert.ok(keys.includes("OPENAI_API_KEY"), `derived keys do not include OPENAI_API_KEY: ${keys.join(", ")}`);
});

test("the listing step carries every key that gates collection, FROM ITS SECRET", () => {
  // The name alone is not the property. `hasProviderEnvKeys` is
  // `every(k => !!process.env[k])`, and Actions defines an unknown secret as the
  // EMPTY STRING — so `OPENAI_API_KEY: ${{ secrets.OPENAI_APIKEY }}`, one character
  // wrong, declares the variable, collects zero tests from the file, and drops it
  // from the matrix exactly as before. Measured: the listing collapses to the
  // pre-fix file set while a names-only guard stays green. Here the spelling IS the
  // behaviour, which is what makes asserting it worth doing.
  const workflow = read(WORKFLOW);
  const listing = effectiveEnv(workflow, LISTING_STEP);
  for (const key of collectionGateKeys().keys) {
    assert.ok(
      listing.has(key),
      `${LISTING_STEP} does not carry ${key}: a spec file generated from it collects zero tests, leaves the matrix, and is run by no shard — silently (#1764)`,
    );
    assert.match(
      listing.get(key) ?? "",
      new RegExp(`^\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}$`),
      `${LISTING_STEP} sets ${key} from something other than secrets.${key} — an unknown secret renders "" and the file leaves the matrix again (#1764)`,
    );
  }
});

test("the shard step carries them too, from the same secrets", () => {
  // The listing decides which files exist; the shard decides which variants run.
  // A key on one side only means the matrix promises a file the run cannot fill,
  // or fills a file the matrix never listed. Both are the same drift — and so is
  // the same NAME on both sides reading two different secrets.
  const workflow = read(WORKFLOW);
  const shard = effectiveEnv(workflow, SHARD_STEP);
  const listing = effectiveEnv(workflow, LISTING_STEP);
  for (const key of collectionGateKeys().keys) {
    assert.ok(
      shard.has(key),
      `${SHARD_STEP} does not carry ${key} — the shards would collect a different suite than the matrix was built from`,
    );
    assert.equal(
      shard.get(key),
      listing.get(key),
      `${key} is set from a different expression on the two steps — they would collect different suites`,
    );
  }
});

test("the env block belongs to the step that actually lists the suite", () => {
  // Guards the move that looks harmless: keeping the keys in the file while the
  // `--list` command drifts to another step, which puts the environment back where
  // it cannot be read.
  // Read from the `run:` SCRIPT with comment lines dropped, not from the step text:
  // moving the real `--list` to an earlier step and leaving behind a comment that
  // mentions it satisfied the loose version of this check (measured), which is
  // #1226's shape — the test pinned the string, not the command.
  const workflow = read(WORKFLOW);
  const { lines, keyIndent } = stepBody(workflow, LISTING_STEP);
  assert.match(
    runScript(lines, keyIndent),
    /--list/,
    `${LISTING_STEP} no longer runs \`--list\` — the provider keys are guarding a step that does not build the matrix`,
  );
});
