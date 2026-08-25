// Unit tests for the provider-model flow builder.
// Run with: npm run test:units
//
// The builder wires a base URL into a model-provider component so an SSRF spec
// can ask what the policy does with it. Every failure mode here is a spec that
// asserts the guard's verdict on a URL it never actually set — green, and about
// nothing. So the tests assert the wiring, and assert that each way of losing it
// THROWS naming the cause rather than producing a plausible flow.
//
// Pure function only: no catalog fetch, no network, no clock. The fixture is a
// hand-built catalog shaped like `GET /api/v1/all` (`category -> {type: template}`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_MODEL,
  OPENAI_MODEL,
  buildProviderModelFlowData,
} from "./create-provider-model-flow-via-api";

/** A catalog carrying both components under test, shaped like GET /api/v1/all. */
function catalogFixture(): Record<string, unknown> {
  return {
    openai: {
      [OPENAI_MODEL.componentType]: {
        display_name: "OpenAI",
        template: {
          openai_api_base: { type: "str", value: "" },
          api_key: { type: "str", value: "OPENAI_API_KEY", load_from_db: true },
          input_value: { type: "str", value: "" },
          model_name: { type: "str", value: "gpt-4o-mini" },
        },
      },
    },
    anthropic: {
      [ANTHROPIC_MODEL.componentType]: {
        display_name: "Anthropic",
        template: {
          base_url: { type: "str", value: "https://api.anthropic.com" },
          api_key: { type: "str", value: "ANTHROPIC_API_KEY", load_from_db: true },
          input_value: { type: "str", value: "" },
        },
      },
    },
    // A metadata map, not a category — the catalog carries one and its values are
    // not templates. Walking it as a category is how a lookup finds nothing.
    component_display_names: { "ext:openai:openaimodelcomponent@official": "OpenAI" },
  };
}

function nodeTemplate(data: ReturnType<typeof buildProviderModelFlowData>) {
  return data.nodes[0].data.node.template;
}

test("the base URL lands on the field that component actually uses", () => {
  // The two components name the field differently — openai_api_base vs base_url
  // — which is the whole reason #14704 existed. Writing to the wrong one leaves
  // the component running its DEFAULT url.
  const openai = buildProviderModelFlowData(catalogFixture(), {
    provider: OPENAI_MODEL,
    nodeId: "n1",
    baseUrl: "http://169.254.169.254/v1",
  });
  assert.equal(nodeTemplate(openai).openai_api_base.value, "http://169.254.169.254/v1");

  const anthropic = buildProviderModelFlowData(catalogFixture(), {
    provider: ANTHROPIC_MODEL,
    nodeId: "n1",
    baseUrl: "http://169.254.169.254/v1",
  });
  assert.equal(nodeTemplate(anthropic).base_url.value, "http://169.254.169.254/v1");
});

test("an empty base URL is written through, because empty IS the skip path", () => {
  // Not a no-op: `_is_provider_default` treats empty as "use the provider
  // default" and skips the policy. A builder that dropped an empty value would
  // leave whatever the template shipped — for Anthropic, the canonical endpoint,
  // which happens to skip too, so the bug would hide.
  const data = buildProviderModelFlowData(catalogFixture(), {
    provider: ANTHROPIC_MODEL,
    nodeId: "n1",
    baseUrl: "",
  });
  assert.equal(nodeTemplate(data).base_url.value, "");
});

test("the api key is a literal, with load_from_db turned OFF", () => {
  // The template ships the NAME of a global variable and load_from_db true. Left
  // alone, the run fails resolving a credential that does not exist — an error
  // that is not the guard's, on a spec whose whole claim is which error appears.
  const data = buildProviderModelFlowData(catalogFixture(), {
    provider: OPENAI_MODEL,
    nodeId: "n1",
    baseUrl: "http://127.0.0.1/v1",
  });
  const key = nodeTemplate(data).api_key;
  assert.equal(key.value, OPENAI_MODEL.dummyApiKey);
  assert.equal(key.load_from_db, false);
});

test("the dummy key is shaped like the provider's own, but is not a credential", () => {
  // Shape matters: the control assertion is that the provider ITSELF refuses the
  // key, and a provider rejects a malformed key before authenticating it, which
  // would produce a different message.
  assert.match(OPENAI_MODEL.dummyApiKey, /^sk-/);
  assert.match(ANTHROPIC_MODEL.dummyApiKey, /^sk-ant-/);
  for (const p of [OPENAI_MODEL, ANTHROPIC_MODEL]) {
    assert.match(p.dummyApiKey, /dummy|invalid|not-a-real/i, `${p.label} key must read as fake`);
  }
});

test("the input value reaches the component, so the run has something to do", () => {
  const data = buildProviderModelFlowData(catalogFixture(), {
    provider: OPENAI_MODEL,
    nodeId: "n1",
    baseUrl: "",
    inputValue: "ping",
  });
  assert.equal(nodeTemplate(data).input_value.value, "ping");
});

test("the node is a single root with no edges", () => {
  // The provider model components accept input_value directly and run as a graph
  // root. A second node would only add a surface that can fail for reasons
  // unrelated to the guard.
  const data = buildProviderModelFlowData(catalogFixture(), {
    provider: OPENAI_MODEL,
    nodeId: "provider-node-1",
    baseUrl: "",
  });
  assert.equal(data.nodes.length, 1);
  assert.deepEqual(data.edges, []);
  assert.equal(data.nodes[0].id, "provider-node-1");
  assert.equal(data.nodes[0].data.id, "provider-node-1");
  assert.equal(data.nodes[0].data.type, OPENAI_MODEL.componentType);
});

test("two builds from one catalog do not share mutated state", () => {
  // The spec fetches the catalog once and builds six flows from it. Without a
  // deep copy the second build inherits the first one's URL, and every test after
  // the first asserts the wrong address — silently, since the values are all
  // plausible.
  const catalog = catalogFixture();
  const first = buildProviderModelFlowData(catalog, {
    provider: OPENAI_MODEL,
    nodeId: "n1",
    baseUrl: "http://127.0.0.1/v1",
  });
  const second = buildProviderModelFlowData(catalog, {
    provider: OPENAI_MODEL,
    nodeId: "n2",
    baseUrl: "",
  });
  assert.equal(nodeTemplate(first).openai_api_base.value, "http://127.0.0.1/v1");
  assert.equal(nodeTemplate(second).openai_api_base.value, "");
});

test("a component the image does not ship throws, naming it", () => {
  // A vendor distribution can be absent per image
  // (docs/component-distribution-policy.md). An undefined template reaching
  // POST /api/v1/flows/ surfaces as an unattributable 422.
  assert.throws(
    () =>
      buildProviderModelFlowData(
        { openai: {} },
        { provider: OPENAI_MODEL, nodeId: "n1", baseUrl: "" },
      ),
    (e: Error) =>
      e.message.includes(OPENAI_MODEL.componentType) &&
      /component-distribution-policy/.test(e.message),
  );
});

test("a renamed base-URL field throws instead of running the component's default", () => {
  // The failure this guards is the quiet one: without it the node keeps the
  // template's own base URL, the policy skips it, and every refusal test reports
  // "admitted" against a URL the spec never set.
  const catalog = catalogFixture();
  const openai = (catalog.openai as Record<string, { template: Record<string, unknown> }>)[
    OPENAI_MODEL.componentType
  ];
  delete openai.template.openai_api_base;
  openai.template.api_base = { type: "str", value: "" };

  assert.throws(
    () =>
      buildProviderModelFlowData(catalog, { provider: OPENAI_MODEL, nodeId: "n1", baseUrl: "" }),
    (e: Error) =>
      e.message.includes(OPENAI_MODEL.baseUrlField) && e.message.includes("api_base"),
  );
});

test("a missing api_key field throws too", () => {
  // Without it the run fails on a required field rather than on the guard.
  const catalog = catalogFixture();
  const openai = (catalog.openai as Record<string, { template: Record<string, unknown> }>)[
    OPENAI_MODEL.componentType
  ];
  delete openai.template.api_key;
  assert.throws(
    () =>
      buildProviderModelFlowData(catalog, { provider: OPENAI_MODEL, nodeId: "n1", baseUrl: "" }),
    /api_key/,
  );
});

test("each provider declares its own refusal wording, and they differ", () => {
  // The skip-path control asserts the PROVIDER refused the dummy key. Sharing one
  // fragment across providers would make that assertion pass on whichever
  // provider happened to answer, so a component that stopped calling out
  // altogether could still look controlled.
  assert.notEqual(OPENAI_MODEL.authRefusalFragment, ANTHROPIC_MODEL.authRefusalFragment);
  for (const p of [OPENAI_MODEL, ANTHROPIC_MODEL]) {
    assert.ok(p.authRefusalFragment.length > 8, `${p.label} fragment is too short to discriminate`);
    // Must not be the SSRF marker: the control's whole point is that this string
    // appears where the SSRF one does not.
    assert.ok(!p.authRefusalFragment.includes("SSRF"), `${p.label} fragment collides with the marker`);
  }
});

test("the two providers declare different canonical endpoints", () => {
  // The canonical endpoint is the OTHER value `_is_provider_default` skips, and
  // it is per provider. One shared constant would test the skip path of one
  // component against the other's endpoint — a validated, admitted public URL,
  // which passes for the wrong reason.
  assert.notEqual(OPENAI_MODEL.canonicalBaseUrl, ANTHROPIC_MODEL.canonicalBaseUrl);
  assert.match(OPENAI_MODEL.canonicalBaseUrl, /openai\.com/);
  assert.match(ANTHROPIC_MODEL.canonicalBaseUrl, /anthropic\.com/);
});
