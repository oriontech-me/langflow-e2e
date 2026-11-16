import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { APIRequestContext } from "@playwright/test";
import {
  buildBundleV2Write,
  buildBundleWrite,
  bundleSets,
  bundleV2Sets,
  describeBundleSets,
  describeBundleV2,
  describePolicyState,
  isBundlePristine,
  isBundleV2Pristine,
  isPolicyPristine,
  POLICY_BUNDLE_SETS,
  POLICY_BUNDLE_V2_LIST_SETS,
  POLICY_BUNDLE_V2_NULLABLE_SETS,
  type PolicyBundleV2Response,
  restorePolicyBundleV2,
  sameBundleSets,
  sameBundleV2Sets,
  singleNodeFlow,
  writePolicyBundleV2,
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

describe("v2 bundle (#2451)", () => {
  const pristine = () => bundleV2Sets({});

  it("reads an absent list as [] and an absent tri-state set as null", () => {
    const sets = bundleV2Sets({ revision: 1 });
    for (const name of POLICY_BUNDLE_V2_LIST_SETS) assert.deepEqual(sets[name], [], name);
    for (const name of POLICY_BUNDLE_V2_NULLABLE_SETS) assert.equal(sets[name], null, name);
  });

  it("keeps [] apart from null in a tri-state set", () => {
    // [] denies every integration or trigger kind; null is unrestricted. A reader
    // that folded one into the other would restore deny-all as "unrestricted".
    assert.deepEqual(bundleV2Sets({ approved_trigger_kinds: [] }).approved_trigger_kinds, []);
    assert.equal(bundleV2Sets({ approved_trigger_kinds: null }).approved_trigger_kinds, null);
  });

  it("isBundleV2Pristine refuses [] in a tri-state set and any populated list", () => {
    assert.equal(isBundleV2Pristine({ revision: 1, source: "migration" }), true);
    for (const name of POLICY_BUNDLE_V2_NULLABLE_SETS) {
      assert.equal(isBundleV2Pristine({ [name]: [] }), false, `${name}: []`);
      assert.equal(isBundleV2Pristine({ [name]: ["x"] }), false, `${name}: [x]`);
    }
    for (const name of POLICY_BUNDLE_V2_LIST_SETS) {
      assert.equal(isBundleV2Pristine({ [name]: ["x"] }), false, name);
    }
  });

  it("describeBundleV2 names deny-all explicitly", () => {
    assert.equal(describeBundleV2({}), "pristine");
    assert.equal(
      describeBundleV2({ approved_integration_provider_ids: [], approved_trigger_kinds: ["schedule"] }),
      "approved_integration_provider_ids: [] (denies all); approved_trigger_kinds: schedule",
    );
  });

  it("sameBundleV2Sets ignores order but never equates null with []", () => {
    const a = { ...pristine(), approved_trigger_kinds: ["schedule", "inbound_webhook"] };
    const b = { ...pristine(), approved_trigger_kinds: ["inbound_webhook", "schedule"] };
    assert.equal(sameBundleV2Sets(a, b), true);
    for (const name of POLICY_BUNDLE_V2_NULLABLE_SETS) {
      assert.equal(sameBundleV2Sets(pristine(), { ...pristine(), [name]: [] }), false, name);
    }
    for (const name of POLICY_BUNDLE_V2_LIST_SETS) {
      assert.equal(sameBundleV2Sets(pristine(), { ...pristine(), [name]: ["x"] }), false, name);
    }
  });

  it("a write carries every set, null included, and the current revision", () => {
    const body = buildBundleV2Write(
      { revision: 4, blocked_component_keys: ["Agent"], approved_integration_provider_ids: null },
      { approved_trigger_kinds: ["schedule"] },
      "why",
    );
    assert.equal(body.expected_revision, 4);
    assert.equal(body.reason, "why");
    assert.deepEqual(body.blocked_component_keys, ["Agent"]);
    assert.deepEqual(body.approved_trigger_kinds, ["schedule"]);
    // Sent as null, never omitted: v2 reads an omitted trigger facet as "keep it".
    assert.ok("approved_integration_provider_ids" in body);
    assert.equal(body.approved_integration_provider_ids, null);
  });

  /** A fake that answers GETs from `reads` in order (the last repeats) and records PUTs. */
  function fakeBundle(reads: PolicyBundleV2Response[], putStatus = 200) {
    const puts: Array<{ url: string; data: unknown }> = [];
    let i = 0;
    const answer = (status: number, body: unknown) => ({
      ok: () => status >= 200 && status < 300,
      status: () => status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    const request = {
      get: async () => answer(200, reads[Math.min(i++, reads.length - 1)]),
      put: async (url: string, o: { data: unknown }) => {
        puts.push({ url, data: o.data });
        return answer(putStatus, putStatus === 200 ? o.data : { detail: "refused" });
      },
    } as unknown as APIRequestContext;
    return { request, puts };
  }

  it("writePolicyBundleV2 sends the current sets with the override to the v2 route", async () => {
    const { request, puts } = fakeBundle([{ revision: 9, approved_trigger_kinds: null }]);
    await writePolicyBundleV2(request, "Bearer x", { approved_trigger_kinds: [] }, "deny all kinds");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].url, "/api/v2/policy-bundle");
    const data = puts[0].data as Record<string, unknown>;
    assert.equal(data.expected_revision, 9);
    assert.deepEqual(data.approved_trigger_kinds, []);
    assert.equal(data.approved_integration_provider_ids, null);
  });

  it("restorePolicyBundleV2 writes nothing when the bundle already matches", async () => {
    const { request, puts } = fakeBundle([{ revision: 3 }]);
    await restorePolicyBundleV2(request, "Bearer x", pristine());
    assert.equal(puts.length, 0);
  });

  it("restorePolicyBundleV2 puts null back over a deny-all", async () => {
    const { request, puts } = fakeBundle([{ revision: 5, approved_trigger_kinds: [] }, { revision: 6 }]);
    await restorePolicyBundleV2(request, "Bearer x", pristine());
    assert.equal(puts.length, 1);
    const data = puts[0].data as Record<string, unknown>;
    assert.equal(data.expected_revision, 5);
    assert.equal(data.approved_trigger_kinds, null);
  });

  it("restorePolicyBundleV2 throws when the bundle still differs after the write", async () => {
    const { request } = fakeBundle([{ revision: 5, approved_trigger_kinds: [] }]);
    await assert.rejects(
      restorePolicyBundleV2(request, "Bearer x", pristine()),
      /not restored: expected pristine, found approved_trigger_kinds: \[\] \(denies all\)/,
    );
  });

  it("restorePolicyBundleV2 throws naming the status when the write is refused", async () => {
    const { request } = fakeBundle([{ revision: 5, approved_trigger_kinds: [] }], 409);
    await assert.rejects(restorePolicyBundleV2(request, "Bearer x", pristine()), /answered 409/);
  });
});
