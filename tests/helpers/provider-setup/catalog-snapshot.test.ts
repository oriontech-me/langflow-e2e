// Unit tests for the run-scoped model-catalog snapshot (issue #1386).
// Run with: npm run test:units
//
// What rides on this: the TITLE of 19 spec files. 18 derive it from
// `resolveTestTargets()` and one from `resolveGeminiModel()`, and a title is a test's
// identity — the runner computes it at collection, each worker recomputes it at load.
// When those two disagree Playwright reports `Test not found in the worker process`
// with `duration 0` and never opens a browser, which on the daily of 2026-08-10 was
// then read by the auto-removal path as a hard failure and cost an `@stable` tag.
//
// The disagreement is not hypothetical and does not need a rare race: the writer is
// `tests/collect-models.spec.ts`, which is `@stable` and therefore partitioned into a
// shard's own spec list, and it rewrites `models.json` from inside the run.
//
// So the assertions below are all one property, stated from different sides: **what a
// resolver returns must not depend on when it is called.**
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CATALOG_SNAPSHOT_ENV,
  MODELS_PATH,
  freezeModelCatalog,
  readCatalogText,
} from "./catalog-snapshot";
import { resolveGeminiModel } from "./resolve-gemini-model";
import { resolveGptModel } from "./resolve-gpt-model";
import { resolveTestTargets } from "./test-targets";
import { makeTempDir } from "../../../scripts/lib/tmp-dir.mjs";

const OPENAI_ONLY = [{ provider: "openai", model: "gpt-4o-mini" }];
const WITH_GOOGLE = [
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "google", model: "gemini-flash-latest" },
];

/** A temp file standing in for `models.json`, seeded with `records`. */
function tempCatalog(records: unknown, name = "models.json"): string {
  const dir = makeTempDir("catalog-snapshot-");
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(records));
  return file;
}

/**
 * Run `fn` with the real `PW_MODELS_SNAPSHOT` replaced, then restore it. The tests
 * that exercise the REAL resolvers (which read `process.env` and the real path) have
 * to go through the env, never through the repo's own `models.json` — that file is
 * gitignored, so it is absent in the unit lane and present locally, and a test that
 * reads it passes on one and ENOENTs on the other (#1287).
 */
function withSnapshot(value: string | undefined, fn: () => void): void {
  const previous = process.env[CATALOG_SNAPSHOT_ENV];
  if (value === undefined) delete process.env[CATALOG_SNAPSHOT_ENV];
  else process.env[CATALOG_SNAPSHOT_ENV] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[CATALOG_SNAPSHOT_ENV];
    else process.env[CATALOG_SNAPSHOT_ENV] = previous;
  }
}

// ─── The regression itself ────────────────────────────────────────────────────

test("a frozen catalog survives a mid-run rewrite of the file", () => {
  const file = tempCatalog(OPENAI_ONLY);
  const env: NodeJS.ProcessEnv = {};

  const verdict = freezeModelCatalog(env, file);
  assert.equal(verdict.kind, "frozen");
  assert.equal(verdict.count, 1);

  // What `collect-models.spec.ts` does from inside the run.
  fs.writeFileSync(file, JSON.stringify(WITH_GOOGLE));

  assert.deepEqual(JSON.parse(env[CATALOG_SNAPSHOT_ENV] as string), OPENAI_ONLY);
});

test("the resolver that feeds a describe title reads the frozen catalog, not the disk", () => {
  // The exact shape of the daily's failure: the runner listed
  // `… [google / default]` because google was absent, then the file gained a google
  // model and the worker resolved `… [google / gemini-flash-latest]`.
  withSnapshot(JSON.stringify(OPENAI_ONLY), () => {
    assert.equal(resolveGeminiModel(), undefined);
  });
  withSnapshot(JSON.stringify(WITH_GOOGLE), () => {
    assert.equal(resolveGeminiModel(), "gemini-flash-latest");
  });
});

test("resolveGptModel reads the frozen catalog too", () => {
  withSnapshot(JSON.stringify(WITH_GOOGLE), () => {
    assert.equal(resolveGptModel(), "gpt-4o-mini");
  });
  withSnapshot(JSON.stringify([{ provider: "google", model: "gemini-flash-latest" }]), () => {
    assert.equal(resolveGptModel(), undefined);
  });
});

test("resolveTestTargets parametrizes from the frozen catalog", () => {
  withSnapshot(JSON.stringify(WITH_GOOGLE), () => {
    const targets = resolveTestTargets({ tier: "tool-calling", env: {}, skipReasons: new Map() });
    assert.deepEqual(
      targets.map((t) => t.label),
      ["openai / gpt-4o-mini", "google / gemini-flash-latest"],
    );
  });
});

// ─── Freeze verdicts ──────────────────────────────────────────────────────────

test("an absent catalog freezes the EMPTY one, not nothing", () => {
  // Without a sentinel, "no file" would fall through to a live read in the workers —
  // the same identity mismatch from the other direction, on a run whose pre-flight
  // failed entirely but whose in-shard collect-models succeeded.
  const env: NodeJS.ProcessEnv = {};
  const missing = path.join(os.tmpdir(), "definitely-absent-models-1386.json");
  const verdict = freezeModelCatalog(env, missing);
  assert.equal(verdict.kind, "absent");
  assert.equal(env[CATALOG_SNAPSHOT_ENV], "[]");
});

test("an unreadable catalog is reported, and still freezes the empty one", () => {
  const env: NodeJS.ProcessEnv = {};
  // A directory reads as EISDIR — exists, cannot be read.
  const dir = makeTempDir("catalog-snapshot-");
  const verdict = freezeModelCatalog(env, dir);
  assert.equal(verdict.kind, "unreadable");
  assert.match(verdict.reason ?? "", /EISDIR|EPERM|EACCES/);
  assert.equal(env[CATALOG_SNAPSHOT_ENV], "[]");
});

test("a malformed catalog is frozen VERBATIM so the readers still fail loud", () => {
  // Parsing here would move #1035's deliberate throw into globalSetup, where it would
  // abort the whole run instead of failing at the one place that must decide.
  const dir = makeTempDir("catalog-snapshot-");
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, "{ not json");
  const env: NodeJS.ProcessEnv = {};
  const verdict = freezeModelCatalog(env, file);
  assert.equal(verdict.kind, "frozen");
  assert.match(verdict.reason ?? "", /not valid JSON/);
  assert.equal(env[CATALOG_SNAPSHOT_ENV], "{ not json");
});

test("a catalog that is valid JSON but not an array is reported", () => {
  const file = tempCatalog({ openai: "gpt-4o-mini" });
  const env: NodeJS.ProcessEnv = {};
  const verdict = freezeModelCatalog(env, file);
  assert.equal(verdict.kind, "frozen");
  assert.match(verdict.reason ?? "", /not an array/);
});

test("freezing overwrites a stale value inherited from a parent process", () => {
  const file = tempCatalog(OPENAI_ONLY);
  const env: NodeJS.ProcessEnv = { [CATALOG_SNAPSHOT_ENV]: JSON.stringify(WITH_GOOGLE) };
  freezeModelCatalog(env, file);
  assert.deepEqual(JSON.parse(env[CATALOG_SNAPSHOT_ENV] as string), OPENAI_ONLY);
});

// ─── readCatalogText ──────────────────────────────────────────────────────────

test("the snapshot stands in for the real path only", () => {
  const file = tempCatalog(OPENAI_ONLY);
  const env: NodeJS.ProcessEnv = { [CATALOG_SNAPSHOT_ENV]: JSON.stringify(WITH_GOOGLE) };

  // An injected fixture is never shadowed by whatever the ambient run froze — this is
  // what keeps every `catalogPath:` unit-test seam meaningful.
  assert.deepEqual(JSON.parse(readCatalogText(file, env) as string), OPENAI_ONLY);
  // The real path resolves to the snapshot.
  assert.deepEqual(JSON.parse(readCatalogText(MODELS_PATH, env) as string), WITH_GOOGLE);
});

test("with no snapshot, readCatalogText is the file — and undefined when absent", () => {
  const file = tempCatalog(OPENAI_ONLY);
  assert.deepEqual(JSON.parse(readCatalogText(file, {}) as string), OPENAI_ONLY);
  assert.equal(
    readCatalogText(path.join(os.tmpdir(), "definitely-absent-models-1386.json"), {}),
    undefined,
  );
});

// ─── Structural: the freeze must stay wired, and stay first ───────────────────

test("globalSetup freezes the catalog before it does anything else", () => {
  // The whole mechanism is one call. A refactor that drops it, or moves it after a
  // step that can throw (the backend health poll fails on every local run with no
  // instance up), silently restores the race — and the symptom is a `Test not found`
  // on an unrelated spec three weeks later.
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "globalSetup.ts"), "utf-8");
  const body = source.slice(source.indexOf("export default async function globalSetup"));
  const freezeAt = body.indexOf("freezeCatalog()");
  const contextAt = body.indexOf("playwrightRequest.newContext");
  assert.ok(freezeAt > -1, "globalSetup must call freezeCatalog()");
  assert.ok(contextAt > -1, "globalSetup must still create the request context");
  assert.ok(freezeAt < contextAt, "freezeCatalog() must run before any network work");
});
