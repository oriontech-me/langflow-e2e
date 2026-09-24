// Unit tests for scripts/mirror-freshness-summary.mjs.
// Run with: npm run test:scripts
//
// The line these protect is the only place a stall that resolved itself overnight is
// written down, now that the freshness alarm posts at most once a day. A line that
// undercounts reads as "the mirror was fine", which is the silence #1947 removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHistory, summarize, mirrorLine } from "./mirror-freshness-summary.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mirror-freshness-summary.mjs");
const H = 3600;
const NOW = 1_800_000_000;
const looks = (...pairs) => pairs.map(([hoursAgo, state]) => ({ ts: NOW - hoursAgo * H, state }));

test("the night of 2026-09-23/24: two stalls, the longest about 4h", () => {
  // Hourly looks: behind at 02, recovered at 06, behind at 08, recovered at 09 (BRT),
  // read at the 05:00 daily of the next day.
  const history = looks(
    [27, "current"], [26, "not-current"], [25, "not-current"], [24.5, "not-current"],
    [23, "not-current"], [22, "current"], [21, "current"], [20, "not-current"], [19, "current"],
    [10, "current"], [1, "current"],
  );
  const s = summarize(history, NOW);
  assert.equal(s.stalls, 2);
  assert.equal(s.longestSeconds, 4 * H);
  assert.equal(
    mirrorLine({ runState: "current", history, now: NOW }),
    "current at run time · fell behind 2 time(s) in the last 24h, the longest for about 4h",
  );
});

test("UNKNOWN neither opens nor closes a stall", () => {
  const history = looks([5, "not-current"], [4, "unknown"], [3, "not-current"], [2, "current"]);
  const s = summarize(history, NOW);
  assert.equal(s.stalls, 1, "a look that could not ask split one stall into two");
  assert.equal(s.longestSeconds, 3 * H);
  assert.equal(summarize(looks([3, "unknown"], [2, "current"]), NOW).stalls, 0);
});

test("a stall still open at the end of the window is counted up to now", () => {
  const s = summarize(looks([3, "current"], [2, "not-current"], [1, "not-current"]), NOW);
  assert.equal(s.stalls, 1);
  assert.equal(s.longestSeconds, 2 * H);
});

test("a stall that ended more than 24h ago is outside the line", () => {
  const s = summarize(looks([30, "not-current"], [25, "current"], [2, "current"]), NOW);
  assert.deepEqual(s, { looks: 1, stalls: 0, longestSeconds: 0 });
});

test("a stall that began before the window and ended inside it counts whole", () => {
  // Cut at the window's edge it would read as one hour; it lasted four.
  const s = summarize(looks([26, "not-current"], [24.5, "not-current"], [22, "current"]), NOW);
  assert.equal(s.stalls, 1);
  assert.equal(s.longestSeconds, 4 * H);
});

test("a quiet day, an empty history and an unreadable one read differently", () => {
  assert.equal(
    mirrorLine({ runState: "current", history: looks([2, "current"]), now: NOW }),
    "current at run time · no stall in the last 24h",
  );
  assert.match(mirrorLine({ runState: "current", history: [], now: NOW }), /no hourly check recorded/);
  assert.match(mirrorLine({ runState: "current", history: null, now: NOW }), /could not be read/);
});

test("the state at run time leads, and BEHIND says what it cost", () => {
  assert.match(mirrorLine({ runState: "behind", history: [], now: NOW }), /^BEHIND at run time, so this run executed an older suite than main/);
  assert.match(mirrorLine({ runState: "unknown", history: [], now: NOW }), /^could not be checked at run time/);
  // No state (the preflight did not ask) leaves only the history part.
  assert.match(mirrorLine({ runState: undefined, history: [], now: NOW }), /^no hourly check/);
});

test("the line is plain text: the notifier decorates it per transport", () => {
  const line = mirrorLine({ runState: "behind", history: looks([2, "not-current"]), now: NOW });
  assert.doesNotMatch(line, /[`*_]/);
});

test("malformed history lines are skipped, not fatal", () => {
  const parsed = parseHistory(`garbage\n${NOW}\tcurrent\n${NOW - H}\tsideways\n\n${NOW - 2 * H}\tnot-current\n`);
  assert.deepEqual(parsed.map((l) => l.state), ["not-current", "current"]);
});

test("the CLI reads the file the alarm writes and always exits 0", () => {
  const dir = makeTempDir("mirror-summary-cli");
  const file = join(dir, "history");
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(file, `${now - 2 * H}\tnot-current\n${now - H}\tcurrent\n`);
  const ok = spawnSync("node", [SCRIPT], { encoding: "utf8", env: { ...process.env, MIRROR_HISTORY_FILE: file, MIRROR_RUN_STATE: "current" } });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "current at run time · fell behind 1 time(s) in the last 24h, the longest for about 1h");

  const missing = spawnSync("node", [SCRIPT], { encoding: "utf8", env: { ...process.env, MIRROR_HISTORY_FILE: join(dir, "nope") } });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /could not be read/);
  rmSync(dir, { recursive: true, force: true });
});

test("the CLI ignores a STATE_DIR in the daily's environment", () => {
  // A collision, not an override: the default path must win over the generic name.
  const dir = makeTempDir("mirror-summary-statedir");
  const now = Math.floor(Date.now() / 1000);
  mkdirSync(join(dir, "langflow-e2e"), { recursive: true });
  writeFileSync(join(dir, "langflow-e2e", "mirror-freshness.history"), `${now - H}\tcurrent\n`);
  const r = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, MIRROR_HISTORY_FILE: "", XDG_STATE_HOME: dir, STATE_DIR: join(dir, "elsewhere") },
  });
  assert.equal(r.stdout.trim(), "no stall in the last 24h");
  rmSync(dir, { recursive: true, force: true });
});
