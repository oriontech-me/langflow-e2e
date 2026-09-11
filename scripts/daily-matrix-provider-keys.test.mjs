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
// file is ollama-gated at collection.
//
// An earlier version of this comment said the daily "does not set it anywhere". It
// does: `daily-stable.yml` sets `OLLAMA_BASE_URL` at the **test job** level and not
// in `prep` — i.e. the listing-vs-shard asymmetry this guard is about already exists
// for that variable, and is harmless only because nothing gates on it at COLLECTION
// time. A mirrored value would be wrong anyway: the service hostname the shards
// reach does not resolve in `prep`. The day a whole spec file IS ollama-gated, that
// file needs its own decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./lib/tmp-dir.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW = ".github/workflows/daily-stable.yml";
const LISTING_STEP = "Compute duration-balanced shard matrix";
const SHARD_STEP = "Run @stable tests (shard ${{ matrix.shard }})";
const PROVIDER_CONFIG = "tests/helpers/provider-setup/provider-config.ts";

// Every read goes through this. `trimStart()` does not strip a trailing `\r`, so on a
// CRLF checkout the STEP is never found and every tolerance below is unreachable —
// the guard reds on a correct workflow with "has no step named …". Split out from
// `read` so the property is assertable without a CRLF fixture on disk.
const normalise = (text) => text.replace(/\r\n/g, "\n");
const read = (rel) => normalise(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));

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
  const entry = new RegExp(`^ {${keyIndent + 2}}([A-Za-z_][A-Za-z0-9_]*):(.*?)$`);
  const outdent = new RegExp(`^ {0,${keyIndent + 1}}\\S`);
  // No block-scalar guard, deliberately. An earlier version carried one and claimed a
  // measurement for it; both were wrong. A block scalar's body must be indented
  // DEEPER than its key, and `open` matches at exactly `keyIndent`, so no body line
  // can ever be read as an `env:` block — removing the guard changed no input, and a
  // differential run over random fragments found none either. A heredoc printing an
  // env block is already handled by that arithmetic, which is what the tests pin.

  const found = new Map();
  let inside = false;
  for (const line of lines) {
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
  // Three layers, lowest first. Workflow level was missing and reddened a correct
  // hoist exactly as job level once did — the same "maintainer learns to edit around
  // the guard" failure, one scope short. `daily-stable.yml` has no workflow-level
  // `env:` today; the layer exists so moving the keys there is a refactor, not a red.
  const jobsAt = all.findIndex((l) => /^jobs:\s*$/.test(l));
  const top = envEntries(all.slice(0, jobsAt === -1 ? all.length : jobsAt), 0);
  const at = all.findIndex((l) => l.trimStart() === `- name: ${stepName}`);
  let jobStart = at;
  while (jobStart >= 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(all[jobStart])) jobStart--;
  let jobEnd = jobStart + 1;
  while (jobEnd < all.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(all[jobEnd])) jobEnd++;
  const job = envEntries(all.slice(jobStart, jobEnd), 4);

  return new Map([...top, ...job, ...own]);
}

/**
 * The env keys that gate COLLECTION, derived from `providerConfigMap`.
 *
 * `hasProviderEnvKeys` reads `envKeys`, and only `credential: "api-key"` providers
 * are iterated by the key-subject specs — so this is the set whose absence at
 * listing time can empty a spec file. `declared` is counted without the entry-shape
 * regex, so the vacuity check can compare the parse against the config itself.
 */
function collectionGateKeys(sourceText) {
  const source = sourceText ?? read(PROVIDER_CONFIG);
  const start = source.indexOf("export const providerConfigMap = {");
  // Bounded at the map's close, not run to EOF: any later `credential: "api-key"` —
  // one sentence added to a doc comment does it — inflated `declared`, and the
  // vacuity test then reported "the parse, not the config, is what changed", which
  // is precisely backwards.
  // Column-0 anchored: `} satisfies` matched anywhere truncated the map at the first
  // occurrence, hiding every provider declared after it while `parsed === declared`
  // still held — the vacuity hole, reopened by the bound that was meant to close it.
  const close = source.indexOf("\n} satisfies", start);
  // And an anchor that cannot be found is UNKNOWN, not a pass-through (#1012):
  // running to EOF restored the very false red this bound exists to prevent.
  assert.ok(
    close !== -1,
    `${PROVIDER_CONFIG}: no column-0 \`} satisfies\` closes providerConfigMap — the parse, not the config, changed`,
  );
  const map = source.slice(start, close);
  const keys = [];
  let parsed = 0;
  for (const [, body] of map.matchAll(/^ {2}\w+: \{$([\s\S]*?)^ {2}\},$/gm)) {
    if (!/credential:\s*"api-key"/.test(body)) continue;
    parsed++;
    const envKeys = body.match(/envKeys:\s*\[([^\]]*)\]/);
    assert.ok(envKeys, `a keyed provider in ${PROVIDER_CONFIG} declares no envKeys`);
    const before = keys.length;
    // Either quote: the repo lints neither quote style nor runs Prettier, so a
    // single-quoted array parsed to ZERO names while `parsed === declared` still
    // held — the guard then iterated a shorter list and went green over a workflow
    // missing that very key (measured). The per-provider floor closes the class
    // rather than this one spelling.
    for (const [, name] of envKeys[1].matchAll(/["']([^"']+)["']/g)) keys.push(name);
    assert.ok(
      envKeys[1].trim() !== "",
      `a keyed provider in ${PROVIDER_CONFIG} declares an EMPTY envKeys — decide what gates it before this guard can mirror it`,
    );
    assert.ok(
      keys.length > before,
      `envKeys for a keyed provider in ${PROVIDER_CONFIG} parsed to zero names — the parse, not the config, changed`,
    );
  }
  const declared = (map.match(/credential:\s*"api-key"/g) ?? []).length;
  return { keys, parsed, declared };
}

/**
 * One env value, read the way YAML reads it.
 *
 * A trailing `# comment` is not part of a plain scalar, and `"${{ … }}"` is the same
 * expression as `${{ … }}` — the shard step this guard also reads already writes
 * `CI: "true"` and `PLAYWRIGHT_BASE_URL: "http://localhost:7860/"`. Matching the raw text reddened
 * both shapes with a message asserting the opposite of what had happened, which is
 * the failure mode this guard exists to avoid being.
 */
function scalar(value) {
  return (value ?? "")
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
}

/** The `run:` script of a step, with comment lines dropped. */
function runScript(lines, keyIndent) {
  const at = lines.findIndex((l) => new RegExp(`^ {${keyIndent}}run:`).test(l));
  if (at === -1) return "";
  const outdent = new RegExp(`^ {0,${keyIndent}}\\S`);
  // The inline remainder counts: `run: npx playwright test … --list` is a shape this
  // file already uses elsewhere, and dropping it reported a step that does run
  // `--list` as one that does not.
  // Comment-stripped like the body lines below it. Seeding it raw traded one false
  // red for a false GREEN of the same shape: on an inline `run:` — a plain YAML
  // scalar, where ` #` really is a comment — `run: … --reporter=json # was --list`
  // satisfied the gate on a step that no longer lists anything.
  // Trailing comments are stripped on EVERY line, inline seed and block body alike.
  // Stripping only the seed closed a shape this repo does not use while leaving the
  // one it does: the real listing step is `run: |`, and demoting its command to
  // `… --reporter=json  # was --list` passed the gate on a step that lists nothing.
  // Not a YAML comment inside a block scalar — a SHELL one — which is why the body
  // loop already dropped full-line `#`, and why this file's own script carries
  // `esac      # non-numeric → default 4` two lines from the command.
  const decomment = (line) => line.replace(/\s+#.*$/, "");
  const body = [decomment(lines[at].slice(lines[at].indexOf("run:") + 4))];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && outdent.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    body.push(decomment(line));
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
      scalar(listing.get(key)),
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
      scalar(shard.get(key)),
      scalar(listing.get(key)),
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

// --- the helpers, on synthetic YAML ------------------------------------------
//
// The four tests above read the REAL workflow, which is what they are for — but it
// means every regression in the parser has only ever been found by someone mutating
// that workflow by hand. Three review rounds each found one this way, and each fix
// opened the next: a tolerance added for a correct shape turned into a false GREEN on
// a broken one. These pin the helpers directly, so the next one fails in the lane.
//
// Each case names the shape it stands for; none of them touches the real file.

const STEP = (body) => `jobs:\n  prep:\n    steps:\n      - name: S\n${body}`;

test("envEntries reads a step's env: and nothing that merely looks like one", () => {
  const entries = (body) => envEntries(stepBody(STEP(body), "S").lines, 8);

  // The value is taken whole, comments and all — `scalar()` decides what it means.
  assert.deepEqual(
    [...entries(`        env:\n          A: 1\n          B: two words  # note\n`)],
    [["A", "1"], ["B", "two words  # note"]],
  );
  // A heredoc printing an env block declares nothing — because a block scalar's body
  // is indented deeper than its key and `open` matches at the key's own indent. That
  // arithmetic is the whole mechanism; an earlier version added a guard for this and
  // claimed a measurement, and removing the guard changed no input.
  assert.deepEqual(
    [...entries(`        run: |\n          cat <<'EOF'\n            env:\n              A: 1\n          EOF\n`)],
    [],
  );
  // ...and the real block after it is still found.
  assert.deepEqual(
    [...entries(`        run: |\n          echo hi\n        env:\n          A: 1\n`)],
    [["A", "1"]],
  );
  // A comment inside the block is not an entry, and the case has to sit at the KEY's
  // own indent: at the entry indent `entry` already rejects it and `outdent` cannot
  // match, so the assertion passes with the comment-skip removed and proves nothing.
  // At indent 8 the skip is the only thing standing between a maintainer's separator
  // comment and a false red on a correctly-wired workflow.
  assert.deepEqual(
    [...entries(`        env:\n        # --- the collection gate ---\n          A: 1\n`)],
    [["A", "1"]],
  );
  // The block ends at an OUTDENT, never at the first line that is not an entry — a
  // folded value continues on a deeper line.
  assert.deepEqual(
    [...entries(`        env:\n          A: >-\n            folded\n          B: 2\n`)],
    [["A", ">-"], ["B", "2"]],
  );
});

test("a CRLF checkout is normalised before anything tries to find a step", () => {
  // `trimStart()` does not strip `\r`, so without this the STEP is never found and
  // every tolerance below it is unreachable — the guard reds on a correct workflow
  // with "has no step named …", which is how the first attempt at this fix looked
  // like it worked while changing nothing a reader would see.
  const yaml = STEP(`        env:\n          A: 1\n`);
  assert.throws(() => stepBody(yaml.replace(/\n/g, "\r\n"), "S"), /has no step named/);
  assert.deepEqual(
    [...envEntries(stepBody(normalise(yaml.replace(/\n/g, "\r\n")), "S").lines, 8)],
    [["A", "1"]],
  );
});

test("scalar reads a value the way YAML does, and cannot launder a wrong one", () => {
  assert.equal(scalar("${{ secrets.X }}"), "${{ secrets.X }}");
  assert.equal(scalar('"${{ secrets.X }}"'), "${{ secrets.X }}");
  assert.equal(scalar("${{ secrets.X }}  # the third gate"), "${{ secrets.X }}");
  // A `#` without leading whitespace is part of the value, not a comment.
  assert.equal(scalar("sk-a#b"), "sk-a#b");
  // The laundering attempt: a comment cannot complete a broken quote pair.
  assert.notEqual(scalar('"${{ secrets.X }} # tail'), "${{ secrets.X }}");
  assert.equal(scalar(undefined), "");
});

test("runScript returns the command, inline or block, without its comments", () => {
  const script = (body) => runScript(stepBody(STEP(body), "S").lines, 8);
  assert.match(script(`        run: npx playwright test --list\n`), /--list/);
  // The seed is comment-stripped like the body: this is the false GREEN that a raw
  // seed introduced — an inline command that no longer lists, with `--list` surviving
  // only in its trailing comment.
  assert.doesNotMatch(script(`        run: npx playwright test --reporter=json # was --list\n`), /--list/);
  assert.doesNotMatch(script(`        run: |\n          # was --list\n          npx playwright test\n`), /--list/);
  assert.match(script(`        run: |\n          npx playwright test --list\n`), /--list/);
  // The block form is the one the real listing step uses, and stripping only the
  // inline seed left this open: a trailing shell comment on a body line laundered
  // `--list` onto a step that no longer lists.
  assert.doesNotMatch(
    script(`        run: |\n          npx playwright test --reporter=json  # was --list\n`),
    /--list/,
  );
  // ...while a `#` that is part of the command survives.
  assert.match(script(`        run: |\n          npx playwright test --list --grep "a#b"\n`), /--list/);
});

test("the derivation is anchored at column 0 and refuses to guess", () => {
  const map = (extra = "", tail = "\n} satisfies Record<Provider, ProviderConfig>;\n") =>
    `export const providerConfigMap = {\n` +
    `  openai: {\n    credential: "api-key",\n    envKeys: ["OPENAI_API_KEY"],\n  },\n` +
    extra +
    tail;

  assert.deepEqual(collectionGateKeys(map()).keys, ["OPENAI_API_KEY"]);
  // Either quote style: the repo lints neither, and a double-quote-only match parsed
  // a single-quoted array to zero names while every other check still held.
  assert.deepEqual(
    collectionGateKeys(map(`  cohere: {\n    credential: "api-key",\n    envKeys: ['COHERE_API_KEY'],\n  },\n`)).keys,
    ["OPENAI_API_KEY", "COHERE_API_KEY"],
  );
  // An INDENTED `} satisfies` must not truncate the map and hide what follows it.
  assert.equal(
    collectionGateKeys(
      map(`  // helper } satisfies nothing\n  cohere: {\n    credential: "api-key",\n    envKeys: ["COHERE_API_KEY"],\n  },\n`),
    ).declared,
    2,
  );
  // No column-0 close is UNKNOWN, not "run to end of file" (#1012).
  assert.throws(() => collectionGateKeys(map("", "\n  } satisfies X;\n")), /no column-0/);
  // An empty envKeys is the CONFIG changing, and says so.
  assert.throws(
    () => collectionGateKeys(map(`  cohere: {\n    credential: "api-key",\n    envKeys: [],\n  },\n`)),
    /declares an EMPTY envKeys/,
  );
});

// ---------------------------------------------------------------------------
// THE LISTING SAYS WHICH GATE IT RESOLVED — and cannot die trying (#1813)
// ---------------------------------------------------------------------------
// The env block above is the fix for #1764; this is the report that makes the same
// state readable a day later. `scripts/collection-gate-keys.ts` runs in this step,
// before the `--list` it describes, and its answer rides onto the day's history row
// so a cross-lane test-count difference resolves to a cause instead of a hypothesis.
//
// Two properties, and the second is the one review cannot hold. The report is
// REPORTING: this step runs under `bash -eo pipefail` and its product is the shard
// matrix, so a gate that cannot answer must degrade to a warning — an aborted `prep`
// is a daily that never ran, traded for a field. And it must not answer WRONGLY: a
// field renamed on the TypeScript side leaves the `sed`s matching nothing, which
// would write "this run never measured its gate" onto a run that measured fine —
// the one state the present/absent pair exists to distinguish. Both are exercised by
// RUNNING the step's own script with a stubbed resolver, because every assertion
// about a shell that is only a regex over the YAML passes the mutation it exists to
// catch (#1226).

/**
 * The listing step's `run:` script, comments dropped, as bash would see it.
 *
 * `runScript` keeps the block-scalar indicator it finds after `run:` — harmless where
 * every other caller only pattern-matches the text, and a bash SYNTAX ERROR the moment
 * one is executed, since a lone `|` is a pipe with nothing on either side. Dropped
 * here rather than in `runScript`, whose callers above assert on what YAML wrote.
 */
function listingScript() {
  const { lines, keyIndent } = stepBody(read(WORKFLOW), LISTING_STEP);
  return runScript(lines, keyIndent).replace(/^[ \t]*\|-?[ \t]*\n/, "");
}

/**
 * Runs that script with `npx` stubbed, and reports what it did.
 *
 * The stub answers `npx ts-node …` with `gate` (or `rc`), and makes `npx playwright`
 * announce itself and fail — so under `-e` the script stops at the listing instead of
 * reaching `node scripts/partition-shards.mjs`. `listed` is therefore the question
 * these cases are really about: did the run get PAST the gate?
 */
function runListingStep({ gate = "", rc = 0 } = {}) {
  const dir = makeTempDir("listing-gate-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "gate.txt"), gate);
  fs.writeFileSync(
    path.join(bin, "npx"),
    [
      "#!/usr/bin/env bash",
      `if [ "$1" = "ts-node" ]; then cat ${JSON.stringify(path.join(dir, "gate.txt"))}; exit ${rc}; fi`,
      'echo "REACHED_LISTING $*" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  const script = path.join(dir, "step.sh");
  fs.writeFileSync(script, listingScript());
  const out = path.join(dir, "github-output");
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", ["-e", "-o", "pipefail", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHARDS: "1", GITHUB_OUTPUT: out },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    output: fs.readFileSync(out, "utf8"),
    listed: /REACHED_LISTING .*--list/.test(r.stderr ?? ""),
  };
}

const GATE_BLOCK = [
  "keys=OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY",
  "present=OPENAI_API_KEY ANTHROPIC_API_KEY",
  "absent=GOOGLE_API_KEY",
  "providers_listed=openai anthropic",
  "providers_absent=google",
  "complete=false",
  "summary=listing with openai, anthropic; GOOGLE_API_KEY absent",
  "",
].join("\n");

test("the gate is resolved BEFORE the suite is listed, which is the whole contract", () => {
  // A report produced after the partition describes an environment nobody can act on.
  // Read with COMMENT LINES DROPPED: the comment above the resolver names the `--list`
  // it precedes, so an ordering read off the prose would pass on a step whose commands
  // are in the wrong order.
  const script = listingScript();
  const gate = script.indexOf("scripts/collection-gate-keys.ts");
  const list = script.indexOf("npx playwright test");
  assert.ok(gate > -1, `${LISTING_STEP} no longer resolves the collection gate`);
  assert.ok(list > -1, `${LISTING_STEP} no longer lists the suite`);
  assert.ok(gate < list, "the gate is resolved after the listing it describes");
});

test("the field names this step parses are the ones the resolver actually emits", () => {
  // The seam. Every case below feeds the step a HAND-WRITTEN block, so a field renamed
  // on the TypeScript side would leave them all green while the real run parsed
  // nothing. So the real resolver runs once, and the names are read out of the YAML
  // rather than restated here.
  const emitted = execFileSync("npx", ["ts-node", "scripts/collection-gate-keys.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "a" },
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf("=")));

  const script = listingScript();
  const parsed = [
    ...[...script.matchAll(/sed -n 's\/\^([a-z_]+)=/g)].map((m) => m[1]),
    ...[...script.matchAll(/grep -q '\^([a-z_]+)='/g)].map((m) => m[1]),
  ];
  assert.ok(parsed.length >= 4, `${LISTING_STEP} parses only ${parsed.length} field(s) — this test reads the wrong place`);
  for (const field of parsed) {
    assert.ok(
      emitted.includes(field),
      `${LISTING_STEP} reads \`${field}=\`, which the resolver does not emit (it emits: ${emitted.join(", ")})`,
    );
  }
});

test("a resolved gate becomes the step's two outputs, present and absent both", () => {
  const r = runListingStep({ gate: GATE_BLOCK });
  assert.match(r.output, /^collection_gate_keys=OPENAI_API_KEY ANTHROPIC_API_KEY$/m);
  assert.match(r.output, /^collection_gate_keys_absent=GOOGLE_API_KEY$/m);
  assert.match(r.stdout, /listing gate: listing with openai, anthropic/);
  assert.ok(r.listed, "the step did not go on to list the suite");
});

test("a gate that cannot answer warns and the matrix is still built", () => {
  // REPORTING, not a gate on the day. The VM twin dies on this state on purpose —
  // there the run's product is the cross-lane comparison — but here an abort costs
  // the whole daily, so the row simply carries no block and the comparator reports
  // parity UNVERIFIED, which is the pre-#1813 state plus a warning.
  const r = runListingStep({ gate: "", rc: 2 });
  assert.match(r.stdout, /::warning::could not resolve the collection-gating provider keys/);
  assert.equal(r.output, "", `a failed resolver wrote outputs anyway: ${r.output}`);
  assert.ok(r.listed, "a failed gate report stopped the shard matrix");
});

test("a renamed field is caught, not written onto the row as 'never measured'", () => {
  // Exit 0 with a block this parse cannot read is the drift case, and it fails in the
  // worst direction available: both `sed`s match nothing, the row carries no block,
  // and a fully-keyed run reads as one that never measured its gate.
  for (const gate of ["PRESENT=OPENAI_API_KEY\nABSENT=\n", "unexpected=shape\n", "present=OPENAI_API_KEY\n"]) {
    const r = runListingStep({ gate });
    assert.match(
      r.stdout,
      /::warning::could not resolve the collection-gating provider keys/,
      `block ${JSON.stringify(gate)} was accepted`,
    );
    assert.equal(r.output, "", `block ${JSON.stringify(gate)} wrote ${r.output}`);
    assert.ok(r.listed);
  }
});
