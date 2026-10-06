import type { APIRequestContext } from "@playwright/test";

/** Keeps each quoted value readable inside an assertion message. */
const MAX_CHARS = 200;

const quote = (value: string): string =>
  JSON.stringify(value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}…` : value);

const reasonOf = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, MAX_CHARS) ?? "unknown error";
};

/** One LLM call of a session, as the native trace recorded it. */
export interface LlmCall {
  /** The text the call returned. LangChain builds it from string AND dict content items. */
  text: string | null;
  /** The model that SERVED the call (`generation_info.model_name`), else the one requested. */
  model: string | null;
}

/** The LLM calls of a session, or why they could not be read (#1012: unknown is not clean). */
export type SessionLlmCalls = { available: true; calls: LlmCall[] } | { available: false; reason: string };

/**
 * Describes, on the failing branch, why a persisted agent reply lacks the
 * payload the agent was asked to echo. The result is meant to be appended to the
 * message of the assertion that is about to fail.
 *
 * Why this exists (#2176): the VM daily failed
 * `mcp-client-agent-gemini-tool-regression` twice (2026-09-10 on `1.13.0.dev8`,
 * 2026-10-05 on `1.13.0.dev33`). Both times the persisted reply was
 * `"Echo: hello m"`, and the report said nothing else. Two causes fit that string,
 * and only the trace separates them:
 *
 * - **Langflow dropped the tail.** `handle_on_chat_model_end` in `lfx`'s
 *   `base/agents/events.py` keeps a round's text through
 *   `_coerce_ai_message_blocks`, which drops plain-string items of a list content.
 *   LangChain's `merge_content` produces `[{text: "Echo: hello m"}, "cp (…)"]`
 *   when a list-content chunk is followed by a string chunk, and
 *   `langchain-google-genai` switches between the two per chunk on
 *   `response.model_version` and the thought signature. The trace's `llm` span still
 *   holds the full text, because `ChatGeneration.text` joins both item kinds.
 * - **The model stopped there.** Then the `llm` span stops short as well.
 *
 * Neither cause reproduced on demand: 0 failures in about 175 runs, local and VM.
 * So the evidence has to come from the occurrence itself.
 *
 * Two properties are contractual, and both are pinned in
 * `describe-agent-reply-loss.test.ts`:
 *
 * 1. **It never throws.** It runs on the branch where a test is already failing,
 *    and a throw would replace the real failure with its own.
 * 2. **Every state it could not read is named** (#1012). Tracing off, a trace
 *    with no `llm` span and a failed trace request are different observations.
 */
export function describeAgentReplyLoss(input: {
  replyText: string;
  payload: RegExp;
  toolOutputs: string[];
  llm: SessionLlmCalls;
}): string {
  try {
    const reply = typeof input.replyText === "string" ? input.replyText : "";
    const outputs = Array.isArray(input.toolOutputs)
      ? input.toolOutputs.filter((o): o is string => typeof o === "string")
      : [];
    const lines: string[] = [`persisted reply: ${quote(reply)}`];

    if (outputs.length === 0) {
      lines.push("echo tool output: no echo tool output was persisted for this turn");
    } else {
      for (const output of outputs) lines.push(`echo tool output: ${quote(output)}`);
    }

    const trimmed = reply.trim();
    if (trimmed === "") {
      lines.push(
        "persisted reply is empty: the #2176 mechanism can produce it (string chunks followed by a " +
          "signed empty dict), and so can a read taken before the turn ended (#2095)",
      );
    } else if (outputs.some((o) => o.startsWith(trimmed) && o.trim() !== trimmed)) {
      lines.push(
        "#2176 signature: the persisted reply is a strict prefix of the echo tool output. Langflow " +
          "kept only part of the streamed answer (lfx base/agents/events.py, _coerce_ai_message_blocks " +
          "drops plain-string content items)",
      );
    } else if (outputs.length > 0) {
      lines.push(
        "not the #2176 signature: the persisted reply is not a prefix of the echo tool output, so " +
          "this is a different cause",
      );
    }

    const llm = input.llm;
    if (!llm || typeof llm !== "object") {
      lines.push("LLM calls unavailable: no trace reading was taken");
    } else if (!llm.available) {
      lines.push(`LLM calls unavailable: ${llm.reason}`);
    } else if (llm.calls.length === 0) {
      lines.push("LLM calls: the native trace had no llm span for this session");
    } else {
      llm.calls.forEach((call, i) => {
        lines.push(
          `LLM call ${i + 1}: model ${call.model ?? "<unknown>"}, text ${call.text === null ? "<unreadable>" : quote(call.text)}`,
        );
      });
      const replyHasPayload = input.payload.test(reply);
      const llmHasPayload = llm.calls.some((c) => c.text !== null && input.payload.test(c.text));
      if (llmHasPayload && !replyHasPayload) {
        lines.push(
          "an LLM call returned the payload but the persisted reply lacks it: the text was lost " +
            "inside Langflow, after the model answered",
        );
      } else if (!llmHasPayload && trimmed !== "") {
        lines.push("the model itself returned no text holding the payload: the loss is not Langflow's");
      }
      for (const model of new Set(llm.calls.map((c) => c.model).filter((m): m is string => !!m))) {
        if (!/gemini-3/i.test(model)) {
          lines.push(
            `served model ${model} is not a Gemini 3 model: langchain-google-genai switches between ` +
              "string and dict chunks for it, which is the #2176 trigger",
          );
        }
      }
    }
    return lines.join("\n");
  } catch (error) {
    return `diagnosis unavailable (${reasonOf(error)})`;
  }
}

/**
 * The text of a persisted `tool_use` block's `output`: a dumped `ToolMessage`
 * (`{content: "…"}` or `{content: [{type: "text", text}]}`), or a bare string.
 */
export function toolOutputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return null;
  const content = (output as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
            ? (item as { text: string }).text
            : "",
      )
      .join("");
    return text === "" ? null : text;
  }
  return null;
}

/** Every `type: "llm"` span of a trace detail, at any depth, as an {@link LlmCall}. */
export function collectLlmCalls(traceDetail: unknown): LlmCall[] {
  const calls: LlmCall[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 50 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const span = node as { type?: unknown; outputs?: unknown; modelName?: unknown; children?: unknown };
    if (span.type === "llm") calls.push(readLlmSpan(span));
    if (Array.isArray(span.children)) visit(span.children, depth + 1);
    const spans = (node as { spans?: unknown }).spans;
    if (Array.isArray(spans)) visit(spans, depth + 1);
  };
  try {
    visit(traceDetail, 0);
  } catch {
    // Contract: never throw. Whatever was collected before the bad node stands.
  }
  return calls;
}

function readLlmSpan(span: { outputs?: unknown; modelName?: unknown }): LlmCall {
  const requested = typeof span.modelName === "string" ? span.modelName : null;
  let outputs: unknown = span.outputs;
  if (typeof outputs === "string") {
    try {
      outputs = JSON.parse(outputs);
    } catch {
      return { text: null, model: requested };
    }
  }
  const first = (outputs as { generations?: unknown } | null)?.generations;
  const generation = Array.isArray(first) && Array.isArray(first[0]) ? first[0][0] : undefined;
  if (!generation || typeof generation !== "object") return { text: null, model: requested };
  const text = (generation as { text?: unknown }).text;
  const served = (generation as { generation_info?: { model_name?: unknown } }).generation_info?.model_name;
  return {
    text: typeof text === "string" ? text : null,
    model: typeof served === "string" && served !== "" ? served : requested,
  };
}

/**
 * Reads the LLM calls of one session from the native trace. Traces cascade with
 * their flow, so the caller must read before teardown deletes the flow. Polls
 * because the trace is written when the run ends, a moment after the reply is
 * persisted. The interval stays under 2 s: a keep-alive socket idle for 2 s is
 * dropped by the backend (`socket hang up`). Never throws.
 */
export async function readSessionLlmCalls(
  request: APIRequestContext,
  options: {
    flowId: string;
    sessionId: string;
    headers: Record<string, string>;
    budgetMs?: number;
    intervalMs?: number;
  },
): Promise<SessionLlmCalls> {
  const budgetMs = options.budgetMs ?? 10000;
  const intervalMs = options.intervalMs ?? 1000;
  const query =
    `flow_id=${encodeURIComponent(options.flowId)}` + `&session_id=${encodeURIComponent(options.sessionId)}`;
  const deadline = Date.now() + budgetMs;
  try {
    for (;;) {
      const res = await request.get(`/api/v1/monitor/traces?${query}`, {
        headers: options.headers,
        timeout: 15000,
      });
      if (!res.ok()) {
        return { available: false, reason: `GET /api/v1/monitor/traces answered ${res.status()}` };
      }
      const body = (await res.json()) as { traces?: unknown };
      const traces = Array.isArray(body?.traces) ? (body.traces as Array<{ id?: unknown }>) : [];
      if (traces.length > 0) {
        const calls: LlmCall[] = [];
        for (const trace of traces) {
          if (typeof trace?.id !== "string") continue;
          const detail = await request.get(`/api/v1/monitor/traces/${trace.id}`, {
            headers: options.headers,
            timeout: 15000,
          });
          if (!detail.ok()) {
            return {
              available: false,
              reason: `GET /api/v1/monitor/traces/${trace.id} answered ${detail.status()}`,
            };
          }
          calls.push(...collectLlmCalls(await detail.json()));
        }
        return { available: true, calls };
      }
      if (Date.now() >= deadline) {
        return {
          available: false,
          reason:
            `no native trace for this session within ${Math.round(budgetMs / 1000)}s ` +
            "(is LANGFLOW_DEACTIVATE_TRACING set on this instance?)",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (error) {
    return { available: false, reason: `trace read failed: ${reasonOf(error)}` };
  }
}
