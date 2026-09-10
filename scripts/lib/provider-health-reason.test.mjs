// Round-trip contract for the provider-health skip reason (issue #1456).
// Run with: npm run test:scripts
//
// The producer (`tests/helpers/provider-setup/provider-health.ts`) writes this
// string into a `test.skip` description; the consumer
// (`scripts/lane-coverage-verdict.mjs`) reads it back out of the Playwright report to
// decide whether a run covered the providers it was supposed to cover. A drift
// between the two is SILENT in the direction that matters: an unrecognised
// description makes the verdict report "no provider-health skip", i.e. exactly the
// green the verdict exists to remove.
//
// So the pair is pinned as a round trip rather than as a literal. Two tests do assert
// the literal shape as well — the exact bytes reach the Playwright report and a human
// reads them there — but every other case is written so that renaming the wording in
// the formatter keeps them passing only if the parser was taught the new wording too.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NO_REASON_RECORDED,
  formatProviderInactiveReason,
  parseProviderInactiveReason,
} from "./provider-health-reason.mjs";

test("the formatted line is what the gate has always emitted", () => {
  // The one literal assertion: this string lands in the Playwright report and in the
  // skip line a human reads, so a refactor must not reword it by accident.
  assert.equal(
    formatProviderInactiveReason("openai", "credit balance is too low"),
    'Provider "openai" inactive — credit balance is too low',
  );
});

test("a nullable error still produces a usable line, never `inactive — null`", () => {
  const line = formatProviderInactiveReason("google", null);
  assert.equal(line, `Provider "google" inactive — ${NO_REASON_RECORDED}`);
  assert.doesNotMatch(line, /null/);
  assert.equal(
    formatProviderInactiveReason("google", undefined),
    formatProviderInactiveReason("google", null),
  );
});

test("every formatted reason parses back to what went in", () => {
  const cases = [
    ["openai", "credit balance is too low"],
    ["anthropic", "collector never configured this provider"],
    ["google", "monthly spending cap reached"],
    // An error that itself contains the separator: the parser must take the whole
    // remainder, not stop at the first em dash.
    ["mistral", "429 — rate limited by the provider"],
    // Multi-line: `collect-models` records what the provider answered, and a
    // provider error body is not guaranteed to be one line.
    ["groq", "invalid_api_key\n  at provider probe"],
  ];
  for (const [provider, error] of cases) {
    const parsed = parseProviderInactiveReason(
      formatProviderInactiveReason(provider, error),
    );
    assert.deepEqual(parsed, { provider, error }, `round trip failed for ${provider}`);
  }
});

test("an empty error round-trips as empty rather than as `not a provider skip`", () => {
  // `provider-health.ts` passes `record.error` through with `??`, so an empty string
  // stays empty and the line ends at the separator. Reading that back as "this was
  // not a provider-health skip" would drop the very skip the verdict is counting.
  const parsed = parseProviderInactiveReason(formatProviderInactiveReason("openai", ""));
  assert.deepEqual(parsed, { provider: "openai", error: "" });
});

test("the fallback reason round-trips too", () => {
  assert.deepEqual(
    parseProviderInactiveReason(formatProviderInactiveReason("openai", null)),
    { provider: "openai", error: NO_REASON_RECORDED },
  );
});

test("every other skip description is NOT a provider-health skip", () => {
  // The skips a healthy run legitimately carries. Classifying any of these as a
  // provider-health skip would let the verdict claim a provider was not covered on a
  // day nothing was wrong with it — and, when nothing else ran, fail the lane for it.
  const others = [
    "no backend in this environment",
    "OPENAI_API_KEY required to run this test", // the env-key reason, deliberately out of scope
    "MODEL_NOT_AVAILABLE: gpt-4o-mini",
    'provider "openai" has no vision-capable model in the catalog',
    "@destructive tests run in their own lane",
    "Provider openai inactive — credit balance is too low", // no quotes: not the contract
    "provider \"openai\" inactive — credit balance is too low", // lower-cased: not the contract
    "",
  ];
  for (const description of others) {
    assert.equal(
      parseProviderInactiveReason(description),
      null,
      `misread as a provider-health skip: ${JSON.stringify(description)}`,
    );
  }
});

test("a non-string description is not a skip reason", () => {
  // Playwright's annotation `description` is optional — `test.fixme()` carries none —
  // and the parser is called on whatever the report holds.
  for (const value of [undefined, null, 0, {}, [], true]) {
    assert.equal(parseProviderInactiveReason(value), null);
  }
});

test("surrounding whitespace does not hide a provider-health skip", () => {
  assert.deepEqual(
    parseProviderInactiveReason('  Provider "openai" inactive — dead key\n'),
    { provider: "openai", error: "dead key" },
  );
});
