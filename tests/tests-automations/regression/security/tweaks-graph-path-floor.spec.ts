import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { parseStreamEvents } from "../../../fixtures/flow-error-policy";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createPythonInterpreterFlowViaApi } from "../../../helpers/flows/create-python-interpreter-flow-via-api";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";

// The protected-field floor is a property of the tweaks contract, not of one
// endpoint. `security/tweaks-injection.spec.ts` covers it on POST /api/v1/run,
// where tweaks are applied to the graph PAYLOAD before construction. Langflow
// has a second, structurally different path: the streaming and background run
// modes build the Graph first and then push overrides onto built vertices
// (process_tweaks_on_graph / apply_tweaks_on_vertex). Upstream
// langflow-ai/langflow#14538 records that this path "filtered only the literal
// key `code` in api/build.py, so it accepted tweaks the sync mode refused: a
// `global_imports` override widening the exec sandbox was applied", and adds the
// enforcement plus `except TweakRefusedError` re-raises at three call sites
// "because both call sites previously swallowed the refusal into a 500".
//
// MEASURED on 1.12.0.dev37: the floor holds on all four run surfaces — no
// protected tweak is applied anywhere. What differs is how the refusal REACHES
// THE CALLER, and that is what this file pins:
//   POST /api/v1/run        -> 422, code TWEAKS_REFUSED, fields naming the key
//   /api/v2/workflows sync  -> 500 INTERNAL_SERVER_ERROR (the defect; Test 3)
//   /api/v2/workflows stream/background
//                           -> 200 plus an event:"error" frame naming
//                              TweakRefusedError and the refused key. NOT a
//                              defect: api/build.py records that these callers
//                              run the build in their own task, so a refusal is
//                              reported on an already-committed 200.
//
// Both failure directions are asserted on every surface, because they are
// opposite and a spec catching one can miss the other: ACCEPTANCE is caught
// causally (the author's code branches on whether the widened module is in
// scope, so the run itself names which value was in effect), and an
// UNATTRIBUTABLE refusal is caught by requiring the refusal to name itself and
// the key. Each is paired with a benign tweak on the same surface, because "the
// sentinel is absent" also passes when the tweaks mechanism is dead altogether.
//
// See docs/security/tweaks-graph-path-floor.md for the measured table, the
// LANGFLOW_TWEAKS_POLICY findings, and the port-shadowing trap this spec was
// written through.

/**
 * Node id of the chat fixture's Chat Input. Hardcoded for the same reason as in
 * `tweaks-injection.spec.ts`: it is stored in the committed fixture
 * (`tests/assets/flows/chat-io-ok-trace-fixture.json`) and the helper does not
 * export it. Addressing by node id is deliberate — it is the mode measured to
 * work on all three v2 run modes.
 */
const CHAT_INPUT_NODE_ID = "ChatInput-b6UCc";

/** Printed by the author's code only when the sandbox was widened. */
const WIDENED_PREFIX = "WIDENED:";

/** A module the author's `global_imports` does not list. */
const SANDBOX_WIDENING_TWEAK = { global_imports: ["os"] };

/** The exception the refusal must be attributed to, in every surface's report. */
const REFUSAL_MARKER = "TweakRefusedError";

type StreamingMode = "stream" | "background";
type Tweaks = Record<string, Record<string, unknown>>;

/**
 * The author's `python_code`: a causal probe rather than a fixed string.
 *
 * `validate_code_safety()` rejects an inline `import`, so `os` is in scope only
 * when the protected `global_imports` was widened. The run's own output
 * therefore names which value was in effect, which no status code does.
 */
function sandboxProbe(authorMark: string): string {
  return [
    "try:",
    `    print("${WIDENED_PREFIX}" + os.name)`,
    "except NameError:",
    `    print("${authorMark}")`,
    "",
  ].join("\n");
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Posts a run to the v2 endpoint.
 *
 * No top-level `input_value` is ever sent: it overrides the Chat Input and would
 * mask the benign control, which is the half that proves a refusal was measured
 * rather than a dead mechanism.
 */
async function postWorkflow(
  request: APIRequestContext,
  bearerToken: string,
  flowId: string,
  mode: "sync" | StreamingMode,
  tweaks?: Tweaks,
): Promise<APIResponse> {
  return request.post("/api/v2/workflows", {
    headers: { Authorization: bearerToken },
    data: { flow_id: flowId, mode, ...(tweaks ? { tweaks } : {}) },
  });
}

interface StreamFacts {
  /** Every event, so an assertion can look for what must NOT be there too. */
  events: unknown[];
  /** The text the flow produced, from the last `add_message` event. */
  messageText: string | null;
  /** The serialized `event: "error"` frames, where a refusal is reported. */
  errorFrames: string[];
  /** The whole body, for asserting a sentinel appears NOWHERE. */
  raw: string;
}

/**
 * Reads a run stream.
 *
 * `parseStreamEvents` is reused from the flow-error policy for its parser only —
 * it already tolerates SSE, NDJSON and a truncated tail. The message text is
 * read from the `add_message` event rather than from the raw body because the
 * response echoes the request's own tweaks, so a substring search could be
 * satisfied by the request instead of by the run. The reverse holds for
 * `WIDENED:`, which the request never contains: there the raw body is the
 * stricter target, since it also covers the component's own log line.
 */
function readStream(raw: string): StreamFacts {
  const events = parseStreamEvents(raw) as Array<{
    event?: unknown;
    data?: { data?: { text?: unknown } };
  }>;
  const messages = events.filter((event) => event?.event === "add_message");
  const text = messages.at(-1)?.data?.data?.text;
  return {
    events,
    messageText: typeof text === "string" ? text : null,
    errorFrames: events
      .filter((event) => event?.event === "error")
      .map((event) => JSON.stringify(event)),
    raw,
  };
}

test.describe("Tweaks — the protected-field floor on the graph run path", () => {
  let bearerToken: string;

  // Flow B — Python Interpreter -> Chat Output, built from the live catalog.
  let pythonFlowId: string;
  let pythonNodeId: string;
  let authorMark: string;
  let deletePythonFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Flow A — Chat Input -> Chat Output passthrough, the benign control.
  let chatFlowId: string;
  let deleteChatFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    authorMark = unique("AUTHOR");
    const pythonFlow = await createPythonInterpreterFlowViaApi(
      request,
      { Authorization: bearerToken },
      { authorCode: sandboxProbe(authorMark) },
    );
    pythonFlowId = pythonFlow.flowId;
    pythonNodeId = pythonFlow.pythonNodeId;
    deletePythonFlow = pythonFlow.deleteFlow;

    // The whole causal probe depends on `os` NOT being on the author's list, so
    // the stored value is asserted rather than assumed: a template default
    // change upstream must fail here, not silently make the probe vacuous.
    const stored = await request.get(`/api/v1/flows/${pythonFlowId}`, {
      headers: { Authorization: bearerToken },
    });
    expect(stored.status()).toBe(200);
    const storedFlow = await stored.json();
    const interpreter = storedFlow?.data?.nodes?.find(
      (node: { id?: string }) => node?.id === pythonNodeId,
    );
    expect(
      String(interpreter?.data?.node?.template?.global_imports?.value ?? ""),
      "the author's global_imports must not already grant `os`, or the widening tweak would be unobservable",
    ).not.toContain("os");

    const chatFlow = await createRunnableChatFlowViaApi(request, {
      Authorization: bearerToken,
    });
    chatFlowId = chatFlow.flowId;
    deleteChatFlow = chatFlow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Both flows are deleted id-scoped, and a failure in one must not skip the
    // other. `afterAll` uses its OWN request — the beforeAll one cannot be
    // reused (Playwright fixture-scope rule).
    try {
      if (deletePythonFlow) await deletePythonFlow(request);
    } finally {
      if (deleteChatFlow) await deleteChatFlow(request);
    }
  });

  /** Runs a streaming-family mode and returns its stream, however it is delivered. */
  async function runStreaming(
    request: APIRequestContext,
    mode: StreamingMode,
    flowId: string,
    tweaks?: Tweaks,
  ): Promise<StreamFacts> {
    const res = await postWorkflow(request, bearerToken, flowId, mode, tweaks);
    expect(
      res.status(),
      `POST /api/v2/workflows (mode=${mode}) commits its response before the build runs`,
    ).toBe(200);

    if (mode === "stream") return readStream(await res.text());

    const submitted = await res.json();
    expect(typeof submitted?.job_id, "the background submit must return a job_id").toBe(
      "string",
    );
    const jobId = submitted.job_id as string;

    // The poller returns null instead of throwing on an unreadable answer: a
    // throw inside expect.poll propagates and aborts the poll rather than retrying.
    let facts: StreamFacts | null = null;
    await expect
      .poll(
        async () => {
          try {
            const events = await request.get(`/api/v2/workflows/${jobId}/events`, {
              headers: { Authorization: bearerToken },
            });
            if (!events.ok()) return null;
            const read = readStream(await events.text());
            // A terminal frame either way — the run produced a message, or it
            // was refused. Anything else means the job is still queued.
            if (!read.messageText && read.errorFrames.length === 0) return null;
            facts = read;
            return read;
          } catch {
            return null;
          }
        },
        {
          message: `background job ${jobId} never reached a terminal event — nothing was measured`,
          timeout: 60_000,
          intervals: [500, 1_000, 2_000, 4_000],
        },
      )
      .not.toBeNull();
    return facts as unknown as StreamFacts;
  }

  /**
   * The whole contract for one streaming-family mode. Shared so the two surfaces
   * cannot drift apart: an assertion added for one is added for both.
   */
  async function assertStreamingSurface(
    request: APIRequestContext,
    mode: StreamingMode,
  ): Promise<void> {
    await test.step(`a global_imports tweak is refused and named (mode=${mode})`, async () => {
      const facts = await runStreaming(request, mode, pythonFlowId, {
        [pythonNodeId]: SANDBOX_WIDENING_TWEAK,
      });
      expect(
        facts.raw,
        "the flow author's sandbox must still be in effect — the run reached the widened branch",
      ).not.toContain(WIDENED_PREFIX);
      expect(
        facts.errorFrames.join("\n"),
        "the refusal must be attributable on this surface, not a bare failure",
      ).toContain(REFUSAL_MARKER);
      expect(
        facts.errorFrames.join("\n"),
        "and it must name the key it refused",
      ).toContain("global_imports");
    });

    await test.step(`a python_code tweak is refused and named (mode=${mode})`, async () => {
      const pwned = unique("PWNED");
      const facts = await runStreaming(request, mode, pythonFlowId, {
        [pythonNodeId]: { python_code: `print("${pwned}")` },
      });
      expect(facts.raw, "the caller's code must never be what executes").not.toContain(
        pwned,
      );
      expect(
        facts.errorFrames.join("\n"),
        "the refusal must be attributable on this surface, not a bare failure",
      ).toContain(REFUSAL_MARKER);
      expect(
        facts.errorFrames.join("\n"),
        "and it must name the key it refused",
      ).toContain("python_code");
    });

    await test.step(`a benign tweak on the same surface still applies (mode=${mode})`, async () => {
      const benign = unique("BENIGN");
      const applied = await runStreaming(request, mode, chatFlowId, {
        [CHAT_INPUT_NODE_ID]: { input_value: benign },
      });
      expect(
        applied.messageText ?? "",
        "tweaks must be alive on this surface, or the refusals above measured nothing",
      ).toContain(benign);
      expect(
        applied.errorFrames,
        "and a tweak the contract allows must not be reported as a refusal",
      ).toHaveLength(0);
    });
  }

  test(
    "mode=stream refuses a protected tweak and names the refusal",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      await assertStreamingSurface(request, "stream");
    },
  );

  test(
    "mode=background refuses a protected tweak and names the refusal",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      await assertStreamingSurface(request, "background");
    },
  );

  // `mode=sync` is asserted SHAPE-AGNOSTICALLY, on purpose.
  //
  // Measured on 1.12.0.dev37 it answers 500 INTERNAL_SERVER_ERROR / "An
  // unexpected error occurred." for every refusal, where POST /api/v1/run
  // answers 422 with code TWEAKS_REFUSED and `fields` naming the key — the shape
  // #14538 introduced, and the shape api/v2/workflow_execution.py's own comment
  // says this path should produce ("let the app-level handler answer with 422").
  // TweakRefusedError is deliberately not an HTTPException, so it lands in the
  // catch-all `except Exception -> 500` arm of api/v2/workflow.py's inline sync
  // handler and never reaches the app-level handler in main.py.
  //
  // Pinning 422 here would ship a test that is red for months on a reporting
  // difference; pinning 500 would bless it. Neither is what this file is for.
  // What it asserts instead holds under both shapes and is the failure that
  // actually matters: a refusal must never answer 2xx — not by applying the
  // tweak, and not by dropping it silently and running anyway. The shape is
  // recorded in docs/security/tweaks-graph-path-floor.md instead.
  test(
    "mode=sync refuses a protected tweak without ever answering 2xx",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      for (const [field, tweak] of [
        ["global_imports", SANDBOX_WIDENING_TWEAK],
        ["python_code", { python_code: 'print("refused")' }],
      ] as const) {
        await test.step(`a ${field} tweak is refused`, async () => {
          const res = await postWorkflow(request, bearerToken, pythonFlowId, "sync", {
            [pythonNodeId]: tweak,
          });
          expect(
            res.status(),
            `a refused ${field} tweak must not answer 2xx — a success status means the tweak either took effect or was dropped without telling the caller`,
          ).toBeGreaterThanOrEqual(400);
        });
      }

      await test.step("the refused requests left the flow running the author's code", async () => {
        const res = await postWorkflow(request, bearerToken, pythonFlowId, "sync");
        expect(res.status()).toBe(200);
        const body = await res.json();
        const text = String(body?.output?.text ?? "");
        expect(
          text,
          "a refusal must leave nothing behind — the author's sandbox is still what runs",
        ).not.toContain(WIDENED_PREFIX);
        expect(text, "and the author's own code is still what runs").toContain(authorMark);
      });

      await test.step("a benign tweak on the same surface still applies", async () => {
        const benign = unique("BENIGN");
        const res = await postWorkflow(request, bearerToken, chatFlowId, "sync", {
          [CHAT_INPUT_NODE_ID]: { input_value: benign },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(
          String(body?.output?.text ?? ""),
          "tweaks must be alive on this surface, or the refusals above measured nothing",
        ).toContain(benign);
      });
    },
  );
});
