// Unit tests for the missing-tool-option attribution (issue #1422).
// Run with: npm run test:units
//
// What rides on this function: whether the next reader of this failure looks at
// the spec, at Langflow, or at the runner's npm path. On the 2026-08-11 daily
// the test died three times as
// `TimeoutError: … waiting for locator('[data-testid="sequentialthinking-0-option"]')`
// — a message that says "slow UI" and cost the issue a whole investigation
// directive to correct. The DOM at that moment (error-context artifact) read
// `Error loading server: Connection closed`: the stdio subprocess had died, and
// no budget would ever have helped. The two branches below are that split.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_TOOL_LIST_TIMEOUT_MS,
  missingMcpToolOptionMessage,
} from "./wait-for-mcp-tool-option";

test("a node error is reported as a dead server, not as a slow list", () => {
  const msg = missingMcpToolOptionMessage({
    optionTestId: "sequentialthinking-0-option",
    waitedMs: MCP_TOOL_LIST_TIMEOUT_MS,
    refreshes: 3,
    nodeError: "Error loading server: Connection closed",
  });

  // The product's own words, verbatim — this is the string that decides triage.
  assert.match(msg, /Error loading server: Connection closed/);
  assert.match(msg, /never served a tool list/i);
  assert.match(msg, /no wait can help/i);
  // The reader must know Langflow will not clear this on its own, so a green
  // re-run is not evidence the state healed itself.
  assert.match(msg, /does NOT retry this by itself/);
  // Both the budget and the refresh count are facts about what was already
  // tried; without them the message invites "just raise the timeout" again.
  assert.match(msg, new RegExp(`${MCP_TOOL_LIST_TIMEOUT_MS}ms`));
  assert.match(msg, /3 "Refresh list" attempt/);
});

test("no node error is reported as a wrong tool set, not as a dead server", () => {
  // The other side of the split: the server answered and the list resolved, it
  // just does not carry this tool — a package/version change, where blaming the
  // stdio path or the runner's npm would send the reader at the wrong layer.
  const msg = missingMcpToolOptionMessage({
    optionTestId: "echo-0-option",
    waitedMs: MCP_TOOL_LIST_TIMEOUT_MS,
    refreshes: 0,
    nodeError: null,
  });

  assert.match(msg, /echo-0-option/);
  assert.match(msg, /does not\s+serve this tool/i);
  assert.match(msg, /not as a timing problem/i);
  assert.doesNotMatch(msg, /stdio subprocess died/i);
});

test("a node bound to another server outranks both other branches", () => {
  // Measured on 1.12.0.dev25: after the modal created `test_server_12345` the
  // component was still holding `lf-starter_project`, so its tool list resolved
  // — correctly, for the wrong server — carrying that project's flows and NO
  // error label. Both other branches would have lied about it: the no-error
  // branch blames the package for serving a different tool set, and a
  // node-error branch would blame a dead subprocess. Neither would have sent
  // the reader at the component's server binding.
  const msg = missingMcpToolOptionMessage({
    optionTestId: "sequentialthinking-0-option",
    waitedMs: MCP_TOOL_LIST_TIMEOUT_MS,
    refreshes: 3,
    nodeError: null,
    boundServer: "lf-starter_project",
    expectedServer: "test_server_12345",
  });

  assert.match(msg, /bound to MCP server "lf-starter_project"/);
  assert.match(msg, /NOT "test_server_12345"/);
  assert.match(msg, /no refresh of this list can fix that/i);
  assert.doesNotMatch(msg, /does not\s+serve this tool/i);
});

test("a matching binding does not trigger the wrong-server branch", () => {
  // The binding is only a verdict when it DISAGREES: with the right server
  // bound, the failure is about the tool list again, and hijacking the message
  // would send the reader chasing a selection that is correct.
  const msg = missingMcpToolOptionMessage({
    optionTestId: "echo-0-option",
    waitedMs: MCP_TOOL_LIST_TIMEOUT_MS,
    refreshes: 1,
    nodeError: "Error loading server: Connection closed",
    boundServer: "test_server_12345",
    expectedServer: "test_server_12345",
  });

  assert.match(msg, /Error loading server: Connection closed/);
  assert.doesNotMatch(msg, /bound to MCP server/);
});

test("the option under test is always named", () => {
  // The helper is called three times in one test with three different options
  // (#1422's spec: A's tool, B's tool, then A's again). A message that omitted
  // it would leave the reader unable to tell WHICH of the three waits ran out.
  for (const optionTestId of [
    "sequentialthinking-0-option",
    "echo-0-option",
  ]) {
    const msg = missingMcpToolOptionMessage({
      optionTestId,
      waitedMs: 1000,
      refreshes: 1,
      nodeError: null,
    });
    assert.match(msg, new RegExp(optionTestId));
    assert.match(msg, /dropdown_str_tool/);
  }
});
