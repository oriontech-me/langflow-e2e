import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import { PROVIDER_OUTAGE_CODES, PROVIDER_OUTAGE_MARKER, providerOutageMessage } from "./provider-outage";

test("every outage code yields a message the infra classifier reads as provider-outage", () => {
  for (const code of PROVIDER_OUTAGE_CODES) {
    const message = providerOutageMessage("google", ["auth-expired", code]);
    assert.ok(message, code);
    assert.equal(classifyInfraError(message)?.id, "provider-outage", code);
    // As Playwright reports it: the custom message first, then the diff.
    const reported = `Error: ${message}\n\nexpect(received).toEqual(expected)\n- ["auth-expired"]\n+ ["${code}"]`;
    assert.equal(classifyInfraError(reported)?.id, "provider-outage", `${code}, as reported`);
  }
});

test("codes that are the spec's own answer, or a product refusal, yield no message", () => {
  for (const codes of [
    ["auth-expired"],
    ["scope-missing"],
    ["connection-unresolved"],
    ["connection-not-authorized"],
    ["invalid-request"],
    [null],
    [],
  ]) {
    assert.equal(providerOutageMessage("google", codes), null, JSON.stringify(codes));
  }
});

test("the plain diff a non-outage failure produces is not classified as infra", () => {
  const diff = 'Error: expect(received).toEqual(expected)\n- ["auth-expired"]\n+ ["scope-missing"]';
  assert.equal(classifyInfraError(diff), null);
});

test("the marker is what the shared pattern matches, and only the marker", () => {
  const raw = JSON.parse(
    readFileSync(path.join(__dirname, "../../../scripts/lib/infra-signature-patterns.json"), "utf8"),
  ) as Array<{ id: string; pattern: string; flags: string }>;
  const entry = raw.find((s) => s.id === "provider-outage");
  assert.ok(entry, "infra-signature-patterns.json carries a provider-outage entry");
  const pattern = new RegExp(entry!.pattern, entry!.flags);
  assert.ok(pattern.test(PROVIDER_OUTAGE_MARKER));
  // Prose about an outage, without the marker, is not enough.
  assert.equal(pattern.test("the provider was unavailable (provider-outage)"), false);
  assert.equal(pattern.test("provider-unavailable"), false);
});
