// Unit tests for the Agent credential-settle classifier (issue #1072).
// Run with: npm run test:units
//
// What rides on this module: the guard at the end of every
// `SimpleAgentTemplatePage.load()` fails with whatever this produces, and that
// message is the entire product of the failure in a daily's report. Before #1072
// the guard raised a bare `expect(...).toBe(...)` mismatch — "Expected
// GOOGLE_API_KEY / Received ANTHROPIC_API_KEY" — which was triaged as a
// provider-wiring bug on the 2026-07-22 and 2026-07-27 dailies before anyone
// traced it to this guard.
//
// Two properties these tests exist to protect:
//
//  1. **The payload shape.** `template.model.value` is an ARRAY of model objects,
//     not a string. The first cut of this module read it as a string, so every
//     probe came back with no model and the verdicts that carry the whole
//     distinction became unreachable — while the tests passed, because the fixture
//     used a string too. Every fixture below therefore uses the real shape, and
//     `MODEL_VALUE_SHAPE` documents where it is verified in the product.
//  2. **The verdict distinctions.** Several states produce the same "not the
//     provider I asked for" observation and they send a reader to opposite places: a
//     lagging autosave, a model click that never registered, a provider that matches
//     only because it is the selector's default, and a read that never succeeded. A
//     classifier that collapses any of those silently re-creates the mis-triage,
//     and no Playwright spec would fail for it.
//  3. **The axis itself (#1274).** The guard settles on the PROVIDER of the
//     persisted model, not on `api_key` — upstream #14311 stopped writing that
//     field, so a classifier that consults it can only ever refuse to settle, which
//     is how 13 `@stable` specs failed on the 2026-08-05 daily. Tests below pin both
//     directions: an empty api_key must not block settling, and a stale one must not
//     either.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCredentialSettle,
  formatCredentialSettleFailure,
  readAgentCredentialProbe,
  type AgentCredentialProbe,
} from "./agent-credential-settle";

/**
 * Where the array shape is established in the product and in this repo:
 * `provider-setup/setup-language-model-openai.ts` ("the backend executes
 * `model.value[0].name` directly"), `agent-structured-output.spec.ts` (reads
 * `value` and maps `m.name`), and `rag-pipeline.spec.ts` (`tmpl.model.value =
 * [modelOption]`).
 */
const MODEL_VALUE_SHAPE = (name: string) => [
  { id: `openai/${name}`, name, provider: "OpenAI", icon: "OpenAI" },
];

/**
 * A `GET /api/v1/flows/{id}` payload shaped like the real one: the Simple Agent
 * template's ChatInput + Agent + ChatOutput, with only the fields the probe reads
 * spelled out.
 */
const flowWithAgent = (credential: string, modelValue: unknown) => ({
  id: "flow-1",
  data: {
    nodes: [
      { data: { type: "ChatInput", node: { template: { input_value: { value: "" } } } } },
      {
        data: {
          type: "Agent",
          node: {
            template: {
              api_key: { value: credential },
              model: { value: modelValue },
              system_prompt: { value: "You are a helpful assistant" },
            },
          },
        },
      },
      { data: { type: "ChatOutput", node: { template: {} } } },
    ],
  },
});

// ─── readAgentCredentialProbe — against the real payload shape ───────────────

test("the fixture itself uses the real array-of-objects shape", () => {
  // Without this, the pair (fixture, implementation) can be reverted TOGETHER to
  // the string shape and every other test still passes — which is exactly the
  // inert state described in this file's header. The fixture is the property.
  const value = MODEL_VALUE_SHAPE("gpt-4o-mini");
  assert.ok(Array.isArray(value), "model.value must be an array");
  assert.equal(typeof value[0], "object");
  assert.equal(value[0]?.name, "gpt-4o-mini");
});

test("reads the provider, the SELECTED model names and the credential off the real shape", () => {
  const probe = readAgentCredentialProbe(
    flowWithAgent("OPENAI_API_KEY", MODEL_VALUE_SHAPE("gpt-4o-mini")),
  );
  assert.deepEqual(probe, {
    credential: "OPENAI_API_KEY",
    // `selected` is what the classifier decides on: the provider and the model name
    // PAIRED, off the same entry. The two flat arrays below are projections kept for
    // the diagnostic — comparing them independently is what let a cross-entry
    // combination classify as settled.
    selected: [{ name: "gpt-4o-mini", provider: "OpenAI" }],
    selectedProviders: ["OpenAI"],
    selectedModels: ["gpt-4o-mini"],
  });
});

test("#1274 provider and model must match on the SAME entry", () => {
  // Proved by review: with two entries each carrying half of the wanted pair, two
  // independent `includes()` checks classified this as `settled` for
  // (google, gemini-2.5-flash) — a combination neither entry contains.
  const crossed = probeOfPairs([
    ["OpenAI", "gemini-2.5-flash"],
    ["Google Generative AI", "gpt-4o"],
  ]);
  assert.equal(
    classifyCredentialSettle(crossed, "Google Generative AI", "gemini-2.5-flash"),
    "model-not-applied",
    "the google entry carries gpt-4o, not the wanted model",
  );
  assert.equal(
    classifyCredentialSettle(
      probeOfPairs([["Google Generative AI", "gemini-2.5-flash"]]),
      "Google Generative AI",
      "gemini-2.5-flash",
    ),
    "settled",
  );
});

test("#1274 a model with no provider is unobservable, NOT a wrong provider", () => {
  // Proved by review: this landed on `provider-pending`, whose guidance tells the
  // reader to compare "the observed provider" while the diagnostic prints
  // `providers=[]` — a claim about something never observed.
  const noProvider = probeOfPairs([["", "gpt-4o-mini"]]);
  assert.deepEqual(noProvider.selectedProviders, []);
  assert.equal(classifyCredentialSettle(noProvider, "OpenAI"), "provider-unobservable");
  const message = formatCredentialSettleFailure({
    flowId: "f", provider: "openai", expectedProvider: "OpenAI",
    probe: noProvider, verdict: "provider-unobservable", elapsedMs: 20_000, reads: 9,
  });
  assert.ok(message.includes("providers=[]"), message);
  assert.ok(message.includes("unobservable"), message);
  assert.ok(
    !message.includes("A DIFFERENT provider"),
    "must not claim a wrong provider when none was observed:\n" + message,
  );
});

test("an unselected model field reads as no models, not as one empty name", () => {
  // The template ships `model.value: ""`, and the field stays empty until a
  // selection is autosaved. `[""]` would make `includes(expectedModel)` false but
  // `length === 0` false too, hiding `nothing-persisted`.
  for (const empty of [[], "", null, undefined, [null], [{}], [{ name: 42 }]]) {
    const probe = readAgentCredentialProbe(flowWithAgent("ANTHROPIC_API_KEY", empty));
    assert.deepEqual(
      probe?.selectedModels,
      [],
      `expected no model names for ${JSON.stringify(empty)}`,
    );
  }
});

test("a bare-string model value is still read, for a pre-unified-selector payload", () => {
  const probe = readAgentCredentialProbe(
    flowWithAgent("OPENAI_API_KEY", "gpt-4o-mini"),
  );
  assert.deepEqual(probe?.selectedModels, ["gpt-4o-mini"]);
});

test("returns null when the flow carries no Agent node", () => {
  const noAgent = { data: { nodes: [{ data: { type: "ChatInput" } }] } };
  assert.equal(readAgentCredentialProbe(noAgent), null);
});

test("survives every partial payload a poll can observe", () => {
  // The probe runs inside a retry loop, so a transient/incomplete body must read
  // as "not settled yet" — never as a crash that escapes the loop.
  for (const payload of [
    undefined,
    null,
    {},
    { data: {} },
    { data: { nodes: null } },
    { data: { nodes: [{}] } },
    { data: { nodes: [{ data: { type: "Agent" } }] } },
  ]) {
    const probe = readAgentCredentialProbe(payload);
    assert.ok(
      probe === null ||
        (probe.credential === "" && probe.selectedModels.length === 0),
      `unexpected probe for ${JSON.stringify(payload)}: ${JSON.stringify(probe)}`,
    );
  }
});

test("a non-string api_key reads as empty, not as the raw object", () => {
  const weird = flowWithAgent(
    { name: "OPENAI_API_KEY" } as unknown as string,
    MODEL_VALUE_SHAPE("gpt-4o-mini"),
  );
  assert.equal(readAgentCredentialProbe(weird)?.credential, "");
});

// ─── classifyCredentialSettle — the distinctions that matter ─────────────────

/**
 * A probe from PAIRED entries — the shape the classifier decides on.
 *
 * Takes `[provider, model]` tuples rather than two parallel arrays on purpose: the
 * parallel-array helper this replaced could build a probe whose provider and model
 * came from different entries, which is exactly the combination the classifier used
 * to accept (and the review proved). A fixture that cannot express the bug is how
 * the bug survives its own test.
 */
const probeOfPairs = (
  pairs: Array<[provider: string, model: string]>,
  credential = "",
): AgentCredentialProbe => {
  const selected = pairs.map(([provider, name]) => ({ name, provider }));
  return {
    credential,
    selected,
    selectedProviders: selected.map((e) => e.provider).filter((p) => p.length > 0),
    selectedModels: selected.map((e) => e.name).filter((n) => n.length > 0),
  };
};

/** One provider/model pair — the overwhelmingly common single-select case. */
const probeOf = (
  providers: string[],
  models: string[],
  credential = "",
): AgentCredentialProbe => {
  const width = Math.max(providers.length, models.length);
  return probeOfPairs(
    Array.from({ length: width }, (_, i) => [providers[i] ?? "", models[i] ?? ""]),
    credential,
  );
};

// Langflow's own spelling, measured on 1.12.0.dev16 — NOT this repo's Provider key.
const GOOGLE = "Google Generative AI";
const ANTHROPIC = "Anthropic";
const OPENAI = "OpenAI";

test("provider and model both applied is settled", () => {
  assert.equal(
    classifyCredentialSettle(probeOf([GOOGLE], ["gemini-2.5-flash"]), GOOGLE, "gemini-2.5-flash"),
    "settled",
  );
});

test("#1274 an empty api_key does NOT prevent settling — it is not an axis", () => {
  // The regression this issue is: since #14311 `api_key` reads "" on every build,
  // so any classification that consulted it could only ever refuse to settle.
  // 13 @stable specs failed the guard on the 2026-08-05 daily for exactly this.
  assert.equal(
    classifyCredentialSettle(
      probeOf([GOOGLE], ["gemini-2.5-flash"], ""),
      GOOGLE,
      "gemini-2.5-flash",
    ),
    "settled",
  );
});

test("#1274 a stale api_key does not prevent settling either", () => {
  // The mirror case: on a pre-#14311 build the field can still carry a value, and
  // for a google load that value may be the mount-time ANTHROPIC default. The
  // guard must not read that as unsettled once the provider is right, or it would
  // swap one dated premise for another.
  assert.equal(
    classifyCredentialSettle(
      probeOf([GOOGLE], ["gemini-2.5-flash"], "ANTHROPIC_API_KEY"),
      GOOGLE,
      "gemini-2.5-flash",
    ),
    "settled",
  );
});

test("the mount-time default provider is provider-pending, NOT settled", () => {
  // Measured read 0 on 1.12.0.dev16: a freshly mounted node carries
  // { name: "claude-opus-5", provider: "Anthropic" }. A google caller that settled
  // here would run Anthropic's model with Anthropic's key — the #744 signature.
  assert.equal(
    classifyCredentialSettle(probeOf([ANTHROPIC], ["claude-opus-5"]), GOOGLE, "gemini-2.5-flash"),
    "provider-pending",
  );
});

test("#1274 an ANTHROPIC caller is not settled by the default binding either", () => {
  // The vacuity #1072 found, carried onto the new axis: for anthropic the default
  // provider IS the expected one, so the provider axis alone would settle before
  // the pick lands. The model axis is what still separates them — which is why
  // gating on the model when one is pinned is retained rather than dropped.
  assert.equal(
    classifyCredentialSettle(probeOf([ANTHROPIC], ["claude-opus-5"]), ANTHROPIC, "claude-sonnet-5"),
    "model-not-applied",
  );
  assert.equal(
    classifyCredentialSettle(probeOf([ANTHROPIC], ["claude-sonnet-5"]), ANTHROPIC, "claude-sonnet-5"),
    "settled",
  );
});

test("a different model under the RIGHT provider is model-not-applied", () => {
  assert.equal(
    classifyCredentialSettle(probeOf([GOOGLE], ["gemini-3.5-pro"]), GOOGLE, "gemini-2.5-flash"),
    "model-not-applied",
  );
});

test("no persisted model or provider at all is nothing-persisted", () => {
  assert.equal(
    classifyCredentialSettle(probeOf([], []), OPENAI, "gpt-4o-mini"),
    "nothing-persisted",
  );
});

test("nothing-persisted is decided BEFORE the provider axis", () => {
  // Order matters: an empty model list also has an empty provider list, so testing
  // the provider first would report "a different provider is persisted" about a
  // node carrying none — a claim about something nobody observed.
  assert.equal(classifyCredentialSettle(probeOf([], []), GOOGLE), "nothing-persisted");
});

test("#1274 a caller that pins NO model still blocks on a real transition", () => {
  // This is what the credential axis could no longer do. `api_key` is "" both
  // before and after the pick, so these three specs
  // (model-provider-model-toggle, general-bugs-agent-images-playground,
  // agent-model-connection-isolation) would have settled on the first read and
  // proved nothing. The provider is always known, so they still gate.
  assert.equal(
    classifyCredentialSettle(probeOf([ANTHROPIC], ["claude-opus-5"]), OPENAI),
    "provider-pending",
    "the mount-time default must not settle an openai caller",
  );
  assert.equal(
    classifyCredentialSettle(probeOf([OPENAI], ["gpt-4o-mini"]), OPENAI),
    "settled",
  );
});

test("#1274 a keyless provider is a positive assertion, not an empty-string match", () => {
  // #1187 had to lean on the caller passing a model, because for Ollama the settled
  // credential ("") equalled the pre-selection state. `provider: "Ollama"` is
  // observable in its own right.
  assert.equal(
    classifyCredentialSettle(probeOf([ANTHROPIC], ["claude-opus-5"]), "Ollama"),
    "provider-pending",
  );
  assert.equal(
    classifyCredentialSettle(probeOf(["Ollama"], ["llama3.1:latest"]), "Ollama"),
    "settled",
  );
});

test("a provider with no observable model name is model-pending, not model-not-applied", () => {
  // Degenerate payload: an entry carrying `provider` and no `name`. There is no
  // other model to name, so the sharper verdict would assert something unobserved.
  assert.equal(
    classifyCredentialSettle(probeOf([GOOGLE], []), GOOGLE, "gemini-2.5-flash"),
    "model-pending",
  );
});

test("a missing Agent node is its own verdict, not a pending provider", () => {
  assert.equal(classifyCredentialSettle(null, OPENAI, "gpt-4o-mini"), "no-agent-node");
});

// ─── formatCredentialSettleFailure ───────────────────────────────────────────

const failure = (
  over: Partial<Parameters<typeof formatCredentialSettleFailure>[0]> = {},
) =>
  formatCredentialSettleFailure({
    flowId: "abc-123",
    provider: "google",
    expectedProvider: "Google Generative AI",
    expectedModel: "gemini-2.5-flash",
    probe: probeOf(["Anthropic"], ["claude-opus-5"]),
    verdict: "provider-pending",
    elapsedMs: 20_400,
    reads: 14,
    ...over,
  });

/** The value on a labelled line, so an assertion cannot pass on a coincidence. */
function field(message: string, label: string): string | undefined {
  const line = message
    .split("\n")
    .find((candidate) => candidate.trim().startsWith(`${label} `));
  return line?.trim().slice(label.length).trim();
}

test("the message carries every fact needed to triage without the artifacts", () => {
  const message = failure();
  // Read per labelled field rather than substring-matching the whole message:
  // `gemini-2.5-flash` appears on two lines, so a plain `includes` could not fail
  // if the "model wanted" line were dropped.
  assert.equal(field(message, "flow"), "abc-123");
  assert.equal(
    field(message, "provider"),
    'google (expected "Google Generative AI" on the persisted model)',
  );
  assert.equal(field(message, "model wanted"), "gemini-2.5-flash");
  assert.equal(
    field(message, "observed"),
    'providers=[Anthropic] models=[claude-opus-5] api_key=""',
  );
  assert.equal(field(message, "waited"), "20.4s over 14 read(s)");
  assert.equal(field(message, "verdict"), "provider-pending");
  // The two issues a reader needs: why the guard exists, where the load relief is.
  assert.ok(message.includes("#751"), message);
  assert.ok(message.includes("#1077"), message);
});

test("a caller that chose no model says so on the model line", () => {
  assert.equal(
    field(failure({ expectedModel: undefined }), "model wanted"),
    "(caller let the setup helper choose)",
  );
});

test("provider-pending does not wave the failure off as load", () => {
  // It prints only AFTER the budget expired, i.e. retrying did not help within it,
  // and a persisted THIRD provider is a real misbinding rather than slowness.
  const message = failure();
  assert.ok(
    message.includes("retrying did NOT help"),
    "the guidance must not tell the reader to dismiss a failure that did not settle",
  );
  assert.ok(message.includes("THIRD provider"), message);
});

test("nothing-persisted points at the request that actually rebinds", () => {
  // The flows PATCH only persists the result; the binding is computed by the
  // custom_component update. Naming the wrong one sends the reader to a healthy
  // request and a wrong conclusion.
  const message = failure({
    verdict: "nothing-persisted",
    probe: probeOf([], []),
  });
  assert.ok(message.includes("custom_component/update"), message);
});

test("#1274 provider-pending names BOTH of its causes and how to tell them apart", () => {
  // Reachable two ways that mean different things: the mount-time DEFAULT provider,
  // where the pick simply has not been autosaved and waiting is right; and some
  // THIRD provider, where the setup step clicked wrong and waiting cannot help.
  // Guidance asserting only one is misleading half the time it prints.
  const message = failure();
  assert.ok(message.includes("DEFAULT"), message);
  assert.ok(message.includes("THIRD"), message);
  assert.ok(message.includes("#1077"), "the waiting-is-right cause needs the load pointer");
});

test("#1274 model-pending describes the degenerate payload, not a normal pending state", () => {
  const message = failure({
    verdict: "model-pending",
    probe: probeOf(["Google Generative AI"], []),
  });
  assert.ok(message.includes("degenerate"), message);
  assert.ok(
    !message.includes("DIFFERENT model is persisted"),
    "there is no other model to name here:\n" + message,
  );
});

test("a guard that never read the flow reports UNKNOWN, not an absent Agent node", () => {
  const message = failure({
    probe: null,
    verdict: "read-failed",
    reads: 0,
    lastReadError: "apiRequestContext.get: Timeout 20000ms exceeded.",
  });
  assert.equal(field(message, "observed"), "no successful read of the persisted flow");
  assert.equal(field(message, "last read err"), "apiRequestContext.get: Timeout 20000ms exceeded.");
  assert.ok(message.includes("UNKNOWN"), message);
  assert.ok(
    !message.includes("has no Agent node"),
    "read-failed must not assert a fact the guard never observed",
  );
});

test("no-agent-node is reported only for a flow that WAS read", () => {
  const message = failure({ probe: null, verdict: "no-agent-node" });
  assert.equal(field(message, "observed"), "the flow was read and carries no Agent node");
  assert.ok(
    message.includes("did not instantiate as expected"),
    "the verdict needs guidance of its own, not an empty line",
  );
});

test("model-not-applied covers the wedged save path, not only a wrong click", () => {
  // Verified on 1.12.0.dev10: the Agent's mount-time prefill persists
  // ANTHROPIC_API_KEY plus the default Claude model, so on a google/openai load a
  // save path that never lands leaves EXACTLY this state. Guidance that sends the
  // reader to the setup helper only would misdirect every wedged load (#1077).
  const message = failure({
    verdict: "model-not-applied",
    expectedProvider: "Google Generative AI",
    probe: probeOf(["Google Generative AI"], ["gemini-3.5-pro"]),
  });
  assert.ok(message.includes("setup helper"), message);
  // The wedged-save case MOVED to provider-pending in #1274: a node that kept its
  // mount-time default carries a different PROVIDER, not merely a different model.
  // Guidance that still sent this verdict's reader hunting a wedged save would
  // point at the wrong mechanism.
  assert.ok(message.includes("provider-pending"), message);
});

test("#1274 no verdict claims a check that did not run, for any caller", () => {
  // The old code needed a per-caller special case: `credential-pending`'s guidance
  // asserted "the requested model IS applied", which was false for the three
  // callers that pin no model. The primary axis is now the provider, which every
  // caller supplies, so one string per verdict is true for all of them — and no
  // guidance may assert the model axis was consulted.
  for (const expectedModel of [undefined, "gemini-2.5-flash"]) {
    const message = failure({ expectedModel });
    assert.ok(
      !message.includes("The requested model IS applied"),
      `must not assert a check that could not run (expectedModel=${expectedModel}):\n${message}`,
    );
  }
});

test("#1274 the note says api_key is not asserted — without claiming it is empty", () => {
  // Every reader arrives knowing the pre-#14311 behaviour, and the observed line
  // still prints an api_key. Without a note the field reads as the defect, which is
  // how the 2026-08-05 daily's failures were first triaged as a product regression.
  //
  // Asserted on the INTENT, not on a phrase about the value: `manual.yml` can
  // dispatch a pre-#14311 build where api_key IS written, and a note claiming it is
  // empty on "every build" would contradict the observed line above it. Pinning the
  // phrase is what let that false claim ship (caught in review of this PR).
  const message = failure();
  assert.ok(message.includes("NOT asserted in either direction"), message);
  assert.ok(message.includes("#1274"), message);
  assert.ok(
    !/api_key is EMPTY on every build/.test(message),
    "the note must not claim the field is empty on builds where it is written:\n" + message,
  );
});

test("#1274 the api_key note is printed only when an api_key was observed", () => {
  // Review caught it printing unconditionally, including for read-failed, where no
  // api_key was seen — the same unobserved-claim defect this module exists to avoid.
  const observed = failure();
  assert.ok(observed.includes("api_key is NOT asserted"), observed);
  for (const verdict of ["read-failed", "no-agent-node"] as const) {
    const message = failure({ probe: null, verdict, reads: 0 });
    assert.ok(
      !message.includes("api_key is NOT asserted"),
      `${verdict} observed no api_key, so it must not comment on one:\n${message}`,
    );
  }
});
