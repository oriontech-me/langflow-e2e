// The model catalog, frozen for the lifetime of ONE Playwright run (#1386).
//
// ## The invariant this exists to hold
//
// A test's identity in Playwright is its TITLE, and the title is computed twice, in
// two different processes, at two different moments:
//
//   1. the runner loads every spec file to build the test tree (the `load` task), and
//   2. each worker RE-loads the file it was handed and matches by title.
//
// Nineteen specs derive that title from `models.json` at module load — 18 through
// `resolveTestTargets()` (`[${label}]` = `provider / model`) and
// `mcp-client-agent-gemini-tool-regression.spec.ts` through `resolveGeminiModel()`.
// So for those files the title is a pure function of the FILE CONTENT AT READ TIME,
// and anything that writes the file between (1) and (2) changes the test's identity
// underneath it. Playwright then reports, from the worker:
//
//     Test not found in the worker process. Make sure test title does not change.
//
// with `duration 0` and `workerIndex -1` — no browser, no assertion, nothing about
// the spec's subject. On the daily of 2026-08-10 (run 31373880200) that cost
// `mcp-client-agent-gemini-tool-regression` its `@stable` tag through the automatic
// removal path, on a failure that never executed a line of the test.
//
// There IS such a writer, and it is inside the run: `tests/collect-models.spec.ts` is
// `@stable`, so it is collected by the daily's `--grep @stable --list` and partitioned
// into some shard's spec list like any other file. On shard 3 the pre-flight sweep had
// finished with `Models found (google): []` (a drained key — the sibling issue), and
// the in-shard copy then re-ran, succeeded, and rewrote `models.json` WITH google
// 32 seconds later. The runner had listed `… [google / default]`; the worker resolved
// `… [google / gemini-flash-latest]`.
//
// ## Why freezing, and not the alternatives
//
//  - **Keep the model out of the title.** It cannot go: under `ALL_MODELS`/
//    `MODEL_TEST_PROVIDER` a spec parametrizes one describe PER MODEL, so the model is
//    what makes those titles distinct. Dropping it collapses them into duplicates.
//  - **Keep `collect-models.spec.ts` out of the shard that reads its output.** That is
//    a scheduling constraint the partitioner would have to keep true forever, on every
//    lane, and it does not help a local `npx playwright test tests/` at all. It is also
//    not the invariant: the defect is that identity depends on mutable state, not that
//    one particular file mutates it.
//  - **Freeze the catalog for the run.** One value, resolved before the tree is built,
//    read identically by the runner and by every worker. Nothing downstream has to know
//    the file can change, and no future writer can reopen the hole.
//
// ## Mechanics
//
// `globalSetup` runs BEFORE the load task — `createGlobalSetupTasks` precedes
// `createLoadTask` in Playwright's CLI task list (`runner/testRunner.js`) — so the
// snapshot is in place before the first title is computed. Workers are forked after
// that and inherit `process.env`, which is why the env var reaches both sides while a
// module-level cache could not (they are separate processes).
//
// The snapshot carries the file's RAW TEXT, not a parsed array: `readCatalog()` in
// `test-targets.ts` throws on a malformed catalog on purpose (#1035 — an undecidable
// catalog must not degrade to the fallback), and parsing here would move that failure
// into `globalSetup`, where it would abort the whole run instead of failing at the one
// place that has to make a decision. Measured size of a real three-provider catalog:
// 5.2 KB — orders of magnitude below any `ARG_MAX` concern for the forked workers.
//
// A run whose `models.json` is ABSENT freezes `[]`. That is not a detail: without a
// sentinel, "no file" would fall through to a live read in the workers, and a run
// whose pre-flight failed entirely but whose in-shard `collect-models` succeeded would
// hit exactly the same identity mismatch from the other direction.
//
// Deliberately NOT frozen: `providers.json`. It is read through
// `providerSkipReasons()` and only ever feeds a `skipReason`, never a title or the
// number of targets — so a mid-run change there makes a test skip or run, which is a
// coverage question (the sibling collect-models issue), not an identity one. Freezing
// it would also fight `globalSetup`'s own credential-degradation path (#1058), which
// WRITES that file.
import * as fs from "fs";
import * as path from "path";

/**
 * Where the frozen catalog travels from the runner to the workers.
 *
 * `PW_`-prefixed like the suite's other run-scoped switches (`PW_DESTRUCTIVE`,
 * `PW_SHARD_FILE_LEVEL`, `PW_HTTP_ERROR_DEBUG`).
 */
export const CATALOG_SNAPSHOT_ENV = "PW_MODELS_SNAPSHOT";

/** The one path the snapshot stands in for. */
export const MODELS_PATH = path.join(__dirname, "data", "models.json");

export interface FreezeVerdict {
  /**
   * `frozen` — the file was read and its text is in the env.
   * `absent` — no file; the empty catalog was frozen instead (see the header).
   * `unreadable` — the file exists but could not be read; the empty catalog was
   *   frozen and the reason is reported. Never silent (#1012).
   */
  kind: "frozen" | "absent" | "unreadable";
  /** Number of records, when the text parsed as an array. `undefined` otherwise. */
  count?: number;
  /** Present on `unreadable`, and on a `frozen` catalog that does not parse. */
  reason?: string;
}

/**
 * Freeze `models.json` into `env` for this run. Call once, from `globalSetup`.
 *
 * Idempotent by construction — the file cannot change between two calls in the same
 * `globalSetup` — but it deliberately does NOT preserve a pre-existing value: a stale
 * `PW_MODELS_SNAPSHOT` inherited from a parent process would silently pin a catalog
 * from another run.
 */
export function freezeModelCatalog(
  env: NodeJS.ProcessEnv = process.env,
  jsonPath: string = MODELS_PATH,
): FreezeVerdict {
  let text: string;
  try {
    text = fs.readFileSync(jsonPath, "utf-8");
  } catch (e) {
    const absent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    env[CATALOG_SNAPSHOT_ENV] = "[]";
    return absent
      ? { kind: "absent", count: 0 }
      : { kind: "unreadable", count: 0, reason: String(e) };
  }

  env[CATALOG_SNAPSHOT_ENV] = text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { kind: "frozen", count: parsed.length };
    return {
      kind: "frozen",
      reason: `${jsonPath} is not an array of { provider, model } records (got ${
        parsed === null ? "null" : typeof parsed
      }) — the specs that read it will fail at collection.`,
    };
  } catch (e) {
    // Frozen as-is: the readers own this failure, and moving it here would abort the
    // run in globalSetup instead (see the header).
    return {
      kind: "frozen",
      reason: `${jsonPath} is not valid JSON (${String(e)}) — the specs that read it ` +
        `will fail at collection.`,
    };
  }
}

/**
 * The catalog text every resolver must read: the run's frozen snapshot when there is
 * one, the file otherwise. `undefined` means "no catalog at all", which each caller
 * already handles in its own way.
 *
 * The snapshot stands in for exactly ONE path. A caller that passes some other file —
 * every unit test does — reads that file, so injecting a fixture is never shadowed by
 * whatever the ambient run froze.
 */
export function readCatalogText(
  jsonPath: string = MODELS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (path.resolve(jsonPath) === path.resolve(MODELS_PATH)) {
    const frozen = env[CATALOG_SNAPSHOT_ENV];
    if (frozen !== undefined) return frozen;
  }
  if (!fs.existsSync(jsonPath)) return undefined;
  return fs.readFileSync(jsonPath, "utf-8");
}
