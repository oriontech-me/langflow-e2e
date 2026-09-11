// Unit tests for the provider panel's toggle-batch flush gate (#1649).
// Run with: npm run test:units
//
// What rides on this predicate is not a wait, it is WHICH of the product's two
// send paths carries the toggles. `useModelToggleQueue` debounces every toggle by
// 1000 ms; the debounced flush refreshes the model picker (its `onSettled` calls
// `refreshAllModelInputs`), while the close-path flush does not. Closing the panel
// inside the debounce window therefore leaves the picker on the PRE-toggle enabled
// set — on a freshly configured provider, the `MIN_DEFAULT_MODELS = 5` default —
// and the picker read that follows raises `MODEL_PICKER_DEFECT`.
//
// Measured on 1.12.0.dev44, one clean container, three runs of the identical
// sequence differing only in the pause before Close, server at enabled=41 in all
// three: 0 ms -> picker offers 5; 1200 ms -> 35; 2000 ms -> 35.
//
// The predicate is pure so every branch is reachable without a browser — the same
// reason `resolveModelOption` and `censusForTarget` are.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flushVerdict,
  modelTriggerStallMessage,
  planToggleTargets,
  writeStallReason,
  type ToggleBatchObservation,
} from "./model-toggle-batch";
import {
  ANTHROPIC_MODEL_PREFERENCES,
  GOOGLE_MODEL_PREFERENCES,
  OPENAI_MODEL_PREFERENCES,
} from "./model-preferences";

const OPTS = { quietMs: 1500, deadlineAt: 100_000 };

function obs(over: Partial<ToggleBatchObservation> = {}): ToggleBatchObservation {
  return {
    clicked: 3,
    lastClickAt: 1_000,
    postsStarted: 1,
    postsFinished: 1,
    lastPostStartedAt: 1_200,
    ...over,
  };
}

test("a panel nobody changed needs no flush at all", () => {
  // The normal CI path, and it stayed normal for a different reason twice over:
  // it used to be that `Collect models` had already enabled everything, which
  // stopped being true at #1666 (its sweep landed zero writes and was removed);
  // since #1679 it is that the plan is usually empty, because the model a setup
  // picks is one of the provider's five defaults. Either way there is no batch to
  // wait for, and this branch is what keeps the fix free on every run that does
  // not hit the defect.
  const v = flushVerdict(obs({ clicked: 0, postsStarted: 0, postsFinished: 0 }), 1_000, OPTS);
  assert.equal(v.kind, "nothing-to-flush");
});

test("the debounce window still being open is not settled", () => {
  const v = flushVerdict(obs({ lastClickAt: 5_000 }), 5_900, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /debounce/i);
});

test("a write that was issued but has not answered is not settled", () => {
  const v = flushVerdict(obs({ postsStarted: 2, postsFinished: 1 }), 9_000, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /in flight/i);
});

test("clicks with NO write issued yet are not settled — the queue has not fired", () => {
  const v = flushVerdict(
    obs({ postsStarted: 0, postsFinished: 0, lastPostStartedAt: null }),
    9_000,
    OPTS,
  );
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /no write/i);
});

test("a write that answered but only just started leaves room for a follow-up batch", () => {
  // The queue splits into several batches when the loop is slow: a POST finishing
  // does not prove the LAST one has been sent. Requiring quiet since the last
  // start too is what makes this a quiescence check rather than a first-response
  // check — `waitForResponse` on the first POST was measured returning while the
  // batch was still being sent.
  const v = flushVerdict(obs({ lastPostStartedAt: 8_500 }), 9_000, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /quiet/i);
});

test("clicks flushed, answered and quiet on both clocks is settled", () => {
  const v = flushVerdict(obs({ lastClickAt: 1_000, lastPostStartedAt: 2_000 }), 4_000, OPTS);
  assert.equal(v.kind, "settled");
});

test("past the deadline it gives up NAMING what it saw, never silently", () => {
  // Giving up is not a failure: the picker read that follows is the real gate and
  // it fails loudly with the right message. What must not happen is giving up
  // without a trace — an unevaluated wait is unknown, not clean (#1012).
  const v = flushVerdict(
    obs({ clicked: 7, postsStarted: 2, postsFinished: 1 }),
    100_001,
    OPTS,
  );
  assert.equal(v.kind, "gave-up");
  if (v.kind === "gave-up") {
    assert.match(v.message, /7 toggle\(s\) clicked/);
    assert.match(v.message, /2 write\(s\) started/);
    assert.match(v.message, /1 finished/);
    assert.match(v.message, /#1649/);
  }
});

test("the deadline never overrides nothing-to-flush", () => {
  // An unchanged panel past the deadline is still nothing to flush — reporting a
  // give-up there would put a scary line in every healthy run's log.
  const v = flushVerdict(
    obs({ clicked: 0, postsStarted: 0, postsFinished: 0, lastClickAt: null }),
    100_001,
    OPTS,
  );
  assert.equal(v.kind, "nothing-to-flush");
});

// --- #1649 (reopened): a give-up is an OBSERVED cause, and it must be carried ---
//
// The gate above already prints what it saw. What it did NOT do was hand that
// observation to the picker read that follows, so 90 s later the failure named a
// cause nobody had measured ("the picker did not refresh, or the option list is
// filtered") while the real one — the write never answered — sat in a log line no
// failure message, no `error_signature` and no triage dataset correlates. All eight
// give-ups on the 2026-09-01 daily read `1 write(s) started, 0 finished`.
//
// `writeStallReason` is the carrier, and it is pure for the same reason
// `flushVerdict` is. Three properties ride on it: an UNOBSERVED batch is not a
// negative one (#1012), a SETTLED batch must leave the existing verdict alone, and
// an unchanged panel is never a stall.

test("a gave-up batch yields a reason naming the write that never answered", () => {
  const reason = writeStallReason({
    clicked: 30,
    verdict: "gave-up",
    writesStarted: 1,
    writesFinished: 0,
  });
  assert.ok(reason !== null);
  assert.match(reason!, /30 toggle\(s\) clicked/);
  assert.match(reason!, /1 write\(s\) started/);
  assert.match(reason!, /0 finished/);
  // The endpoint is named, because "the write" is not actionable on its own.
  assert.match(reason!, /enabled_models/);
});

test("an UNOBSERVED batch is not a stalled one", () => {
  // The three provider helpers pass what they measured; anything else (a caller
  // that never ran the gate) must produce no claim at all rather than a negative.
  assert.equal(writeStallReason(undefined), null);
});

test("a settled batch is never a stall, whatever the counts say", () => {
  // This is the branch that keeps MODEL_PICKER_DEFECT alive: a picker that
  // disagrees AFTER a clean flush is the genuine, unexplained disagreement #1461
  // wrote its assertion for, and re-labelling it as an instance stall would blind
  // the suite to it.
  assert.equal(
    writeStallReason({ clicked: 36, verdict: "settled", writesStarted: 1, writesFinished: 1 }),
    null,
  );
  assert.equal(
    writeStallReason({ clicked: 0, verdict: "nothing-to-flush", writesStarted: 0, writesFinished: 0 }),
    null,
  );
});

test("a panel nobody changed is never a stall, even past the deadline", () => {
  // `flushVerdict` cannot return gave-up with clicked === 0 today, but the guard is
  // cheap and the alternative is a scary instance-stall verdict on a healthy run
  // the moment that ordering changes.
  assert.equal(
    writeStallReason({ clicked: 0, verdict: "gave-up", writesStarted: 0, writesFinished: 0 }),
    null,
  );
});

test("the model_model message blames the instance, keeps the original error, and cannot skip", () => {
  const message = modelTriggerStallMessage(
    { clicked: 30, verdict: "gave-up", writesStarted: 1, writesFinished: 0 },
    {
      providerLabel: "Google Generative AI",
      original: "locator.waitFor: Timeout 60000ms exceeded.",
    },
  );
  assert.ok(message !== null);
  // Two of #1649's six occurrences were this timeout, 60 s each, with nothing in
  // the message naming a cause. The prefix must NOT be the skip prefix.
  assert.ok(!message!.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(message!, /^MODEL_TOGGLE_WRITE_STALLED:/);
  assert.match(message!, /Google Generative AI/);
  assert.match(message!, /1 write\(s\) started, 0 finished/);
  assert.match(message!, /locator\.waitFor: Timeout 60000ms exceeded\./);
  // The refresh runs in the batch's own onSettled — saying so is what separates
  // this from a trigger/testid defect.
  assert.match(message!, /onSettled/);
  assert.match(message!, /#1649/);
});

test("with no stall the model_model failure is left exactly as it was", () => {
  // A trigger that never appears on a HEALTHY flush is a real defect and must keep
  // surfacing as Playwright's own locator error, not be re-labelled.
  assert.equal(
    modelTriggerStallMessage(
      { clicked: 36, verdict: "settled", writesStarted: 1, writesFinished: 1 },
      { providerLabel: "OpenAI", original: "locator.click: Timeout 60000ms exceeded." },
    ),
    null,
  );
});

// ─── planToggleTargets (#1679) ────────────────────────────────────────────────
//
// The panel used to be SWEPT — every unchecked `:visible` toggle clicked — and that
// write is not affordable. `POST /models/enabled_models` is an `async def` handler
// that calls `validate_model_provider_key` once per enabled update, synchronously,
// and that call ends in `llm.invoke("test")` on the event loop of the single
// uvicorn worker the lanes pin. Measured on 1.13.0.dev8, one idle container,
// `LANGFLOW_WORKERS=1`, `LANGFLOW_WORKER_TIMEOUT=120`, `/health_check` probed at
// 1 Hz: one model answers 200 in 0.86 s and never drops a probe, while 29 models
// NEVER answer — the connection closes at 93.2 s with 26 consecutive probes down
// over 97 s, the container log carrying `WORKER TIMEOUT` -> `Worker was sent
// SIGKILL!`, and the enabled set afterwards still exactly the `MIN_DEFAULT_MODELS`
// five, because `_update_model_sets` runs AFTER the validation loop. The sweep is
// therefore not a slow success: it is a guaranteed failure every spec on that
// instance re-pays in full.
//
// The planner is PURE for the same reason `flushVerdict` is: the branches that
// matter are decided by panel states a spec cannot produce on demand (a pin the
// catalog retired, a provider whose defaults no caller accepts).
//
// The model ids below are the REAL catalog, read from
// `GET /api/v1/models?purpose=configure` on 1.13.0.dev8 — including the fact that
// the five `default: true` entries are catalog positions 0-4 for all three
// providers.
const GOOGLE_DEFAULTS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];
const GOOGLE_REST = [
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite-image",
  "gemini-omni-flash-preview",
  "gemini-3.5-live-translate-preview",
];
const GOOGLE_LISTED = [...GOOGLE_DEFAULTS, ...GOOGLE_REST];

const OPENAI_DEFAULTS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6", "gpt-5.6-terra"];
const OPENAI_REST = ["gpt-realtime-2.1", "gpt-5.5-pro", "gpt-5.5", "gpt-4o-mini", "gpt-4o"];
const OPENAI_LISTED = [...OPENAI_DEFAULTS, ...OPENAI_REST];

// THE REAL LADDERS, imported — not copies. The first version of this file
// re-declared them, because they were module-private in the three `setup-*.ts`
// files, and copies pin nothing: gutting each real ladder to `[]` — the exact
// failure the ladder exists to prevent — passed the whole unit suite 1326/1326.
// `model-preferences.ts` exists so a `node --test` process can reach them without
// importing `@playwright/test`.
const OPENAI_LADDER = OPENAI_MODEL_PREFERENCES;
const GOOGLE_LADDER = GOOGLE_MODEL_PREFERENCES;

test("the #1679 case: the pinned Google model IS a default, so nothing is clicked", () => {
  // `resolveGeminiModel`'s first preference — what `google-provider.spec.ts` (the
  // 2026-09-03 occurrence) and `language-model-regression.spec.ts` pin — is
  // `gemini-flash-latest`, one of the five `default: true` models and therefore
  // enabled server-side the moment the credential exists. For that class of caller
  // the whole 29-toggle batch was buying nothing even when it landed. The
  // parametrized agent specs pin the SETTLED model instead (locally
  // `gemini-2.5-flash`, not a default) and take the branch below.
  const plan = planToggleTargets({
    listed: GOOGLE_LISTED,
    checked: GOOGLE_DEFAULTS,
    requested: "gemini-flash-latest",
    acceptable: GOOGLE_LADDER,
  });
  assert.deepEqual(plan.toClick, []);
  assert.match(plan.reason, /already enabled/);
});

test("a pinned model the panel lists but has OFF is the only toggle clicked", () => {
  const plan = planToggleTargets({
    listed: GOOGLE_LISTED,
    checked: GOOGLE_DEFAULTS,
    requested: "gemini-flash-lite-latest",
    acceptable: GOOGLE_LADDER,
  });
  // One click — and specifically not the ladder's own first choice, which would
  // substitute a model the caller did not ask for.
  assert.deepEqual(plan.toClick, ["gemini-flash-lite-latest"]);
  assert.match(plan.reason, /ONLY "gemini-flash-lite-latest"/);
});

test("a pinned model the panel does NOT list falls through to the preference ladder", () => {
  // `initialGPTsetup` pins from `models.json`, which can be stale (#606), and its
  // consumers must degrade rather than fail. The whole-panel sweep degraded by
  // accident — everything was enabled, so the post-close ranking always had a
  // choice. Enabling nothing here would silently stop doing that, leaving the
  // ranking with only the five defaults, none of which it accepts.
  const plan = planToggleTargets({
    listed: OPENAI_LISTED,
    checked: OPENAI_DEFAULTS,
    requested: "gpt-4o-mini-2024-07-18",
    acceptable: OPENAI_LADDER,
  });
  assert.deepEqual(plan.toClick, ["gpt-4o-mini"]);
  assert.match(plan.reason, /does not list the pinned "gpt-4o-mini-2024-07-18"/);
});

test("OpenAI with no pin enables the ladder's top match even though five are already on", () => {
  // The defaults are `gpt-6-astra` and four `gpt-5.6-*`; the ranking accepts none of
  // them, so a no-pin caller (the vision spec) must not be left with them. The RANK
  // decides, not the count: an already-enabled lower rank does not stop a listed
  // higher rank from being enabled.
  const plan = planToggleTargets({
    listed: OPENAI_LISTED,
    checked: OPENAI_DEFAULTS,
    acceptable: OPENAI_LADDER,
  });
  assert.deepEqual(plan.toClick, ["gpt-4o-mini"]);
  assert.match(plan.reason, /no model was pinned/);
  assert.match(plan.reason, /preference 1 of 4/);
});

test("no pin and an already-enabled model that matches: no write at all", () => {
  // Google's and Anthropic's defaults are all `gemini`/`claude`, so this is the
  // no-pin path on two of the three providers — and it pays nothing.
  const plan = planToggleTargets({
    listed: GOOGLE_LISTED,
    checked: GOOGLE_DEFAULTS,
    acceptable: GOOGLE_LADDER,
  });
  assert.deepEqual(plan.toClick, []);
  assert.match(plan.reason, /"gemini-3\.8-flash" is already enabled/);
});

test("the ladder is walked in order — rank 2 is only reached when rank 1 is nowhere", () => {
  const plan = planToggleTargets({
    listed: ["gemini-3.1-flash-lite-image", "gemini-2.5-pro"],
    checked: [],
    acceptable: GOOGLE_LADDER,
  });
  // Rank 1 excludes the image variant, so rank 2 ("any gemini") decides, and it
  // takes the FIRST listed match rather than a scan order of its own.
  assert.deepEqual(plan.toClick, ["gemini-3.1-flash-lite-image"]);
  assert.match(plan.reason, /preference 2 of 2/);
});

test("a ladder nothing satisfies leaves the panel alone and SAYS so", () => {
  // Not silence: "clicked nothing" has four causes and only two of them are
  // healthy, so the reason is what a run can triage from (#1012).
  const plan = planToggleTargets({
    listed: OPENAI_DEFAULTS,
    checked: OPENAI_DEFAULTS,
    acceptable: OPENAI_LADDER,
  });
  assert.deepEqual(plan.toClick, []);
  assert.match(plan.reason, /none of the 5 listed model\(s\) matches/);
  assert.match(plan.reason, /picker ranking decides/);
});

test("no pin and no ladder is a decision, not an omission", () => {
  // BOTH spellings of "no ladder", because they are two different call sites: a
  // caller that omits the field, and one that computes an empty array. The guard
  // reads `acceptable === undefined || acceptable.length === 0`, and weakening it
  // to the first half alone changed no `toClick` — the empty array falls out of
  // the loop with nothing to click either way — so only the REASON separates
  // them, and the reason is what the give-up path prints (#1012).
  for (const acceptable of [undefined, []]) {
    const plan = planToggleTargets({
      listed: GOOGLE_LISTED,
      checked: GOOGLE_DEFAULTS,
      acceptable,
    });
    assert.deepEqual(plan.toClick, []);
    assert.match(plan.reason, /no preference was given/);
    assert.doesNotMatch(plan.reason, /preference 1 of 0|matches any of the 0/);
  }
});

test('an empty pin is NO pin, and the reason must not quote a model named ""', () => {
  // `modelTestId` reaches the setups as `string | undefined` through
  // `providerSetupMap`, and a caller resolving it from the environment
  // (`MODEL_TEST_ID`) can hand over "" or " ".
  //
  // The `toClick` half is NOT what pins this — "" is in neither `checked` nor
  // `listed`, so the ladder decides either way and the click list is identical
  // with or without the guard (measured: dropping it failed nothing). What the
  // guard decides is the REASON, which is the line a triage reads: without it a
  // run reports `the panel does not list the pinned ""`, an absence of a model
  // nobody asked for. So the assertion is on the reason, and on the absence of
  // the empty-quote spelling.
  for (const requested of ["", "   "]) {
    const plan = planToggleTargets({
      listed: OPENAI_LISTED,
      checked: OPENAI_DEFAULTS,
      requested,
      acceptable: OPENAI_LADDER,
    });
    assert.deepEqual(plan.toClick, ["gpt-4o-mini"]);
    assert.match(plan.reason, /no model was pinned/);
    assert.doesNotMatch(plan.reason, /pinned ""|pinned "\s+"/);
  }
});

test("the ladder sees the model id LOWERCASED, and the plan keeps the original", () => {
  // The predicates are substring tests written in lower case (they are shared with
  // the picker-side ranking, which lower-cases its labels). A build that renders an
  // id with capitals must still match, and the click must still address the real
  // testid.
  const plan = planToggleTargets({
    listed: ["GPT-4o-Mini"],
    checked: [],
    acceptable: OPENAI_LADDER,
  });
  assert.deepEqual(plan.toClick, ["GPT-4o-Mini"]);
});

// ─── the plan and the three real ladders together (#1679) ────────────────────
//
// The ladders themselves — which of each provider's five `default: true` models
// each one accepts, and which non-chat families it must reject — are asserted in
// `model-preferences.test.ts`, next to the module that owns them. What is pinned
// HERE is the consequence the setups depend on: fed a real ladder and the real
// catalog it was designed against, the PLAN is empty for Google and Anthropic and
// one model for OpenAI.
const ANTHROPIC_DEFAULTS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
];

test("Anthropic's own defaults satisfy its ladder, so that setup plans no write", () => {
  assert.deepEqual(
    planToggleTargets({
      listed: ANTHROPIC_DEFAULTS,
      checked: ANTHROPIC_DEFAULTS,
      acceptable: ANTHROPIC_MODEL_PREFERENCES,
    }).toClick,
    [],
  );
});

test("OpenAI's own defaults satisfy nothing in its ladder, so that setup plans one write", () => {
  // The asymmetry the three lists exist to encode. If a future edit makes one of
  // OpenAI's defaults acceptable, `general-bugs-agent-images-playground` silently
  // starts running its multimodal assertion on a frontier model instead of
  // `gpt-4o-mini`.
  assert.deepEqual(
    planToggleTargets({
      listed: OPENAI_LISTED,
      checked: OPENAI_DEFAULTS,
      acceptable: OPENAI_MODEL_PREFERENCES,
    }).toClick,
    ["gpt-4o-mini"],
  );
});

test("an unlisted pin with an empty panel plans nothing — and names the empty panel", () => {
  // `waitForModelToggles` runs before the enumeration precisely so this state means
  // "the provider really has no toggles" (unconfigured, rejected key) rather than
  // "we looked too early". Either way there is nothing to click, and the picker read
  // at the end of the setup is the gate that reports it with evidence.
  const plan = planToggleTargets({
    listed: [],
    checked: [],
    requested: "gemini-flash-latest",
    acceptable: GOOGLE_LADDER,
  });
  assert.deepEqual(plan.toClick, []);
  assert.match(plan.reason, /0 listed model\(s\)/);
});

test("every branch states a reason, and no branch can ever plan a sweep", () => {
  // The give-up message prints the plan's reason, so an empty one would make a
  // stall on a one-model write indistinguishable from a stall on a plan that
  // clicked nothing. The second assertion is the #1679 invariant itself: a
  // provider setup picks exactly one model, so no input may grow the plan back
  // into a batch.
  const inputs = [
    { listed: GOOGLE_LISTED, checked: GOOGLE_DEFAULTS, requested: "gemini-flash-latest" },
    { listed: GOOGLE_LISTED, checked: [], requested: "gemini-flash-latest" },
    { listed: GOOGLE_LISTED, checked: GOOGLE_DEFAULTS, requested: "gemini-1.0-pro" },
    { listed: [], checked: [], requested: "gemini-flash-latest" },
    { listed: [], checked: [] },
    { listed: GOOGLE_LISTED, checked: GOOGLE_DEFAULTS },
    { listed: GOOGLE_LISTED, checked: [] },
    { listed: OPENAI_LISTED, checked: OPENAI_DEFAULTS },
  ];
  for (const input of inputs) {
    for (const acceptable of [undefined, GOOGLE_LADDER, OPENAI_LADDER]) {
      const plan = planToggleTargets({ ...input, acceptable });
      assert.ok(plan.reason.trim().length > 0, JSON.stringify(input));
      assert.ok(plan.toClick.length <= 1, JSON.stringify(input));
    }
  }
});
