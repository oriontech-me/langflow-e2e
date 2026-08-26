import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  MASK,
  RECEIVED_LEN_PREFIX,
  SECRET_EDGE_NODE_IDS,
  createSecretEdgeFlowViaApi,
  fetchComponentCatalog,
} from "../../../helpers/flows/create-secret-edge-flow-via-api";

/**
 * A credential crossing a graph edge — upstream `langflow-ai/langflow#14216`
 * (`fix: preserve secret values across graph edges`, merged 2026-07-22, fixing
 * #14152).
 *
 * Spec doc: docs/security/credential-secret-across-edges.md
 *
 * Root cause, in the PR's words: `Component._get_output_result()` sanitized its
 * return value IN PLACE before storing it in `Output.value`, and
 * `ComponentVertex._get_result()` prefers that cache for connected edges — so a
 * downstream component received the literal mask instead of the real value.
 * Masking in `_build_results()` alone was rejected because downstream would then
 * get the real value without knowing it came from a secret input, "which can
 * expose it again in terminal flow results". So the fix carries runtime-only
 * secret metadata across the edge.
 *
 * WHY EITHER HALF ALONE IS WORTHLESS, which is why this file measures both on ONE
 * run:
 *   - masking asserted alone PASSES ON THE DEFECT. Before the fix the downstream
 *     received `**********`, so "the secret does not appear" was MORE true, not
 *     less: the value had already been destroyed.
 *   - delivery asserted alone passes on a build that masks nothing.
 *
 * `security/credential-secret-exposure.spec.ts` (#7313) covers a credential
 * reaching ONE node and none of the observable surfaces; its flow is deliberately
 * independent ROOT nodes with no edges, so this mechanism is outside it.
 *
 * No `page` fixture and therefore no allowHttpErrors()/allowFlowErrors(): every
 * call goes through the `request` fixture and the fixture's monitors are
 * `page.on("response")` listeners, which a request call never reaches.
 *
 * Serial: one credential, one flow and one run serve every assertion, and the
 * file's central claim is that the readings are SIMULTANEOUS.
 */
test.describe.configure({ mode: "serial" });

/**
 * The credential's value. 22 characters, and the length is the point: the mask is
 * ten, so a ten-character sentinel would make the real value indistinguishable
 * from what a pre-fix build delivered. Asserted below rather than trusted.
 */
const SENTINEL = `EDGE-SECRET-SENTINEL-${Date.now().toString(36)}`;

/**
 * A field name matching no sensitive-key pattern anywhere.
 *
 * #7313's defect was a NAME-based mask; the fix is type-based (`password=True`).
 * A field called `api_key` would be masked by a name check too, so a regression
 * back to name matching would hide behind it.
 */
const SECRET_FIELD = "gateway_pin";

/** One node's reading out of a `POST /api/v1/run/{id}` debug response. */
interface NodeReading {
  /** The `text` of the node's output Message, from `artifacts.output.repr`. */
  text: string;
  /** The node's whole slice, for absence assertions scoped to it. */
  raw: string;
}

test.describe("A credential crossing a graph edge is real to execution and masked on display", () => {
  let bearer: Record<string, string>;
  let apiKeyId = "";
  let variableId = "";
  let flowId = "";
  let deleteFlow: ((reqOverride?: never) => Promise<void>) | undefined;

  /** Every node's reading from the single run, keyed by node id. */
  const readings = new Map<string, NodeReading>();
  /** The whole run response, for the absence assertion that must span surfaces. */
  let runBody = "";

  test.beforeAll(async ({ request }) => {
    // The run happens HERE, once, because every test below is a reading of the
    // same response — that simultaneity is the file's claim. A broken run fails
    // here with its cause named instead of producing four confusing reds.
    expect(
      SENTINEL.length,
      "the sentinel must not be the mask's length, or the delivery assertion cannot " +
        "distinguish the real value from what a pre-fix build delivered",
    ).not.toBe(MASK.length);

    const token = await getAuthToken(request);
    bearer = { Authorization: token };

    const variableName = `cred-edge-${Date.now()}`;
    const varRes = await request.post("/api/v1/variables/", {
      headers: bearer,
      data: { name: variableName, value: SENTINEL, type: "Credential", default_fields: [] },
    });
    expect(varRes.status(), "the Credential variable is the premise of the whole file").toBe(201);
    variableId = (await varRes.json()).id as string;

    const catalog = await fetchComponentCatalog(request, bearer);
    const flow = await createSecretEdgeFlowViaApi(request, bearer, catalog, {
      secretFieldName: SECRET_FIELD,
      credentialVariableName: variableName,
    });
    flowId = flow.flowId;
    deleteFlow = flow.deleteFlow as (reqOverride?: never) => Promise<void>;

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `cred-edge-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const key = await keyRes.json();
    apiKeyId = key.id;

    // `output_type: "debug"` so every vertex reports, not just the terminal one.
    const runRes = await request.post(`/api/v1/run/${flowId}?stream=false`, {
      headers: { "x-api-key": key.api_key },
      data: { input_value: "go", input_type: "text", output_type: "debug" },
    });
    runBody = await runRes.text();
    expect(runRes.status(), `the run must succeed; body: ${runBody.slice(0, 400)}`).toBe(200);

    const parsed = JSON.parse(runBody) as {
      outputs?: Array<{ outputs?: Array<Record<string, unknown>> }>;
    };
    for (const group of parsed.outputs ?? []) {
      for (const inner of group.outputs ?? []) {
        const id = String(inner.component_id ?? "");
        const artifacts = (inner.artifacts ?? {}) as { output?: { repr?: unknown } };
        const repr = String(artifacts.output?.repr ?? "");
        let text = "";
        try {
          text = String((JSON.parse(repr) as { text?: unknown }).text ?? "");
        } catch {
          text = repr;
        }
        readings.set(id, { text, raw: JSON.stringify(inner) });
      }
    }

    // With LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false the code never runs, so this
    // fails loudly rather than letting the masking assertions pass vacuously.
    for (const id of Object.values(SECRET_EDGE_NODE_IDS)) {
      expect(
        readings.has(id),
        `node ${id} reported nothing — with LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false the ` +
          "custom code never executes and every assertion below would be vacuous",
      ).toBe(true);
    }
  });

  test.afterAll(async ({ request }) => {
    try {
      if (deleteFlow) await deleteFlow(request as never);
    } finally {
      try {
        if (apiKeyId) await request.delete(`/api/v1/api_key/${apiKeyId}`, { headers: bearer });
      } finally {
        if (variableId) {
          await request.delete(`/api/v1/variables/${variableId}`, { headers: bearer });
        }
      }
    }
  });

  test(
    "the edge delivers the real secret, not the mask",
    { tag: ["@stable", "@api", "@regression"] },
    async () => {
      // THE assertion that fails on the pre-fix build, where `Output.value` held
      // the sanitized copy the edge then read: the downstream would report
      // `received_len=10`, the mask's length.
      //
      // It is also the control that the credential resolved at all — a length is
      // impossible to produce without the real value and discloses nothing. Had
      // the variable failed to resolve, the upstream emits "" and this reads 0,
      // distinguishable from both 22 and 10.
      const measure = readings.get(SECRET_EDGE_NODE_IDS.measure);
      expect(measure?.text).toBe(`${RECEIVED_LEN_PREFIX}${SENTINEL.length}`);
    },
  );

  test(
    "the upstream's own display copy is masked on that same run",
    { tag: ["@stable", "@api", "@regression"] },
    async () => {
      // Simultaneous with the test above by construction: same run, same graph.
      // The node that emitted the real value onto the edge shows only the mask.
      const upstream = readings.get(SECRET_EDGE_NODE_IDS.upstream);
      expect(upstream?.text).toBe(MASK);
      expect(
        upstream?.raw ?? "",
        "the upstream's own slice must not carry the secret anywhere",
      ).not.toContain(SENTINEL);
    },
  );

  test(
    "a downstream that re-emits the secret is masked too",
    { tag: ["@stable", "@api", "@regression"] },
    async () => {
      // The metadata-propagation half. This node received the REAL value (its
      // sibling proves the edge delivered it) and re-emitted it — so without the
      // secret metadata riding the edge, its display copy would be the plaintext.
      // That is exactly the exposure masking in `_build_results()` alone would
      // have left open.
      const echo = readings.get(SECRET_EDGE_NODE_IDS.echo);
      expect(echo?.text).toBe(MASK);
      expect(echo?.raw ?? "").not.toContain(SENTINEL);
    },
  );

  test(
    "the secret appears nowhere in the run response",
    { tag: ["@stable", "@api", "@regression"] },
    async () => {
      // Asserted over the WHOLE payload, not one node's slice: "not in that node"
      // says nothing about the other surfaces the same run writes.
      expect(runBody).not.toContain(SENTINEL);
      // And the mask must be there — otherwise "the secret is absent" would also
      // pass on a run that produced no output at all.
      expect(runBody, "a run with no masked output proves nothing about masking").toContain(MASK);
    },
  );
});
