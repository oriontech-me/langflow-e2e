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
 * Which run-stream surface a response belongs to — and therefore how strong the
 * verdict may be.
 *
 *   "v1"  the endpoints the fixture has ALWAYS watched. A verdict here fails the
 *         test, exactly as before; specs are calibrated to that.
 *   "v2"  `POST /api/v2/workflows`, the current playground/agent/node run path.
 *         New coverage, so a verdict here is ADVISORY for now — see the staging
 *         note below.
 *   null  not a run stream.
 *
 * ## Why v2 is advisory
 *
 * Turning on a gate that has been dead for a whole endpoint is not a no-op. 88
 * specs trigger a run (playground *or* node), 75 of them without
 * `page.allowFlowErrors()`, and some provoke an execution error deliberately —
 * `core-components/validate-raise-errors-components.spec.ts` raises a
 * `ValueError` from a custom component and asserts the error UI, is
 * `@stable @release`, and has no hatch because until now it never needed one.
 * Failing on the v2 path immediately would turn that spec (and an unmeasured
 * number of others) red for doing exactly what it is written to do.
 *
 * So this lands in two steps, the same way #1084 handled the HTTP half — fix the
 * classification first, decide about failing second:
 *
 *   step 1 (here) the verdict is computed and LOGGED with its cause, which is
 *                 all #1059 needed: the reason a run failed is in the output
 *                 instead of being inferred from a downstream timeout.
 *   step 2        flip v2 to failing, after auditing which of those 75 specs
 *                 provoke an error on purpose and hatching them. Step 1's own
 *                 log is what makes that audit cheap.
 *
 * Nothing loosens: v1 keeps failing tests today.
 */
export type RunStreamSurface = "v1" | "v2" | null;

// Anchored at the API root, not "contains". `/build/` and `/run/` as substrings
// matched `/assets/build/index.js` and `/api/v1/files/download/run/report.json`.
const V1_PATTERNS = [/^\/api\/v1\/build\//, /^\/api\/v1\/run\//];
const V2_RUN_PATH = /^\/api\/v2\/workflows$/;

export function runStreamSurface(url: string, method = "POST"): RunStreamSurface {
  let pathname: string;
  let search: string;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    return null;
  }

  // Anchored on the pathname, never a substring of the whole URL: `includes()`
  // matched `/assets/build/index.js` and any query string containing `/run/`.
  if (V2_RUN_PATH.test(pathname)) {
    // `/api/v2/workflows/pending` is a 5 s react-query poll, not a run — reading
    // it on every canvas spec is pure waste. Only the POST is a run.
    return method === "POST" ? "v2" : null;
  }
  if (V1_PATTERNS.some((p) => p.test(pathname)) || (pathname.endsWith("/events") && search.includes("event_delivery="))) {
    return "v1";
  }
  return null;
}

/** Back-compat helper for call sites that only need "is this a run stream". */
export function isRunStreamUrl(url: string, method = "POST"): boolean {
  return runStreamSurface(url, method) !== null;
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

/**
 * Collapse to a single readable line.
 *
 * NOT "the first line": `errorMessage` opens with
 * `"Error building Component Agent: \n\n<the provider's message>"`, so taking
 * line 1 dropped the only part that says what went wrong. Joins the leading
 * lines instead, which is also what makes the message useful in the run-history
 * `error_signature`.
 */
const firstLine = (text: unknown, limit = 400): string =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .slice(0, limit);

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
  const events = parseStreamEvents(body);
  for (const event of events) {
    const e = asRecord(event);
    if (!e) continue;

    // v2 — the terminal verdict of the run. Most direct, so checked first.
    if (e.type === "RUN_ERROR" && e.message) {
      return { failed: true, message: firstLine(e.message), shape: "RUN_ERROR" };
    }

    // v2 — the error message pushed into the chat. The payload shape varies by
    // emitter (`agui_translator.py`): the rich path nests a message under
    // `data.data`, the minimal one sends `{"error": "<text>"}`. Reading only the
    // first produced a verdict whose message was literally "[object Object]".
    const value = asRecord(e.value);
    if (value?.event_type === "error") {
      const data = asRecord(value.data);
      const text =
        asRecord(data?.data)?.text ??
        asRecord(data?.data)?.error ??
        data?.error ??
        data?.text ??
        (typeof value.data === "string" ? value.data : undefined);
      return {
        failed: true,
        message: firstLine(text) || "flow emitted an error event with no readable text",
        shape: "event_type=error",
      };
    }

    // v1 — the event envelope is `{"event": "<type>", "data": …}`
    // (`lfx/events/event_manager.py`), and its error payload carries
    // `error: false`, so the `data.error === true` check below never saw it.
    if (e.event === "error") {
      const data = asRecord(e.data);
      return {
        failed: true,
        message: firstLine(data?.text ?? data?.error_message ?? e.data) || "flow emitted an error event",
        shape: "event=error",
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

  // Raw-text traceback matching, ONLY for a body that is not a structured
  // stream. On a structured one it scans every assistant token and every echoed
  // prompt: an agent explaining `TypeError: unsupported operand` — or a tool
  // returning a traceback the agent then handled — would fail a healthy run.
  // Harmless while this code sat behind the event-stream skip; a false-positive
  // engine the moment the skip was lifted.
  if (events.length === 0) {
    for (const pattern of EXCEPTION_PATTERNS) {
      const match = String(body ?? "").match(pattern);
      if (match) return { failed: true, message: match[0].slice(0, 400), shape: "python exception" };
    }
  }

  return { failed: false };
}
