import test from "node:test";
import assert from "node:assert/strict";
import { firstTaskIdInSseChunk } from "./start-a2a-stream";

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
