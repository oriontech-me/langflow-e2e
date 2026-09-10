/**
 * What each provider setup will accept when no pinned model resolves (#1679).
 *
 * These are the ladders `planToggleTargets` walks, and for OpenAI the same ladder
 * its post-close picker ranking walks — one list read twice, so the setup cannot
 * enable one model and then select another.
 *
 * ## Why they live in their own module
 *
 * They are the fix's central safety property and they were unpinned while they sat
 * as module-private consts in the three `setup-*.ts` files: those import
 * `@playwright/test` transitively, so a `node --test` unit test could not reach
 * them, and the tests had to re-declare copies. Measured on the first version of
 * this change — gutting each real ladder to `[]`, the exact failure the ladder
 * exists to prevent, passed the whole unit suite 1326/1326 three times over. A
 * module with NO imports is what makes them testable, and it puts the three side by
 * side, which is where a reader compares them.
 *
 * ## Why a ladder at all, rather than "enable nothing"
 *
 * Because the provider's own defaults are not a safe answer for every provider.
 * Five models per provider are enabled with no write at all — for these three,
 * `default_model_count = 5` in `unified_models/model_catalog.py`, stamped after the
 * catalog sort, which is why the defaults are always catalog positions 0-4 (the
 * same 5 as `MIN_DEFAULT_MODELS`, but that constant governs the live-discovery
 * providers instead). Measured on 1.13.0.dev8 those five are:
 *
 *   google      gemini-3.8-flash, gemini-3.7-flash, gemini-flash-latest,
 *               gemini-3.6-flash, gemini-3.5-flash-lite
 *   anthropic   claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-fable-5,
 *               claude-opus-4-8
 *   openai      gpt-6-astra, gpt-5.6-sol, gpt-5.6-luna, gpt-5.6, gpt-5.6-terra
 *
 * Google's and Anthropic's satisfy their ladder as they stand, so those setups
 * click nothing. **None of OpenAI's does** — its ranking rejects all five — so a
 * no-pin OpenAI caller would fall through to "first available" and get a frontier
 * model where the whole-panel sweep used to leave it `gpt-4o-mini`. That is the
 * asymmetry these three lists encode, and it is why the OpenAI one may not be
 * simplified into "the first offered model".
 *
 * Every predicate reads a LOWERCASED model id: `planToggleTargets` lower-cases
 * before matching and the picker ranking lower-cases its labels, so a build that
 * renders an id with capitals still matches.
 */

/**
 * OpenAI families that are NOT general-purpose vision chat models: reasoning
 * (o1/o3/o4…), audio/realtime/tts/transcribe, search-preview and nano variants.
 *
 * A bare `gpt-4o-mini` substring would otherwise match `gpt-4o-mini-tts`, and a
 * text-only `o3-mini` would rank as a `-mini` fallback — breaking callers like the
 * agent image test, which needs real vision output.
 */
export const OPENAI_NON_CHAT_MODEL = /\bo\d|audio|realtime|tts|transcribe|search|nano/;

/**
 * Most- to least-preferred, all small multimodal chat models. Anything unmatched
 * (pro, reasoning, codex) is reached only through the caller's own last-resort
 * branch, which is scoped to OpenAI's options.
 */
export const OPENAI_MODEL_PREFERENCES: Array<(model: string) => boolean> = [
  (m) => m.includes("gpt-4o-mini") && !OPENAI_NON_CHAT_MODEL.test(m),
  (m) => m.includes("-mini") && !OPENAI_NON_CHAT_MODEL.test(m),
  (m) => m.includes("gpt-4o") && !OPENAI_NON_CHAT_MODEL.test(m),
  (m) => m.includes("gpt-4.1") && !OPENAI_NON_CHAT_MODEL.test(m),
];

/** Google variants that are not chat completions — an image/tts/preview model is a poor default for a chat spec. */
export const GOOGLE_NON_CHAT_MODEL = /image|tts|audio|preview/;

/**
 * Mirrors `setup-google.ts`'s picker-side `find` (the first `gemini` option) with
 * one refinement the sweep used to make unnecessary: prefer a flash chat model when
 * one is listed.
 */
export const GOOGLE_MODEL_PREFERENCES: Array<(model: string) => boolean> = [
  (m) => /gemini/.test(m) && /flash/.test(m) && !GOOGLE_NON_CHAT_MODEL.test(m),
  (m) => /gemini/.test(m),
];

/**
 * Mirrors `setup-anthropic.ts`'s picker-side `find` (the first `claude` option),
 * preferring a non-opus model: a spec that only needs a completion should not pay
 * for the largest one.
 */
export const ANTHROPIC_MODEL_PREFERENCES: Array<(model: string) => boolean> = [
  (m) => /claude/.test(m) && !/opus/.test(m),
  (m) => /claude/.test(m),
];
