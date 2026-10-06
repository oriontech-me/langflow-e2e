// Unit tests for scripts/resolve-migration-pair.mjs: which two versions a migration run
// moves between. Run with: npm run test:scripts
//
// The PyPI document is a fixture shaped like https://pypi.org/pypi/langflow/json, with
// the releases that matter: the yanked 1.7.0 between 1.6.9 and 1.7.1, pre-releases and
// dev builds above the last final, and an empty release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { parseVersion, previousStable, resolveMigrationPair, imageFor } from "./resolve-migration-pair.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "resolve-migration-pair.mjs");
const file = (yanked = false) => [{ filename: "x.whl", yanked }];
const PYPI = {
  releases: {
    "1.6.8": file(),
    "1.6.9": file(),
    "1.7.0": file(true),
    "1.7.1": file(),
    "1.10.0": file(),
    "1.12.3": file(),
    "1.12.4": file(),
    "1.12.4.post1": file(),
    "1.12.5rc0": file(),
    "1.12.5rc1": file(),
    "1.13.0.dev32": file(),
    "1.13.0.dev33": file(),
    "1.12.6": [],
  },
};

test("versions are read the PEP 440 way Langflow writes them", () => {
  assert.deepEqual(parseVersion("1.13.0.dev33"), { release: [1, 13, 0], pre: null, post: null, dev: 33 });
  assert.deepEqual(parseVersion("1.12.5rc1").pre, ["rc", 1]);
  assert.equal(parseVersion("1.12.4.post1").post, 1);
  assert.equal(parseVersion("latest"), null);
});

test("the source is the newest final release strictly below the target's X.Y.Z", () => {
  for (const [target, source] of [
    ["1.13.0.dev33", "1.12.4"],
    ["1.12.5rc1", "1.12.4"],
    ["1.12.5", "1.12.4"],
    ["1.12.4", "1.12.3"],
  ]) {
    assert.equal(previousStable(target, PYPI).source, source, target);
  }
});

test("numbers compare as numbers: 1.10.0 is above 1.7.1", () => {
  assert.equal(previousStable("1.11.0", PYPI).source, "1.10.0");
});

test("a yanked release is never the source, and is named when it would have been (1.7.0)", () => {
  const r = previousStable("1.7.2", PYPI);
  assert.equal(r.source, "1.7.1");
  assert.deepEqual(r.skipped, []);
  const y = previousStable("1.7.1", PYPI);
  assert.equal(y.source, "1.6.9");
  assert.deepEqual(y.skipped, ["1.7.0 (yanked)"]);
});

test("a release with no files is not one", () => {
  const r = previousStable("1.13.0", PYPI);
  assert.equal(r.source, "1.12.4");
  assert.deepEqual(r.skipped, ["1.12.6 (no files)"]);
});

test("rc, dev and post releases are never the source", () => {
  const only = { releases: { "1.12.4.post1": file(), "1.12.5rc0": file(), "1.13.0.dev1": file() } };
  assert.match(previousStable("1.13.0.dev33", only).error, /no stable release below/);
});

test("images: the nightly repository for a dev build, the release repository otherwise", () => {
  assert.equal(imageFor("1.13.0.dev33"), "langflowai/langflow-nightly:1.13.0.dev33");
  assert.equal(imageFor("1.12.5rc1"), "langflowai/langflow:1.12.5rc1");
  assert.equal(imageFor("1.12.4"), "langflowai/langflow:1.12.4");
  const pair = resolveMigrationPair("1.13.0.dev33", PYPI);
  assert.equal(pair.source_image, "langflowai/langflow:1.12.4");
  assert.equal(pair.target_image, "langflowai/langflow-nightly:1.13.0.dev33");
});

test("the CLI prints one JSON object and exits 0 when it decided, 1 when it could not", () => {
  const dir = makeTempDir("migration-pair-");
  const doc = join(dir, "pypi.json");
  writeFileSync(doc, JSON.stringify(PYPI));
  const ok = spawnSync("node", [SCRIPT, "--target", "1.13.0.dev33", "--pypi-json", doc], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).source, "1.12.4");
  const bad = spawnSync("node", [SCRIPT, "--target", "nightly", "--pypi-json", doc], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /not a version/);
  writeFileSync(doc, "<html>rate limited</html>");
  const garbled = spawnSync("node", [SCRIPT, "--target", "1.13.0", "--pypi-json", doc], { encoding: "utf8" });
  assert.equal(garbled.status, 1);
  assert.match(JSON.parse(garbled.stdout).error, /cannot read the PyPI document/);
  assert.equal(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status, 2);
});
