/**
 * Captures the body of a v2 run stream AS IT ARRIVES, instead of asking for it
 * afterwards (#1168).
 *
 * WHY THIS EXISTS
 *
 * `response.text()` does not read a body — it asks CDP for the one Chromium
 * buffered. That works while the resource is still around, and an SSE run stream
 * routinely outlives the test that started it: the UI shows the error, the spec
 * asserts and ends, the request is cancelled, and Chromium drops the partial
 * buffer. The ask then fails with
 *
 *     Protocol error (Network.getResponseBody): No resource with given identifier found
 *
 * Measured on 1.12.0.dev10 with `validate-raise-errors-components.spec.ts`: no
 * verdict at all, 3 runs out of 3, on a run that *did* emit
 * `event_type=error`. Waiting longer cannot help — the teardown drain was raised
 * 3 s -> 10 s and changed nothing, because the body is not slow, it is gone. So
 * the fixture's strongest gate was blind in exactly the case it exists for, and
 * whether a node run got a verdict came down to whether its stream happened to
 * close first.
 *
 * ## Why not `page.route` + `route.fetch()`
 *
 * The obvious tee buffers. `route.fetch()` hands back an `APIResponse` whose body
 * accessors (`body()`, `text()`, `json()`) are all-or-nothing — there is no
 * streaming read — so the fixture would have to hold the whole run before
 * calling `route.fulfill()`, and the page would receive it in one chunk at the
 * end. That breaks incremental delivery for every playground spec, starting with
 * `playground-response-streaming-sse.spec.ts`, which asserts on it directly.
 *
 * ## What this does instead
 *
 * `Network.streamResourceContent` tells Chromium to deliver the body through
 * `Network.dataReceived` as it arrives. Nothing is proxied, buffered or
 * re-fulfilled, so page-visible behaviour is unchanged by construction — the
 * fixture is a second reader, not a middleman.
 *
 * The payoff is that a CANCELLED stream still leaves every byte that arrived. A
 * partial body is enough: `parseStreamEvents()` tolerates a truncated tail, and
 * an SSE error event lands long before the stream closes.
 */
import type { CDPSession, Page } from "@playwright/test";
import { runStreamSurface } from "./flow-error-policy";

/**
 * How long `settle()` may spend waiting for verdicts that are still resolving.
 *
 * Each pending item is one CDP round-trip, so this is a backstop against a send
 * that never answers rather than a budget anyone expects to spend. Exceeding it
 * is not an error state: the residual keeps counting in `pendingStreams()`, so
 * a caller is told the verdict is undecided instead of being handed a clean one.
 */
const SETTLE_BUDGET_MS = 2_000;
/**
 * The same, at teardown. Larger because this is the last chance any verdict
 * gets — after it the session is detached and the bytes are gone — and nothing
 * is waiting on the result but the test's own summary.
 */
const DRAIN_BUDGET_MS = 5_000;

/** Resolve when `work` settles or the deadline passes, whichever is first. */
async function withDeadline(
  work: Promise<unknown>,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CapturedStream {
  url: string;
  body: string;
  /** False when the stream was still open — a cancelled run, usually. */
  complete: boolean;
}

export interface RunStreamCapture {
  /**
   * Hand over every stream still open, then stop capturing. Called at teardown:
   * these are precisely the ones the old `response.text()` path always lost.
   */
  drain: () => Promise<CapturedStream[]>;
  /**
   * Wait for the verdicts of streams that have already CLOSED, without touching
   * the ones still open and without detaching (#1452).
   *
   * `onStream` fires from an async continuation — a stream that hit
   * `loadingFinished` may still be resolving its body one CDP round-trip later —
   * so a caller asking "did this run produce a flow error?" mid-test would race
   * it and read a verdict that had not landed. This is the half of `drain()` that
   * is safe to call while the test is still running: it settles what is decided
   * and leaves what is not.
   *
   * Bounded by construction: each pending item is one round-trip, never a wait on
   * the network.
   */
  settle: (budgetMs?: number) => Promise<void>;
  /**
   * How many v2 runs have NO verdict yet — for any of the three reasons there
   * are, which is the part that took a review to get right (#1452).
   *
   * Not just the open streams. A run counts as undecided while:
   *
   *   - its response headers have not arrived (`requestWillBeSent` seen,
   *     `responseReceived` not) — a backend still thinking about the request;
   *   - its stream is open and receiving;
   *   - its stream has CLOSED but the body is still resolving. `finish()`
   *     removes the entry from `open` BEFORE tracking the continuation, so
   *     counting only `open` reported such a run as decided while its verdict
   *     was one CDP round-trip away — invisible, and exactly the false-clean
   *     this accessor exists to prevent.
   *
   * A caller rendering a clean verdict while any of the three is true would be
   * reporting on a run that has not finished.
   */
  pendingStreams: () => number;
  /**
   * v2 runs whose response was NOT 200, so no stream was ever captured.
   *
   * The capture ignores them by design — there is nothing to read — but they are
   * not nothing: a run that answered 500 crashed harder than one that streamed
   * an error, and an HTTP error never fails a test on its own (#1084). Counting
   * them lets the report call such a run unevaluated instead of clean.
   */
  nonOkRuns: () => number;
  /**
   * False when no CDP session could be opened, so NOTHING on the v2 path was
   * watched. The caller must say so rather than render a clean verdict — an
   * unwatched surface is unknown, not clean (#1012).
   */
  available: boolean;
}

/** A capture that never fires, for when CDP is unavailable (non-Chromium). */
const INERT: RunStreamCapture = {
  drain: async () => [],
  settle: async () => {},
  pendingStreams: () => 0,
  nonOkRuns: () => 0,
  available: false,
};

/**
 * Start capturing v2 run streams on `page`.
 *
 * `onStream` fires as soon as a stream finishes, so a verdict can still be
 * logged DURING the test rather than only in its summary. Streams still open at
 * teardown come back from `drain()`.
 *
 * Never throws: a page that cannot give a CDP session (a non-Chromium project,
 * a context already closing) degrades to no capture rather than failing every
 * test in the suite. The caller keeps its own accounting either way.
 */
export async function attachRunStreamCapture(
  page: Page,
  onStream: (stream: CapturedStream) => void,
): Promise<RunStreamCapture> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
  } catch {
    return INERT;
  }

  /** Requests seen, so `responseReceived` can recover the URL and method. */
  const requests = new Map<string, { url: string; method: string }>();
  /** Chunks per captured stream. Buffers, not strings: a chunk boundary can
   *  split a multi-byte character, and decoding per chunk would corrupt it. */
  const open = new Map<
    string,
    { url: string; chunks: Buffer[]; streaming: Promise<void> }
  >();
  /** `finish` is async (it may fall back to a CDP round-trip); teardown must not
   *  render its verdict while one of those is still resolving. */
  const settling = new Set<Promise<void>>();
  /** v2 runs that answered non-200, so no stream exists to judge (#1452). */
  let nonOk = 0;

  const track = (work: Promise<void>) => {
    settling.add(work);
    void work.finally(() => settling.delete(work));
  };

  const finish = (requestId: string, complete: boolean) => {
    const entry = open.get(requestId);
    if (!entry) return;
    open.delete(requestId);
    track(
      (async () => {
        // The enable round-trip may still be in flight: a short response can
        // finish before it lands, and its `bufferedData` is then the only copy
        // of the body.
        await entry.streaming;
        let body = Buffer.concat(entry.chunks).toString("utf8");
        if (!body) {
          // Finished before streaming was enabled at all. This is the OPPOSITE
          // failure to the one this module exists for, and the fallback is the
          // old path — which works precisely here, because a response that just
          // completed is still buffered. The two together cover both ends: a
          // stream that outlives its test, and one that ends before capture
          // could start.
          body = await session
            .send("Network.getResponseBody", { requestId })
            .then((r) =>
              r.base64Encoded
                ? Buffer.from(r.body, "base64").toString("utf8")
                : r.body,
            )
            .catch(() => "");
        }
        onStream({ url: entry.url, body, complete });
      })(),
    );
  };

  session.on("Network.requestWillBeSent", (event) => {
    // Only what could become a run stream: keeping every request would grow a
    // map for the whole test on a page that fires hundreds.
    if (runStreamSurface(event.request.url, event.request.method) !== "v2") {
      return;
    }
    requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
    });
  });

  session.on("Network.responseReceived", (event) => {
    const request = requests.get(event.requestId);
    requests.delete(event.requestId);
    if (!request) return;
    if (event.response.status !== 200) {
      // No stream to capture, and not a non-event either: this run produced no
      // verdict at all, and the fixture's HTTP channel never fails a test on its
      // own (#1084). Counted so the report can say so (#1452).
      nonOk += 1;
      return;
    }

    // The entry is registered synchronously, before the enable round-trip: this
    // handler cannot be async without `dataReceived` racing ahead of it.
    // `bufferedData` covers whatever arrived in the meantime.
    const entry: { url: string; chunks: Buffer[]; streaming: Promise<void> } = {
      url: request.url,
      chunks: [],
      streaming: Promise.resolve(),
    };
    entry.streaming = session
      .send("Network.streamResourceContent", { requestId: event.requestId })
      .then(({ bufferedData }) => {
        if (bufferedData) {
          entry.chunks.unshift(Buffer.from(bufferedData, "base64"));
        }
      })
      .catch(() => {
        // Streaming could not be enabled — the request had already finished, or
        // was cancelled. Deliberately NOT recorded as a failure: `finish` still
        // asks for the buffered body, and that fallback usually succeeds. Only
        // an EMPTY result means the stream went unevaluated, and the caller
        // already counts that. Reporting it here made a stream that was
        // evaluated fine show up under "verdict is unknown".
      });
    open.set(event.requestId, entry);
  });

  session.on("Network.dataReceived", (event) => {
    const entry = open.get(event.requestId);
    if (!entry || !event.data) return;
    entry.chunks.push(Buffer.from(event.data, "base64"));
  });

  session.on("Network.loadingFinished", (event) => {
    requests.delete(event.requestId);
    finish(event.requestId, true);
  });
  session.on("Network.loadingFailed", (event) => {
    // Dropped from `requests` too, not only from `open`: a request that dies
    // BEFORE `responseReceived` never had an entry in `open`, and leaving it in
    // `requests` would count it as undecided for the rest of the test — a
    // `pending` that never comes down, so `clean` could never be true again.
    requests.delete(event.requestId);
    finish(event.requestId, false);
  });

  /**
   * Drain `settling` until it stays empty. One `allSettled` is not enough: a
   * body resolving during the await can call `finish` for the NEXT stream and
   * re-populate the set, and that item would then be missed by a caller that
   * asked once. Capped rather than looped to exhaustion — a page that keeps
   * closing streams must not be able to hold a teardown open — and the cap being
   * reached is not an error state: whatever is left is simply still pending, and
   * `pendingStreams()` says so.
   */
  const settle = async (budgetMs = SETTLE_BUDGET_MS): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    for (let pass = 0; pass < 5 && settling.size > 0; pass++) {
      if (Date.now() >= deadline) break;
      // Raced against the remaining budget, because "bounded by construction" is
      // bounded in ROUND TRIPS, not in time: a CDP send that never answers would
      // otherwise hold the caller to the 5-minute test timeout, where the v1 read
      // next door gives up after 2 s. Giving up here is safe precisely because
      // whatever is left still counts in `pendingStreams()` — the residual is
      // reported, never assumed settled.
      await withDeadline(Promise.allSettled([...settling]), deadline);
    }
  };

  return {
    available: true,
    settle,
    pendingStreams: () => open.size + settling.size + requests.size,
    nonOkRuns: () => nonOk,
    drain: async () => {
      // Streams that finished while the test was ending may still be resolving
      // their body. Awaiting them here is bounded by construction — each is one
      // CDP round-trip, not a wait on the network.
      await settle(DRAIN_BUDGET_MS);

      const remaining: CapturedStream[] = [];
      for (const [requestId, entry] of open) {
        remaining.push({
          url: entry.url,
          body: Buffer.concat(entry.chunks).toString("utf8"),
          complete: false,
        });
        open.delete(requestId);
      }
      // Detached rather than left to the context: a session per page across the
      // whole suite is worth closing explicitly, and a failure here must not
      // mask the verdicts just collected.
      await session.detach().catch(() => {});
      return remaining;
    },
  };
}
