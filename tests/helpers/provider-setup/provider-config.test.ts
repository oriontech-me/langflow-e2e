// Unit tests for the provider map and its keyed narrowing (issue #1187).
// Run with: npm run test:units
//
// What rides on this file: `providerConfigMap` is the single source of provider
// configuration, and until #1187 every entry was assumed to hold an API key. Adding a
// keyless one (Ollama, configured by a base URL) makes two invariants load-bearing
// that used to be free:
//
//  - **`openai` must stay first.** A dozen specs resolve a missing provider as
//    `Object.keys(providerConfigMap)[0]`, and `test-targets.ts` uses the same
//    expression for its no-catalog fallback. Inserting an entry ahead of openai would
//    silently re-point all of them — at a keyless provider, in the worst case.
//  - **Key-subject consumers must iterate `keyedProviders`, not the whole map.** The
//    compiler enforces the field access (a `BaseUrlProviderConfig` has no
//    `keyPlaceholder`), but nothing stops a future `Object.keys(providerConfigMap)`
//    loop from *counting* a keyless provider — which is how the invalid-key spec
//    would grow a test case for a key that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  keyedProviderNames,
  keyedProviders,
  langflowProviderName,
  providerConfigMap,
  type Provider,
} from "./provider-config";

test("openai is the first entry — a dozen specs resolve `[0]` as their fallback provider", () => {
  assert.equal(Object.keys(providerConfigMap)[0], "openai");
});

test("keyedProviders is exactly the api-key providers, in declaration order", () => {
  assert.deepEqual(keyedProviderNames, ["openai", "anthropic", "google"]);
  for (const [, config] of keyedProviders) {
    assert.equal(config.credential, "api-key");
  }
});

test("ollama is in the map but NOT keyed — the sweep and the invalid-key journey skip it", () => {
  assert.ok("ollama" in providerConfigMap);
  assert.equal(providerConfigMap.ollama.credential, "base-url");
  assert.ok(!keyedProviderNames.includes("ollama" as never));
});

test("every entry declares at least one env var, and keyed ones a placeholder + invalid key", () => {
  for (const provider of Object.keys(providerConfigMap) as Provider[]) {
    const config = providerConfigMap[provider];
    assert.ok(config.envKeys.length > 0, `${provider} declares no env var`);
    assert.ok(config.providerTestId.startsWith("provider-item-"), `${provider} testid`);
    if (config.credential === "api-key") {
      assert.ok(config.keyPlaceholder.length > 0, `${provider} has no key placeholder`);
      // The invalid key must be recognisably invalid AND provider-shaped, so the
      // error the UI reports is an auth rejection rather than a parse failure.
      assert.match(config.invalidKey, /invalid/i, `${provider} invalid key`);
    } else {
      assert.ok(
        config.variableInputTestId.startsWith("provider-variable-input-"),
        `${provider} variable input testid`,
      );
    }
  }
});

test("ollama's env gate is the base URL — nothing about it is a secret", () => {
  // Langflow persists it as a `Global` variable, not a `Credential`
  // (GET /api/v1/models on 1.12.0.dev10: `is_secret: false`), which is what makes
  // this provider usable with no account and no credit at all — the resilience
  // argument #1187 rests on.
  assert.deepEqual(providerConfigMap.ollama.envKeys, ["OLLAMA_BASE_URL"]);
  assert.ok(!/KEY|TOKEN|SECRET/i.test(providerConfigMap.ollama.envKeys[0]));
});

// ─── Structural guard: key-subject consumers must not iterate the whole map ──

test("the key-subject consumers iterate keyedProviders, never the full map", () => {
  // Not a style rule. Each of these fills or validates an API KEY per provider, so a
  // loop over the full map hands them a provider with no key: the invalid-auth spec
  // would declare a test case that types into a field that does not exist, and the
  // collect-models sweep would try to save a URL as a secret. The compiler catches
  // the field access; only this catches the iteration.
  const files = [
    "collect-models.ts",
    "../../tests-automations/regression/core-functionality/llm-agents/provider-invalid-auth-error.spec.ts",
  ];
  for (const file of files) {
    const full = path.join(__dirname, file);
    assert.ok(fs.existsSync(full), `guarded file moved — update this guard: ${full}`);
    const source = fs.readFileSync(full, "utf-8");
    assert.doesNotMatch(
      source,
      /Object\.(keys|entries|values)\(providerConfigMap\)/,
      `${path.basename(file)} iterates providerConfigMap directly — use keyedProviders (#1187)`,
    );
  }
});

// ─── langflowProviderName (#1274) ────────────────────────────────────────────
//
// This one line decides the string the #751 guard compares against on every
// `SimpleAgentTemplatePage.load()`, i.e. on 29 spec files. Review found it had ZERO
// coverage: replacing the body with `return providerTestId` — which yields
// `"provider-item-OpenAI"`, a string the product never persists — passed all 436
// unit tests, while making the guard wait its full 20 s and hard-fail for every
// dependent spec. The values below are not conventions; they were verified three
// ways on 1.12.0.dev16: `GET /api/v1/models/providers`, the upstream constants in
// `lfx/components/agentics/constants.py`, and the frontend's
// `data-testid={`provider-item-${provider.provider}`}` template.
test("langflowProviderName returns the name Langflow itself persists", () => {
  assert.equal(langflowProviderName("openai"), "OpenAI");
  assert.equal(langflowProviderName("anthropic"), "Anthropic");
  assert.equal(langflowProviderName("google"), "Google Generative AI");
  assert.equal(langflowProviderName("ollama"), "Ollama");
});

test("langflowProviderName never returns the testid prefix", () => {
  // The mutation that survived: the raw testid is a plausible-looking string that
  // is wrong everywhere it matters.
  for (const provider of Object.keys(providerConfigMap) as Provider[]) {
    const name = langflowProviderName(provider);
    assert.doesNotMatch(
      name,
      /^provider-item-/,
      `${provider}: the display name must have the testid prefix stripped`,
    );
    assert.ok(name.length > 0, `${provider}: empty display name`);
    assert.equal(
      providerConfigMap[provider].providerTestId,
      `provider-item-${name}`,
      `${provider}: the testid must remain derivable from the display name`,
    );
  }
});

test("langflowProviderName fails loudly if the testid convention breaks", () => {
  // The throw exists so that an upstream rename fails for every provider at once,
  // with a message naming the fix — rather than silently yielding a wrong string
  // that reads as a 20 s guard timeout in 29 specs.
  const original = providerConfigMap.openai.providerTestId;
  try {
    (providerConfigMap.openai as { providerTestId: string }).providerTestId = "OpenAI";
    assert.throws(() => langflowProviderName("openai"), /does not start with/);
  } finally {
    (providerConfigMap.openai as { providerTestId: string }).providerTestId = original;
  }
  assert.equal(langflowProviderName("openai"), "OpenAI", "the guard must not leak state");
});
