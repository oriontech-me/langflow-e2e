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
  readProviderHealth,
  unavailableReason,
  type ProviderHealthRecord,
} from "./provider-health";

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
): ProviderHealthRecord => ({ provider, model: "some-model", status, error });

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
    fs.mkdtempSync(path.join(os.tmpdir(), "provider-health-")),
    "providers.json",
  );
  fs.writeFileSync(file, '[{"provider":"google",');
  assert.equal(readProviderHealth(file), null);
});

test("readProviderHealth returns null for valid JSON that is not an array", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "provider-health-")),
    "providers.json",
  );
  fs.writeFileSync(file, '{"provider":"google","status":"inactive"}');
  assert.equal(readProviderHealth(file), null);
});

test("readProviderHealth parses a real providers.json shape", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "provider-health-")),
    "providers.json",
  );
  fs.writeFileSync(file, JSON.stringify(RUN_30374528125));
  const records = readProviderHealth(file);
  assert.equal(records?.length, 3);
  assert.equal(records?.find((r) => r.provider === "google")?.status, "inactive");
});
