/**
 * Decides which run-stream responses carry a flow-execution error (#1162).
 *
 * WHY THIS EXISTS
 *
 * `fixtures.ts` provides two error monitors, and their asymmetry is what a green
 * run is worth (#1084): an `http_error` is logged and never fails a test, while a
 * `flow_error` **fails** it. On Langflow 1.12.x the strong half could not fire for
 * a playground or agent run at all — for two independent reasons, both measured on
 * 1.12.0.dev10 from a Playwright trace of `agent-max-tokens.spec.ts`:
 *
 *   1. The URL filter covered `/events?event_delivery=`, `/build/` and `/run/`.
 *      The playground run is `POST /api/v2/workflows`, which matches none of them.
 *   2. Even had it matched, the body was skipped: that response is
 *      `content-type: text/event-stream`, and the inline detector returned early
 *      for stream-like content types.
 *
 * So an Anthropic `400` travelled all the way to the UI with no fixture verdict —
 * no `🚨 Flow Error Detected`, nothing. The spec then failed 120 s later on an
 * unrelated count assertion, which is the whole reason #1059 had to be triaged by
 * hypothesis (see that issue).
 *
 * Extracted as a pure module for the same reason `http-error-policy.ts` was: the
 * fixture only runs inside a real browser session, so its classification used to
 * be provable only by running the suite and reading a terminal. Here it is covered
 * by `npm run test:units` on every PR, against payloads captured from a real run.
 *
 * ## This decides FAILURE, not visibility
 *
 * Unlike the HTTP policy, a verdict here fails the test unless the spec called
 * `page.allowFlowErrors()`. So a false positive is expensive: every shape matched
 * below is one that only appears when a run actually failed, and the `error: false`
 * trap is called out where it bites.
 */

/** Facts the fixture has about a response before reading its body. */
export interface RunStreamFacts {
  url: string;
  contentType?: string;
}

export type FlowErrorVerdict =
  /** A run failed: fail the test (unless allowed) and quote this. */
  | { failed: true; message: string; shape: string }
  /** Nothing in this body says a run failed. */
  | { failed: false };

/**
 * Endpoints that stream flow-execution events.
 *
 * `/api/v2/workflows` is the current playground/agent run path; the other three
 * are the v1 endpoints the suite has always watched, kept because specs still
 * reach them (component runs, the legacy IOModal path) and because a nightly can
 * serve either.
 */
const RUN_STREAM_PATTERNS = [
  "/api/v2/workflows",
  "/events?event_delivery=",
  "/build/",
  "/run/",
];

export function isRunStreamUrl(url: string): boolean {
  return RUN_STREAM_PATTERNS.some((pattern) => url.includes(pattern));
}

/**
 * Content types whose bodies the fixture must NOT block on indefinitely.
 *
 * `text/event-stream` is deliberately absent from the skip list for run streams:
 * skipping it is defect (2) above. It is read with a bounded drain instead — see
 * `fixtures.ts`.
 */
export function isUnreadableStream(contentType = ""): boolean {
  const ct = contentType.toLowerCase();
  return ["application/grpc", "application/octet-stream"].some((hint) =>
    ct.includes(hint),
  );
}

/**
 * Split a run-stream body into its JSON events.
 *
 * Handles both wire formats the suite meets: SSE (`data: {...}` per line, as
 * `/api/v2/workflows` emits) and bare NDJSON (the v1 endpoints). Non-JSON lines —
 * SSE `event:`/`id:`/`retry:` fields, keep-alive comments, blank lines — are
 * skipped rather than treated as evidence of anything.
 */
export function parseStreamEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const rawLine of String(body ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) continue;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload.startsWith("{") && !payload.startsWith("[")) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // A truncated final chunk is normal when a drain deadline cuts the read.
    }
  }
  return events;
}

/** Python tracebacks that reach the stream as plain text rather than a shape. */
const EXCEPTION_PATTERNS = [
  /NameError: .+/,
  /TypeError: .+/,
  /ValueError: .+/,
  /AttributeError: .+/,
  /ImportError: .+/,
  /KeyError: .+/,
  /An error occured .+/,
];

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" ? (value as Record<string, any>) : null;

const firstLine = (text: unknown, limit = 400): string =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.slice(0, limit) ?? "";

/**
 * Classify one run-stream body.
 *
 * The shapes, in the order a failing v2 run emits them (captured from a real
 * 1.12.0.dev10 run whose Agent hit an Anthropic 400):
 *
 *   {"type":"RUN_ERROR","message":"Error code: 400 - {...}"}
 *   {"type":"CUSTOM","name":"langflow.event","value":{"event_type":"error", ...}}
 *   {"type":"STATE_DELTA","delta":[{"value":{"status":"error","output":{"outputs":
 *      {"response":{"message":{"errorMessage":"Error building Component Agent: …",
 *                              "stackTrace":"Traceback…"}}}}}}]}
 *
 * plus the two v1 shapes the inline detector already knew (`build_data.params`
 * starting with "Error", and `error === true` with an `error_message`).
 *
 * NOTE the trap that made the old detector miss this: the message object inside
 * the `event_type: "error"` event carries **`"error": false`**, so a detector
 * keyed on `data.error === true` reads a failed run as healthy. The event_type is
 * the signal there, not the flag.
 */
export function classifyFlowError(body: string): FlowErrorVerdict {
  for (const event of parseStreamEvents(body)) {
    const e = asRecord(event);
    if (!e) continue;

    // v2 — the terminal verdict of the run. Most direct, so checked first.
    if (e.type === "RUN_ERROR" && e.message) {
      return { failed: true, message: firstLine(e.message), shape: "RUN_ERROR" };
    }

    // v2 — the error message pushed into the chat.
    const value = asRecord(e.value);
    if (value?.event_type === "error") {
      const text = asRecord(asRecord(value.data)?.data)?.text ?? value.data;
      return {
        failed: true,
        message: firstLine(text) || "flow emitted an error event with no text",
        shape: "event_type=error",
      };
    }

    // v2 — a node that ended in error, which carries the component context.
    for (const patch of Array.isArray(e.delta) ? e.delta : []) {
      const node = asRecord(asRecord(patch)?.value);
      if (node?.status !== "error") continue;
      const outputs = asRecord(asRecord(node.output)?.outputs) ?? {};
      for (const output of Object.values(outputs)) {
        const message = asRecord(asRecord(output)?.message);
        if (message?.errorMessage) {
          return {
            failed: true,
            message: firstLine(message.errorMessage),
            shape: "node status=error",
          };
        }
      }
      return {
        failed: true,
        message: `node ${asRecord(patch)?.path ?? "(unknown)"} ended with status=error`,
        shape: "node status=error",
      };
    }

    // v1 — kept verbatim from the inline detector.
    const data = asRecord(e.data);
    if (typeof data?.build_data?.params === "string" && data.build_data.params.startsWith("Error")) {
      return { failed: true, message: firstLine(data.build_data.params), shape: "build_data.params" };
    }
    if (data?.error === true || e.error === true) {
      return {
        failed: true,
        message: firstLine(data?.error_message ?? e.error_message) || "Unknown error",
        shape: "error=true",
      };
    }
  }

  for (const pattern of EXCEPTION_PATTERNS) {
    const match = String(body ?? "").match(pattern);
    if (match) return { failed: true, message: match[0].slice(0, 400), shape: "python exception" };
  }

  return { failed: false };
}
