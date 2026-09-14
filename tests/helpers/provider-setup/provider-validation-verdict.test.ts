// Unit tests for the panel's credential-check verdict (#1823).
// Run with: npm run test:units
//
// What rides on it: whether a key the PROVIDER refused is reported as the key
// verdict it is, or as the 240 s "collector stall" it was on the 2026-09-11 daily
// (run 34599745145) — where the message read "this is NOT a key or account
// problem, the key was never probed" about a key Langflow had probed live and had
// been told was invalid 0.4 s after the click.
//
// Bodies below are verbatim from 1.13.0.dev9.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_REJECTED_PREFIX,
  UNSTATED_REJECTION_REASON,
  formatCredentialRejection,
  isCredentialRejectedReason,
  isValidateProviderUrl,
  parseValidationVerdict,
  validationPayloadProvider,
} from "./provider-validation-verdict";

const REJECTED = '{"valid":false,"error":"Invalid API key for Anthropic"}';
const ACCEPTED = '{"valid":true,"error":null}';

test("a rejection is read out of the BODY, which is the only place it exists", () => {
  // The status line is 200 for both of these — measured on all three providers of
  // the local instance, and the reason `validateResp.ok()` proves nothing.
  assert.deepEqual(parseValidationVerdict(REJECTED), {
    kind: "rejected",
    error: "Invalid API key for Anthropic",
  });
  assert.deepEqual(parseValidationVerdict(ACCEPTED), { kind: "accepted" });
});

test("a rejection with no message still says something", () => {
  const verdict = parseValidationVerdict('{"valid":false}');
  assert.equal(verdict.kind, "rejected");
  assert.equal(verdict.kind === "rejected" && verdict.error, UNSTATED_REJECTION_REASON);
  // Blank is the same case as absent — a rejection whose reason is "" would print
  // as a dangling colon and read like a truncated log line.
  const blank = parseValidationVerdict('{"valid":false,"error":"   "}');
  assert.equal(blank.kind === "rejected" && blank.error, UNSTATED_REJECTION_REASON);
});

test("anything that is not a definite verdict is UNREADABLE, never accepted", () => {
  // The load-bearing half: only a definite `valid:false` may short-circuit the
  // wait, so every one of these has to fall through to the existing behaviour
  // rather than be guessed either way (#1012).
  for (const body of [
    "",
    "not json at all",
    "null",
    "[]",
    '"a string"',
    "{}",
    '{"error":"Invalid API key for Anthropic"}',
    '{"valid":"false"}',
    '{"valid":0}',
    '{"detail":"No authentication credentials provided"}',
  ]) {
    const verdict = parseValidationVerdict(body);
    assert.equal(verdict.kind, "unreadable", `expected UNREADABLE for ${JSON.stringify(body)}`);
    assert.ok(
      verdict.kind === "unreadable" && verdict.reason.length > 0,
      `the reason must be stated for ${JSON.stringify(body)}`,
    );
  }
});

test('a truthy-string "false" is not a rejection', () => {
  // Guards the direction that matters: read as rejected, it would blame a key the
  // provider never refused. `"false"` is truthy, so a `!== false` test would have
  // called it ACCEPTED; the strict boolean check calls it unreadable instead.
  assert.equal(parseValidationVerdict('{"valid":"false"}').kind, "unreadable");
});

test("the provider is read from the REQUEST payload, and 'cannot tell' is null", () => {
  assert.equal(
    validationPayloadProvider('{"provider":"Google Generative AI","variables":{"GOOGLE_API_KEY":"x"}}'),
    "Google Generative AI",
  );
  // Each of these must be null rather than a guess: the sweep configures three
  // providers on one page, so a wrong match would blame the wrong key.
  for (const payload of [null, undefined, "", "{", "[]", "null", "{}", '{"provider":42}', '{"provider":""}']) {
    assert.equal(validationPayloadProvider(payload), null, `expected null for ${String(payload)}`);
  }
});

test("the endpoint is matched on the pathname, with its real query string", () => {
  assert.equal(
    isValidateProviderUrl(
      "http://localhost:7860/api/v1/models/validate-provider?flowId=abc&projectId=def",
    ),
    true,
  );
  assert.equal(isValidateProviderUrl("http://localhost:7860/api/v1/models/validate-provider/"), true);
  // The two ways a looser match gets it wrong.
  assert.equal(isValidateProviderUrl("http://localhost:7860/assets/validate-provider.js"), false);
  assert.equal(
    isValidateProviderUrl("http://localhost:7860/api/v1/models/validate-provider/extra"),
    false,
  );
  assert.equal(isValidateProviderUrl("not a url"), false);
});

test("the rejection sentence names who decided, what they said, and why no write followed", () => {
  const reason = formatCredentialRejection({
    displayName: "Anthropic",
    error: "Invalid API key for Anthropic",
    elapsedMs: 412,
  });
  assert.match(reason, /REJECTED/);
  assert.match(reason, /Anthropic/);
  assert.match(reason, /Invalid API key for Anthropic/);
  assert.match(reason, /0\.4s/);
  assert.match(reason, /NO credential write/);
  // The sentence it replaces claimed the opposite; a reader must not be able to
  // reach that conclusion from this one.
  assert.doesNotMatch(reason, /never probed/);
});

test("a rejection is NOT classified as a collector stall", () => {
  // `collect-models.spec.ts` treats a collector stall as "no key verdict exists"
  // and deliberately declines to call it a key problem. A rejection must reach the
  // hard-failure step instead, which is what #570 asks for.
  const error = `${CREDENTIAL_REJECTED_PREFIX}the provider REJECTED the key`;
  assert.equal(isCredentialRejectedReason(error), true);
  assert.equal(isCredentialRejectedReason("collector stall: no credential write answered"), false);
  for (const value of [null, undefined, ""]) {
    assert.equal(isCredentialRejectedReason(value), false);
  }
});
