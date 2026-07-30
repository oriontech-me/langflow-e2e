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
//  2. **The verdict distinctions.** Several states produce the same "wrong
//     credential" observation and they send a reader to opposite places: a lagging
//     autosave, a model click that never registered, a credential that matches only
//     because it is the selector's default, and a read that never succeeded. A
//     classifier that collapses any of those silently re-creates the mis-triage,
//     and no Playwright spec would fail for it.
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

test("reads the credential and the SELECTED model names off the real shape", () => {
  const probe = readAgentCredentialProbe(
    flowWithAgent("OPENAI_API_KEY", MODEL_VALUE_SHAPE("gpt-4o-mini")),
  );
  assert.deepEqual(probe, {
    credential: "OPENAI_API_KEY",
    selectedModels: ["gpt-4o-mini"],
  });
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

const probeOf = (credential: string, models: string[]): AgentCredentialProbe => ({
  credential,
  selectedModels: models,
});

test("credential and model both applied is settled", () => {
  assert.equal(
    classifyCredentialSettle(
      probeOf("GOOGLE_API_KEY", ["gemini-2.5-flash"]),
      "GOOGLE_API_KEY",
      "gemini-2.5-flash",
    ),
    "settled",
  );
});

test("the anthropic default binding alone is model-pending, NOT settled", () => {
  // The vacuity #1072 found: for `provider: "anthropic"` the expected credential
  // IS the selector's default auto-binding, so a credential-only check declared
  // the load settled before the model selection had been applied at all.
  assert.equal(
    classifyCredentialSettle(
      probeOf("ANTHROPIC_API_KEY", []),
      "ANTHROPIC_API_KEY",
      "claude-sonnet-5",
    ),
    "model-pending",
  );
});

test("model applied but credential still on the default is credential-pending", () => {
  // The 2026-07-27 daily flake, exactly: a google target observing the default
  // ANTHROPIC binding while the requested Gemini model IS already selected.
  assert.equal(
    classifyCredentialSettle(
      probeOf("ANTHROPIC_API_KEY", ["gemini-2.5-flash"]),
      "GOOGLE_API_KEY",
      "gemini-2.5-flash",
    ),
    "credential-pending",
  );
});

test("a different persisted model is model-not-applied", () => {
  assert.equal(
    classifyCredentialSettle(
      probeOf("ANTHROPIC_API_KEY", ["claude-sonnet-5"]),
      "GOOGLE_API_KEY",
      "gemini-2.5-flash",
    ),
    "model-not-applied",
  );
});

test("no persisted model at all is nothing-persisted", () => {
  assert.equal(
    classifyCredentialSettle(
      probeOf("ANTHROPIC_API_KEY", []),
      "OPENAI_API_KEY",
      "gpt-4o-mini",
    ),
    "nothing-persisted",
  );
});

test("without an expected model only the credential axis is available", () => {
  // A caller that lets the setup helper pick the first model has no name to
  // compare, so the model axis must not manufacture a verdict.
  assert.equal(
    classifyCredentialSettle(probeOf("OPENAI_API_KEY", []), "OPENAI_API_KEY"),
    "settled",
  );
  assert.equal(
    classifyCredentialSettle(
      probeOf("ANTHROPIC_API_KEY", ["claude-sonnet-5"]),
      "OPENAI_API_KEY",
    ),
    "credential-pending",
  );
});

test("a missing Agent node is its own verdict, not a pending credential", () => {
  assert.equal(
    classifyCredentialSettle(null, "OPENAI_API_KEY", "gpt-4o-mini"),
    "no-agent-node",
  );
});

// ─── formatCredentialSettleFailure ───────────────────────────────────────────

const failure = (
  over: Partial<Parameters<typeof formatCredentialSettleFailure>[0]> = {},
) =>
  formatCredentialSettleFailure({
    flowId: "abc-123",
    provider: "google",
    expectedCredential: "GOOGLE_API_KEY",
    expectedModel: "gemini-2.5-flash",
    probe: probeOf("ANTHROPIC_API_KEY", ["gemini-2.5-flash"]),
    verdict: "credential-pending",
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
  assert.equal(field(message, "provider"), 'google (expected credential "GOOGLE_API_KEY")');
  assert.equal(field(message, "model wanted"), "gemini-2.5-flash");
  assert.equal(
    field(message, "observed"),
    'api_key="ANTHROPIC_API_KEY" models=[gemini-2.5-flash]',
  );
  assert.equal(field(message, "waited"), "20.4s over 14 read(s)");
  assert.equal(field(message, "verdict"), "credential-pending");
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

test("credential-pending does not wave the failure off as load", () => {
  // It prints only AFTER the budget expired, i.e. retrying did not help within it,
  // and a credential belonging to a THIRD provider is a real misbinding.
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
    probe: probeOf("ANTHROPIC_API_KEY", []),
  });
  assert.ok(message.includes("custom_component/update"), message);
});

test("model-pending covers BOTH the default-binding and the real-rebind case", () => {
  // The verdict is reachable two ways and they mean different things: anthropic,
  // where the credential match is free because it is the selector's default; and
  // any other provider, where the rebind DID land and only the selection has not.
  // Guidance that asserts only the first is false half the time it prints.
  const message = failure({
    verdict: "model-pending",
    provider: "anthropic",
    expectedCredential: "ANTHROPIC_API_KEY",
    expectedModel: "claude-sonnet-5",
    probe: probeOf("ANTHROPIC_API_KEY", []),
  });
  assert.ok(message.includes("DEFAULT binding"), message);
  assert.ok(
    message.includes("any other provider"),
    "must not assert the default-binding cause for a provider where it is wrong",
  );
  assert.ok(message.includes("provider setup"), message);
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
});
