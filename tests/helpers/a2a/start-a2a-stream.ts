/**
 * Start a `message/stream` run and return its task id as soon as the server
 * announces it — while the run is still going.
 *
 * Why this cannot use Playwright's `APIRequestContext`: `request.post()` resolves
 * once the response is **buffered**, and an SSE run only ends when the run ends. By
 * then there is nothing left to cancel. Reading the body incrementally is the whole
 * point, so this uses the global `fetch` (same approach
 * `helpers/provider-setup/collect-models.ts` already takes) with the base URL the
 * caller passes in from Playwright's `baseURL` fixture.
 *
 * The caller is responsible for `close()` — leaving the reader open holds a
 * connection to a single-worker backend for the rest of the test file — or for
 * `drain()`, which reads the stream to its end and returns every frame it carried.
 */

/** One SSE `data:` payload, parsed. */
interface SseFrame {
  result?: { id?: string };
}

/**
 * Pull the first task id out of an SSE text chunk, or `null` if this chunk has none.
 *
 * Split out as a pure function so the frame handling is unit-testable without a
 * server: partial frames (a chunk that ends mid-JSON) must be tolerated rather than
 * throwing, because a chunk boundary can land anywhere.
 */
export function firstTaskIdInSseChunk(chunk: string): string | null {
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let frame: SseFrame;
    try {
      frame = JSON.parse(line.slice(5)) as SseFrame;
    } catch {
      // A truncated frame at the chunk boundary — the next read carries the rest.
      continue;
    }
    const id = frame.result?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** One SSE frame, reduced to what a lifecycle assertion reads. */
export interface A2aStreamFrame {
  /** `result.kind` (`task`, `status-update`, `artifact-update`), or `error` for an error frame. */
  kind: string;
  /** `result.status.state`, when the frame carries a status. */
  state: string | undefined;
  /** An `artifact-update`, or a `task` frame carrying its result inline. */
  hasArtifact: boolean;
}

interface SseResultFrame {
  result?: {
    kind?: string;
    status?: { state?: string };
    artifact?: unknown;
    artifacts?: unknown[];
  };
  error?: unknown;
}

/**
 * Every complete `data:` frame in an SSE text, in order.
 *
 * Measured on 1.13.0.dev34, the server ends lines with CRLF, so lines are split on
 * either. A truncated tail is skipped rather than thrown on — `drain()` hands this
 * whatever arrived, and a stream cut mid-frame is still evidence up to the cut. An
 * error frame is kept as `kind: "error"`: dropping it would let a stream that failed
 * read as one that merely carried nothing.
 */
export function parseSseFrames(text: string): A2aStreamFrame[] {
  const frames: A2aStreamFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let frame: SseResultFrame;
    try {
      frame = JSON.parse(line.slice(5)) as SseResultFrame;
    } catch {
      continue;
    }
    if (frame.error !== undefined) {
      frames.push({ kind: "error", state: undefined, hasArtifact: false });
      continue;
    }
    const result = frame.result ?? {};
    frames.push({
      kind: result.kind ?? "unknown",
      state: result.status?.state,
      hasArtifact: result.artifact !== undefined || (result.artifacts?.length ?? 0) > 0,
    });
  }
  return frames;
}

export interface StartedStream {
  /** The task id from the run's first identifying frame (`submitted`). */
  taskId: string;
  /** Milliseconds from request start to that id — reported so a spec can log the margin. */
  taskIdAtMs: number;
  /** Abandon the stream. Safe to call more than once. */
  close: () => Promise<void>;
  /**
   * Read the stream to its end and return EVERY frame it carried, including the ones
   * that arrived in the same read as the task id. Rejects naming the cause when the
   * stream has not ended within `timeoutMs` (and abandons it), so a run that never
   * finishes surfaces as that rather than as the test's own timeout.
   */
  drain: (options: { timeoutMs: number }) => Promise<A2aStreamFrame[]>;
}

/**
 * POST a JSON-RPC body to a flow's A2A endpoint as a stream and resolve once the
 * task id is known.
 *
 * Rejects if the stream ends without ever naming a task — an unevaluated run is
 * unknown, not clean, and a spec that silently proceeded with no id would assert
 * against `undefined`.
 */
export async function startA2aStream(
  baseURL: string,
  flowId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<StartedStream> {
  const startedAt = Date.now();
  const res = await fetch(
    new URL(`/api/v1/a2a/${flowId}/jsonrpc`, baseURL).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok || !res.body) {
    throw new Error(
      `message/stream did not open: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Every decoded byte, so drain() can return the frames that shared a read with the id.
  let received = "";
  const close = async () => {
    await reader.cancel().catch(() => {
      /* already closed */
    });
  };
  const drain = async ({ timeoutMs }: { timeoutMs: number }): Promise<A2aStreamFrame[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void close();
        reject(new Error(`the message/stream response did not end within ${timeoutMs} ms of the drain starting`));
      }, timeoutMs);
    });
    const readToEnd = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      return parseSseFrames(received);
    };
    try {
      return await Promise.race([readToEnd(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    received += chunk;
    const taskId = firstTaskIdInSseChunk(chunk);
    if (taskId) return { taskId, taskIdAtMs: Date.now() - startedAt, close, drain };
  }

  await close();
  throw new Error(
    "the message/stream response ended without ever carrying a task id — there is nothing to cancel, " +
      "which is a finding about the stream, not a reason to skip the assertion",
  );
}
