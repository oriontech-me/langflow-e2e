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
  censusForTarget,
  hasOptionIdentity,
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
    listedModels: ["claude-opus-5", "claude-haiku-4-5"],
    checkedModels: ["claude-opus-5", "claude-haiku-4-5"],
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
    listedModels: ["claude-opus-5", "claude-haiku-4-5"],
    checkedModels: ["claude-opus-5", "claude-haiku-4-5"],
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

// ─── censusForTarget / hasOptionIdentity (#1464) ──────────────────────────────
//
// These pin the OTHER direction of the same property: not "can a model the picker
// offers resolve to a skip", but "can a model the picker still offers be reported
// as GONE". `model-provider-model-toggle.spec.ts` asserted a removal by matching the
// option's TEXT with `hasText: /^model$/`, which the dev26 counter had already
// defeated — so `toHaveCount(0)` passed whether or not the model was removed, for
// as long as the spec existed. It never noticed because a second defect (the model
// name derived from a provider-prefixed testid) skipped the test before it ran.
//
// So the property is: a `target: 0` verdict is trustworthy ONLY together with
// `total > 0` and `providerOthers > 0`. Both zero-states below were reached by
// executed mutation during review, not imagined.

const OPENAI_MODELS = new Set(["gpt-4o-mini", "gpt-4o-mini-search-preview"]);

test("censusForTarget finds the target by data-value and counts the provider's others", () => {
  const target = option("OpenAI", "gpt-4o-mini", "40 of 90");
  const census = censusForTarget(DEV26_PICKER, target, OPENAI_MODELS);
  assert.equal(census.total, 5);
  assert.equal(census.target, 1);
  assert.equal(census.providerOthers, 1);
  assert.deepEqual(census.labels[0], "claude-opus-5");
});

test("censusForTarget reports removal as target 0 while the provider's others survive", () => {
  const target = option("OpenAI", "gpt-4o-mini", "40 of 90");
  const remaining = DEV26_PICKER.filter((o) => o.model !== "gpt-4o-mini");
  const census = censusForTarget(remaining, target, OPENAI_MODELS);
  assert.equal(census.target, 0);
  assert.equal(census.total, 4);
  // The half that makes the zero mean anything.
  assert.equal(census.providerOthers, 1);
});

test("an EMPTY picker yields target 0 — indistinguishable from removal without total", () => {
  const census = censusForTarget([], option("OpenAI", "gpt-4o-mini"), OPENAI_MODELS);
  assert.equal(census.target, 0);
  assert.equal(census.total, 0);
  assert.equal(census.providerOthers, 0);
});

test("a picker whose identities stopped parsing yields target 0 with providerOthers 0", () => {
  // Exactly the review mutation: the options are still rendered and still readable
  // by a human, but neither attribute resolves any more.
  const unparsable = DEV26_PICKER.map((o) => ({
    ...o,
    testId: "",
    value: "",
    model: null,
  }));
  const census = censusForTarget(
    unparsable,
    option("OpenAI", "gpt-4o-mini"),
    OPENAI_MODELS,
  );
  assert.equal(census.target, 0);
  assert.ok(census.total > 0, "the list is populated — only the identity broke");
  assert.equal(census.providerOthers, 0, "so the zero is not attributable to a toggle");
});

test("censusForTarget falls back to the testid when data-value is gone", () => {
  const withoutValue = DEV26_PICKER.map((o) => ({ ...o, value: "" }));
  const target = { testId: "OpenAI-gpt-4o-mini-option", value: "" };
  assert.equal(censusForTarget(withoutValue, target, OPENAI_MODELS).target, 1);
});

test("censusForTarget does not confuse two providers sharing a model id", () => {
  // The #597 collision the spec's target selection has to exclude: a sibling spec
  // enables `OpenAI Compatible::gpt-4o-mini`, whose bare id is also in the OpenAI
  // panel's toggle list. Identity keeps them apart.
  const mixed = [...DEV26_PICKER, option("OpenAI Compatible", "gpt-4o-mini", "91 of 91")];
  const target = option("OpenAI", "gpt-4o-mini", "40 of 90");
  assert.equal(censusForTarget(mixed, target, OPENAI_MODELS).target, 1);
});

test("a target with NEITHER attribute matches nothing, so its census is vacuous", () => {
  const blank = { testId: "", value: "" };
  assert.equal(hasOptionIdentity(blank), false);
  const census = censusForTarget(DEV26_PICKER, blank, OPENAI_MODELS);
  // Zero targets over a healthy, populated, parsable picker — the trap a caller
  // must refuse BEFORE polling, since both guards pass here.
  assert.equal(census.target, 0);
  assert.ok(census.total > 0);
  assert.ok(census.providerOthers > 0);
});

test("hasOptionIdentity accepts an option carrying either attribute alone", () => {
  assert.equal(hasOptionIdentity({ testId: "OpenAI-gpt-4o-option", value: "" }), true);
  assert.equal(hasOptionIdentity({ testId: "", value: "OpenAI::gpt-4o" }), true);
});

// The `sr-only`-stripping half runs INSIDE the page (`Locator.evaluateAll`), so it
// has no unit coverage here on purpose — replaying it against a hand-parsed string
// would test the stand-in, not the shipped callback (#1017). Its live coverage is
// the provider specs, whose pinned model only resolves when the strip works, plus
// the force-fail that reverts it. What this file pins is the half a live spec
// cannot reproduce on demand: the verdict.

// --- #1649: the panel LISTS a model and the panel ENABLES it are different facts ---
//
// `enumerateEnabledModels` returns every rendered `llm-toggle-*` id regardless of
// `aria-checked` — its own docstring says so, and says a count taken from it is
// never a count of enabled models. It was nonetheless passed as the single
// `enabledModels` source, so the loud verdict announced "is ENABLED in the provider
// panel" from evidence that only proves the panel LISTS it. On 2026-08-31 that
// claim happened to be true; the reason it was true was a separate defect (#1649:
// setup-openai closed the panel inside the toggle queue's 1000 ms debounce, so the
// picker kept the pre-toggle set). The split below makes the message state what it
// measured, and — the load-bearing half — keeps the new branch LOUD: a model the
// panel lists with its toggle OFF is a setup failure, never a skip.

test("a model whose toggle is ON but which the picker omits FAILS, and says ENABLED truthfully", () => {
  const verdict = resolveModelOption("claude-haiku-4-5", [option("OpenAI", "gpt-4o-mini")], {
    listedModels: ["claude-opus-5", "claude-haiku-4-5"],
    checkedModels: ["claude-opus-5", "claude-haiku-4-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "unmatchable");
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(verdict.message, /is ENABLED in the provider panel/);
  assert.match(verdict.message, /llm-toggle-claude-haiku-4-5/);
});

test("a model the panel LISTS with its toggle OFF is a setup failure, not a picker defect", () => {
  const verdict = resolveModelOption("claude-haiku-4-5", [option("OpenAI", "gpt-4o-mini")], {
    listedModels: ["claude-opus-5", "claude-haiku-4-5"],
    checkedModels: ["claude-opus-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "not-enabled");
  // Never the skip prefix, and never the picker-defect prefix either: the picker is
  // not disagreeing with anything — it is correctly omitting a disabled model.
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"));
  assert.ok(!verdict.message.startsWith("MODEL_PICKER_DEFECT"));
  assert.match(verdict.message, /MODEL_NOT_ENABLED/);
  assert.match(verdict.message, /toggle is OFF/);
  // The count that separates "the setup enabled nothing" from "it missed one".
  assert.match(verdict.message, /1 of 2 listed/);
});

test("the not-enabled verdict outranks absence — a listed model is never reported missing", () => {
  // `claude-haiku-3-5` is NOT in the picker, and the nearest-model machinery would
  // happily produce a plausible `MODEL_NOT_AVAILABLE` for it. The panel listing it
  // outranks that: absent means nobody knows the model.
  const verdict = resolveModelOption("claude-haiku-3-5", DEV26_PICKER, {
    listedModels: ["claude-haiku-3-5", "claude-opus-5"],
    checkedModels: ["claude-opus-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "not-enabled");
  assert.ok(!verdict.message.startsWith("MODEL_NOT_AVAILABLE"));
});

test("with only listedModels observed the message says so instead of claiming ENABLED", () => {
  const verdict = resolveModelOption("claude-haiku-4-5", [option("OpenAI", "gpt-4o-mini")], {
    listedModels: ["claude-haiku-4-5"],
    providerLabel: "Anthropic",
  });
  assert.equal(verdict.kind, "unmatchable");
  assert.match(verdict.message, /listed by the provider panel/);
  assert.ok(!/is ENABLED in the provider panel/.test(verdict.message));
});
