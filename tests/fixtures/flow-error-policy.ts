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
  /**
   * A run failed, but for a reason outside the system under test: the provider
   * refused or throttled the call. Reported as UNEVALUATED — never as a failure,
   * and never as clean. See `PROVIDER_OUTAGE_PATTERNS`.
   */
  | { failed: false; providerOutage: string; message: string; shape: string }
  /** Nothing in this body says a run failed. */
  | { failed: false };

/**
 * Which run-stream surface a response belongs to — and therefore how strong the
 * verdict may be.
 *
 *   "v1"  the endpoints the fixture has ALWAYS watched. A verdict here fails the
 *         test, as it did before — but see "what v1 gained" below: "unchanged"
 *         would be inaccurate, and this gate exists to stop that kind of claim.
 *   "v2"  `POST /api/v2/workflows`, the current playground/agent/node run path.
 *         A verdict here fails the test too, since #1165.
 *   null  not a run stream.
 *
 * ## v2 was staged, and what it cost to un-stage it
 *
 * Turning on a gate that has been dead for a whole endpoint is not a no-op, so
 * #1162 shipped the v2 verdict as ADVISORY — computed and logged, never failing —
 * and #1165 flipped it after an audit. The audit is worth keeping here, because
 * the framing it started from was wrong in a way that would have made the flip
 * look far more dangerous than it was.
 *
 * The count that justified staging was "88 specs trigger a run, 75 without
 * `page.allowFlowErrors()`". That is how many specs COULD be affected. Measured
 * across five consecutive scheduled dailies, the advisory log named **ten**
 * distinct causes, and eight of them were specs provoking an error on purpose
 * that already carried the hatch — plus `flow-error-gate.spec.ts` itself, the
 * largest single emitter, which mocks a `RUN_ERROR` deliberately.
 *
 * The other two were the finding, and they are why `PROVIDER_OUTAGE_PATTERNS`
 * exists above: a Google embedding quota and a drained Anthropic key, delivered
 * inside the run stream on specs with no hatch. Failing on those would have
 * turned an empty account into stripped `@stable` tags.
 *
 * The instrument mattered as much as the result. #1165 asked for a full-suite
 * `manual.yml` dispatch, which that lane cannot finish at any cap (#1174: 32 of the
 * 298 specs are lane-gated and unreachable there, and the unvalidated remainder
 * retries twice against a 5-minute per-test timeout); the daily prints the same
 * advisory block every weekday, its job logs
 * outlive the 7-day artifact retention, and it is sharded — so a cause narrows to
 * one shard's 52 specs before any content matching. That last part is what
 * settled the rows the July inventory had to leave as "strong, not proof".
 *
 * ## What v1 gained (it is NOT unchanged)
 *
 * Nothing loosens — no path that failed a test before stops failing. But the
 * reverse direction is not empty either, and saying "v1 is unchanged" would send
 * whoever triages the first red down the wrong path:
 *
 *   - the old detector skipped BY CONTENT TYPE before it ever looked at the URL,
 *     so a v1 `text/event-stream` or `application/x-ndjson` body was never
 *     classified. Those are read now, and a verdict on them fails the test.
 *   - the `{"event": "error"}` envelope (below) is a v1 shape that never matched
 *     before, because its payload carries `error: false`.
 *
 * That is the same "turn a dead gate on" move this file argues against for v2, so
 * it needs its reason: `/api/v1/build/{id}/flow` has been retired since 1.11
 * (`ui-ux/execution-error-notification.spec.ts`), which is what the whole suite
 * runs against, so on every scheduled lane this is latent. It is live only for a
 * `manual.yml` dispatch at <= 1.10 — a supervised run. Staging v1 too would leave
 * the fixture with no failing flow-error gate at all, which is a real loss for a
 * hypothetical one; the honest bound is documented rather than removed.
 *
 * The read budget is bounded accordingly — see `SHORT_READ_TIMEOUT_MS` in
 * `fixtures.ts`: only v2 reads get the long budget, because only v2 reads are
 * drained at teardown.
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

/**
 * Errors that reach the run stream because the PROVIDER refused the call, not
 * because the flow is wrong (#1165).
 *
 * Why these cannot be an ordinary flow error. The harvest of five consecutive
 * scheduled dailies found ten distinct advisory causes; eight are specs
 * provoking an error on purpose, and the other two are these — a Google
 * embedding quota (`RESOURCE_EXHAUSTED`) on `rag-pipeline`, and a drained
 * Anthropic key (`credit balance is too low`) on
 * `openai-compatible-provider-setup`, both on specs with no
 * `page.allowFlowErrors()`. Neither says anything about Langflow.
 *
 * The cost of getting this wrong is not one red test, it is a tag. A failure the
 * fixture raises carries the text `Flow execution error detected during test`,
 * which matches nothing in `scripts/lib/infra-signature-patterns.json` — that
 * list is transport-level only (`apiRequestContext.*: Timeout`, `ECONNREFUSED`,
 * `ECONNRESET`, DNS). So `remove-stable-from-failures.ts` would score a drained
 * key as ATTRIBUTABLE and strip `@stable` in an unreviewed commit. This repo has
 * three recorded account drains (#772 openai, #1029 google, #1169 anthropic) and
 * the third is dated inside the harvest that found this.
 *
 * Narrow in SCOPE, not in wording. The alternative fixes were rejected: hatching
 * the two specs would silence genuine flow errors on them forever, and widening
 * the infra-signature list would change how flakes are filed across the whole
 * suite (`CONTRIBUTING.md` calls that "a deliberate change, not a convenience").
 *
 * But within that scope the patterns err WIDE, because the two errors do not
 * cost the same. A pattern that is too wide downgrades one run to UNEVALUATED —
 * counted, printed, never clean. A pattern that is too narrow fails a test on a
 * drained key, and that failure's text matches nothing in
 * `infra-signature-patterns.json`, so it is scored ATTRIBUTABLE and takes a tag.
 * The first version enumerated one token per provider and, measured on the real
 * payloads, missed three of the strings this repo already recognises elsewhere
 * (`no credits remaining`, `billing_not_active`, a bare 402).
 *
 * A match downgrades the verdict to UNEVALUATED, never to clean — the same rule
 * the fixture already applies to a stream it could not read (#1012).
 */
const PROVIDER_OUTAGE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  // Google, measured 2026-09-01: "Error embedding content (RESOURCE_EXHAUSTED):
  // 429 RESOURCE_EXHAUSTED. {'error': {'code': 429, …}}"
  { id: "quota-exhausted", pattern: /\bRESOURCE_EXHAUSTED\b/ },
  // Anthropic, measured 2026-09-02: "Error code: 400 - {'type': 'error',
  // 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance
  // is too low to access the Anthropic API. …'}}"
  { id: "credit-exhausted", pattern: /credit balance is too low/i },
  // OpenAI's equivalent. Not measured in the harvest — included because it is
  // the same account state under the third provider this suite runs, and the
  // one whose drain (#772) cost three specs their tag.
  //
  // Matched on the bare word, NOT on `insufficient_quota`, for two reasons the
  // review of this PR measured. (a) The provider says it twice in one payload —
  // `'message': 'You exceeded your current quota…'` at ~offset 50 and
  // `'type': 'insufficient_quota'` at ~offset 276 — and `providerOutage()` runs
  // on the message AFTER `summarize()` has cut it to 3 lines / 400 chars, so the
  // token that arrives last is the one a slightly longer component name drops.
  // The prose sits at the front and survives. (b) `run-node-and-wait.ts`
  // classifies the SAME run message with `/\bquota\b/i`; two lists disagreeing
  // about the same string is what produced this gap.
  { id: "quota-exhausted", pattern: /\bquota\b/i },
  // The drained-account wording of the OpenAI-COMPATIBLE endpoints, which is a
  // different string from either of the two above. Not a guess about a provider
  // we do not run: `openai-compatible-provider-setup.spec.ts:1029` already skips
  // on exactly these two tokens, and that spec is one of the two measured cases
  // this carve-out was built for — so leaving them out covered the harvest's
  // Anthropic half of that spec and not its OpenAI-compatible half.
  { id: "credit-exhausted", pattern: /no credits remaining|billing_not_active/i },
  // The billing refusal as a bare status, which is how an endpoint that returns
  // no JSON body words it. `\b402\b` is safe where a bare `429` is not: 429 is
  // the rate-limit status AND a plausible request id or token count, while 402
  // appears in neither — the suite has no other source of that number.
  { id: "payment-required", pattern: /\b402\b|payment required/i },
  // The rate-limit status as the provider words it inside the stream. Anchored
  // on the provider's own phrasing rather than a bare "429", which appears in
  // request ids and token counts.
  { id: "rate-limited", pattern: /\b(rate[ _-]?limit(ed|_error|s)?|too many requests)\b/i },
];

/**
 * Whether an error message is a provider outage rather than a flow failure, and
 * which kind. Matched against the message the shape carried, not the whole body:
 * a body-wide match would fire on an agent that merely *mentions* a rate limit,
 * which is the same false-positive engine the raw-traceback patterns are fenced
 * off from below.
 */
export function providerOutage(message: string): string | null {
  for (const { id, pattern } of PROVIDER_OUTAGE_PATTERNS) {
    if (pattern.test(message)) return id;
  }
  return null;
}

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" ? (value as Record<string, any>) : null;

/**
 * Collapse a multi-line error into one readable line.
 *
 * Explicitly NOT "the first line", which is why it is not called that:
 * `errorMessage` opens with `"Error building Component Agent: \n\n<the
 * provider's message>"`, so taking line 1 dropped the only part that says what
 * went wrong. Joins the leading lines instead, which is also what makes the
 * message useful in the run-history `error_signature`.
 */
const summarize = (text: unknown, limit = 400): string =>
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
  /**
   * The single exit for "this body says a run failed".
   *
   * Every shape returns through here so the provider-outage downgrade cannot be
   * added to one shape and forgotten on the next: the two measured cases arrived
   * as `event_type=error`, but the same provider message reaches `RUN_ERROR` and
   * `node status=error` on other runs, and a per-shape check would have covered
   * the ones that happened to be sampled.
   */
  const fail = (message: string, shape: string): FlowErrorVerdict => {
    const outage = providerOutage(message);
    return outage
      ? { failed: false, providerOutage: outage, message, shape }
      : { failed: true, message, shape };
  };

  const events = parseStreamEvents(body);
  for (const event of events) {
    const e = asRecord(event);
    if (!e) continue;

    // v2 — the terminal verdict of the run. Most direct, so checked first.
    if (e.type === "RUN_ERROR" && e.message) {
      return fail(summarize(e.message), "RUN_ERROR");
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
      return fail(
        summarize(text) || "flow emitted an error event with no readable text",
        "event_type=error",
      );
    }

    // v1 — the event envelope is `{"event": "<type>", "data": …}`
    // (`lfx/events/event_manager.py`), and its error payload carries
    // `error: false`, so the `data.error === true` check below never saw it.
    if (e.event === "error") {
      const data = asRecord(e.data);
      return fail(
        summarize(data?.text ?? data?.error_message ?? e.data) || "flow emitted an error event",
        "event=error",
      );
    }

    // v2 — a node that ended in error, which carries the component context.
    for (const patch of Array.isArray(e.delta) ? e.delta : []) {
      const node = asRecord(asRecord(patch)?.value);
      if (node?.status !== "error") continue;
      const outputs = asRecord(asRecord(node.output)?.outputs) ?? {};
      for (const output of Object.values(outputs)) {
        const message = asRecord(asRecord(output)?.message);
        if (message?.errorMessage) {
          return fail(summarize(message.errorMessage), "node status=error");
        }
      }
      return fail(
        `node ${asRecord(patch)?.path ?? "(unknown)"} ended with status=error`,
        "node status=error",
      );
    }

    // v1 — kept verbatim from the inline detector.
    const data = asRecord(e.data);
    if (typeof data?.build_data?.params === "string" && data.build_data.params.startsWith("Error")) {
      return fail(summarize(data.build_data.params), "build_data.params");
    }
    if (data?.error === true || e.error === true) {
      return fail(
        summarize(data?.error_message ?? e.error_message) || "Unknown error",
        "error=true",
      );
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
      if (match) return fail(match[0].slice(0, 400), "python exception");
    }
  }

  return { failed: false };
}
