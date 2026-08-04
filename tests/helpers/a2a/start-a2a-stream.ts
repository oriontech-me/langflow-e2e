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
 * connection to a single-worker backend for the rest of the test file.
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

export interface StartedStream {
  /** The task id from the run's first identifying frame (`submitted`). */
  taskId: string;
  /** Milliseconds from request start to that id — reported so a spec can log the margin. */
  taskIdAtMs: number;
  /** Abandon the stream. Safe to call more than once. */
  close: () => Promise<void>;
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
  const close = async () => {
    await reader.cancel().catch(() => {
      /* already closed */
    });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const taskId = firstTaskIdInSseChunk(decoder.decode(value, { stream: true }));
    if (taskId) return { taskId, taskIdAtMs: Date.now() - startedAt, close };
  }

  await close();
  throw new Error(
    "the message/stream response ended without ever carrying a task id — there is nothing to cancel, " +
      "which is a finding about the stream, not a reason to skip the assertion",
  );
}
