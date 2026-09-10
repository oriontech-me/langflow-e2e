/**
 * The three preference ladders, asserted against the LIVE catalogs (#1679).
 *
 * Its own file rather than a block inside `model-toggle-batch.test.ts`, for the
 * convention CONTRIBUTING.md states outright (`provider-setup/x.ts` ->
 * `provider-setup/x.test.ts`) and for the reason the ladders were moved into
 * `model-preferences.ts` in the first place: they are the fix's central safety
 * property, and while they sat as module-private consts in the three `setup-*.ts`
 * files nothing could reach them — gutting each real ladder to `[]` passed the
 * whole unit suite. The sibling file keeps the PLANNER's tests, which read a
 * ladder as one input among several; this one is about what each ladder accepts
 * and rejects, which is a property of the ladder alone.
 *
 * The measured catalogs below are duplicated from that sibling on purpose: one
 * `.test.ts` importing another would run the imported file's tests a second time.
 * Both copies read `GET /api/v1/models?purpose=configure` on 1.13.0.dev8.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_MODEL_PREFERENCES,
  GOOGLE_MODEL_PREFERENCES,
  GOOGLE_NON_CHAT_MODEL,
  OPENAI_MODEL_PREFERENCES,
  OPENAI_NON_CHAT_MODEL,
} from "./model-preferences";

/** The five `default: true` models of each provider — catalog positions 0-4. */
const GOOGLE_DEFAULTS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];
const ANTHROPIC_DEFAULTS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
];
const OPENAI_DEFAULTS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6", "gpt-5.6-terra"];

const accepts = (ladder: Array<(m: string) => boolean>, model: string): boolean =>
  ladder.some((rank) => rank(model.toLowerCase()));

test("no ladder is empty — the mutation that passed the whole suite before they were testable", () => {
  for (const [name, ladder] of [
    ["openai", OPENAI_MODEL_PREFERENCES],
    ["google", GOOGLE_MODEL_PREFERENCES],
    ["anthropic", ANTHROPIC_MODEL_PREFERENCES],
  ] as const) {
    assert.ok(ladder.length > 0, `${name} ladder is empty`);
  }
});

test("Google's and Anthropic's ladders accept their own defaults — those setups write nothing", () => {
  for (const model of GOOGLE_DEFAULTS) {
    assert.ok(accepts(GOOGLE_MODEL_PREFERENCES, model), `google ladder rejects ${model}`);
  }
  for (const model of ANTHROPIC_DEFAULTS) {
    assert.ok(accepts(ANTHROPIC_MODEL_PREFERENCES, model), `anthropic ladder rejects ${model}`);
  }
});

test("OpenAI's ladder rejects ALL five of its defaults — that setup MUST write", () => {
  // The asymmetry the three lists exist to encode. If a future edit makes one of
  // these acceptable, `general-bugs-agent-images-playground` silently starts
  // running its multimodal assertion on a frontier model instead of `gpt-4o-mini`.
  for (const model of OPENAI_DEFAULTS) {
    assert.ok(
      !accepts(OPENAI_MODEL_PREFERENCES, model),
      `openai ladder accepts ${model}, so the no-pin path would stop enabling a chat model`,
    );
  }
  assert.ok(accepts(OPENAI_MODEL_PREFERENCES, "gpt-4o-mini"));
});

// Every id below is one a rank WOULD match on its substring alone, so each pins
// one token of `OPENAI_NON_CHAT_MODEL` and none of them is vacuous. That
// distinction is the finding this table was rewritten for: the first version
// listed `gpt-5-nano`, which no rank matches in the first place (not
// `gpt-4o-mini`, not `-mini`, not `gpt-4o`, not `gpt-4.1`), so it held with or
// without the guard — and `nano`, `realtime` and `transcribe` could all be
// deleted from the regex with the whole unit suite still green. `gpt-4.1-nano` is
// not hypothetical: `resolve-gpt-model.ts`'s rank 3 is `/^gpt-4\.1(-mini|-nano)?$/`,
// so that helper can settle on the very id this ladder refuses. The two do not
// collide today — a settled model arrives as a PIN, and a pin that the panel lists
// is enabled without consulting the ladder at all — but they are two OpenAI
// preference lists in one directory that disagree about one family, and nothing
// pins that agreement (pre-existing, #1679 did not introduce it).
const OPENAI_NON_CHAT_CASES: Array<[token: string, model: string, matchedBy: string]> = [
  ["\\bo\\d", "o3-mini", "rank 2, -mini"],
  ["audio", "gpt-4o-mini-audio-preview", "rank 1, gpt-4o-mini"],
  ["realtime", "gpt-4o-realtime-preview", "rank 3, gpt-4o"],
  ["tts", "gpt-4o-mini-tts", "rank 1, gpt-4o-mini"],
  ["transcribe", "gpt-4o-mini-transcribe", "rank 1, gpt-4o-mini"],
  ["search", "gpt-4o-mini-search-preview", "rank 1, gpt-4o-mini"],
  ["nano", "gpt-4.1-nano", "rank 4, gpt-4.1"],
];

test("each OPENAI_NON_CHAT_MODEL token is load-bearing for an id a rank would otherwise take", () => {
  for (const [token, model, matchedBy] of OPENAI_NON_CHAT_CASES) {
    // Asserted directly on the regex as well as through the ladder: dropping the
    // token from the regex is the mutation, and only this half localises it to
    // the token rather than to whichever rank happened to match.
    assert.ok(
      OPENAI_NON_CHAT_MODEL.test(model),
      `OPENAI_NON_CHAT_MODEL no longer rejects ${model} — the "${token}" token is gone`,
    );
    assert.ok(
      !accepts(OPENAI_MODEL_PREFERENCES, model),
      `openai ladder accepts ${model} (${matchedBy}), so a vision/chat spec could be handed it`,
    );
  }
});

// Same table shape, and the same trap avoided a second time: every non-chat
// gemini id in the measured catalog carries `preview` as well, so a list read
// straight off it pins `preview` and NOTHING else — deleting `tts` or `audio`
// from `GOOGLE_NON_CHAT_MODEL` left the suite green. Two of the four ids below
// are therefore CONSTRUCTED, not catalog rows, and they are the only way to
// isolate their token. The token is still worth having: `preview` is dropped from
// a model id the moment it goes GA, and a GA `-tts` or `-audio` gemini is what
// this rank exists to keep off a chat spec.
const GOOGLE_NON_CHAT_CASES: Array<[token: string, model: string, source: string]> = [
  ["image", "gemini-3.1-flash-lite-image", "catalog, 1.13.0.dev8"],
  ["preview", "gemini-omni-flash-preview", "catalog, 1.13.0.dev8"],
  ["tts", "gemini-2.5-flash-tts", "constructed — every catalog tts row also says preview"],
  ["audio", "gemini-2.5-flash-native-audio", "constructed — same reason"],
];

test("Google's first rank is chat-only, and its second is the catch-all", () => {
  // Rank 1 is `gemini` AND `flash` AND not a non-chat variant, so each id here
  // satisfies the first two and is rejected only by `GOOGLE_NON_CHAT_MODEL`.
  for (const [token, model, source] of GOOGLE_NON_CHAT_CASES) {
    assert.ok(
      GOOGLE_NON_CHAT_MODEL.test(model),
      `GOOGLE_NON_CHAT_MODEL no longer rejects ${model} (${source}) — the "${token}" token is gone`,
    );
    assert.ok(
      !GOOGLE_MODEL_PREFERENCES[0](model),
      `google's first rank accepts ${model}, which is not a chat model`,
    );
    // …and the catch-all still takes it, which is what makes rank 1 a PREFERENCE
    // rather than a filter: a panel offering nothing else must still resolve.
    assert.ok(accepts(GOOGLE_MODEL_PREFERENCES, model));
  }
  assert.ok(GOOGLE_MODEL_PREFERENCES[0]("gemini-3.8-flash"));
});

test("Anthropic's first rank skips opus, and its second one does not", () => {
  // The ladder's stated purpose — "a spec that only needs a completion should not
  // pay for the largest one" — and it was asserted nowhere: dropping
  // `&& !/opus/` from rank 1 left both ranks coinciding on every other input and
  // the suite green.
  assert.ok(!ANTHROPIC_MODEL_PREFERENCES[0]("claude-opus-5"));
  assert.ok(!ANTHROPIC_MODEL_PREFERENCES[0]("claude-opus-4-8"));
  assert.ok(ANTHROPIC_MODEL_PREFERENCES[0]("claude-sonnet-5"));
  // Rank 2 is why an opus-only panel still resolves instead of clicking nothing.
  assert.ok(accepts(ANTHROPIC_MODEL_PREFERENCES, "claude-opus-5"));
  assert.ok(!accepts(ANTHROPIC_MODEL_PREFERENCES, "gpt-4o-mini"));
});
