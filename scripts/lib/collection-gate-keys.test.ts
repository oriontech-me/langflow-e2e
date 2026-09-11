// Unit tests for the collection-gate report (issue #1813).
// Run with: npm run test:units
//
// What these protect. The report's whole job is to make a NARROWER SUITE say so before
// it is partitioned, and every way it can be wrong looks like an answer:
//
//   - An empty derivation reports "nothing is missing" for every environment,
//     including one that lost all three keys. That is #1796's vacuity trap, arriving
//     here as a green report instead of a green guard.
//   - `""` is what both silent inputs actually produce — Actions renders an unknown
//     secret as the empty string, and a `.env` line with nothing after the `=` reads
//     the same. A report that counts those as present describes a suite that will not
//     be collected.
//   - A keyless provider drifting into the set would make a correctly-keyed lane
//     report itself narrow, which is the failure that trains a reader to ignore the
//     line.
//   - And the report is printed into run logs that end up pasted into issues, so it
//     must carry names and never values.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectionGateKeys,
  resolveCollectionGate,
  renderGateLines,
} from "./collection-gate-keys";
import {
  keyedProviders,
  providerConfigMap,
} from "../../tests/helpers/provider-setup/provider-config";

/** Every key the config declares, so the fixtures below cannot go stale. */
const ALL = collectionGateKeys();
const allPresent = () => Object.fromEntries(ALL.map((k) => [k, "value"]));

test("the derivation covers every keyed provider the config declares", () => {
  // Compared against the config's own count rather than a literal three: a fourth
  // keyed provider must widen this set the day it is added, not the day the next
  // cross-lane comparison notices a file went missing.
  const declared = Object.values(providerConfigMap).filter(
    (c) => c.credential === "api-key",
  );
  assert.equal(keyedProviders.length, declared.length);
  for (const [, config] of keyedProviders) {
    for (const key of config.envKeys) assert.ok(ALL.includes(key), `${key} is not derived`);
  }
  assert.ok(ALL.includes("OPENAI_API_KEY"), `derived keys are ${ALL.join(", ")}`);
});

test("a keyless provider is NOT a collection gate", () => {
  // `ollama`'s gate is a base URL, and its spec lists unconditionally (it skips at RUN
  // time on an unreachable probe). Counting OLLAMA_BASE_URL here would report the
  // Actions lane — which sets it nowhere — as listing a narrower suite than it does,
  // every single day.
  assert.ok(!ALL.includes("OLLAMA_BASE_URL"), `derived keys are ${ALL.join(", ")}`);
  assert.equal(providerConfigMap.ollama.credential, "base-url");
});

test("the derivation refuses to be empty", () => {
  // Not reachable through the public map — which is the point: the guarantee is
  // asserted where it is made, so a future refactor that can empty the list fails here
  // rather than reporting a complete gate to every caller.
  assert.ok(ALL.length >= 3, `only ${ALL.length} collection-gating key(s) derived`);
});

test("a fully-keyed environment lists every provider", () => {
  const gate = resolveCollectionGate(allPresent());
  assert.equal(gate.complete, true);
  assert.deepEqual(gate.absent, []);
  assert.deepEqual(gate.present, ALL);
  assert.deepEqual(gate.providersAbsent, []);
  assert.match(gate.summary, /^listing with openai, anthropic/);
  assert.match(gate.summary, /every collection-gating key resolved/);
});

test("the VM's measured shape reads as a narrower listing, naming the key", () => {
  // The exact state #1764 recorded on the VM: two of three variants listed and run,
  // with nothing on either side reporting the asymmetry. This line is that report.
  const gate = resolveCollectionGate({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" });
  assert.equal(gate.complete, false);
  assert.deepEqual(gate.present, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(gate.absent, ["GOOGLE_API_KEY"]);
  assert.deepEqual(gate.providersListed, ["openai", "anthropic"]);
  assert.deepEqual(gate.providersAbsent, ["google"]);
  assert.equal(gate.summary, "listing with openai, anthropic; GOOGLE_API_KEY absent");
});

test("an empty value is ABSENT, which is the shape both silent inputs have", () => {
  const gate = resolveCollectionGate({ ...allPresent(), OPENAI_API_KEY: "" });
  assert.equal(gate.complete, false);
  assert.ok(gate.absent.includes("OPENAI_API_KEY"));
  assert.ok(!gate.providersListed.includes("openai"));
});

test("a key-less environment says so instead of naming no providers at all", () => {
  // "listing with " followed by nothing is a sentence a reader completes wrongly.
  const gate = resolveCollectionGate({});
  assert.deepEqual(gate.providersListed, []);
  assert.match(gate.summary, /^listing with no keyed provider;/);
  for (const key of ALL) assert.ok(gate.summary.includes(key));
});

test("a provider is listed only when ALL of its keys resolve", () => {
  // `hasProviderEnvKeys` is `every(...)`. Every keyed provider declares exactly one key
  // today, so the rule is exercised on an injected two-key provider — through the real
  // function, not through a copy of its predicate, which is the form of this test that
  // would stay green after the rule changed.
  const providers = [
    ["openai", { envKeys: ["OPENAI_API_KEY", "OPENAI_ORG"] }],
  ] as const;

  const half = resolveCollectionGate({ OPENAI_API_KEY: "a" }, providers);
  assert.deepEqual(half.providersListed, []);
  assert.deepEqual(half.providersAbsent, ["openai"]);
  assert.deepEqual(half.present, ["OPENAI_API_KEY"]);
  assert.deepEqual(half.absent, ["OPENAI_ORG"]);
  assert.equal(half.complete, false);

  const both = resolveCollectionGate({ OPENAI_API_KEY: "a", OPENAI_ORG: "b" }, providers);
  assert.deepEqual(both.providersListed, ["openai"]);
  assert.equal(both.complete, true);
});

test("a derivation that comes back empty throws instead of reporting a complete gate", () => {
  // The vacuity trap, asserted where it can actually be reached: an empty provider list
  // would otherwise produce `complete: true, absent: []` — a report that tells every
  // environment, including one that lost all three keys, that nothing is missing.
  assert.throws(() => collectionGateKeys([]), /no collection-gating key/);
  assert.throws(() => resolveCollectionGate({}, []), /no collection-gating key/);
});

test("the rendered block carries names and booleans, never a value", () => {
  // This output is printed into a run log and pasted into comparison issues. A report
  // that leaked the key it was reporting on would be worse than the silence it
  // replaces.
  const secret = "sk-do-not-print-me-12345";
  const lines = renderGateLines(
    resolveCollectionGate({ OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret }),
  );
  const text = lines.join("\n");
  assert.ok(!text.includes(secret), text);
  assert.ok(!text.includes("do-not-print"), text);
});

test("the block is key=value lines a shell and $GITHUB_OUTPUT can both read", () => {
  const lines = renderGateLines(resolveCollectionGate(allPresent()));
  const fields = new Map(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.deepEqual(
    [...fields.keys()],
    ["keys", "present", "absent", "providers_listed", "providers_absent", "complete", "summary"],
  );
  assert.equal(fields.get("complete"), "true");
  assert.equal(fields.get("absent"), "");
  assert.equal(fields.get("present"), ALL.join(" "));
  // Only `summary` may contain a space, because it is the only field a `sed -n
  // 's/^x=//p'` reads as "the rest of the line" rather than as a list.
  for (const [name, value] of fields) {
    if (name === "summary") continue;
    for (const word of value.split(" ").filter(Boolean)) {
      assert.match(word, /^[A-Za-z0-9_-]+$/, `${name} carries an unsplittable value: ${value}`);
    }
  }
});

test("summary is one line, so a log reader cannot miss half of it", () => {
  for (const env of [{}, allPresent(), { OPENAI_API_KEY: "a" }]) {
    assert.ok(!resolveCollectionGate(env).summary.includes("\n"));
  }
});
