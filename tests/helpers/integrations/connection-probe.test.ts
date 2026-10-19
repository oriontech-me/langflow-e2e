// Unit tests for the connection-resolution probe (#2296).
// Run with: npm run test:units
//
// The probe is an oracle: if its code or its parser drifts, every entry-point test
// reads the wrong verdict and stays green. So the load-bearing properties are that
// the generated Python declares exactly the handles it is given, that the parser
// reads both outcomes from raw AND JSON-escaped text without swallowing the
// separator, and that it refuses a field reported two different ways.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  driveListFlowSpec,
  DRIVE_LIST_TYPE,
  parseProbeOutput,
  probeComponentCode,
  probeFlowSpec,
} from "./connection-probe";

const USER = "11111111-2222-4333-8444-555555555555";
const INSTANCE = "66666666-7777-4888-9999-aaaaaaaaaaaa";

test("the probe declares one google ConnectionRefInput per target, valued with its handle", () => {
  const code = probeComponentCode([
    { field: "user_connection", handle: "google/probe_user_abc" },
    { field: "instance_connection", handle: "google/probe_instance_abc" },
  ]);
  assert.match(code, /ConnectionRefInput\(name="user_connection", display_name="user_connection", provider="google", value="google\/probe_user_abc"\)/);
  assert.match(code, /ConnectionRefInput\(name="instance_connection", .*value="google\/probe_instance_abc"\)/);
  assert.match(code, /for field in \("user_connection", "instance_connection",\):/);
  // It resolves through the host, and prints identity — never the credential itself.
  assert.match(code, /self\.resolve_connection\(field\)\.get_credential\(\)/);
  assert.doesNotMatch(code, /access_token|get_token|refresh_token/);
  // The join must reach Python as "\n", i.e. a backslash-n inside the string literal.
  assert.match(code, /Message\(text="\\n"\.join\(lines\)\)/);
});

test("a field that is not a Python identifier, a duplicate, or a non-google handle is refused", () => {
  assert.throws(() => probeComponentCode([]), /at least one target/);
  assert.throws(() => probeComponentCode([{ field: "user-connection", handle: "google/a" }]), /not a Python identifier/);
  assert.throws(
    () =>
      probeComponentCode([
        { field: "a", handle: "google/a" },
        { field: "a", handle: "google/b" },
      ]),
    /duplicate probe field/,
  );
  assert.throws(() => probeComponentCode([{ field: "a", handle: "slack/a" }]), /not a google handle/);
  assert.throws(() => probeComponentCode([{ field: "a", handle: 'google/a"); import os #' }]), /not a google handle/);
});

test("both outcomes are read from raw text", () => {
  const text =
    `PROBE user_connection resolved owner_kind=user connection_id=${USER}\n` +
    "PROBE instance_connection denied code=connection-not-authorized reason=anonymous-principal";
  assert.deepEqual(parseProbeOutput(text), {
    user_connection: { state: "resolved", ownerKind: "user", connectionId: USER },
    instance_connection: { state: "denied", code: "connection-not-authorized", reason: "anonymous-principal" },
  });
});

test("JSON-escaped text keeps the escaped newline out of every value", () => {
  // What a response body carries: the newline is a backslash and an n.
  const body = JSON.stringify({
    text: `PROBE user_connection resolved owner_kind=user connection_id=${USER}\nPROBE instance_connection resolved owner_kind=instance connection_id=${INSTANCE}`,
  });
  assert.deepEqual(parseProbeOutput(body), {
    user_connection: { state: "resolved", ownerKind: "user", connectionId: USER },
    instance_connection: { state: "resolved", ownerKind: "instance", connectionId: INSTANCE },
  });
});

test("an empty reason is read as empty, and text with no probe line reads as no outcome", () => {
  assert.deepEqual(parseProbeOutput("PROBE f denied code=scope-missing reason="), {
    f: { state: "denied", code: "scope-missing", reason: "" },
  });
  assert.deepEqual(parseProbeOutput("Hello, World!"), {});
});

test("the same field reported twice must agree", () => {
  const line = `PROBE user_connection resolved owner_kind=user connection_id=${USER}`;
  assert.deepEqual(parseProbeOutput(`${line} ... ${line}`), {
    user_connection: { state: "resolved", ownerKind: "user", connectionId: USER },
  });
  assert.throws(
    () => parseProbeOutput(`${line}\nPROBE user_connection denied code=connection-unresolved reason=missing`),
    /reported twice, differently/,
  );
});

test("the probe flow wires Chat Input -> Probe -> Chat Output, and the Drive oracle binds its handle", () => {
  const spec = probeFlowSpec([{ field: "user_connection", handle: "google/a" }]);
  assert.deepEqual(
    spec.nodes.map((n) => n.type),
    ["ChatInput", "CustomComponent", "ChatOutput"],
  );
  assert.deepEqual(
    spec.edges.map((e) => `${e.source}.${e.output}->${e.target}.${e.field}`),
    [
      "ChatInput-probe.message->CustomComponent-probe.in_text",
      "CustomComponent-probe.output->ChatOutput-probe.input_value",
    ],
  );
  const drive = driveListFlowSpec("google/b");
  assert.equal(drive.nodes[0].type, DRIVE_LIST_TYPE);
  assert.deepEqual(drive.nodes[0].values, { connection: "google/b" });
});
