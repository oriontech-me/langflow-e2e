import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describePolicyState,
  isPolicyPristine,
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
