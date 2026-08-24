import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createPythonInterpreterFlowViaApi } from "../../../helpers/flows/create-python-interpreter-flow-via-api";
import {
  createRunnableChatFlowViaApi,
  RUNNABLE_CHAT_FLOW_CHAT_INPUT_DISPLAY_NAME,
  RUNNABLE_CHAT_FLOW_DEFAULT_INPUT,
} from "../../../helpers/flows/create-runnable-chat-flow-via-api";

// A tweak value sent to POST /api/v1/run/{flow_id} must not reach a template
// field as executable input (langflow-ai/langflow#9319, fixed upstream; #8672 is
// the interpolation request that defines the other side of the same boundary).
//
// The refusal is LOUD since langflow-ai/langflow#14538, on release-1.12.0 — the
// line the nightly is cut from. It used to be SILENT by design: apply_tweaks()
// logged a warning, skipped the field, and the run still answered 200 with the
// author's value. There was no error to assert on, so this file originally paired
// every refusal with a benign tweak INSIDE the same request — the only control
// available then, since a spec asserting only "the sentinel is absent" passes
// just as well when the tweaks mechanism is dead altogether. Two things changed,
// and both make the assertions stronger rather than weaker:
//
//   - a refused tweak raises TweakRefusedError, which an app-level handler maps
//     to 422 carrying { detail: { error, code: "TWEAKS_REFUSED", message,
//     fields: [...] } } — the refusal is now observed directly instead of being
//     inferred from an absence; and
//   - process_tweaks() decides before it mutates ("a refusal must leave the
//     payload untouched"), so ONE protected field refuses the WHOLE request:
//     nothing runs, and a benign tweak sent alongside it does not apply. The
//     paired control therefore moved to a SECOND request — Test 2 for flow A,
//     Test 3's last step for flow B — which is the same control plus new
//     assertions that the refused request left the flow untouched at run time
//     AND in the database.
//
// detail.message is deliberately NOT asserted: _refusal_reason() returns a
// different string under LANGFLOW_TWEAKS_POLICY=off ("This deployment does not
// accept tweaks."), so pinning it would fail a correctly-behaving instance that
// is merely configured differently. code and fields are stable in every mode.
// NOTE the narrower claim: `declared` does NOT change the string, and does not
// refuse this file's benign tweaks either — is_tweak_refused_by_policy() only
// bites under `declared` when the flow declares an api_editable field, and
// neither fixture flow declares one, so `declared` is byte-identical to
// `permissive` here. Only `off` is a real divergence.
//
// The policy modes and the per-flow api_editable allowlist are out of scope
// here (#1567). The graph-path floor is no longer a gap: it is covered by the
// sibling security/tweaks-graph-path-floor.spec.ts (#1567 / PR #1571).
//
// Two protection routes exist and fail independently:
//   - by field type / name — `code` (Tests 1 and 2), and
//   - by component + field name — an executable field that serializes as a plain
//     `str` on a CODE_EXECUTION_COMPONENT_TYPES node (Test 3). That is the exact
//     bypass which made the first, name-only fix insufficient.

// Flow A's Chat Input, addressable by node id and by display name — apply_tweaks
// accepts both, so both are exercised on the refusal AND on the control.
const CHAT_INPUT_NODE_ID = "ChatInput-b6UCc";
const CHAT_INPUT_DISPLAY_NAME = RUNNABLE_CHAT_FLOW_CHAT_INPUT_DISPLAY_NAME;

/**
 * A syntactically valid ChatInput whose `message_response()` ignores the stored
 * input and returns `sentinel`. If the `code` tweak were honoured, the flow's
 * Chat Output would echo that string and nothing else — which is what makes the
 * assertion "the output is still the author's value" meaningful.
 */
function maliciousChatInputCode(sentinel: string): string {
  return `from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message


class ChatInput(Component):
    display_name = "Chat Input"
    description = "Get chat inputs from the Playground."
    icon = "MessagesSquare"
    name = "ChatInput"

    inputs = [
        MessageTextInput(name="input_value", display_name="Text", value=""),
    ]
    outputs = [
        Output(display_name="Message", name="message", method="message_response"),
    ]

    def message_response(self) -> Message:
        return Message(text="${sentinel}")
`;
}

/** Minimal shape of the run response needed by the assertions below. */
interface RunVertexOutput {
  component_id?: string;
  results?: { message?: { text?: string; sender_name?: string } };
  outputs?: { results?: { message?: { result?: string } } };
  logs?: { results?: Array<{ message?: string }> };
}

interface RunResponseBody {
  outputs?: Array<{ outputs?: RunVertexOutput[] }>;
}

/** Chat Output's echoed text (the `output_type: "chat"` shape). */
function getOutputText(body: RunResponseBody): string | undefined {
  return body?.outputs?.[0]?.outputs?.[0]?.results?.message?.text;
}

/** One vertex of an `output_type: "debug"` response, by node id. */
function getVertex(
  body: RunResponseBody,
  componentId: string,
): RunVertexOutput | undefined {
  return body?.outputs?.[0]?.outputs?.find((v) => v.component_id === componentId);
}

/** The 422 body a refused tweak answers with (TweakRefusedError -> app handler). */
interface RefusalBody {
  detail?: {
    error?: string;
    code?: string;
    message?: string;
    fields?: string[];
  };
}

/**
 * Asserts the full shape of a refusal and returns the body for further checks.
 *
 * `expectedFields` is compared with `toEqual`, not `toContain`: the point of the
 * loud refusal is that the caller learns EVERY key that was refused, so a
 * response naming only the first one is a defect this must catch. The backend
 * emits `sorted(set(refused))`, so the expectation is written sorted rather than
 * in the order the request sent the keys.
 *
 * `detail.message` is read but never asserted — it is policy-dependent (see the
 * header comment). `detail.error` and `detail.code` are handler constants.
 */
async function expectTweakRefusal(
  res: APIResponse,
  expectedFields: string[],
): Promise<RefusalBody> {
  expect(res.status()).toBe(422);
  const body: RefusalBody = await res.json();
  expect(body?.detail?.error).toBe("Refused tweaks");
  expect(body?.detail?.code).toBe("TWEAKS_REFUSED");
  expect(body?.detail?.fields).toEqual(expectedFields);
  return body;
}

test.describe("Tweaks injection — POST /api/v1/run refuses executable fields", () => {
  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;

  // Flow A — Chat Input -> Chat Output passthrough (stored input "Hello").
  let chatFlowId: string;
  let deleteChatFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Flow B — Python Interpreter -> Chat Output, built from the live catalog.
  let pythonFlowId: string;
  let pythonNodeId: string;
  let chatOutputNodeId: string;
  let authorMark: string;
  let deletePythonFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // The run endpoint authenticates with x-api-key, not Bearer.
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `tweaks-injection-key-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    const chatFlow = await createRunnableChatFlowViaApi(request, {
      Authorization: bearerToken,
    });
    chatFlowId = chatFlow.flowId;
    deleteChatFlow = chatFlow.deleteFlow;

    authorMark = `AUTHOR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const pythonFlow = await createPythonInterpreterFlowViaApi(
      request,
      { Authorization: bearerToken },
      { authorCode: `print("${authorMark}")` },
    );
    pythonFlowId = pythonFlow.flowId;
    pythonNodeId = pythonFlow.pythonNodeId;
    chatOutputNodeId = pythonFlow.chatOutputNodeId;
    deletePythonFlow = pythonFlow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Both flows are deleted id-scoped, and a failure in one must not skip the
    // rest of the teardown. `afterAll` uses its OWN request — the beforeAll one
    // cannot be reused (Playwright fixture-scope rule).
    try {
      if (deleteChatFlow) await deleteChatFlow(request);
    } finally {
      try {
        if (deletePythonFlow) await deletePythonFlow(request);
      } finally {
        if (apiKeyId) {
          await request
            .delete(`/api/v1/api_key/${apiKeyId}`, {
              headers: { Authorization: bearerToken },
            })
            .catch(() => {});
        }
      }
    }
  });

  test(
    "a code tweak is refused with a 422 naming the field, and the flow is left untouched",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const sentinel = `PWNED-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const code = maliciousChatInputCode(sentinel);

      // Both addressing modes apply_tweaks accepts. A refusal that fires for
      // only one of them is the bypass shape this loop exists to catch, so the
      // refused-key assertion runs identically for each.
      for (const [label, tweakKey] of [
        ["node id", CHAT_INPUT_NODE_ID],
        ["display name", CHAT_INPUT_DISPLAY_NAME],
      ] as const) {
        await test.step(`the code tweak is refused when keyed by ${label}`, async () => {
          const res = await request.post(`/api/v1/run/${chatFlowId}`, {
            headers: { "x-api-key": apiKey },
            data: {
              input_type: "chat",
              output_type: "chat",
              tweaks: { [tweakKey]: { code } },
            },
          });

          // No sentinel assertion on the refusal body: once the status is 422
          // the body is handler constants plus refused KEY names, so a fresh
          // `PWNED-<ts>` value can never appear in it and the check could not
          // fail. The sentinel is asserted on the two responses below, which do
          // execute — a dead assertion here would only pad the evidence.
          await expectTweakRefusal(res, ["code"]);
        });
      }

      await test.step("the flow is still runnable and still the author's", async () => {
        // Deliberately NOT called an assertion of "decide first, mutate second":
        // a tweak-free run never reaches process_tweaks at all (simple_run_flow
        // skips it and may serve a pre-built graph), so it cannot exercise that
        // ordering. What it does establish is the control the old silent
        // contract could keep inside the refused request — a 200 carrying the
        // author's value proves the endpoint is healthy and the two 422s above
        // were the refusal, not a malformed request — plus that the run path
        // still produces the author's output after one.
        const res = await request.post(`/api/v1/run/${chatFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: { input_type: "chat", output_type: "chat" },
        });

        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(getOutputText(body)).toBe(RUNNABLE_CHAT_FLOW_DEFAULT_INPUT);
        expect(JSON.stringify(body)).not.toContain(sentinel);
      });

      await test.step("the refused tweak left no trace on the stored flow", async () => {
        const res = await request.get(`/api/v1/flows/${chatFlowId}`, {
          headers: { Authorization: bearerToken },
        });
        expect(res.status()).toBe(200);
        const flow = await res.json();
        // The node and the field are asserted PRESENT before their value is
        // compared. With a `?? ""` fallback the step passed on a lookup miss —
        // a fixture node-id change or a reshaped `data.nodes` silently retired
        // the assertion, which is the "unevaluated is unknown, not clean" trap.
        const chatInputNode = flow?.data?.nodes?.find(
          (n: { id?: string }) => n.id === CHAT_INPUT_NODE_ID,
        );
        expect(chatInputNode, `node ${CHAT_INPUT_NODE_ID} not found on the stored flow`).toBeTruthy();
        const storedCode = chatInputNode?.data?.node?.template?.code?.value;
        expect(typeof storedCode).toBe("string");
        expect(storedCode).not.toContain(sentinel);
      });
    },
  );

  test(
    "the refusal is field-scoped: an unprotected field on the same node still applies",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The control that makes the test above evidence rather than a tautology:
      // same flow, same node, same addressing modes, same request shape — only
      // the targeted field differs.
      for (const [label, tweakKey] of [
        ["node id", CHAT_INPUT_NODE_ID],
        ["display name", CHAT_INPUT_DISPLAY_NAME],
      ] as const) {
        await test.step(`a benign tweak keyed by ${label} takes effect`, async () => {
          const benign = `BENIGN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          // No top-level input_value: passing it together with a Chat Input
          // tweak on the same field is rejected with 400 by the backend.
          const res = await request.post(`/api/v1/run/${chatFlowId}`, {
            headers: { "x-api-key": apiKey },
            data: {
              input_type: "chat",
              output_type: "chat",
              tweaks: { [tweakKey]: { input_value: benign } },
            },
          });

          expect(res.status()).toBe(200);
          const body = await res.json();
          expect(getOutputText(body)).toBe(benign);
        });
      }

      await test.step("a field the template does not declare is skipped, not refused", async () => {
        // The boundary between *ignored* and *refused* that #14538 introduced:
        // apply_tweaks skips a key the node's template does not declare, so the
        // run answers 200 with the author's value and `fields` never comes into
        // play. Without this, "200" alone does not tell a caller whether its
        // tweak applied — which is the reporting failure the loud refusal was
        // introduced to fix, arrived at from the other side.
        const res = await request.post(`/api/v1/run/${chatFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: {
            input_type: "chat",
            output_type: "chat",
            tweaks: { [CHAT_INPUT_NODE_ID]: { not_a_template_field: "IGNORED" } },
          },
        });

        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(getOutputText(body)).toBe(RUNNABLE_CHAT_FLOW_DEFAULT_INPUT);
      });
    },
  );

  test(
    "a protected field on a code-execution component refuses the whole request, and the benign tweak sent with it does not land",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const sentinel = `PWNED-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const benignSender = `BENIGN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await test.step("both protected fields are named and the request is refused whole", async () => {
        // ONE request carrying three overrides: two protected fields on the
        // Python Interpreter (python_code is executable code, global_imports is
        // the documented sandbox boundary — both plain `str`, so the field-type
        // guard does not see them) and one unprotected field on Chat Output.
        const res = await request.post(`/api/v1/run/${pythonFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: {
            // "debug" so a 200 carries every vertex, not just Chat Output. It is
            // kept on the refused request too, so the two requests differ only
            // in their tweaks.
            output_type: "debug",
            tweaks: {
              [pythonNodeId]: {
                python_code: `print("${sentinel}")`,
                global_imports: "math,os",
              },
              [chatOutputNodeId]: { sender_name: benignSender },
            },
          },
        });

        // `toEqual`, not `toContain`: both protected keys must be named, and
        // sender_name must NOT be — its absence is the request-scope property
        // (it was collateral to a refusal, never itself protected), and it is
        // already implied by this one comparison, so it gets no second, dead
        // assertion of its own.
        await expectTweakRefusal(res, ["global_imports", "python_code"]);
      });

      // THE ORDER OF THE NEXT TWO STEPS IS LOAD-BEARING, and the reason is
      // upstream's own: _refused_tweak_names() exists because "applying as we go
      // and raising at the end leaves the accepted half written, and the graph
      // the run paths hand us is cached and reused, so that half survives into
      // later runs that send no tweaks at all". A step that re-tweaks
      // sender_name overwrites the very field whose non-landing is the claim —
      // measured: with the accepted half persisted by hand, a version of this
      // test that only re-tweaked stayed GREEN. So non-landing is asserted
      // FIRST, on a request that sends no tweaks at all, and only then is the
      // field re-tweaked to prove it was tweakable all along.
      await test.step("the refused request ran nothing and mutated nothing", async () => {
        const res = await request.post(`/api/v1/run/${pythonFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: { output_type: "debug" },
        });

        expect(res.status()).toBe(200);
        const body: RunResponseBody = await res.json();
        const python = getVertex(body, pythonNodeId);

        // python_code still runs the author's code, and the sentinel is nowhere.
        expect(python?.outputs?.results?.message?.result).toBe(authorMark);
        expect(JSON.stringify(body)).not.toContain(sentinel);

        // The component logs exactly which modules entered the namespace, and
        // only the author's "math" is there. On this request that is a
        // non-persistence claim, not a refusal claim: nothing asked for "os"
        // here. The refusal itself is evidenced by `fields` in the step above.
        const logs = (python?.logs?.results ?? []).map((l) => l.message ?? "");
        expect(logs).toContain("Successfully imported modules: ['math']");

        // The benign field the refused request carried did NOT land — the claim
        // in this test's title, and the one an apply-as-you-go regression would
        // break. Compared against the refused value rather than the author's
        // literal default, so a template default change cannot silently satisfy
        // it.
        const chatOutput = getVertex(body, chatOutputNodeId);
        expect(chatOutput?.results?.message?.sender_name).not.toBe(benignSender);
      });

      await test.step("the refusal left no trace on the stored flow either", async () => {
        // The runtime check above reads a graph that may have been served from
        // cache; this one reads what was persisted. Both have to hold.
        const res = await request.get(`/api/v1/flows/${pythonFlowId}`, {
          headers: { Authorization: bearerToken },
        });
        expect(res.status()).toBe(200);
        const flow = await res.json();
        const nodes: Array<{ id?: string; data?: { node?: { template?: Record<string, { value?: unknown }> } } }> =
          flow?.data?.nodes ?? [];

        const pythonTemplate = nodes.find((n) => n.id === pythonNodeId)?.data?.node
          ?.template;
        const chatOutputTemplate = nodes.find((n) => n.id === chatOutputNodeId)?.data
          ?.node?.template;
        // Asserted present before compared — a lookup miss must fail, not pass.
        expect(pythonTemplate, `node ${pythonNodeId} not found on the stored flow`).toBeTruthy();
        expect(chatOutputTemplate, `node ${chatOutputNodeId} not found on the stored flow`).toBeTruthy();

        expect(pythonTemplate?.python_code?.value).toBe(`print("${authorMark}")`);
        expect(pythonTemplate?.global_imports?.value).not.toContain("os");
        expect(chatOutputTemplate?.sender_name?.value).not.toBe(benignSender);
      });

      const benignSenderAfter = `BENIGN2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await test.step("the same benign field is tweakable when sent on its own", async () => {
        // The control: it rules out "tweaks were ignored wholesale" as the
        // explanation for sender_name not landing above. It runs LAST because it
        // writes the field the two steps above had to read untouched.
        const res = await request.post(`/api/v1/run/${pythonFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: {
            output_type: "debug",
            tweaks: { [chatOutputNodeId]: { sender_name: benignSenderAfter } },
          },
        });

        expect(res.status()).toBe(200);
        const body: RunResponseBody = await res.json();
        const chatOutput = getVertex(body, chatOutputNodeId);
        expect(chatOutput?.results?.message?.sender_name).toBe(benignSenderAfter);
      });
    },
  );
});
