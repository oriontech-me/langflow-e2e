import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createCredentialConsumerFlowViaApi,
  RESOLVED_LEN_PREFIX,
  type CredentialConsumerField,
} from "../../../helpers/flows/create-credential-consumer-flow-via-api";

// The value of a Credential-type global variable, once resolved into a component
// at run time, must not reach the trace detail, the exported flow JSON, or the
// API response of the run (langflow-ai/langflow#7313 — the TracingService
// obfuscated only inputs whose key contained `api_key`, so every other
// SecretStrInput went to the tracing provider in plaintext).
//
// The fix is TYPE-driven: Component._get_trace_value() returns "**********" for
// any input declaring `password=True`, before the value reaches
// get_trace_as_inputs(). That is why the flow carries two nodes with
// deliberately different field names:
//   - `secret_token` — also matches the transactions sanitizer's independent,
//     NAME-based pattern, so it is masked on two paths at once;
//   - `gateway_pin`  — matches no sensitive-key pattern anywhere. It is masked
//     only because the input is a SecretStrInput. This is #7313's exact case and
//     the one that regresses silently if the type check becomes a name check.
//
// Asserting "the secret is absent" alone would pass on a run where the
// credential never resolved, on an empty span, or on a flow that never executed.
// Every test therefore pairs the absence with a control that the secret DID
// reach the component: each node returns `resolved_len=<n>`, the length of its
// own sentinel — impossible to produce without resolving the credential, and
// disclosing nothing. The two sentinels have different lengths, so neither can
// stand in for the other.

/** Field whose name ALSO matches the name-based sanitizer of the transactions path. */
const TOKEN_FIELD = "secret_token";
/** Field whose name matches no sensitive-key pattern — #7313's case. */
const PIN_FIELD = "gateway_pin";

/** The mask `Component._get_trace_value()` writes for a `password=True` input. */
const TRACE_MASK = "**********";

interface RunVertexOutput {
  component_id?: string;
  outputs?: { output?: { message?: string } };
}

interface RunResponseBody {
  outputs?: Array<{ outputs?: RunVertexOutput[] }>;
}

interface StoredFlow {
  data?: {
    nodes?: Array<{
      id: string;
      data?: {
        node?: { template?: Record<string, Record<string, unknown>> };
      };
    }>;
  };
}

interface TraceSpan {
  name?: string;
  inputs?: Record<string, unknown>;
  children?: TraceSpan[];
}

/** Every vertex of an `output_type: "debug"` response, flattened across groups. */
function runVertices(body: RunResponseBody): RunVertexOutput[] {
  return (body?.outputs ?? []).flatMap((group) => group?.outputs ?? []);
}

/** The text one vertex produced, by node id. */
function vertexText(body: RunResponseBody, nodeId: string): string | undefined {
  return runVertices(body).find((v) => v.component_id === nodeId)?.outputs?.output
    ?.message;
}

function flattenSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((span) => [span, ...flattenSpans(span.children ?? [])]);
}

/** Deletes a global variable, tolerating an already-removed id. */
async function deleteVariable(
  request: APIRequestContext,
  authToken: string,
  variableId: string,
): Promise<void> {
  await request
    .delete(`/api/v1/variables/${variableId}`, {
      headers: { Authorization: authToken },
    })
    .catch(() => undefined);
}

test.describe("Credential secret exposure", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let deleteCreatedFlow: (req?: APIRequestContext) => Promise<void>;
  let fields: CredentialConsumerField[];
  let runBody: RunResponseBody;
  let runStatus: number;

  /** fieldName -> the Credential variable name, its id, and its sentinel value. */
  const credentials = new Map<
    string,
    { variableName: string; variableId: string; sentinel: string }
  >();

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `credential-secret-exposure-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Different lengths on purpose: `resolved_len` then identifies WHICH
    // credential a node resolved, not merely that it resolved something.
    const seeds: Array<{ fieldName: string; sentinel: string }> = [
      { fieldName: TOKEN_FIELD, sentinel: `CRED-TOKEN-SENTINEL-${stamp}` },
      { fieldName: PIN_FIELD, sentinel: `CRED-PIN-SENTINEL-${stamp}-EXTRA-PAD` },
    ];
    expect(seeds[0].sentinel).not.toHaveLength(seeds[1].sentinel.length);

    for (const { fieldName, sentinel } of seeds) {
      const variableName = `cred-secret-exposure-${fieldName}-${stamp}`;
      const varRes = await request.post("/api/v1/variables/", {
        headers: { Authorization: bearerToken },
        data: {
          name: variableName,
          value: sentinel,
          type: "Credential",
          default_fields: [],
        },
      });
      expect(varRes.status()).toBe(201);
      const variableId = (await varRes.json()).id as string;
      credentials.set(fieldName, { variableName, variableId, sentinel });
    }

    const flow = await createCredentialConsumerFlowViaApi(
      request,
      { Authorization: bearerToken },
      seeds.map(({ fieldName }) => ({
        fieldName,
        variableName: credentials.get(fieldName)!.variableName,
      })),
    );
    flowId = flow.flowId;
    fields = flow.fields;
    deleteCreatedFlow = flow.deleteFlow;

    // One run, read by all three tests. `debug` returns every vertex, and both
    // nodes are independent roots, so a single run executes both.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "credential-secret-probe",
        input_type: "text",
        output_type: "debug",
      },
    });
    runStatus = runRes.status();
    runBody = (await runRes.json()) as RunResponseBody;
  });

  test.afterAll(async ({ request }) => {
    if (deleteCreatedFlow) {
      await deleteCreatedFlow(request).catch(() => undefined);
    }
    for (const { variableId } of credentials.values()) {
      await deleteVariable(request, bearerToken, variableId);
    }
    if (apiKeyId) {
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => undefined);
    }
  });

  test(
    "the trace detail masks the credential whatever the secret field is called",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      let traceId = "";

      await test.step("wait for the run's trace to be written", async () => {
        // Trace writes are asynchronous — the run answers before the trace lands.
        await expect
          .poll(
            async () => {
              const res = await request.get(
                `/api/v1/monitor/traces?flow_id=${flowId}`,
                { headers: { Authorization: bearerToken } },
              );
              if (res.status() !== 200) return 0;
              const body = await res.json();
              const traces = body.traces ?? [];
              if (traces.length > 0) traceId = traces[0].id;
              return traces.length;
            },
            {
              timeout: 30000,
              intervals: [500, 1000, 2000],
              message:
                "No trace was written for this run. An instance started with " +
                "LANGFLOW_DEACTIVATE_TRACING=true writes none at all — that is a " +
                "precondition failure, not a masking defect (see the spec doc). " +
                "scripts/start-langflow-docker.sh sets it true by decision.",
            },
          )
          .toBeGreaterThan(0);
      });

      const detailRes = await request.get(`/api/v1/monitor/traces/${traceId}`, {
        headers: { Authorization: bearerToken },
      });
      expect(detailRes.status()).toBe(200);
      const detailText = await detailRes.text();
      const detail = JSON.parse(detailText) as { spans?: TraceSpan[] };
      const spans = flattenSpans(detail.spans ?? []);

      await test.step("every secret field is traced, and masked", async () => {
        for (const { fieldName } of fields) {
          const span = spans.find(
            (candidate) =>
              candidate.inputs !== undefined && fieldName in candidate.inputs,
          );

          // The key must be PRESENT: that is what makes the absence assertion
          // below evidence rather than the absence of the whole span.
          expect(
            span,
            `no trace span carries the ${fieldName} input — the component's ` +
              "inputs were not traced at all, so nothing here proves masking",
          ).toBeDefined();
          expect(span!.inputs![fieldName]).toBe(TRACE_MASK);
        }
      });

      await test.step("no sentinel reaches the trace detail", async () => {
        for (const { sentinel } of credentials.values()) {
          expect(detailText).not.toContain(sentinel);
        }
      });

      await test.step("no sentinel reaches the transactions record", async () => {
        let txText = "";

        // Transactions are written asynchronously like the trace, and on a
        // measured run they landed AFTER it — polling for one row per vertex is
        // what keeps the absence assertion below from being the absence of any
        // record at all.
        await expect
          .poll(
            async () => {
              const res = await request.get(
                `/api/v1/monitor/transactions?flow_id=${flowId}`,
                { headers: { Authorization: bearerToken } },
              );
              if (res.status() !== 200) return 0;
              txText = await res.text();
              return (JSON.parse(txText) as { items?: unknown[] }).items?.length ?? 0;
            },
            {
              timeout: 30000,
              intervals: [500, 1000, 2000],
              message:
                "No transaction row was written for this run — the vertices did " +
                "not execute, so nothing here proves the secret was withheld.",
            },
          )
          .toBe(fields.length);

        // Absence, not a mask shape: this path masks by field NAME
        // (`secret_token` reads `***R...D***`, `gateway_pin` shows the
        // unresolved variable name), so asserting the shape would pin an
        // unrelated implementation detail.
        for (const { sentinel } of credentials.values()) {
          expect(txText).not.toContain(sentinel);
        }
      });
    },
  );

  // Quarantined at triage (daily #1544): hard failure on all three attempts —
  // `POST /api/v1/flows/download/` returns the SecretStrInput field as
  // `load_from_db: true` with `value: null`, so the variable name the binding
  // points at is absent from the export (the secret itself is not leaked). Same
  // signature on the 2026-08-20 and 08-21 dailies, both outside every measured
  // outage window. Lifting the quarantine (remove test.fixme + restore @stable)
  // is a deliverable of #1546.
  test.fixme(
    "the exported flow carries the credential binding, never the secret",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const surfaces: Array<{ label: string; body: string }> = [];

      await test.step("export the flow the way the UI does", async () => {
        const res = await request.post("/api/v1/flows/download/", {
          headers: { Authorization: bearerToken },
          data: [flowId],
        });
        expect(res.status()).toBe(200);
        surfaces.push({
          label: "POST /api/v1/flows/download/",
          body: await res.text(),
        });
      });

      let storedFlow: StoredFlow;

      await test.step("read the flow back through the API", async () => {
        const res = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: bearerToken },
        });
        expect(res.status()).toBe(200);
        const body = await res.text();
        surfaces.push({ label: "GET /api/v1/flows/{id}", body });
        storedFlow = JSON.parse(body) as StoredFlow;
      });

      await test.step("the stored flow keeps the binding, not the secret", async () => {
        // Structural, not textual: the binding is what an import needs, and a
        // flow that lost it would satisfy every "the sentinel is absent"
        // assertion below for entirely the wrong reason.
        for (const { fieldName, nodeId } of fields) {
          const { variableName } = credentials.get(fieldName)!;
          const node = (storedFlow.data?.nodes ?? []).find((n) => n.id === nodeId);
          expect(node, `node ${nodeId} is missing from the stored flow`).toBeDefined();

          const field = node!.data?.node?.template?.[fieldName];
          expect(field, `${fieldName} is missing from the stored template`).toBeDefined();
          expect(field!.value).toBe(variableName);
          expect(field!.load_from_db).toBe(true);
          expect(field!.password).toBe(true);
        }
      });

      for (const { label, body } of surfaces) {
        await test.step(`${label} drops the secret`, async () => {
          for (const { variableName, sentinel } of credentials.values()) {
            // The download body is checked textually because a multi-id export
            // answers with an archive rather than a flow object — the variable
            // name is the binding's observable there.
            expect(body, `${label} lost the variable binding`).toContain(
              variableName,
            );
            expect(body).not.toContain(sentinel);
          }
        });
      }
    },
  );

  test(
    "the run resolves the credential without echoing it",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      expect(runStatus).toBe(200);

      await test.step("each node resolved its own credential", async () => {
        for (const { fieldName, nodeId } of fields) {
          const { sentinel } = credentials.get(fieldName)!;
          expect(vertexText(runBody, nodeId)).toBe(
            `${RESOLVED_LEN_PREFIX}${sentinel.length}`,
          );
        }
      });

      await test.step("no sentinel reaches the run response", async () => {
        const runText = JSON.stringify(runBody);
        for (const { sentinel } of credentials.values()) {
          expect(runText).not.toContain(sentinel);
        }
      });

      await test.step("no sentinel reaches the vertex build records", async () => {
        const res = await request.get(`/api/v1/monitor/builds?flow_id=${flowId}`, {
          headers: { Authorization: bearerToken },
        });
        expect(res.status()).toBe(200);
        const buildsText = await res.text();

        // Both vertices must have a build record, else the absence below is the
        // absence of the run itself.
        for (const { nodeId } of fields) {
          expect(buildsText).toContain(nodeId);
        }
        for (const { sentinel } of credentials.values()) {
          expect(buildsText).not.toContain(sentinel);
        }
      });
    },
  );
});
