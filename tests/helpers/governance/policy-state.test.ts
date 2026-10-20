import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBundleWrite,
  bundleSets,
  describeBundleSets,
  describePolicyState,
  isBundlePristine,
  isPolicyPristine,
  POLICY_BUNDLE_SETS,
  sameBundleSets,
  singleNodeFlow,
} from "./policy-state";

describe("isPolicyPristine", () => {
  it("accepts a bundle with every policy set empty", () => {
    assert.equal(
      isPolicyPristine({
        blocked_component_keys: [],
        blocked_template_keys: [],
        approved_provider_ids: [],
      }),
      true,
    );
  });

  it("accepts a bundle that omits the policy fields entirely", () => {
    // A fresh instance answers `source: migration` and the reader must not
    // treat a missing key as a configured policy — that would skip every
    // governance spec on exactly the instance they are meant to run against.
    assert.equal(isPolicyPristine({ revision: 1, source: "migration" }), true);
  });

  it("rejects a bundle carrying any one of the three policy sets", () => {
    assert.equal(
      isPolicyPristine({ blocked_component_keys: ["Agent"] }),
      false,
    );
    assert.equal(
      isPolicyPristine({ blocked_template_keys: ["basic_prompting"] }),
      false,
    );
    assert.equal(
      isPolicyPristine({ approved_provider_ids: ["openai"] }),
      false,
    );
  });
});

describe("describePolicyState", () => {
  it("names every non-empty set so the skip reason is actionable", () => {
    const reason = describePolicyState({
      blocked_component_keys: ["Agent", "ChatOutput"],
      blocked_template_keys: ["basic_prompting"],
      approved_provider_ids: ["openai"],
    });
    assert.equal(
      reason,
      "blocked components: Agent, ChatOutput; blocked templates: basic_prompting; approved providers: openai",
    );
  });

  it("reports a pristine bundle as such", () => {
    assert.equal(describePolicyState({ revision: 1 }), "pristine");
  });
});

describe("singleNodeFlow", () => {
  it("carries the component type where the policy check reads it", () => {
    // The write-path refusal is keyed on `data.nodes[].data.type`; a payload
    // that only names the component in `display_name` saves 201 and the spec
    // would report "no enforcement" against a healthy build.
    const flow = singleNodeFlow("spec flow", "CombineText");
    assert.equal(flow.data.nodes.length, 1);
    assert.equal(flow.data.nodes[0].data.type, "CombineText");
    assert.equal(flow.name, "spec flow");
  });
});

describe("bundle writes (#2299)", () => {
  const empty = () => bundleSets({});

  it("reads all six sets, an absent one as []", () => {
    const sets = bundleSets({ blocked_integration_action_keys: ["integrations.google.gmail.send"] });
    assert.deepEqual(Object.keys(sets).sort(), [...POLICY_BUNDLE_SETS].sort());
    assert.deepEqual(sets.blocked_integration_action_keys, ["integrations.google.gmail.send"]);
    assert.deepEqual(sets.blocked_component_keys, []);
  });

  it("a write carries every set it does not override, and the current revision", () => {
    // The endpoint is a full replacement: a set left out is stored as [], so a
    // write that dropped the component block would clear someone else's policy.
    const body = buildBundleWrite(
      { revision: 7, blocked_component_keys: ["Agent"], approved_provider_ids: ["openai"] },
      { blocked_integration_action_keys: ["integrations.google.gmail.send"] },
      "why",
    );
    assert.equal(body.expected_revision, 7);
    assert.equal(body.reason, "why");
    assert.deepEqual(body.blocked_component_keys, ["Agent"]);
    assert.deepEqual(body.approved_provider_ids, ["openai"]);
    assert.deepEqual(body.blocked_integration_action_keys, ["integrations.google.gmail.send"]);
    for (const name of POLICY_BUNDLE_SETS) assert.ok(Array.isArray(body[name]), name);
  });

  it("an override replaces its set rather than merging into it", () => {
    const body = buildBundleWrite(
      { revision: 1, approved_integration_provider_ids: ["google"] },
      { approved_integration_provider_ids: [] },
      "clear",
    );
    assert.deepEqual(body.approved_integration_provider_ids, []);
  });

  it("isBundlePristine reads the integration and model sets too", () => {
    assert.equal(isBundlePristine({ revision: 1 }), true);
    for (const name of POLICY_BUNDLE_SETS) {
      assert.equal(isBundlePristine({ [name]: ["x"] }), false, name);
    }
    // The older reader ignores exactly the sets this one exists for.
    assert.equal(isPolicyPristine({ blocked_integration_action_keys: ["integrations.google.gmail.send"] }), true);
  });

  it("describeBundleSets names each non-empty set", () => {
    assert.equal(describeBundleSets({}), "pristine");
    assert.equal(
      describeBundleSets({ blocked_component_keys: ["Agent"], approved_integration_provider_ids: ["microsoft"] }),
      "blocked_component_keys: Agent; approved_integration_provider_ids: microsoft",
    );
  });

  it("sameBundleSets ignores order and catches any one difference", () => {
    const a = { ...empty(), blocked_integration_action_keys: ["b", "a"] };
    const b = { ...empty(), blocked_integration_action_keys: ["a", "b"] };
    assert.equal(sameBundleSets(a, b), true);
    for (const name of POLICY_BUNDLE_SETS) {
      assert.equal(sameBundleSets(empty(), { ...empty(), [name]: ["x"] }), false, name);
    }
    assert.equal(sameBundleSets({ ...empty(), blocked_model_keys: ["a", "a"] }, { ...empty(), blocked_model_keys: ["a"] }), false);
  });
});
