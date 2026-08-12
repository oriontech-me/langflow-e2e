import type { APIRequestContext } from "@playwright/test";
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
// The backend refusal is SILENT by design: apply_tweaks() asks
// is_protected_tweak_field() and, on a protected field, logs a warning and skips
// it — the run still answers 200 with the flow author's value. There is no error
// to assert on, so every refusal below is paired with a benign tweak sent the
// same way: without that control, a spec asserting only "the sentinel is absent"
// passes just as well when the tweaks mechanism is dead altogether.
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
    "a code tweak cannot replace a component's implementation",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const sentinel = `PWNED-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const code = maliciousChatInputCode(sentinel);

      await test.step("the code tweak is refused when keyed by node id", async () => {
        const res = await request.post(`/api/v1/run/${chatFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: {
            input_type: "chat",
            output_type: "chat",
            tweaks: { [CHAT_INPUT_NODE_ID]: { code } },
          },
        });

        expect(res.status()).toBe(200);
        const body = await res.json();
        // The author's component still ran: the echo is the stored default and
        // the injected class's sentinel appears nowhere in the response.
        expect(getOutputText(body)).toBe(RUNNABLE_CHAT_FLOW_DEFAULT_INPUT);
        expect(JSON.stringify(body)).not.toContain(sentinel);
      });

      await test.step("the code tweak is refused when keyed by display name", async () => {
        const res = await request.post(`/api/v1/run/${chatFlowId}`, {
          headers: { "x-api-key": apiKey },
          data: {
            input_type: "chat",
            output_type: "chat",
            tweaks: { [CHAT_INPUT_DISPLAY_NAME]: { code } },
          },
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
        const storedCode = JSON.stringify(
          flow?.data?.nodes?.find(
            (n: { id?: string }) => n.id === CHAT_INPUT_NODE_ID,
          )?.data?.node?.template?.code?.value ?? "",
        );
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
    },
  );

  test(
    "an executable field on a code-execution component is refused while the same request's benign tweak lands",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const sentinel = `PWNED-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const benignSender = `BENIGN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // ONE request carrying three overrides: two protected fields on the Python
      // Interpreter (python_code is executable code, global_imports is the
      // documented sandbox boundary — both plain `str`, so the field-type guard
      // does not see them) and one unprotected field on Chat Output.
      const res = await request.post(`/api/v1/run/${pythonFlowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          // "debug" so the response carries every vertex, not just Chat Output.
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

      expect(res.status()).toBe(200);
      const body: RunResponseBody = await res.json();

      await test.step("the benign tweak in the same request took effect", async () => {
        // Asserted FIRST: it is what rules out "tweaks were ignored wholesale"
        // as an explanation for the two refusals below.
        const chatOutput = getVertex(body, chatOutputNodeId);
        expect(chatOutput?.results?.message?.sender_name).toBe(benignSender);
      });

      await test.step("python_code kept the flow author's code", async () => {
        const python = getVertex(body, pythonNodeId);
        expect(python?.outputs?.results?.message?.result).toBe(authorMark);
        expect(JSON.stringify(body)).not.toContain(sentinel);
      });

      await test.step("global_imports did not widen the exec namespace", async () => {
        const python = getVertex(body, pythonNodeId);
        const logs = (python?.logs?.results ?? []).map((l) => l.message ?? "");
        // The component logs exactly which modules entered the namespace; the
        // tweak asked for "math,os" and only the author's "math" is there.
        expect(logs).toContain("Successfully imported modules: ['math']");
      });
    },
  );
});
