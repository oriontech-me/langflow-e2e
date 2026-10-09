import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  createCatalogFlow,
  fetchComponentCatalog,
  type CatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { CUSTOM_COMPONENT_TYPE } from "../../../../helpers/flows/build-custom-component-graph";

// Agent reply persistence: every text item of a merged reply reaches the stored
// message (issue #2200, the deterministic coverage for #2176 / LE-2919).
// Spec doc: docs/core-functionality/llm-agents/agent-reply-content-persistence.md
//
// No model is involved. A custom component builds the merged `AIMessageChunk` that
// LangChain produces for a given chunk sequence, hands it to the real
// `process_agent_events` as an `on_chat_model_end` event, and persists through its
// own `send_message`. Its edge to a Chat Output is what makes `send_message` write
// to the database (`_should_skip_message`), as for an Agent wired to a Chat Output.

const WORKFLOWS_OP = "POST /api/v2/workflows";
const MESSAGES_OP = "GET /api/v1/monitor/messages";

const HEAD = "Echo: hello m";

/** One chunk's `content`: a plain string, or a list of content blocks. */
type ChunkContent = string | Array<Record<string, unknown>>;

/** A text block carrying a thought signature, the shape Gemini emits as a dict. */
function signedText(text: string): Record<string, unknown> {
  return { type: "text", text, extras: { signature: "sig" } };
}

/**
 * The probe's Python source. The chunk sequence crosses as a JSON string parsed by
 * `json.loads`: a JSON literal pasted as Python breaks on `true`/`false`/`null`.
 */
function probeCode(chunks: ChunkContent[]): string {
  return `import json

from langchain_core.messages import AIMessageChunk
from lfx.base.agents.events import process_agent_events
from lfx.custom.custom_component.component import Component
from lfx.io import Output
from lfx.schema.message import Message

CHUNKS = json.loads(${JSON.stringify(JSON.stringify(chunks))})


class AgentReplyProbe(Component):
    display_name = "Agent Reply Probe"
    outputs = [Output(display_name="Message", name="message", method="run_probe", types=["Message"])]

    async def run_probe(self) -> Message:
        # LangChain's own chunk addition, i.e. merge_content, builds the content.
        merged = None
        for content in CHUNKS:
            chunk = AIMessageChunk(content=content)
            merged = chunk if merged is None else merged + chunk

        async def events():
            yield {"event": "on_chat_model_end", "data": {"output": merged}, "name": "probe", "run_id": "probe"}

        agent_message = Message(sender="Machine", sender_name="AI", text="")
        return await process_agent_events(events(), agent_message, self.send_message)
`;
}

/** Turns the catalog's `CustomComponent` copy into the probe. */
function configureProbe(chunks: ChunkContent[]) {
  return (component: CatalogComponent) => {
    component.template.code = { ...component.template.code, value: probeCode(chunks) };
    component.outputs = [
      {
        allows_loop: false,
        cache: true,
        display_name: "Message",
        group_outputs: false,
        method: "run_probe",
        name: "message",
        selected: "Message",
        tool_mode: true,
        types: ["Message"],
        value: "__UNDEFINED__",
      },
    ];
  };
}

interface StoredMessage {
  text?: unknown;
  flow_id?: unknown;
}

test.describe("Agent reply persistence (LLM-free)", () => {
  let bearer: string;
  // Identical for every test, so fetched once per worker (~524 KB).
  let catalog: Record<string, unknown>;
  const createdFlowIds: string[] = [];

  test.beforeEach(async ({ request }) => {
    bearer = await getAuthToken(request);
    catalog ??= await fetchComponentCatalog(request, { Authorization: bearer });
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdFlowIds.splice(0)) {
      await deleteFlow(request, id, { headers: { Authorization: bearer } });
    }
  });

  /**
   * Creates the probe -> Chat Output flow, runs it in a fresh session and returns
   * the messages stored for that session. Identical for every test; only `chunks`
   * differs, which is what makes Test 1 the attribution control of Tests 2 and 3.
   */
  async function runProbe(
    request: APIRequestContext,
    chunks: ChunkContent[],
  ): Promise<{ flowId: string; messages: StoredMessage[] }> {
    const headers = { Authorization: bearer };

    const flowId = await test.step("create the probe -> Chat Output flow", async () => {
      const id = await createCatalogFlow(
        request,
        catalog,
        {
          nodes: [
            {
              id: "CustomComponent-probe",
              type: CUSTOM_COMPONENT_TYPE,
              displayName: "Agent Reply Probe",
              configure: configureProbe(chunks),
            },
            { id: "ChatOutput-probe", type: "ChatOutput" },
          ],
          edges: [
            {
              source: "CustomComponent-probe",
              output: "message",
              target: "ChatOutput-probe",
              field: "input_value",
            },
          ],
        },
        { name: `agent-reply-persistence-${Date.now()}`, headers },
      );
      createdFlowIds.push(id);
      return id;
    });

    // A UUID: the probe stores with the graph's session id, which `send_message`
    // parses as one ("badly formed hexadecimal UUID string" otherwise).
    const sessionId = randomUUID();

    await test.step("run the flow in a fresh session", async () => {
      const res = await request.post("/api/v2/workflows", {
        headers,
        data: { flow_id: flowId, mode: "sync", input_value: "go", session_id: sessionId },
      });
      expect(res.status(), "the run answers 200").toBe(200);
      const body = await res.json();
      expect(body?.status, `the run completed: ${JSON.stringify(body).slice(0, 400)}`).toBe("completed");
      expect(body?.errors ?? [], "the run reports no errors").toEqual([]);
    });

    const messages = await test.step("read back the session's stored messages", async () => {
      const res = await request.get("/api/v1/monitor/messages", {
        headers,
        params: { session_id: sessionId },
      });
      expect(res.status(), "the message read answers 200").toBe(200);
      return (await res.json()) as StoredMessage[];
    });

    return { flowId, messages };
  }

  /** One message, belonging to this flow: the harness worked. Returns its text. */
  function storedReplyText(stored: { flowId: string; messages: StoredMessage[] }): unknown {
    expect(stored.messages, "the session holds exactly one stored message").toHaveLength(1);
    const [message] = stored.messages;
    expect(message.flow_id, "the stored message belongs to this flow").toBe(stored.flowId);
    return message.text;
  }

  /** The contract: the stored text is the whole merged reply. */
  function expectFullReply(text: unknown, sentinel: string): void {
    // Exact equality: the truncated text is a prefix of the full one, so a
    // `toContain` on the head would pass the defect.
    expect(text, "the stored text is the whole merged reply").toBe(`${HEAD}cp (${sentinel})`);
  }

  /**
   * Declares the LE-2919 failure only once the harness has worked and the stored
   * text is either the known defective value or the full reply. Anything that
   * fails before this call (catalog, flow, run, message count) or any third text
   * is a plain red, so within the test body test.fail() absorbs only the known
   * defect. A fixed defect still reports "expected to fail, but passed". Once
   * declared, a failure in afterEach or fixture teardown is absorbed too.
   */
  function declareKnownDefect(text: unknown, sentinel: string, defective: string): void {
    expect(
      [defective, `${HEAD}cp (${sentinel})`],
      "the stored text is the known LE-2919 value or the full reply, nothing else",
    ).toContain(text);
    test.fail();
  }

  test(
    "an all-dict streamed reply is stored whole (attribution control)",
    { tag: ["@api", "@regression", "@agents", "@stable"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([WORKFLOWS_OP, MESSAGES_OP]);
      const sentinel = `probe-${Date.now()}`;

      // Signed dicts, like Tests 2 and 3: only the chunk SHAPE differs from them.
      const stored = await runProbe(request, [[signedText(HEAD)], [signedText(`cp (${sentinel})`)]]);

      await test.step("the stored message carries the full reply", () => {
        expectFullReply(storedReplyText(stored), sentinel);
      });
    },
  );

  test(
    "a string chunk after a list-content chunk is stored, not dropped",
    { tag: ["@api", "@regression", "@agents", "@stable"] },
    async ({ request, apiCoverage }) => {
      // DECLARED FAILING (LE-2919, #2176). The merged content is [dict, str] and
      // `_coerce_ai_message_blocks` drops the str, so the stored text is "Echo: hello m".
      // The final assertion is the CORRECT contract; it fails today, and the
      // declaration expects that. The day upstream fixes it, this reports "expected
      // to fail, but passed", which the daily treats as a hard failure and strips
      // @stable. The lift: delete the declareKnownDefect() call and this comment,
      // restore @stable if the daily removed it, flip the §6.5 bullet to [x], and
      // record the fix in REGRESSIONS.md.
      apiCoverage.declare([WORKFLOWS_OP, MESSAGES_OP]);
      const sentinel = `probe-${Date.now()}`;

      const stored = await runProbe(request, [[signedText(HEAD)], `cp (${sentinel})`]);

      await test.step("the stored message carries the full reply", () => {
        const text = storedReplyText(stored);
        declareKnownDefect(text, sentinel, HEAD);
        expectFullReply(text, sentinel);
      });
    },
  );

  test(
    "string chunks followed by an empty signed text block are stored, not emptied",
    { tag: ["@api", "@regression", "@agents", "@stable"] },
    async ({ request, apiCoverage }) => {
      // DECLARED FAILING (LE-2919, #2176). The merged content is [str, dict] with an
      // empty dict text, so the coercion keeps nothing and the stored text is "".
      // Lifted the same way as the test above, in the same PR.
      apiCoverage.declare([WORKFLOWS_OP, MESSAGES_OP]);
      const sentinel = `probe-${Date.now()}`;

      const stored = await runProbe(request, [HEAD, `cp (${sentinel})`, [signedText("")]]);

      await test.step("the stored message carries the full reply", () => {
        const text = storedReplyText(stored);
        declareKnownDefect(text, sentinel, "");
        expectFullReply(text, sentinel);
      });
    },
  );
});
