// Unit tests for the model-picker resolver (issues #1459 and #1461).
// Run with: npm run test:units
//
// What rides on this function is a verdict, not a selector. Until #1459 the three
// provider-setup helpers resolved a pinned model with
// `hasText: new RegExp("^" + model + "$")`, and on 1.12.0.dev26 the picker began
// rendering a per-option `sr-only` position counter INSIDE the option:
//
//   <div data-testid="Google Generative AI-gemini-flash-latest-option" ...>
//     <div class="truncate text-[13px]">gemini-flash-latest</div>
//     <span class="sr-only">22 of 90</span>
//   </div>
//
// The counter is invisible to a user but part of textContent, so `^model$` matched
// nothing — and the helper reported that single negative observation as
// `MODEL_NOT_AVAILABLE: … model may not be supported`, which every caller turns
// into `test.skip`. One daily (run 31786538844) lost ~30 `@stable` tests that way,
// with 35 skips against a 4–15 baseline as the only trace.
//
// So the property under test is NOT "the matcher works". It is: a model the picker
// actually offers can only ever resolve to a LOUD failure — never to the skip
// prefix. The fixtures below therefore carry the real dev26 markup, counter
// included.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enumerateModelOptions,
  nearestModels,
  resolveModelOption,
  toModelOption,
  type ModelOption,
  type RawModelOption,
} from "./model-option";

/** Verbatim shape of a dev26 option, counter included. */
function raw(provider: string, model: string, position: string, deprecated = false): RawModelOption {
  return {
    testId: `${provider}-${model}-option`,
    value: `${provider}::${model}`,
    visibleLabel: model,
    rawText: `${model}\n${position}${deprecated ? "\nDeprecated" : ""}`,
    deprecated,
  };
}

function option(provider: string, model: string, position = "1 of 1"): ModelOption {
  return toModelOption(raw(provider, model, position));
}

const DEV26_PICKER: ModelOption[] = [
  option("Anthropic", "claude-opus-5", "1 of 90"),
  option("Anthropic", "claude-haiku-4-5", "9 of 90"),
  option("Google Generative AI", "gemini-flash-latest", "22 of 90"),
  option("OpenAI", "gpt-4o-mini", "40 of 90"),
  option("OpenAI", "gpt-4o-mini-search-preview", "41 of 90"),
];

test("toModelOption reads the identity from data-value, not from the text", () => {
  const parsed = toModelOption(raw("Google Generative AI", "gemini-flash-latest", "22 of 90"));
  assert.equal(parsed.provider, "Google Generative AI");
  assert.equal(parsed.model, "gemini-flash-latest");
  // The counter survives in rawText: it is evidence for the message, never a match key.
  assert.equal(parsed.rawText, "gemini-flash-latest\n22 of 90");
  assert.equal(parsed.visibleLabel, "gemini-flash-latest");
});

test("toModelOption falls back to the testid when data-value is gone", () => {
  const parsed = toModelOption({
    testId: "Anthropic-claude-haiku-4-5-option",
    value: "",
    visibleLabel: "claude-haiku-4-5",
    rawText: "claude-haiku-4-5\n9 of 90",
    deprecated: false,
  });
  assert.equal(parsed.provider, "Anthropic");
  assert.equal(parsed.model, "claude-haiku-4-5");
});

test("toModelOption keeps a model id containing '::' intact", () => {
  const parsed = toModelOption({
    testId: "Ollama-llama3.2:1b-option",
    value: "Ollama::llama3.2:1b",
    visibleLabel: "llama3.2:1b",
    rawText: "llama3.2:1b\n3 of 4",
    deprecated: false,
  });
  assert.equal(parsed.model, "llama3.2:1b");
});

// The regression the whole file exists for.
test("the dev26 counter no longer defeats the match", () => {
  for (const model of ["claude-haiku-4-5", "gemini-flash-latest", "gpt-4o-mini"]) {
    const verdict = resolveModelOption(model, DEV26_PICKER);
    assert.equal(verdict.kind, "match", `${model} must resolve on a dev26 picker`);
    if (verdict.kind === "match") assert.equal(verdict.option.model, model);
  }
});

test("a longer model id is not matched by its prefix", () => {
  const verdict = resolveModelOption("gpt-4o-mini", DEV26_PICKER);
  assert.equal(verdict.kind, "match");
  if (verdict.kind === "match") {
    assert.equal(verdict.option.testId, "OpenAI-gpt-4o-mini-option");
  }
});

test("an identity attribute that drifts FAILS loudly instead of skipping", () => {
  // The #1459 break one layer deeper: the option is right there, labelled exactly
  // as the test pinned it, but `data-value` now spells the id differently. The
  // suite cannot establish an absence against its own evidence, so this is a
  // failure — the outcome the old guard turned into `test.skip`.
  const drifted: ModelOption = toModelOption({
    testId: "Anthropic-claude-haiku-4-5-option",
    value: "Anthropic::claude-haiku-4.5",
    visibleLabel: "claude-haiku-4-5",
    rawText: "claude-haiku-4-5\n9 of 90",
    deprecated: false,
  });
  const verdict = resolveModelOption("claude-haiku-4-5", [drifted]);
  assert.equal(verdict.kind, "unmatchable");
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"), "must not carry the skip prefix");
  assert.match(verdict.message, /IS offered by the model picker/);
  assert.match(verdict.message, /visible label "claude-haiku-4-5"/);
});

test("a display label is a usable identity when the attributes are gone", () => {
  // The complement of the test above, and the reason absence stays rare: with no
  // parseable attribute left, the visible label still identifies the option and
  // the testid still clicks it. Matching here is correct — failing loudly on a
  // selectable model would be its own coverage loss.
  const labelOnly = toModelOption({
    testId: "model-option-9",
    value: "",
    visibleLabel: "claude-haiku-4-5",
    rawText: "claude-haiku-4-5\n9 of 90",
    deprecated: false,
  });
  const verdict = resolveModelOption("claude-haiku-4-5", [labelOnly]);
  assert.equal(verdict.kind, "match");
});

test("a provider name carrying spaces still parses from the testid alone", () => {
  const verdict = resolveModelOption("gemini-flash-latest", [
    toModelOption({
      testId: "Google Generative AI-gemini-flash-latest-option",
      value: "",
      visibleLabel: "gemini-flash-latest",
      rawText: "gemini-flash-latest\n22 of 90",
      deprecated: false,
    }),
  ]);
  assert.equal(verdict.kind, "match");
  if (verdict.kind === "match") assert.equal(verdict.option.provider, "Google Generative AI");
});

test("a model enabled in the provider panel but missing from the picker FAILS loudly", () => {
  const verdict = resolveModelOption("claude-haiku-4-5", [option("OpenAI", "gpt-4o-mini")], {
    enabledModels: ["claude-opus-5", "claude-haiku-4-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "unmatchable");
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(verdict.message, /llm-toggle-claude-haiku-4-5/);
  assert.match(verdict.message, /1 option\(s\) enumerated/);
});

test("an EMPTY picker proves nothing and FAILS loudly", () => {
  const verdict = resolveModelOption("claude-haiku-4-5", [], { providerLabel: "Anthropic" });
  assert.equal(verdict.kind, "empty");
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(verdict.message, /ZERO options/);
});

test("an established absence skips, and the message carries what was seen", () => {
  const verdict = resolveModelOption("claude-haiku-3-5", DEV26_PICKER, {
    enabledModels: ["claude-opus-5", "claude-haiku-4-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "absent");
  assert.ok(verdict.message.startsWith("MODEL_NOT_AVAILABLE: "), "callers key on this prefix");
  // Evidence, not inference: how many options, from which providers, and what was
  // offered instead. The pre-#1461 message asserted "model may not be supported"
  // and named nothing it had checked.
  assert.match(verdict.message, /5 enumerated option\(s\)/);
  assert.match(verdict.message, /Anthropic: 2/);
  assert.match(verdict.message, /2 provider toggle\(s\) observed/);
  assert.match(verdict.message, /Nearest offered: claude-haiku-4-5/);
  assert.ok(!/may not be supported/.test(verdict.message));
});

test("unobserved toggles are reported as unobserved, never as a negative", () => {
  const verdict = resolveModelOption("claude-haiku-3-5", DEV26_PICKER);
  assert.equal(verdict.kind, "absent");
  assert.match(verdict.message, /provider toggles were not observed/);
});

test("nearestModels surfaces the rename candidates first", () => {
  const nearest = nearestModels("claude-haiku-3-5", DEV26_PICKER);
  assert.equal(nearest[0], "claude-haiku-4-5");
  assert.ok(!nearest.includes("gpt-4o-mini-search-preview"));
});

// The `sr-only`-stripping half runs INSIDE the page (`Locator.evaluateAll`), so it
// has no unit coverage here on purpose — replaying it against a hand-parsed string
// would test the stand-in, not the shipped callback (#1017). Its live coverage is
// the provider specs, whose pinned model only resolves when the strip works, plus
// the force-fail that reverts it. What this file pins is the half a live spec
// cannot reproduce on demand: the verdict.
