// Unit tests for scripts/target-lock-drift.mjs.
// Run with: npm run test:scripts
//
// What these protect (#2063): a distribution off the lock is never counted as at it,
// a version the lock pins twice matches either one, and an input that cannot be read
// renders as "not computed", never as a clean section. An absent or clean-looking
// section on a day the lock was never read is the #1012 shape: it reads as "no drift".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRIFT_LISTED,
  normalizeName,
  parseFreeze,
  parseLockVersions,
  crossesMajor,
  diffAgainstLock,
  renderDrift,
  renderSection,
} from "./target-lock-drift.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./target-lock-drift.mjs", import.meta.url));

/** A lock in the shape uv writes it, one `[[package]]` table per (name, version). */
const lock = (entries) =>
  [
    "version = 1",
    'requires-python = ">=3.10"',
    "",
    ...entries.flatMap(([name, version, extra = []]) => [
      "[[package]]",
      `name = "${name}"`,
      ...(version === null ? [] : [`version = "${version}"`]),
      'source = { registry = "https://pypi.org/simple" }',
      "dependencies = [",
      '    { name = "not-a-package-entry" },',
      "]",
      ...extra,
      "",
    ]),
  ].join("\n");

const pinned = (text) => Object.fromEntries(Object.entries(parseLockVersions(text)).map(([k, v]) => [k, [...v].sort()]));

test("names are compared the way PEP 503 spells them", () => {
  assert.equal(normalizeName("Typing_Extensions"), "typing-extensions");
  assert.equal(normalizeName("zope.interface"), "zope-interface");
});

test("the freeze keeps pinned lines, and a direct-URL line as its raw text", () => {
  const installed = parseFreeze(
    ["# comment", "", "Anyio==4.15.1", "my_pkg @ file:///tmp/my_pkg-1.0-py3-none-any.whl", "  pydantic==2.13.5  "].join("\n"),
  );
  assert.deepEqual(installed, {
    anyio: "4.15.1",
    "my-pkg": "my_pkg @ file:///tmp/my_pkg-1.0-py3-none-any.whl",
    pydantic: "2.13.5",
  });
});

test("the lock yields every version it pins, and nothing from inline tables or the project itself", () => {
  const text = lock([
    ["numpy", "2.5.1"],
    ["numpy", "2.2.6"], // a fork per Python: either one is "at the lock"
    ["langflow", null], // a workspace member: no version, not a dependency
    ["protobuf", "5.29.6", ["", "[package.optional-dependencies]", 'grpc = [{ name = "grpcio" }]']],
  ]);
  assert.deepEqual(pinned(text), { numpy: ["2.2.6", "2.5.1"], protobuf: ["5.29.6"] });
});

test("a key inside a package's sub-table is not read as the package's version", () => {
  // Only the `[[package]]` header opens a package. A sub-table that happened to carry
  // a `version` key would otherwise add a pin the lock never made, and a drifted
  // distribution matching it would count as at the lock.
  const text = lock([["anyio", "4.14.2", ["", "[package.metadata]", 'version = "4.15.1"']]]);
  assert.deepEqual(pinned(text), { anyio: ["4.14.2"] });
});

test("a major move is a change in the first number, or in the second below 1.0", () => {
  assert.equal(crossesMajor("5.29.6", "7.36.2"), true);
  assert.equal(crossesMajor("0.120.0", "0.125.0"), true);
  assert.equal(crossesMajor("0.62.1", "0.62.3"), false);
  assert.equal(crossesMajor("2.48.0", "2.54.0"), false);
  assert.equal(crossesMajor("x", "1.0"), false, "unparseable is drift, not a jump");
});

test("the diff counts what is at the lock, and orders the drift major jumps first", () => {
  const diff = diffAgainstLock(
    { anyio: "4.15.1", numpy: "2.2.6", openai: "2.54.0", protobuf: "7.36.2", truststore: "0.10.4" },
    parseLockVersions(lock([["anyio", "4.14.2"], ["numpy", "2.5.1"], ["numpy", "2.2.6"], ["openai", "2.48.0"], ["protobuf", "5.29.6"]])),
  );
  assert.equal(diff.total, 5);
  assert.equal(diff.atLock, 1, "numpy matches the second of its two pins");
  assert.deepEqual(
    diff.drifted.map((d) => [d.name, d.major]),
    [["protobuf", true], ["anyio", false], ["openai", false]],
  );
  assert.deepEqual(diff.unlocked, [{ name: "truststore", installed: "0.10.4" }]);
});

test("a venv at the lock says so with its count", () => {
  const text = renderDrift(diffAgainstLock({ anyio: "4.14.2" }, parseLockVersions(lock([["anyio", "4.14.2"]]))), "v1.13.0.dev22");
  assert.match(text, /^### Target dependencies against the lock/);
  assert.match(text, /All \*\*1\*\* installed distributions are at the version pinned by the `uv.lock` of `v1.13.0.dev22`\./);
});

test("the drift names the count, the majors, the first few, and the rest in a table", () => {
  const installed = {};
  const entries = [];
  for (let i = 0; i < DRIFT_LISTED + 3; i += 1) {
    installed[`pkg-${String(i).padStart(2, "0")}`] = "2.0.0";
    entries.push([`pkg-${String(i).padStart(2, "0")}`, i === 0 ? "1.0.0" : "2.0.0rc1"]);
  }
  installed.extra = "0.1.0";
  const text = renderDrift(diffAgainstLock(installed, parseLockVersions(lock(entries))), "v1.0.0");
  assert.match(text, new RegExp(`\\*\\*${DRIFT_LISTED + 4} of ${DRIFT_LISTED + 4}\\*\\* installed distributions are not at the version`));
  assert.match(text, /1 of them across a major/);
  assert.match(text, /^- `pkg-00` 1\.0\.0 → \*\*2\.0\.0\*\*$/m, "the major jump is first and bold");
  assert.match(text, /- …and 3 more below\./);
  assert.match(text, /Installed and absent from the lock: `extra` 0\.1\.0\./);
  assert.match(text, new RegExp(`<details><summary>All ${DRIFT_LISTED + 3} off the lock</summary>`));
  assert.equal(text.match(/^\| `pkg-/gm).length, DRIFT_LISTED + 3, "the table holds every drifted one");
});

test("a short drift has no table", () => {
  const text = renderDrift(diffAgainstLock({ a: "2.0" }, parseLockVersions(lock([["a", "1.0"]]))), "v1");
  assert.doesNotMatch(text, /<details>/);
});

test("every input that cannot be read renders as not computed, never as clean", () => {
  const dir = makeTempDir("lock-drift-");
  const freeze = join(dir, "freeze.txt");
  const good = join(dir, "uv.lock");
  const empty = join(dir, "empty.lock");
  const noPackages = join(dir, "no-packages.lock");
  writeFileSync(freeze, "anyio==4.14.2\n");
  writeFileSync(good, lock([["anyio", "4.14.2"]]));
  writeFileSync(empty, "");
  writeFileSync(noPackages, "version = 1\n");

  const cases = [
    [{ freezePath: join(dir, "absent.txt"), lockPath: good, ref: "v1" }, /the target venv's freeze could not be read/],
    [{ freezePath: empty, lockPath: good, ref: "v1" }, /the target venv's freeze could not be read/],
    [{ freezePath: freeze, lockPath: good, ref: "" }, /neither a served nor an installed Langflow version is known/],
    [{ freezePath: freeze, lockPath: empty, ref: "v1" }, /no `uv.lock` could be fetched for `v1`/],
    [{ freezePath: freeze, lockPath: noPackages, ref: "v1" }, /names no package/],
  ];
  for (const [input, reason] of cases) {
    const text = renderSection(input);
    assert.match(text, /^### Target dependencies against the lock/, JSON.stringify(input));
    assert.match(text, reason, JSON.stringify(input));
    assert.match(text, /which is not the same as no/, JSON.stringify(input));
    assert.doesNotMatch(text, /installed distributions are/, JSON.stringify(input));
  }
  assert.match(renderSection({ freezePath: freeze, lockPath: good, ref: "v1" }), /All \*\*1\*\* installed/);
});

test("the CLI renders the section from the three flags", () => {
  const dir = makeTempDir("lock-drift-cli-");
  writeFileSync(join(dir, "f.txt"), "anyio==4.15.1\n");
  writeFileSync(join(dir, "uv.lock"), lock([["anyio", "4.14.2"]]));
  const r = spawnSync(process.execPath, [SCRIPT, "--freeze", join(dir, "f.txt"), "--lock", join(dir, "uv.lock"), "--ref", "v9"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\*\*1 of 1\*\* installed distributions are not at the version pinned by the `uv.lock` of `v9`/);
  assert.match(r.stdout, /- `anyio` 4\.14\.2 → 4\.15\.1/);
});
