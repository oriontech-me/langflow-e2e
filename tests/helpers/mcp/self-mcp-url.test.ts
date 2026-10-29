// Unit tests for the self-registration MCP URL.
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SELF_MCP_HOST, selfMcpUrl } from "./self-mcp-url";

const PROJECT = "adc69bb8-a537-498e-91c9-616f05149189";

test("every loopback spelling becomes the dedicated host, keeping port and path", () => {
  for (const base of ["http://localhost:7860/", "http://127.0.0.1:7860", "http://[::1]:7860/"]) {
    assert.equal(
      selfMcpUrl(PROJECT, base, DEFAULT_SELF_MCP_HOST),
      `http://lf-self.localhost:7860/api/v1/mcp/project/${PROJECT}/streamable`,
      base,
    );
  }
});

test("a non-loopback target is left alone", () => {
  // An RFC-1918 bind is already admitted by the lanes' CIDRs, and a remote
  // target is not something the loopback policy refuses.
  assert.equal(
    selfMcpUrl(PROJECT, "http://10.0.0.5:7860/", DEFAULT_SELF_MCP_HOST),
    `http://10.0.0.5:7860/api/v1/mcp/project/${PROJECT}/streamable`,
  );
  assert.equal(
    selfMcpUrl(PROJECT, "https://langflow.example.com/", DEFAULT_SELF_MCP_HOST),
    `https://langflow.example.com/api/v1/mcp/project/${PROJECT}/streamable`,
  );
});

test("the host can be overridden for an instance allowlisting another name", () => {
  assert.equal(
    selfMcpUrl(PROJECT, "http://localhost:7883/", "self.test"),
    `http://self.test:7883/api/v1/mcp/project/${PROJECT}/streamable`,
  );
});

test("the rewrite never produces a name the SSRF specs use as a refused destination", () => {
  // localhost / 127.0.0.1 must stay refusable: security/ssrf-url-validation,
  // model-provider-base-url-ssrf and agent-tool-error-handling depend on it.
  const host = new URL(selfMcpUrl(PROJECT, "http://localhost:7860/", DEFAULT_SELF_MCP_HOST)).hostname;
  assert.notEqual(host, "localhost");
  assert.notEqual(host, "127.0.0.1");
});
