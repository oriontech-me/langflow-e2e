// Unit tests for buildApiRequestFlowData (#1391).
// Run with: npm run test:units
//
// The helper's network half needs a live instance; its load-bearing half is pure:
// turning a live `GET /api/v1/all` catalog into a single-node API Request flow
// whose `url_input` is the URL the caller chose. Three properties there cannot be
// seen from a green spec.
//
// (1) The URL really lands on the node. `security/ssrf-url-validation.spec.ts`
// asserts what Langflow's SSRF guard does with a specific address. If the value
// did not reach `template.url_input`, the component would fetch its own DEFAULT
// url — and the loopback tests would still "pass" (any default is likely
// unreachable too), asserting a verdict about an address the test never chose.
//
// (2) A renamed field fails LOUDLY. `url_input`/`method` are exactly what an
// upstream refactor renames. Silently building a node without them is the same
// false-green as (1), so the helper throws naming the field and the fields it did
// find.
//
// (3) The CATALOG LOOKUP. If the component is not in the image, the helper must
// fail naming it — an undefined template would otherwise reach
// `POST /api/v1/flows/` and surface as an unattributable 422 (#1012's rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_REQUEST_COMPONENT_TYPE,
  buildApiRequestFlowData,
} from "./create-api-request-flow-via-api";

/** A minimal stand-in for the catalog entry the helper reads. */
function fakeCatalog(apiRequest?: unknown): Record<string, unknown> {
  const entry =
    apiRequest === undefined
      ? {
          display_name: "API Request",
          template: {
            code: { type: "code", value: "class APIRequestComponent: ..." },
            url_input: { type: "str", value: "" },
            curl_input: { type: "str", value: "" },
            method: { type: "str", value: "GET" },
          },
        }
      : apiRequest;

  const catalog: Record<string, Record<string, unknown>> = {
    input_output: {},
    data_source: {},
  };
  if (entry !== null) {
    catalog.data_source[API_REQUEST_COMPONENT_TYPE] = entry;
  }
  return catalog;
}

test("the caller's URL lands on the node's url_input", () => {
  const data = buildApiRequestFlowData(fakeCatalog(), {
    nodeId: "APIRequest-1",
    url: "http://127.0.0.1:7860/api/v1/version",
  });

  assert.equal(data.nodes.length, 1);
  const node = data.nodes[0];
  assert.equal(node.id, "APIRequest-1");
  assert.equal(node.data.id, "APIRequest-1");
  assert.equal(node.data.type, API_REQUEST_COMPONENT_TYPE);
  assert.equal(
    node.data.node.template.url_input.value,
    "http://127.0.0.1:7860/api/v1/version",
  );
  // The default GET must be explicit on the node, not inherited by luck.
  assert.equal(node.data.node.template.method.value, "GET");
  // A single root node: no edge is needed for it to run, and a second node would
  // only add a surface that can fail for reasons unrelated to the guard.
  assert.deepEqual(data.edges, []);
});

test("the method is overridable and keeps the field's other keys", () => {
  const data = buildApiRequestFlowData(fakeCatalog(), {
    nodeId: "APIRequest-2",
    url: "http://169.254.169.254/latest/meta-data/",
    method: "POST",
  });

  const template = data.nodes[0].data.node.template;
  assert.equal(template.method.value, "POST");
  // Spreading, not replacing: the template field carries `type` and display
  // metadata the backend validates against.
  assert.equal(template.method.type, "str");
  assert.equal(template.url_input.type, "str");
});

test("the catalog is deep-copied, so two flows do not share one template", () => {
  const catalog = fakeCatalog();

  const first = buildApiRequestFlowData(catalog, {
    nodeId: "APIRequest-a",
    url: "http://127.0.0.1:7860/x",
  });
  const second = buildApiRequestFlowData(catalog, {
    nodeId: "APIRequest-b",
    url: "http://10.0.0.1/y",
  });

  assert.equal(
    first.nodes[0].data.node.template.url_input.value,
    "http://127.0.0.1:7860/x",
  );
  assert.equal(
    second.nodes[0].data.node.template.url_input.value,
    "http://10.0.0.1/y",
  );
  // And the source catalog is untouched, so a caller that fetches it once and
  // builds N flows gets N independent payloads.
  const source = (catalog.data_source as Record<string, any>)[
    API_REQUEST_COMPONENT_TYPE
  ];
  assert.equal(source.template.url_input.value, "");
});

test("a renamed url field throws naming it and the fields that exist", () => {
  const renamed = {
    display_name: "API Request",
    template: {
      code: { type: "code", value: "class APIRequestComponent: ..." },
      // upstream renamed url_input -> url
      url: { type: "str", value: "" },
      method: { type: "str", value: "GET" },
    },
  };

  assert.throws(
    () =>
      buildApiRequestFlowData(fakeCatalog(renamed), {
        nodeId: "APIRequest-3",
        url: "http://127.0.0.1:7860/x",
      }),
    (error: Error) =>
      /url_input/.test(error.message) &&
      /renamed/.test(error.message) &&
      // the fields it DID find, so the reader can see the new spelling
      /method/.test(error.message),
  );
});

test("a missing method field throws too", () => {
  const noMethod = {
    display_name: "API Request",
    template: {
      url_input: { type: "str", value: "" },
    },
  };

  assert.throws(
    () =>
      buildApiRequestFlowData(fakeCatalog(noMethod), {
        nodeId: "APIRequest-4",
        url: "http://127.0.0.1:7860/x",
      }),
    /"method" field/,
  );
});

test("an absent component throws naming it, not a TypeError", () => {
  assert.throws(
    () =>
      buildApiRequestFlowData(fakeCatalog(null), {
        nodeId: "APIRequest-5",
        url: "http://127.0.0.1:7860/x",
      }),
    (error: Error) =>
      error.message.includes(API_REQUEST_COMPONENT_TYPE) &&
      /GET \/api\/v1\/all/.test(error.message) &&
      /component-distribution-policy/.test(error.message),
  );
});

test("a non-catalog body (an auth failure) throws the same way", () => {
  assert.throws(
    () =>
      buildApiRequestFlowData({ detail: "Not authenticated" }, {
        nodeId: "APIRequest-6",
        url: "http://127.0.0.1:7860/x",
      }),
    (error: Error) => error.message.includes(API_REQUEST_COMPONENT_TYPE),
  );
});
