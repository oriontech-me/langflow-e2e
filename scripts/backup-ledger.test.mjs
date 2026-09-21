// Unit tests for scripts/backup-ledger.sh.
// Run with: npm run test:scripts
//
// WHAT THESE PROTECT
//
// A backup is the one tool nobody exercises until the day it matters, and the failure
// everyone actually gets is not "it crashed" — it is an archive that exists, weighs
// something, and holds the wrong thing. So the refusals are the subject here, not the
// happy path: an empty series, a missing series, an archive whose row count does not
// match the source, and a transfer reported successful by an exit code alone.
//
// The destination is exercised through `local:`, which is the same code path as the
// remote one minus ssh — same staging, same archive, same digest comparison, same
// pruning. Stubbing ssh would test the stub; using a real directory tests the logic
// that decides whether the copy is good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "backup-ledger.sh");

const SERIES = ["daily-history.jsonl", "token-history.jsonl", "spec-durations.json"];

/** A ledger directory that looks like the real one: three named files, non-empty. */
function makeLedger(root, { rows = 3, omit = [], empty = [] } = {}) {
  const dir = join(root, "state", "langflow-e2e");
  mkdirSync(dir, { recursive: true });
  for (const f of SERIES) {
    if (omit.includes(f)) continue;
    if (empty.includes(f)) { writeFileSync(join(dir, f), ""); continue; }
    const body = f.endsWith(".jsonl")
      ? Array.from({ length: rows }, (_, i) => JSON.stringify({ date: `2026-09-${10 + i}` })).join("\n") + "\n"
      : JSON.stringify({ "a.spec.ts": 1000 }) + "\n";
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

function run(env = {}) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("copies the three series and verifies the digest at the destination", () => {
  const root = makeTempDir("backup-ok");
  const ledger = makeLedger(root, { rows: 5 });
  const dest = join(root, "dest");

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${dest}` });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok: langflow-e2e-ledger-\d{8}T\d{6}Z\.tgz/);
  assert.match(r.stdout, /5 daily rows, digest verified/);

  const archives = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
  assert.equal(archives.length, 1);

  // The archive unpacks as langflow-e2e/<file> — the shape the hand-made copies use,
  // so an old copy and a new one are interchangeable to whoever restores.
  const listed = spawnSync("tar", ["tzf", join(dest, archives[0])], { encoding: "utf8" }).stdout;
  for (const f of SERIES) assert.ok(listed.includes(`langflow-e2e/${f}`), `${f} missing from archive`);
});

test("refuses an empty series instead of archiving it", () => {
  const root = makeTempDir("backup-empty");
  const ledger = makeLedger(root, { empty: ["token-history.jsonl"] });
  const dest = join(root, "dest");

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${dest}` });

  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: token-history\.jsonl is empty/);
  assert.equal(readdirSync(root).includes("dest"), false, "nothing should have been written");
});

test("refuses a missing series rather than shipping a partial archive", () => {
  const root = makeTempDir("backup-missing");
  const ledger = makeLedger(root, { omit: ["spec-durations.json"] });

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${join(root, "dest")}` });

  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: spec-durations\.json is missing/);
});

test("refuses a source directory that does not exist", () => {
  const root = makeTempDir("backup-nodir");
  const r = run({ LEDGER_DIR: join(root, "nope"), BACKUP_DEST: `local:${join(root, "dest")}` });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: LEDGER_DIR is not a directory/);
});

test("not configured is reported as disabled, not as success and not as failure", () => {
  // The distinction matters: a run whose backup never ran must not read the same as a
  // run whose backup worked. Exit 0 keeps it from colouring the daily; the word
  // DISABLED keeps it from being mistaken for a copy that happened.
  const root = makeTempDir("backup-off");
  const ledger = makeLedger(root);

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: "" });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /DISABLED: BACKUP_DEST is not set, nothing was copied/);
});

test("refuses a destination that is not <host>:<dir>", () => {
  const root = makeTempDir("backup-baddest");
  const ledger = makeLedger(root);
  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: "/just/a/path" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: BACKUP_DEST must be <host>:<dir>/);
});

test("prunes to BACKUP_KEEP, newest kept", () => {
  const root = makeTempDir("backup-keep");
  const ledger = makeLedger(root);
  const dest = join(root, "dest");
  mkdirSync(dest, { recursive: true });

  // Three older archives, deliberately aged so `ls -t` has a real order to work with.
  const old = ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"];
  old.forEach((stamp, i) => {
    const p = join(dest, `langflow-e2e-ledger-${stamp}.tgz`);
    writeFileSync(p, "old");
    const t = new Date(Date.now() - (old.length - i) * 86400_000);
    utimesSync(p, t, t);
  });

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${dest}`, BACKUP_KEEP: "2" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const left = readdirSync(dest).filter((f) => f.endsWith(".tgz")).sort();
  assert.equal(left.length, 2, `expected 2 archives, got ${left.join(", ")}`);
  // The one just written is the newest, so it survives; the two oldest are gone.
  assert.ok(left.some((f) => !old.some((s) => f.includes(s))), "the new archive was pruned");
  assert.ok(!left.includes("langflow-e2e-ledger-20260101T000000Z.tgz"), "oldest survived");
  assert.match(r.stdout, /2 old archive\(s\) pruned/);
});

test("writes its verdict to BACKUP_LOG, where triage reads", () => {
  const root = makeTempDir("backup-log");
  const ledger = makeLedger(root);
  const logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, "ledger-backup.log");

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${join(root, "dest")}`, BACKUP_LOG: log });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const body = readFileSync(log, "utf8");
  assert.match(body, /\d{8}T\d{6}Z \[backup-ledger\] ok: /);
});

test("a refusal reaches BACKUP_LOG too — silence is the failure being guarded against", () => {
  const root = makeTempDir("backup-log-refusal");
  const ledger = makeLedger(root, { empty: ["daily-history.jsonl"] });
  const log = join(root, "ledger-backup.log");

  const r = run({ LEDGER_DIR: ledger, BACKUP_DEST: `local:${join(root, "dest")}`, BACKUP_LOG: log });

  assert.equal(r.status, 1);
  assert.match(readFileSync(log, "utf8"), /REFUSED: daily-history\.jsonl is empty/);
});
