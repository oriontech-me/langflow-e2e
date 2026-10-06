import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { firstTaskIdInSseChunk, parseSseFrames, startA2aStream } from "./start-a2a-stream";

// The frame parser is the part that can silently go wrong: a chunk boundary can land
// anywhere in the byte stream, and a parser that throws on a truncated frame would
// abort a run the spec still needs to cancel. These cover the shapes measured on
// 1.12.0.dev14 plus the boundary cases the network makes inevitable.

test("reads the task id out of the submitted frame", () => {
  const chunk =
    'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"task","id":"e4edb3a1-cac7-4db4-9e62-c7fff11aefdb","status":{"state":"submitted"}}}\n\n';
  assert.equal(firstTaskIdInSseChunk(chunk), "e4edb3a1-cac7-4db4-9e62-c7fff11aefdb");
});

test("returns the FIRST id when a chunk carries several frames", () => {
  const chunk =
    'data: {"result":{"id":"first","status":{"state":"submitted"}}}\n' +
    'data: {"result":{"id":"second","status":{"state":"working"}}}\n';
  assert.equal(firstTaskIdInSseChunk(chunk), "first");
});

test("tolerates a frame truncated at the chunk boundary instead of throwing", () => {
  // The run continues and the next read carries the rest; throwing here would kill a
  // cancel the spec is about to issue.
  assert.equal(firstTaskIdInSseChunk('data: {"result":{"id":"trunc'), null);
});

test("keeps reading past a truncated frame to a complete one in the same chunk", () => {
  const chunk = 'data: {"result":{"id":"bro\ndata: {"result":{"id":"good"}}\n';
  assert.equal(firstTaskIdInSseChunk(chunk), "good");
});

test("ignores SSE lines that are not data payloads", () => {
  assert.equal(firstTaskIdInSseChunk(": keep-alive\nevent: status\n\n"), null);
});

test("treats a frame without an id as carrying no id", () => {
  assert.equal(firstTaskIdInSseChunk('data: {"result":{"status":{"state":"working"}}}\n'), null);
});

test("an empty id is not an id", () => {
  // An empty string would pass a truthiness check on `result.id` in a naive parser and
  // then be sent to tasks/cancel as `{"id":""}`.
  assert.equal(firstTaskIdInSseChunk('data: {"result":{"id":""}}\n'), null);
});

// --- #2196: the rest of the stream ------------------------------------------------
//
// The cancel test reads the stream to its END to see whether the run stopped or
// finished. Measured on 1.13.0.dev34, the server separates frames with CRLF, and the
// frames that arrive in the same chunk as the task id are part of the answer — a
// drain that started from the next read would lose `working` and could lose the
// terminal frame itself.

test("parseSseFrames reads kind, state and artifact presence from a CRLF stream", () => {
  const text =
    'data: {"id":"s","jsonrpc":"2.0","result":{"id":"t1","kind":"task","status":{"state":"submitted"}}}\r\n\r\n' +
    'data: {"id":"s","jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"working"},"taskId":"t1"}}\r\n\r\n' +
    'data: {"id":"s","jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"artifactId":"a1","parts":[]},"taskId":"t1"}}\r\n\r\n' +
    'data: {"id":"s","jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"completed"},"taskId":"t1"}}\r\n\r\n';
  assert.deepEqual(parseSseFrames(text), [
    { kind: "task", state: "submitted", hasArtifact: false },
    { kind: "status-update", state: "working", hasArtifact: false },
    { kind: "artifact-update", state: undefined, hasArtifact: true },
    { kind: "status-update", state: "completed", hasArtifact: false },
  ]);
});

test("parseSseFrames counts a task frame that carries artifacts as an artifact", () => {
  // A terminal `task` frame can carry the result inline instead of an artifact-update.
  const text = 'data: {"result":{"id":"t1","kind":"task","status":{"state":"completed"},"artifacts":[{"artifactId":"a1"}]}}\n\n';
  assert.deepEqual(parseSseFrames(text), [{ kind: "task", state: "completed", hasArtifact: true }]);
});

test("parseSseFrames names an error frame instead of dropping it", () => {
  // Dropping it would let a stream that failed read as one that carried nothing.
  const text = 'data: {"jsonrpc":"2.0","id":"s","error":{"code":-32603,"message":"boom"}}\n\n';
  assert.deepEqual(parseSseFrames(text), [{ kind: "error", state: undefined, hasArtifact: false }]);
});

test("parseSseFrames skips a truncated tail and non-data lines", () => {
  const text =
    ": keep-alive\n" +
    "event: message\n" +
    'data: {"result":{"kind":"status-update","status":{"state":"canceled"}}}\n\n' +
    'data: {"result":{"kind":"status-up';
  assert.deepEqual(parseSseFrames(text), [{ kind: "status-update", state: "canceled", hasArtifact: false }]);
});

/** A local SSE endpoint at the path startA2aStream posts to. */
async function sseServer(
  chunks: Array<{ text: string; delayMs?: number }>,
  { end }: { end: boolean },
): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) {
      if (chunk.delayMs) await new Promise((r) => setTimeout(r, chunk.delayMs));
      res.write(chunk.text);
    }
    if (end) res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const FRAME = (result: Record<string, unknown>) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: "s", result })}\r\n\r\n`;

test("drain returns every frame, including the ones that arrived with the task id", async () => {
  const server = await sseServer(
    [
      { text: FRAME({ id: "t1", kind: "task", status: { state: "submitted" } }) + FRAME({ kind: "status-update", status: { state: "working" } }) },
      { text: FRAME({ kind: "status-update", status: { state: "canceled" } }), delayMs: 30 },
    ],
    { end: true },
  );
  try {
    const stream = await startA2aStream(server.baseURL, "flow", { method: "message/stream" }, {});
    assert.equal(stream.taskId, "t1");
    const frames = await stream.drain({ timeoutMs: 5_000 });
    assert.deepEqual(
      frames.map((f) => f.state),
      ["submitted", "working", "canceled"],
    );
  } finally {
    await server.close();
  }
});

test("drain rejects naming the cause when the stream does not end in time", async () => {
  const server = await sseServer([{ text: FRAME({ id: "t1", kind: "task", status: { state: "submitted" } }) }], { end: false });
  try {
    const stream = await startA2aStream(server.baseURL, "flow", { method: "message/stream" }, {});
    await assert.rejects(stream.drain({ timeoutMs: 200 }), /did not end within 200 ms/);
  } finally {
    await server.close();
  }
});
