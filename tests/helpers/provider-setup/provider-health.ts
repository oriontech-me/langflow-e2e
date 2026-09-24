import fs from "fs";
import path from "path";
import { providerConfigMap, type Provider } from "./provider-config";
import {
  formatProviderInactiveReason,
  formatProviderStaleReason,
} from "../../../scripts/lib/provider-health-reason.mjs";

// Provider health gate for specs that HARDCODE a provider (issue #1029).
//
// `collect-models` already records a provider as `inactive` in providers.json
// when its key is dead — drained balance, revoked key, spend cap. Specs that are
// PARAMETRIZED by provider honor that. Specs that hardcode one used to gate on
// the mere presence of the env var:
//
//   test.skip(!process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY required")
//
// A key that exists but is dead therefore ran the test. On run 30374528125 the
// Google key had exceeded its monthly spending cap; `models.json` still listed
// all 36 Google models (it mirrors the Langflow catalog, not the validation),
// so the two Google tests in `language-model-regression.spec.ts` resolved a
// model and made the live call anyway. Each blocked a backend request past
// gunicorn's 300s timeout, killing the shard's single Langflow worker — six
// kill/restart cycles and 14 collateral timeouts across unrelated specs.
//
// This module is the single source of that gate. It reads the same providers.json
// the parametrized specs read, so a provider recorded `inactive` produces a
// `test.skip` quoting the collected reason instead of a live call against a dead
// key.

/**
 * Shape of one providers.json entry written by `collect-models`.
 *
 * Deliberately re-declared instead of importing `ProviderRecord` from
 * `collect-models.ts`: that module imports `@playwright/test` and drives a
 * `SettingsPage`, and this one is consumed by a `node --test` unit lane that must
 * not pull a browser-facing dependency graph. Only the fields this gate reads are
 * declared. Keep in sync with `collect-models.ts` by hand; the producer's own spec
 * asserts the record shape it writes.
 *
 * `checkedAt` is optional here although `collect-models` always writes it, because
 * `degradeProviders` (below) writes `inactive` records without one — and an
 * `inactive` record never needs it. On an `active` record its absence is read as
 * an age that cannot be established, i.e. as expired (#1904, see `isExpired`).
 */
export interface ProviderHealthRecord {
  provider: string;
  model: string | null;
  status: "active" | "inactive";
  error: string | null;
  checkedAt?: string;
}

/**
 * How old an `active` record may be before it stops counting as a signal (#1904).
 *
 * The record is only as good as the sweep that wrote it. Every lane sweeps
 * immediately before its run and starts each shard without an older file — Actions
 * from a fresh checkout, the VM because `run-e2e.sh` drops the clone's copy from
 * each shard — so there it is minutes old: the longest daily in
 * `reports/daily-history.jsonl` took 82 min, and `manual.yml`'s job cap is 180 min.
 * `providers.json` is gitignored, though, and survives across days on a dev box —
 * the one this was written on held a six-day-old all-`active` file — and a
 * targeted local run does not sweep, by design. 12 h is four times the longest
 * lane, and short enough that yesterday's sweep is never trusted today.
 * `PROVIDER_HEALTH_MAX_AGE_HOURS` moves it; a value that is not a positive number
 * (`0` included) falls back to 12, so expiry cannot be switched off on its own —
 * `IGNORE_PROVIDER_HEALTH=1` is the switch, and it lifts the `inactive` skips too.
 */
export const DEFAULT_MAX_AGE_HOURS = 12;

/** The window from the environment, or the default when unset or not a positive number. */
export function maxAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROVIDER_HEALTH_MAX_AGE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_HOURS;
}

/**
 * Whether an `active` record is too old to believe.
 *
 * Only `active` expires. An old `inactive` record still names a key that was dead
 * and a skip the escape hatch already covers; it is the stale `active` that runs a
 * spec into a dead key, which is the direction this gate exists for and the one
 * nothing handled. An unreadable or missing `checkedAt` cannot be shown to be
 * fresh, so it is expired rather than trusted (#1012). A timestamp up to an hour
 * in the future is clock skew and is trusted; further ahead it cannot be a real
 * sweep, and trusting it would never expire the record, so it counts as unreadable.
 */
export function isExpired(
  record: ProviderHealthRecord,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (record.status !== "active") return false;
  const at = Date.parse(String(record.checkedAt ?? ""));
  if (!Number.isFinite(at) || at - now > 3_600_000) return true;
  return now - at > maxAgeHours(env) * 3_600_000;
}

function staleReason(record: ProviderHealthRecord, env: NodeJS.ProcessEnv): string {
  return formatProviderStaleReason(record.provider, record.checkedAt, maxAgeHours(env));
}

const PROVIDERS_PATH = path.join(__dirname, "data", "providers.json");

/**
 * Reads providers.json, or returns `null` when it is absent or unparseable.
 *
 * `null` means "no health signal" and callers must FAIL OPEN — never skip the
 * world because the pre-flight did not run. providers.json is gitignored and
 * only exists after `collect-models`, so a fresh clone or a targeted local run
 * legitimately has no file, and CI's `Collect models` step is explicitly allowed
 * to fail without aborting the shard (#980).
 */
export function readProviderHealth(
  jsonPath: string = PROVIDERS_PATH,
): ProviderHealthRecord[] | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    return Array.isArray(parsed) ? (parsed as ProviderHealthRecord[]) : null;
  } catch {
    return null;
  }
}

/**
 * The providers that own the given env keys — `["GOOGLE_API_KEY"]` → `["google"]`.
 *
 * Inverts `providerConfigMap.envKeys` rather than hardcoding the mapping, so a
 * provider that grows a second required key is covered without editing this.
 */
export function providersForEnvKeys(envKeys: string[]): Provider[] {
  const wanted = new Set(envKeys);
  return (Object.keys(providerConfigMap) as Provider[]).filter((provider) =>
    (providerConfigMap[provider]?.envKeys ?? []).some((key) => wanted.has(key)),
  );
}

/**
 * Marks the given providers `inactive`, returning a NEW record list (issue #1058).
 *
 * The credentials pre-flight used to `throw` in CI when a provider key was present
 * in the environment but absent as a Langflow global variable — killing the whole
 * shard over ONE provider. On run 30444299314 that cost ~184 tests that never
 * touch google. Recording the provider as unusable instead routes it through the
 * gate this module already owns: dependent specs `test.skip` with the reason, and
 * every unrelated spec runs.
 *
 * An existing `inactive` record is NEVER overwritten: `collect-models` measured
 * why the provider is dead ("credit balance too low", "monthly spending cap"), and
 * that is strictly more actionable than the pre-flight's structural observation.
 * A provider with no record at all gets one, because absence means "no signal" to
 * `readProviderHealth` and callers fail OPEN — leaving it absent would let the
 * specs run against a key Langflow does not have.
 */
export function degradeProviders(
  records: ProviderHealthRecord[] | null,
  providers: Provider[],
  reason: string,
): ProviderHealthRecord[] {
  const existing = records ?? [];
  const seen = new Map(existing.map((r) => [r.provider, r]));

  for (const provider of providers) {
    const record = seen.get(provider);
    if (record?.status === "inactive") continue;
    seen.set(provider, { provider, model: null, status: "inactive", error: reason });
  }

  // Preserve input order, then append providers that had no record at all.
  const ordered = existing.map((r) => seen.get(r.provider) ?? r);
  for (const [provider, record] of seen) {
    if (!existing.some((r) => r.provider === provider)) ordered.push(record);
  }
  return ordered;
}

/**
 * Persists provider health. Best-effort by design: this runs from `globalSetup`,
 * where a write failure must not become the reason the suite cannot start — a
 * failed write leaves the previous (or absent) signal, and `readProviderHealth`
 * already fails open on absence. Returns whether the write landed so the caller
 * can say so out loud instead of assuming.
 */
export function writeProviderHealth(
  records: ProviderHealthRecord[],
  jsonPath: string = PROVIDERS_PATH,
): boolean {
  try {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure decision function: the reason the given providers cannot serve a live
 * call, or `undefined` when every one of them is usable.
 *
 * Precedence is deliberate — a missing env key is reported before a recorded
 * `inactive`, because without the key the provider cannot even be configured and
 * "GOOGLE_API_KEY is not set" is more actionable than the stale collected error
 * (which, for an unset key, is just `"GOOGLE_API_KEY not set"` anyway).
 *
 * Split from the I/O above so the matrix can be unit-tested without a fixture
 * file on disk (`provider-health.test.ts`).
 */
export function unavailableReason(
  providers: Provider[],
  records: ProviderHealthRecord[] | null,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string | undefined {
  for (const provider of providers) {
    const missing = (providerConfigMap[provider]?.envKeys ?? []).filter(
      (key) => !env[key],
    );
    if (missing.length > 0) {
      return `${missing.join(", ")} required to run this test`;
    }
  }

  // Escape hatch for a STALE local providers.json, in either direction: an old
  // `inactive` record can hold back a spec that would pass today, and an expired
  // `active` one now skips too (#1904). No lane needs this — every shard collects
  // its own health immediately before its run.
  if (env.IGNORE_PROVIDER_HEALTH === "1") return undefined;

  if (!records) return undefined; // no signal — fail open, see readProviderHealth

  const own = providers.map((p) => records.find((r) => r.provider === p));
  // Every provider's `inactive` first: a key measured dead is the more useful line
  // than another provider's record merely being old.
  for (const record of own) {
    if (record?.status === "inactive") return inactiveReason(record);
  }
  // An expired `active` record SKIPS rather than failing open (#1904). Failing
  // open was weighed and rejected: it lands a drained key on the backend, which
  // is #1029's worker kill — six restarts and 14 collateral timeouts on run
  // 30374528125 — and it does so silently, since no skip line names the cause.
  // A false skip here costs one re-sweep and says so in the report.
  for (const record of own) {
    if (record && isExpired(record, env, now)) return staleReason(record, env);
  }

  return undefined;
}

/**
 * The skip line for one `inactive` record.
 *
 * The reason lands in the Playwright report — it is the whole product of a skip, so
 * it must never read `inactive — null`. `collect-models` always fills `error` for an
 * inactive record today, but the field is nullable and a hand-edited or
 * future-schema file must still produce a usable line.
 *
 * Since #1456 the wording is no longer only for humans: `lane-coverage-verdict.mjs`
 * reads it back out of the Playwright report to tell a provider-health skip from
 * every other kind, so it is a contract with that consumer and is formatted by the
 * module both sides share (`scripts/lib/provider-health-reason.mjs`). The wording can
 * no longer be changed here alone — the round trip is unit-tested from both ends.
 */
function inactiveReason(record: ProviderHealthRecord): string {
  return formatProviderInactiveReason(record.provider, record.error);
}

/**
 * Every `inactive` provider and why, as `provider → reason` (issue #1043).
 *
 * The shape the provider-**parametrized** specs consume: they build one test target
 * per `models.json` entry and need the reason for the target's provider, whichever
 * that turns out to be — unlike the hardcoded specs, which know their providers up
 * front and use `providerSkipGate`.
 *
 * It replaced 18 inlined copies: 16 `agent-*.spec.ts` files and
 * `mcp-client-agent.spec.ts` carried this `Map`-returning shape, and
 * `mcp-client-agent-gemini-tool-regression.spec.ts` a single-provider variant. They
 * had already drifted — 15 warn on a missing `providers.json`, two are silent, and
 * `agent-component-regression` names a `collect-providers.spec.ts` that does not
 * exist — so every change to the skip contract had to be made in 18 places.
 *
 * Three deliberate differences from those copies, all of them the contract this
 * module already owns elsewhere:
 *
 *  - `IGNORE_PROVIDER_HEALTH=1` empties the map, so the escape hatch for a stale
 *    local `providers.json` now works for the parametrized specs too. It did not
 *    before, even though `providerSkipGate` honoured the same variable, so a local
 *    run had to delete the gitignored file to get a stale-`inactive` provider's
 *    targets back. Local only: the variable is set in no workflow, script or config.
 *  - a nullable `error` produces "no reason recorded by collect-models" instead of
 *    the literal `inactive — null`.
 *  - the file is read via `readProviderHealth`, which fails OPEN on an absent or
 *    unparseable file (a fresh clone has none — it is gitignored). Worth naming what
 *    that widens: the copies THREW on malformed JSON, which surfaced as a loud
 *    spec-load failure; these 18 specs now warn and run. That is the module's #980
 *    contract — CI may legitimately run with a failed `Collect models` — but it does
 *    apply to more specs than before.
 *
 * The `console.warn` on a missing file is kept from the majority of the copies: this
 * runs at collection time, and a local run with no `providers.json` should say why
 * every provider looks healthy.
 *
 * `records` and `jsonPath` exist for the unit tests, matching `readProviderHealth` /
 * `writeProviderHealth`; every call site passes nothing. Explicit `null` means "no
 * signal" and fails open, which is why the file read is keyed on `undefined` rather
 * than on falsiness — and why the escape hatch is checked FIRST, so an armed hatch
 * does not pay for a read it discards.
 */
export function providerSkipReasons(
  records?: ProviderHealthRecord[] | null,
  env: NodeJS.ProcessEnv = process.env,
  jsonPath?: string,
  now: number = Date.now(),
): Map<string, string> {
  const reasons = new Map<string, string>();
  if (env.IGNORE_PROVIDER_HEALTH === "1") return reasons;
  const resolved =
    records === undefined ? readProviderHealth(jsonPath) : records;
  if (!resolved) {
    console.warn(
      "providers.json not found or unreadable — run collect-models.spec.ts first. " +
        "Skipping provider pre-validation.",
    );
    return reasons;
  }
  for (const record of resolved) {
    if (record.status === "inactive") {
      reasons.set(record.provider, inactiveReason(record));
    } else if (isExpired(record, env, now)) {
      // Same rule and same reason as `unavailableReason` (#1904): the parametrized
      // specs are the larger population, and the stale `active` hazard is theirs too.
      reasons.set(record.provider, staleReason(record, env));
    }
  }
  return reasons;
}

/**
 * The reason the given provider(s) cannot serve a live call right now, reading
 * the health recorded by `collect-models`; `undefined` when all are usable.
 *
 * Pass every provider the test actually calls — the switch test in
 * `language-model-regression.spec.ts` needs both OpenAI and Google, and a dead
 * key on either one wedges it just the same.
 */
export function providerUnavailableReason(
  ...providers: Provider[]
): string | undefined {
  return unavailableReason(providers, readProviderHealth());
}

/**
 * Shapes a reason into the `test.skip(condition, description)` pair.
 *
 * Split out for the same reason `unavailableReason` is: it makes the contract the
 * 22 call sites actually depend on — `reason` is ALWAYS a string, so Playwright's
 * signature is satisfied even when nothing is skipped — testable without a
 * providers.json on disk.
 */
export function toSkipGate(reason: string | undefined): {
  skip: boolean;
  reason: string;
} {
  return { skip: !!reason, reason: reason ?? "" };
}

/**
 * `test.skip`-shaped gate for a provider-hardcoded spec:
 *
 *   const gate = providerSkipGate("openai", "google");
 *   test.skip(gate.skip, gate.reason);
 *
 * `reason` is always a string so it satisfies Playwright's signature; it is only
 * surfaced when `skip` is true.
 */
export function providerSkipGate(...providers: Provider[]): {
  skip: boolean;
  reason: string;
} {
  return toSkipGate(providerUnavailableReason(...providers));
}

/**
 * What to tell the reader when a provider key is set but not configured in
 * Langflow (#1823).
 *
 * The detection upstream of this is a true positive and its degradation is
 * right; what aged badly is the REMEDY. "Run the collector first" is correct for
 * a key that was never imported, and useless for one the panel refused — there
 * the collector already ran, `POST /api/v1/models/validate-provider` answered
 * `{valid:false}` in ~0.5 s, and the panel then deliberately issued no write.
 * Running it again reproduces the refusal.
 *
 * Pure so the decision is testable on its output rather than asserted about a
 * console line nobody reads.
 */
export function credentialRemedy(rejections: string[]): string {
  if (rejections.length === 0) {
    return (
      "Run `npx playwright test tests/collect-models.spec.ts` first to import them " +
      "(the daily-stable CI does this automatically)."
    );
  }
  return (
    "The collector already ran and the provider REFUSED the credential, so importing again " +
    `cannot help — replace the credential: ${rejections.join(" | ")}.`
  );
}
