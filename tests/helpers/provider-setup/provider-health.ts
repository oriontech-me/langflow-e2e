import fs from "fs";
import path from "path";
import { providerConfigMap, type Provider } from "./provider-config";

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
 * declared — the real records also carry `checkedAt`, the timestamp that would let
 * a future version expire a stale record automatically instead of relying on
 * `IGNORE_PROVIDER_HEALTH=1`. Keep in sync with `collect-models.ts` by hand; the
 * producer's own spec asserts the record shape it writes.
 */
export interface ProviderHealthRecord {
  provider: string;
  model: string | null;
  status: "active" | "inactive";
  error: string | null;
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
): string | undefined {
  for (const provider of providers) {
    const missing = (providerConfigMap[provider]?.envKeys ?? []).filter(
      (key) => !env[key],
    );
    if (missing.length > 0) {
      return `${missing.join(", ")} required to run this test`;
    }
  }

  // Escape hatch for a STALE local providers.json: `collect-models` is not part
  // of a targeted local run, so a record from days ago can hold back a spec that
  // would pass today. CI never needs this — every shard collects its own health
  // immediately before the @stable run.
  if (env.IGNORE_PROVIDER_HEALTH === "1") return undefined;

  if (!records) return undefined; // no signal — fail open, see readProviderHealth

  for (const provider of providers) {
    const record = records.find((r) => r.provider === provider);
    if (record?.status === "inactive") {
      // The reason lands in the Playwright report — it is the whole product of a
      // skip, so it must never read `inactive — null`. `collect-models` always
      // fills `error` for an inactive record today, but the field is nullable and
      // a hand-edited or future-schema file must still produce a usable line.
      return `Provider "${provider}" inactive — ${
        record.error ?? "no reason recorded by collect-models"
      }`;
    }
  }

  return undefined;
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
