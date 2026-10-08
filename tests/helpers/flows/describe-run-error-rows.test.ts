// Unit tests for describe-run-error-rows (#1689).
// Run with: npm run test:units
//
// The context_id specs require every row of a session to carry the configured
// context_id. A failed run persists an error row with `context_id: null`, so a
// drained provider key was reported as a context_id tagging failure. The helper
// names the failed run instead, and these tests pin the two properties that
// make it usable on a failing path: it recognises the measured row, and it
// never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRunErrorRows, isRunErrorRow } from "./describe-run-error-rows";

/** The error row `GET /api/v1/monitor/messages` returned for #1689. */
const DRAINED_KEY_ROW = {
  sender: "Agent",
  context_id: null,
  category: "error",
  properties: { icon: "error", text_color: "red", background_color: "red", state: "complete" },
  text:
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': " +
    "'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to " +
    "upgrade or purchase credits.'}}",
};

const USER_ROW = { sender: "User", context_id: "ctx-1", category: "message", text: "hi (probe-1)" };
const AGENT_REPLY = { sender: "Machine", context_id: "ctx-1", category: "message", text: "Hello!" };

test("a healthy session has no error rows", () => {
  assert.equal(describeRunErrorRows([USER_ROW, AGENT_REPLY]), null);
});

test("the measured #1689 row is named, with its provider error quoted", () => {
  const message = describeRunErrorRows([USER_ROW, DRAINED_KEY_ROW]);
  assert.ok(message, "an error row must produce a message");
  assert.match(message, /^RUN_ERRORED:/);
  assert.match(message, /1 error row\(s\)/);
  assert.match(message, /\[Agent\]/);
  assert.match(message, /credit balance is too low/);
  // The point of the helper: the message must not read as a tagging failure.
  assert.doesNotMatch(message, /context_id/);
});

test("each signal is enough on its own", () => {
  assert.equal(isRunErrorRow({ category: "error" }), true);
  assert.equal(isRunErrorRow({ category: "message", properties: { icon: "error" } }), true);
  assert.equal(isRunErrorRow({ category: "message", properties: { icon: "Bot" } }), false);
  assert.equal(isRunErrorRow({ category: "message" }), false);
});

test("long error text is capped and every error row is listed", () => {
  const long = { ...DRAINED_KEY_ROW, text: "x".repeat(5000) };
  const message = describeRunErrorRows([long, { category: "error", sender: "Chat Output", text: "second" }]);
  assert.ok(message);
  assert.match(message, /2 error row\(s\)/);
  assert.match(message, /…/);
  assert.match(message, /\[Chat Output\] "second"/);
  assert.ok(message.length < 1000, `message is ${message.length} chars`);
});

test("it never throws, whatever the payload holds", () => {
  const hostile = [
    null,
    undefined,
    42,
    "error",
    { category: "error", sender: 7, text: { nested: true } },
    { category: "error", properties: null },
    Object.defineProperty({ category: "error" }, "text", {
      get() {
        throw new Error("boom");
      },
    }),
  ];
  assert.doesNotThrow(() => describeRunErrorRows(hostile));
  assert.match(describeRunErrorRows(hostile) ?? "", /^RUN_ERRORED:/);
  assert.equal(describeRunErrorRows(undefined as unknown as unknown[]), null);
});

test("an error row with no text still names the failure", () => {
  assert.match(describeRunErrorRows([{ category: "error", sender: "Agent" }]) ?? "", /\[Agent\] <no error text>/);
});
