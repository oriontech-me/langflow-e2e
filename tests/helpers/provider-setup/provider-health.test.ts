// Unit tests for the provider health gate (issue #1029).
// Run with: npm run test:units
//
// What rides on this function: it decides whether a provider-hardcoded spec makes
// a live LLM call. Getting it wrong in either direction is expensive.
//
// - Too permissive (the pre-#1029 behavior): a spec calls a provider whose key is
//   dead, the request blocks past gunicorn's 300s timeout and kills the shard's
//   single Langflow worker. On run 30374528125 that cost six worker restarts and
//   14 collateral timeouts across specs that never touch Google.
// - Too strict: a missing or unparseable providers.json skips the whole suite.
//   CI is explicitly allowed to run with a failed `Collect models` step (#980),
//   and a fresh clone has no providers.json at all (it is gitignored), so "no
//   signal" MUST fail open.
//
// The Google error string below is verbatim from the providers.json of the run
// that motivated the issue.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  degradeProviders,
  providerSkipReasons,
  providersForEnvKeys,
  readProviderHealth,
  toSkipGate,
  unavailableReason,
  writeProviderHealth,
  type ProviderHealthRecord,
  credentialRemedy,
  DEFAULT_MAX_AGE_HOURS,
  isExpired,
  maxAgeHours,
} from "./provider-health";
import { parseProviderInactiveReason } from "../../../scripts/lib/provider-health-reason.mjs";
import { makeTempDir } from "../../../scripts/lib/tmp-dir.mjs";

/** Verbatim from run 30374528125's providers.json — Google monthly spend cap. */
const SPEND_CAP =
  "3 of 36 candidate model(s) failed validation with the SAME model-independent " +
  "error — stopped early (tried: gemini-2.5-flash, gemini-3.5-flash, " +
  "gemini-flash-latest); last error: Your project has exceeded its monthly " +
  "spending cap.";

const ALL_KEYS_SET: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  GOOGLE_API_KEY: "AIza-test",
};

const record = (
  provider: string,
  status: "active" | "inactive",
  error: string | null = null,
): ProviderHealthRecord => ({
  provider,
  model: "some-model",
  status,
  error,
  // Fresh by default: an `active` record with no timestamp is expired since #1904.
  checkedAt: new Date().toISOString(),
});

/** The exact provider state of run 30374528125: Google drained, the rest fine. */
const RUN_30374528125: ProviderHealthRecord[] = [
  record("openai", "active"),
  record("anthropic", "active"),
  record("google", "inactive", SPEND_CAP),
];

// ─── The regression this exists to prevent ───────────────────────────────────

test("a key that EXISTS but is recorded inactive still skips", () => {
  const reason = unavailableReason(["google"], RUN_30374528125, ALL_KEYS_SET);
  assert.ok(reason, "google is inactive — the gate must skip, not call it live");
  assert.match(reason, /inactive/);
});

test("the skip reason quotes the collected error, not a generic message", () => {
  // The reason lands in the Playwright report; without the collected error the
  // reader cannot tell a drained key from a revoked one.
  const reason = unavailableReason(["google"], RUN_30374528125, ALL_KEYS_SET);
  assert.match(reason!, /monthly spending cap/);
});

test("an inactive record with no collected error still reads as a sentence", () => {
  // The field is nullable; a skip reason ending in "inactive — null" would tell
  // the report reader nothing.
  const reason = unavailableReason(
    ["google"],
    [record("google", "inactive", null)],
    ALL_KEYS_SET,
  );
  assert.equal(
    reason,
    'Provider "google" inactive — no reason recorded by collect-models',
  );
});

test("an inactive provider taints a multi-provider gate", () => {
  // language-model-regression's switch test drives OpenAI AND Google; a dead key
  // on either one wedges it.
  const reason = unavailableReason(
    ["openai", "google"],
    RUN_30374528125,
    ALL_KEYS_SET,
  );
  assert.match(reason!, /"google" inactive/);
});

// ─── Healthy path ────────────────────────────────────────────────────────────

test("an active provider does not skip", () => {
  assert.equal(
    unavailableReason(["openai"], RUN_30374528125, ALL_KEYS_SET),
    undefined,
  );
});

test("several active providers do not skip", () => {
  assert.equal(
    unavailableReason(["openai", "anthropic"], RUN_30374528125, ALL_KEYS_SET),
    undefined,
  );
});

// ─── Fail open on absent signal ──────────────────────────────────────────────

test("null records fail OPEN — no providers.json must not skip the world", () => {
  assert.equal(unavailableReason(["google"], null, ALL_KEYS_SET), undefined);
});

test("a provider absent from the records fails open", () => {
  // collect-models can write a partial file (a provider it never reached).
  assert.equal(
    unavailableReason(["google"], [record("openai", "active")], ALL_KEYS_SET),
    undefined,
  );
});

test("an empty records array fails open", () => {
  assert.equal(unavailableReason(["google"], [], ALL_KEYS_SET), undefined);
});

// ─── Env-key precedence ──────────────────────────────────────────────────────

test("a missing env key skips, naming the variable", () => {
  const reason = unavailableReason(["google"], RUN_30374528125, {
    ...ALL_KEYS_SET,
    GOOGLE_API_KEY: undefined,
  });
  assert.equal(reason, "GOOGLE_API_KEY required to run this test");
});

test("the missing env key wins over the recorded inactive reason", () => {
  // For an unset key collect-models records `"GOOGLE_API_KEY not set"` anyway —
  // naming the variable is the actionable half, so it must come first.
  const reason = unavailableReason(["google"], RUN_30374528125, {
    GOOGLE_API_KEY: undefined,
  });
  assert.doesNotMatch(reason!, /inactive/);
});

test("an empty-string env key counts as missing", () => {
  // `.env` files routinely carry `GOOGLE_API_KEY=` for an unused provider.
  const reason = unavailableReason(["google"], RUN_30374528125, {
    ...ALL_KEYS_SET,
    GOOGLE_API_KEY: "",
  });
  assert.equal(reason, "GOOGLE_API_KEY required to run this test");
});

test("the first missing key in the argument order is the one reported", () => {
  const reason = unavailableReason(["openai", "google"], RUN_30374528125, {});
  assert.equal(reason, "OPENAI_API_KEY required to run this test");
});

// ─── Escape hatch ────────────────────────────────────────────────────────────

test("IGNORE_PROVIDER_HEALTH=1 bypasses a stale inactive record", () => {
  assert.equal(
    unavailableReason(["google"], RUN_30374528125, {
      ...ALL_KEYS_SET,
      IGNORE_PROVIDER_HEALTH: "1",
    }),
    undefined,
  );
});

test("IGNORE_PROVIDER_HEALTH does NOT bypass a missing env key", () => {
  // The escape hatch overrides a possibly-stale health record; it cannot conjure
  // a credential the test needs to authenticate at all.
  const reason = unavailableReason(["google"], RUN_30374528125, {
    IGNORE_PROVIDER_HEALTH: "1",
  });
  assert.equal(reason, "GOOGLE_API_KEY required to run this test");
});

test("only the exact value \"1\" arms the escape hatch", () => {
  assert.ok(
    unavailableReason(["google"], RUN_30374528125, {
      ...ALL_KEYS_SET,
      IGNORE_PROVIDER_HEALTH: "true",
    }),
    "a truthy-looking value must not silently disable the gate",
  );
});

// ─── The test.skip pair the 22 call sites consume ────────────────────────────

test("toSkipGate returns an empty-string reason when nothing is skipped", () => {
  // Playwright's test.skip(condition, description) types `description` as string.
  // Passing `undefined` through would be a type error at every call site, so the
  // no-skip case MUST carry "".
  assert.deepEqual(toSkipGate(undefined), { skip: false, reason: "" });
});

test("toSkipGate carries the reason verbatim when it skips", () => {
  const reason = unavailableReason(["google"], RUN_30374528125, ALL_KEYS_SET)!;
  assert.deepEqual(toSkipGate(reason), { skip: true, reason });
});

// ─── readProviderHealth I/O ──────────────────────────────────────────────────

test("readProviderHealth returns null for a missing file", () => {
  assert.equal(
    readProviderHealth(path.join(os.tmpdir(), "no-such-providers-1029.json")),
    null,
  );
});

test("readProviderHealth returns null for malformed JSON instead of throwing", () => {
  // A truncated write (killed collect-models) must degrade to "no signal", not
  // crash every spec that consults the gate at collection time.
  const file = path.join(
    makeTempDir("provider-health-"),
    "providers.json",
  );
  fs.writeFileSync(file, '[{"provider":"google",');
  assert.equal(readProviderHealth(file), null);
});

test("readProviderHealth returns null for valid JSON that is not an array", () => {
  const file = path.join(
    makeTempDir("provider-health-"),
    "providers.json",
  );
  fs.writeFileSync(file, '{"provider":"google","status":"inactive"}');
  assert.equal(readProviderHealth(file), null);
});

test("readProviderHealth parses a real providers.json shape", () => {
  const file = path.join(
    makeTempDir("provider-health-"),
    "providers.json",
  );
  fs.writeFileSync(file, JSON.stringify(RUN_30374528125));
  const records = readProviderHealth(file);
  assert.equal(records?.length, 3);
  assert.equal(records?.find((r) => r.provider === "google")?.status, "inactive");
});

// --- Pre-flight degradation (issue #1058) -----------------------------------
//
// What rides on these: the credentials pre-flight in globalSetup used to `throw`
// in CI when a provider key was present in the env but missing as a Langflow
// global variable, killing the entire shard over one provider. It now records the
// provider unusable and lets the rest of the shard run. If that recording is
// wrong in either direction the fix backfires — too permissive and the spec makes
// a live call against a key Langflow does not have (the #1029 worker-kill class),
// too aggressive and it erases the more actionable reason collect-models measured.

test("providersForEnvKeys maps an env key back to its provider", () => {
  assert.deepEqual(providersForEnvKeys(["GOOGLE_API_KEY"]), ["google"]);
  assert.deepEqual(providersForEnvKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]).sort(), [
    "anthropic",
    "openai",
  ]);
  assert.deepEqual(providersForEnvKeys(["NOT_A_PROVIDER_KEY"]), []);
});

test("degradeProviders marks an ACTIVE provider inactive with the given reason", () => {
  const records: ProviderHealthRecord[] = [
    { provider: "openai", model: "gpt-4o-mini", status: "active", error: null },
    { provider: "google", model: "gemini-2.5-flash", status: "active", error: null },
  ];

  const out = degradeProviders(records, ["google"], "never imported");

  assert.equal(out.find((r) => r.provider === "google")?.status, "inactive");
  assert.equal(out.find((r) => r.provider === "google")?.error, "never imported");
  assert.equal(out.find((r) => r.provider === "google")?.model, null);
  // Untouched providers keep running — that is the whole point of the change.
  assert.deepEqual(out.find((r) => r.provider === "openai"), records[0]);
});

test("degradeProviders NEVER overwrites an existing inactive reason", () => {
  // collect-models measured WHY the key is dead ("monthly spending cap"), which is
  // strictly more actionable for triage than the pre-flight's structural note.
  const records: ProviderHealthRecord[] = [
    { provider: "google", model: null, status: "inactive", error: SPEND_CAP },
  ];

  const out = degradeProviders(records, ["google"], "never imported");

  assert.equal(out[0].error, SPEND_CAP);
});

test("degradeProviders creates a record for a provider that has none", () => {
  // Absence means "no signal" to readProviderHealth and callers fail OPEN, so
  // leaving it absent would let the specs run against a key Langflow lacks.
  const out = degradeProviders(null, ["google"], "never imported");

  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "google");
  assert.equal(out[0].status, "inactive");
});

test("degradeProviders does not mutate its input", () => {
  const records: ProviderHealthRecord[] = [
    { provider: "google", model: "gemini-2.5-flash", status: "active", error: null },
  ];
  degradeProviders(records, ["google"], "never imported");
  assert.equal(records[0].status, "active", "the caller's array must be untouched");
});

test("the degraded record drives the existing skip gate", () => {
  // End-to-end through the gate the specs actually consult: degrading is only
  // useful if unavailableReason then reports it.
  const out = degradeProviders(
    [{ provider: "google", model: "gemini-2.5-flash", status: "active", error: null }],
    ["google"],
    "GOOGLE_API_KEY was never imported as a Langflow global variable",
  );

  const reason = unavailableReason(["google"], out, { GOOGLE_API_KEY: "set" } as NodeJS.ProcessEnv);
  assert.match(String(reason), /never imported as a Langflow global variable/);
});

test("writeProviderHealth round-trips through readProviderHealth", () => {
  const dir = makeTempDir("provider-health-");
  const file = path.join(dir, "nested", "providers.json");
  const records = degradeProviders(null, ["google"], "never imported");

  assert.equal(writeProviderHealth(records, file), true, "must create missing parent dirs");
  assert.deepEqual(readProviderHealth(file), records);
});

test("writeProviderHealth reports failure instead of throwing", () => {
  // It runs from globalSetup: a write failure must never become the reason the
  // suite cannot start. The caller says so out loud instead of assuming success.
  const dir = makeTempDir("provider-health-");
  const asDir = path.join(dir, "providers.json");
  fs.mkdirSync(asDir); // a directory where the file should go — write must fail

  assert.equal(writeProviderHealth([], asDir), false);
});

// ─── providerSkipReasons — the parametrized specs' gate (issue #1043) ─────────
//
// What rides on this function: 18 provider-parametrized spec files build one test
// target per `models.json` entry and consult this map for the target's provider. Too
// permissive and a target runs a live call against a dead key — the failure mode
// #1029 exists to prevent (on run 30374528125 that killed the shard's only Langflow
// worker six times and cost 14 collateral timeouts). Too strict and the whole agent
// family skips, which reads as green.
//
// It replaced a byte-similar copy inlined in each of those files. The copies did NOT
// honour `IGNORE_PROVIDER_HEALTH` and printed `inactive — null` for a nullable
// error; both are corrected here, so these tests are also the record of the
// behaviour change.

const QUIET = { ...ALL_KEYS_SET } as NodeJS.ProcessEnv;

/** Collects `console.warn` output emitted while `run` executes. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("maps every inactive provider to its collected reason", () => {
  const reasons = providerSkipReasons(RUN_30374528125, QUIET);
  assert.deepEqual([...reasons.keys()], ["google"]);
  assert.equal(reasons.get("google"), `Provider "google" inactive — ${SPEND_CAP}`);
});

test("an active provider is absent from the map, not present with an empty reason", () => {
  // The call sites do `skipReasons.get(provider)` and pass the result straight to
  // `test.skip(!!reason, reason)`. An empty-string entry would skip nothing but
  // would report a blank reason if the shape ever changed; absence is the contract.
  const reasons = providerSkipReasons(RUN_30374528125, QUIET);
  assert.equal(reasons.has("openai"), false);
  assert.equal(reasons.get("anthropic"), undefined);
});

test("no health signal fails OPEN — an empty map, never a blanket skip", () => {
  // providers.json is gitignored, so a fresh clone and any targeted local run
  // legitimately have none, and CI may run with a failed `Collect models` (#980).
  for (const records of [null, []]) {
    assert.equal(providerSkipReasons(records, QUIET).size, 0);
  }
});

test("IGNORE_PROVIDER_HEALTH=1 empties the map", () => {
  // The escape hatch for a STALE local providers.json. `providerSkipGate` has
  // honoured it since #1029; the inlined copies this replaced did not, so a local
  // run of the agent family was unrunnable off a days-old file.
  const reasons = providerSkipReasons(RUN_30374528125, {
    ...QUIET,
    IGNORE_PROVIDER_HEALTH: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(reasons.size, 0);
});

test("a nullable error still produces a usable line, never `inactive — null`", () => {
  const reasons = providerSkipReasons(
    [{ provider: "google", model: null, status: "inactive", error: null }],
    QUIET,
  );
  assert.equal(
    reasons.get("google"),
    'Provider "google" inactive — no reason recorded by collect-models',
  );
  assert.ok(!String(reasons.get("google")).includes("null"));
});

test("the map and the hardcoded gate report the SAME reason for the same record", () => {
  // The two entry points must not drift: a spec parametrized over google and a spec
  // hardcoding google should quote the same line in the report.
  const reasons = providerSkipReasons(RUN_30374528125, QUIET);
  assert.equal(
    reasons.get("google"),
    unavailableReason(["google"], RUN_30374528125, QUIET),
  );
});

test("providerSkipReasons does not depend on env keys being set", () => {
  // Deliberate parity with the copies it replaced: this gate reports COLLECTED
  // health only. A missing env key is `unavailableReason`'s precedence rule, and
  // folding it in here would change which targets skip vs. fail.
  const reasons = providerSkipReasons(RUN_30374528125, {} as NodeJS.ProcessEnv);
  assert.deepEqual([...reasons.keys()], ["google"]);
});

test("with no records argument it READS providers.json", () => {
  // The zero-argument form is the only one the 18 call sites use, and nothing bound
  // it to the file: changing the parameter's default to `null` left every one of
  // these tests green while silently disabling the gate for the whole agent family —
  // #1029's failure mode, restored by a one-word edit. `jsonPath` is the same
  // test-only seam `readProviderHealth` / `writeProviderHealth` already take.
  const dir = makeTempDir("provider-skip-reasons-");
  const file = path.join(dir, "providers.json");
  writeProviderHealth(RUN_30374528125, file);

  const reasons = providerSkipReasons(undefined, QUIET, file);
  assert.equal(reasons.get("google"), `Provider "google" inactive — ${SPEND_CAP}`);
});

test("an armed escape hatch does not even read the file", () => {
  // Ordering, not micro-optimisation: it documents that the hatch short-circuits
  // before any I/O, so a missing file cannot make the hatch warn.
  const warnings = captureWarnings(() =>
    providerSkipReasons(undefined, { ...QUIET, IGNORE_PROVIDER_HEALTH: "1" } as NodeJS.ProcessEnv, path.join(os.tmpdir(), "does-not-exist-1043", "providers.json")),
  );
  assert.deepEqual(warnings, []);
});

test("only the exact value \"1\" arms the escape hatch here too", () => {
  // `unavailableReason` has this test; without a parallel one the two entry points
  // can drift on the value contract — the very drift this dedupe removed.
  const reasons = providerSkipReasons(RUN_30374528125, {
    ...QUIET,
    IGNORE_PROVIDER_HEALTH: "true",
  } as NodeJS.ProcessEnv);
  assert.equal(reasons.size, 1, "a truthy-looking value must not disable the gate");
});

test("a missing providers.json says so, instead of looking healthy in silence", () => {
  // Kept from the majority of the copies it replaced: this runs at collection time,
  // and a local run with no providers.json should say why every provider looks fine.
  // Two of the copies were silent; the warn is now uniform.
  const warnings = captureWarnings(() => providerSkipReasons(null, QUIET));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /collect-models\.spec\.ts/);
});

// ─── The remedy a rejected credential needs (#1823) ──────────────────────────

test("#1823: with nothing rejected, the remedy is still to run the collector", () => {
  const remedy = credentialRemedy([]);
  assert.match(remedy, /collect-models/, "the import advice must survive the case it was written for");
  assert.doesNotMatch(remedy, /replace the credential/i);
});

test("#1823: a rejected credential is told to be replaced, not re-imported", () => {
  const remedy = credentialRemedy([
    "credential rejected by Anthropic: Invalid API key for Anthropic",
  ]);
  assert.match(remedy, /replace the credential/i);
  assert.match(remedy, /Invalid API key for Anthropic/, "the provider's own words must survive");
  // The whole point: the collector ALREADY ran and was refused, so telling the
  // reader to run it again is advice that cannot change anything.
  assert.doesNotMatch(
    remedy,
    /Run `npx playwright test tests\/collect-models\.spec\.ts`/,
    "re-running the collector cannot help a key the panel refuses",
  );
});

// ─── #1904: an `active` record expires ───────────────────────────────────────

const NOW = Date.parse("2026-09-23T12:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const activeAt = (provider: string, checkedAt: string | undefined): ProviderHealthRecord => ({
  provider,
  model: "m",
  status: "active",
  error: null,
  ...(checkedAt === undefined ? {} : { checkedAt }),
});

test("#1904 an active record inside the window runs, one outside it skips", () => {
  const within = unavailableReason(["openai"], [activeAt("openai", at(DEFAULT_MAX_AGE_HOURS - 1))], ALL_KEYS_SET, NOW);
  assert.equal(within, undefined);
  // The measured case: a six-day-old all-`active` local providers.json.
  const reason = unavailableReason(["openai"], [activeAt("openai", at(6 * 24))], ALL_KEYS_SET, NOW);
  assert.ok(reason, "a six-day-old `active` record must not be believed");
  const parsed = parseProviderInactiveReason(reason);
  assert.equal(parsed?.provider, "openai");
  assert.equal(parsed?.stale, true, "the report must say the record is old, not that the key is dead");
});

test("#1904 an active record with no or an unreadable checkedAt is expired, never trusted", () => {
  assert.equal(isExpired(activeAt("openai", undefined), {}, NOW), true);
  assert.equal(isExpired(activeAt("openai", "yesterday-ish"), {}, NOW), true);
  // Clock skew: a timestamp from the future is not old.
  assert.equal(isExpired(activeAt("openai", new Date(NOW + HOUR).toISOString()), {}, NOW), false);
});

test("#1904 an inactive record never expires — its skip keeps the collected reason", () => {
  const old: ProviderHealthRecord = { provider: "google", model: null, status: "inactive", error: SPEND_CAP, checkedAt: at(6 * 24) };
  assert.equal(isExpired(old, {}, NOW), false);
  assert.match(String(unavailableReason(["google"], [old], ALL_KEYS_SET, NOW)), /monthly spending cap/);
});

test("#1904 the window is PROVIDER_HEALTH_MAX_AGE_HOURS, and a bad value falls back", () => {
  assert.equal(maxAgeHours({}), DEFAULT_MAX_AGE_HOURS);
  assert.equal(maxAgeHours({ PROVIDER_HEALTH_MAX_AGE_HOURS: "2" }), 2);
  for (const bad of ["0", "-1", "soon", ""]) {
    assert.equal(maxAgeHours({ PROVIDER_HEALTH_MAX_AGE_HOURS: bad }), DEFAULT_MAX_AGE_HOURS, bad);
  }
  const threeHoursOld = [activeAt("openai", at(3))];
  assert.equal(unavailableReason(["openai"], threeHoursOld, ALL_KEYS_SET, NOW), undefined);
  assert.ok(
    unavailableReason(["openai"], threeHoursOld, { ...ALL_KEYS_SET, PROVIDER_HEALTH_MAX_AGE_HOURS: "2" }, NOW),
  );
});

test("#1904 IGNORE_PROVIDER_HEALTH=1 runs an expired record too", () => {
  const env = { ...ALL_KEYS_SET, IGNORE_PROVIDER_HEALTH: "1" };
  assert.equal(unavailableReason(["openai"], [activeAt("openai", at(48))], env, NOW), undefined);
  assert.equal(providerSkipReasons([activeAt("openai", at(48))], env, undefined, NOW).size, 0);
});

test("#1904 the parametrized specs' reasons carry an expired active record too", () => {
  const reasons = providerSkipReasons(
    [activeAt("openai", at(48)), activeAt("anthropic", at(1))],
    ALL_KEYS_SET,
    undefined,
    NOW,
  );
  assert.deepEqual([...reasons.keys()], ["openai"]);
  assert.equal(parseProviderInactiveReason(reasons.get("openai"))?.stale, true);
});

test("#1904 no file is still no signal — expiry never turns absence into a skip", () => {
  assert.equal(unavailableReason(["openai"], null, ALL_KEYS_SET, NOW), undefined);
});
