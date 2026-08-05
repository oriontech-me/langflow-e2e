// Behaviour tests for the `--grep` composition (issue #1275).
//
// These assert on SELECTION, not on the shape of the string: every case compiles the
// composed filter and runs it against test titles taken from the real suite. That is
// deliberate — the bug being fixed was a one-character omission whose only symptom is
// which tests match, and #1226 already showed that a guard pinning the built string's
// spelling passes the mutations it exists to catch.
//
// The strings matched here are what Playwright greps against: the project name, the
// file path, the describe titles and the test title, with the `tag:` array appended.
// Tags do not appear in `--list` output, which is why they are spelled out here.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildGrepFilter, parseArgs } from "./build-grep-filter.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "build-grep-filter.mjs");

// Real titles, from `npx playwright test --grep … --list` plus each test's `tag:` array.
const STABLE_MODEL_PROVIDER =
  "[chromium] › tests-automations/regression/core-components/agent-component-regression.spec.ts:164:7 › " +
  "Agent Component — canvas regression › model dropdown exposes manage-model-providers and lists configured models " +
  "@stable @components @model-provider";

const STABLE_AGENTS =
  "[chromium] › tests-automations/regression/core-functionality/llm-agents/agent-config-persistence.spec.ts:96:5 › " +
  "Agent settings survive save and reopen @stable @agents";

const UNSTABLE_AGENTS =
  "[chromium] › tests-automations/regression/core-functionality/llm-agents/agent-tool-inspection.spec.ts:42:5 › " +
  "agent exposes its tool payload @release @agents";

// The same test with its tags in the opposite order. Nothing about a dispatch controls
// the order of a spec's `tag:` array, and the defect is order dependent: the broken
// composition couples the lookaheads to one starting position, so it leaves the
// selection accidentally correct whenever the alternated token happens to come first.
// A fixture that only covers the lucky ordering passes against the bug.
const UNSTABLE_AGENTS_TAGS_REVERSED =
  "[chromium] › tests-automations/regression/core-functionality/llm-agents/agent-tool-inspection.spec.ts:42:5 › " +
  "agent exposes its tool payload @agents @release";

const STABLE_DESTRUCTIVE_MODEL_PROVIDER =
  "[chromium] › tests-automations/regression/core-functionality/model-provider/provider-teardown.spec.ts:12:5 › " +
  "removing every configured provider @destructive @model-provider";

const select = (filter, titles) => {
  const regex = new RegExp(filter);
  return titles.filter((title) => regex.test(title));
};

test("an alternation in test_grep is ANDed as a unit, not split across the lookahead", () => {
  // The regression itself. Before the fix this filter read as
  // `(?=(?:.*@agents)|(?:@model-provider))`, whose second branch has to match at
  // position 0 — so the whole @model-provider half was dropped and the selection was
  // byte-identical to asking for @agents alone.
  const filter = buildGrepFilter({
    tag: "@stable",
    grep: "@agents|@model-provider",
  });

  assert.deepEqual(
    select(filter, [STABLE_MODEL_PROVIDER, STABLE_AGENTS, UNSTABLE_AGENTS]),
    [STABLE_MODEL_PROVIDER, STABLE_AGENTS],
  );
});

test("an alternation is ANDed as a unit on either side of the composition", () => {
  // Same defect, tag side: `test_tag=@stable|@release` narrowed to @stable. Asserted
  // over BOTH tag orderings — under the broken composition the `@release @agents`
  // ordering matches by luck and only `@agents @release` is dropped.
  const filter = buildGrepFilter({ tag: "@stable|@release", grep: "@agents" });

  assert.deepEqual(
    select(filter, [STABLE_AGENTS, UNSTABLE_AGENTS, UNSTABLE_AGENTS_TAGS_REVERSED]),
    [STABLE_AGENTS, UNSTABLE_AGENTS, UNSTABLE_AGENTS_TAGS_REVERSED],
  );
});

test("both filters must match — the composition is an AND, not an OR", () => {
  const filter = buildGrepFilter({ tag: "@stable", grep: "@agents" });

  assert.deepEqual(select(filter, [STABLE_AGENTS, UNSTABLE_AGENTS, STABLE_MODEL_PROVIDER]), [
    STABLE_AGENTS,
  ]);
});

test("a required fragment is ANDed with the dispatch filters", () => {
  // The destructive lane: @destructive AND whatever the dispatch asked for.
  const filter = buildGrepFilter({
    require: ["@destructive"],
    grep: "@agents|@model-provider",
  });

  assert.deepEqual(
    select(filter, [
      STABLE_DESTRUCTIVE_MODEL_PROVIDER,
      STABLE_MODEL_PROVIDER,
      STABLE_AGENTS,
    ]),
    [STABLE_DESTRUCTIVE_MODEL_PROVIDER],
  );
});

test("a required fragment alone selects that lane, unnarrowed", () => {
  const filter = buildGrepFilter({ require: ["@destructive"] });

  assert.deepEqual(
    select(filter, [STABLE_DESTRUCTIVE_MODEL_PROVIDER, STABLE_AGENTS]),
    [STABLE_DESTRUCTIVE_MODEL_PROVIDER],
  );
});

test("a single fragment is passed verbatim, so the --grep @stable lanes are unchanged", () => {
  // Not cosmetic: this is what keeps the overwhelmingly common path on exactly the
  // string it used before this script existed.
  assert.equal(buildGrepFilter({ tag: "@stable" }), "@stable");
  assert.equal(buildGrepFilter({ grep: "@agents|@model-provider" }), "@agents|@model-provider");
  assert.equal(buildGrepFilter({ require: ["@destructive"] }), "@destructive");
});

test("no fragments means no filter — never an empty regex that matches everything", () => {
  assert.equal(buildGrepFilter(), null);
  assert.equal(buildGrepFilter({ tag: "", grep: "" }), null);
  // A dispatch form's untouched text input can arrive as whitespace; `(?=.*(?: ))`
  // would require a literal space in every title.
  assert.equal(buildGrepFilter({ tag: "  ", grep: "\t" }), null);
});

test("whitespace around a fragment is trimmed, not composed into the lookahead", () => {
  const filter = buildGrepFilter({ tag: " @stable ", grep: " @agents " });

  assert.deepEqual(select(filter, [STABLE_AGENTS, UNSTABLE_AGENTS]), [STABLE_AGENTS]);
});

test("a caller's own capture group keeps its number — the wrapper is non-capturing", () => {
  // `(…)` instead of `(?:…)` would renumber this backreference and change what matches.
  const filter = buildGrepFilter({ tag: "@stable", grep: "(agent).*\\1" });
  const regex = new RegExp(filter);

  assert.equal(regex.test("agent settings for the agent @stable"), true);
  assert.equal(regex.test("agent settings @stable"), false);
});

test("an invalid fragment is refused here, naming it, instead of reaching Playwright", () => {
  assert.throws(() => buildGrepFilter({ tag: "@stable", grep: "@agents(" }), {
    message: /not a valid regex: "@agents\("/,
  });
});

test("an unrecognised flag is refused — a typo must not silently widen the run", () => {
  assert.throws(() => parseArgs(["--tags=@stable"]), { message: /--tags/ });
  assert.throws(() => parseArgs(["@stable"]), { message: /unrecognised argument/ });
});

test("parseArgs keeps a value containing '=' and accumulates --require", () => {
  assert.deepEqual(parseArgs(["--grep=a=b", "--require=@destructive", "--require=@api"]), {
    tag: "",
    grep: "a=b",
    require: ["@destructive", "@api"],
  });
});

test("the CLI prints the composed filter on stdout", () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--tag=@stable", "--grep=@agents|@model-provider"],
    { encoding: "utf-8" },
  );

  assert.equal(stdout.trim(), "(?=.*(?:@stable))(?=.*(?:@agents|@model-provider))");
});

test("the CLI prints nothing when there is nothing to filter on", () => {
  const stdout = execFileSync(process.execPath, [SCRIPT, "--tag=", "--grep="], {
    encoding: "utf-8",
  });

  assert.equal(stdout, "");
});

// This one IS structural, and it pins an absence rather than a spelling — the two are
// not the same guard. It cannot tell whether a lane composes its filter correctly (the
// tests above do that, by selection); it tells us no lane went back to composing one
// inline. The bug reached four lanes by copy-paste, so a fifth one is the likely way it
// returns, and that is exactly what a scan for the construct catches.
test("no workflow or action composes a lookahead by interpolating a shell variable", () => {
  const root = path.resolve(import.meta.dirname, "..", ".github");

  const ymlFiles = fs
    .readdirSync(root, { recursive: true })
    .filter((entry) => /\.ya?ml$/.test(entry))
    .map((entry) => path.join(root, entry));

  // Not an empty-set pass: a moved/renamed .github tree must fail loudly here rather
  // than report a clean scan over nothing (#1012's rule).
  assert.ok(ymlFiles.length > 0, `found no YAML under ${root}`);

  const offenders = [];
  for (const file of ymlFiles) {
    fs.readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, index) => {
        // `(?=.*` followed by a shell or GitHub expansion — `${VAR}`, `$VAR`, `${{ … }}`
        // — is the unparenthesised interpolation of #1275. A literal fragment is fine.
        if (/\(\?=\.\*\$/.test(line)) {
          offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    "compose the filter with scripts/build-grep-filter.mjs instead:\n" +
      offenders.join("\n"),
  );
});

test("the CLI exits non-zero and names the cause on an invalid fragment", () => {
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "--grep=@agents("], { encoding: "utf-8", stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /build-grep-filter: not a valid regex/);
      return true;
    },
  );
});
