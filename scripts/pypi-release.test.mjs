// Unit tests for scripts/lib/pypi-release.mjs, which run-on-demand.sh asks before it
// installs a published version.
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allows, pythonFor, judge } from "./lib/pypi-release.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const CLI = fileURLToPath(new URL("./lib/pypi-release.mjs", import.meta.url));
const release = (over = {}) => ({ info: { version: "1.13.1rc0", requires_python: "<3.15,>=3.10", ...over.info }, urls: over.urls ?? [{ yanked: false }] });

test("requires_python is read clause by clause, as x.y.0", () => {
  assert.equal(allows("<3.15,>=3.10", "3.14"), true);
  assert.equal(allows("<3.14,>=3.10", "3.14"), false, "1.8.0rc6 and 1.5.0.post2 publish this");
  assert.equal(allows("<3.14,>=3.10", "3.13"), true);
  assert.equal(allows(">=3.10, <3.14", "3.13"), true);
  assert.equal(allows("~=3.10", "3.14"), true);
  assert.equal(allows("~=3.10.0", "3.11"), false);
  assert.equal(allows("==3.*", "3.13"), true);
  assert.equal(allows("!=3.13.*", "3.13"), false);
  assert.equal(allows("", "3.14"), true);
  assert.equal(allows(null, "3.14"), true);
  assert.equal(allows(">=3.10; python_version", "3.14"), null, "a clause it cannot read is unknown, never a guess");
  assert.equal(allows(">=3.10,<4.*", "3.14"), null);
});

test("the interpreter is the newest the release allows, the daily's when it says nothing readable", () => {
  assert.equal(pythonFor("<3.15,>=3.10"), "3.14");
  assert.equal(pythonFor("<3.14,>=3.10"), "3.13");
  assert.equal(pythonFor("<3.13,>=3.10"), "3.12");
  assert.equal(pythonFor("<3.12"), "", "none this machine runs");
  assert.equal(pythonFor(""), "3.14");
  assert.equal(pythonFor("garbage"), "3.14");
});

test("only the release asked for, with a file left to install, is ok", () => {
  assert.deepEqual(judge(release(), "1.13.1rc0"), { verdict: "ok", version: "1.13.1rc0", python: "3.14", requires: "<3.15,>=3.10" });
  // PyPI answers /1.12/json with 1.12.0: the gate compares exactly, so it is refused.
  assert.equal(judge(release({ info: { version: "1.12.0" } }), "1.12").verdict, "other");
  assert.equal(judge(release({ urls: [] }), "1.13.1rc0").verdict, "nofiles");
  assert.equal(judge(release({ urls: [{ yanked: true }, { yanked: true }] }), "1.13.1rc0").verdict, "yanked");
  assert.equal(judge(release({ urls: [{ yanked: true }, { yanked: false }] }), "1.13.1rc0").verdict, "ok");
  assert.equal(judge(release({ info: { requires_python: "<3.14,>=3.10" } }), "1.13.1rc0").python, "3.13");
  for (const junk of [null, {}, { info: null }, { info: { version: 7 } }, []]) assert.equal(judge(junk, "1.13.1rc0").verdict, "absent", JSON.stringify(junk));
});

test("the command line answers key=value, and an unreadable file is absent, not a crash", () => {
  const dir = makeTempDir("pypi-release-");
  const file = join(dir, "r.json");
  writeFileSync(file, JSON.stringify(release({ info: { requires_python: "<3.14,>=3.10" } })));
  const ok = spawnSync("node", [CLI, file, "1.13.1rc0"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "verdict=ok\nversion=1.13.1rc0\npython=3.13\nrequires=<3.14,>=3.10\n");
  writeFileSync(file, "<html>not json</html>");
  assert.match(spawnSync("node", [CLI, file, "1.13.1rc0"], { encoding: "utf8" }).stdout, /^verdict=absent$/m);
});
