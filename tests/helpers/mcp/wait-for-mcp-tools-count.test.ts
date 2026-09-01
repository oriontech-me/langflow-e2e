// Unit tests for the MCP tool-count readiness wait (issue #1266).
// Run with: npm run test:units
//
// What rides on this helper: whether a slow probe ends the wait or is retried.
// The shape it replaces was `expect.poll` over a bare
// `page.request.get("/api/v2/mcp/servers?action_count=true")` with no explicit
// timeout, so the request inherited `playwright.config.ts` `actionTimeout: 20000`
// AND `expect.poll` propagated the throw instead of polling again — a poll
// declaring 120 000 ms that died on its first probe. Measured on the three
// dailies where the test was `@stable` (2026-07-30 / 08-03 / 08-04): attempt 0
// failed at 33-35 s, three times out of three, with
// `TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.`
//
// Both halves of that defect are pinned below — the retry (a failed probe is
// "not ready yet") and the explicit per-request budget (it can never inherit
// `actionTimeout` again). The message branches are pinned too, because the
// difference between "every probe timed out" and "the server never reported a
// count" is the whole diagnosis (#1012: a wait that gives up must say why).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import {
  MCP_TOOLS_COUNT_PROBE_TIMEOUT_MS,
  missingMcpToolsCountMessage,
  toolsCountOf,
  waitForMcpToolsCount,
} from "./wait-for-mcp-tools-count";

/** Records every probe so a test can assert what the helper actually asked for. */
function fakePage(
  responses: Array<
    | { throws: string }
    | { status: number; body?: unknown; text?: string }
  >,
) {
  const probes: Array<{ url: string; options?: { timeout?: number } }> = [];
  const sleeps: number[] = [];
  let i = 0;
  const page = {
    request: {
      get: async (url: string, options?: { timeout?: number }) => {
        probes.push({ url, options });
        const spec = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if ("throws" in spec) throw new Error(spec.throws);
        return {
          ok: () => spec.status >= 200 && spec.status < 300,
          status: () => spec.status,
          text: async () => spec.text ?? "",
          json: async () => spec.body,
        };
      },
    },
    waitForTimeout: async (ms: number) => {
      sleeps.push(ms);
    },
  } as unknown as Page;
  return { page, probes, sleeps };
}

const ready = (name: string, toolsCount: number | null) => ({
  status: 200,
  body: [{ name: "lf-starter_project", mode: null, toolsCount: null }, { name, mode: "stdio", toolsCount }],
});

test("a probe that throws is not ready yet, not the end of the wait", async () => {
  // THE defect. A transport timeout on the first probe used to abort a poll that
  // declared 120 s; it must now cost one interval and nothing else.
  const { page, probes } = fakePage([
    { throws: "apiRequestContext.get: Timeout 20000ms exceeded." },
    ready("test_server_12345", 13),
  ]);

  const count = await waitForMcpToolsCount(page, "test_server_12345", {
    timeout: 30_000,
    intervalMs: 10,
  });

  assert.equal(count, 13);
  assert.equal(probes.length, 2, "the failed probe must be retried, not propagated");
});

test("every probe carries an EXPLICIT timeout, so it can never inherit actionTimeout", async () => {
  // The regression guard for the other half: dropping the option would compile,
  // pass every behavioural test above, and silently restore the 20 s budget that
  // produced the recorded signature.
  const { page, probes } = fakePage([ready("srv", 3)]);

  await waitForMcpToolsCount(page, "srv", { timeout: 30_000, intervalMs: 10 });

  assert.equal(probes.length, 1);
  assert.match(probes[0].url, /\/api\/v2\/mcp\/servers\?action_count=true/);
  assert.equal(probes[0].options?.timeout, MCP_TOOLS_COUNT_PROBE_TIMEOUT_MS);
});

test("a non-2xx answer is not ready yet either", async () => {
  const { page, probes } = fakePage([
    { status: 500, text: "Internal Server Error" },
    ready("srv", 1),
  ]);

  assert.equal(await waitForMcpToolsCount(page, "srv", { timeout: 30_000, intervalMs: 10 }), 1);
  assert.equal(probes.length, 2);
});

test("a listed server whose toolsCount is still null keeps the wait going", async () => {
  // The real "still spinning up" shape: Langflow lists the server immediately and
  // fills `toolsCount` only once it has connected to it.
  const { page, probes } = fakePage([ready("srv", null), ready("srv", 13)]);

  assert.equal(await waitForMcpToolsCount(page, "srv", { timeout: 30_000, intervalMs: 10 }), 13);
  assert.equal(probes.length, 2);
});

test("the wait still goes red when the count never arrives", async () => {
  // A tolerant probe must not become a wait that cannot fail. This is the
  // assertion the fix is NOT allowed to weaken.
  const { page } = fakePage([ready("srv", null)]);

  await assert.rejects(
    () => waitForMcpToolsCount(page, "srv", { timeout: 30, intervalMs: 10 }),
    /never reported a tool count/i,
  );
});

test("toolsCountOf reads only the named server, and only a real count", () => {
  const body = [
    { name: "lf-starter_project", toolsCount: 7 },
    { name: "srv", toolsCount: null },
  ];
  assert.equal(toolsCountOf(body, "srv"), null, "null is not a count");
  assert.equal(toolsCountOf(body, "lf-starter_project"), 7);
  assert.equal(toolsCountOf(body, "absent"), null, "an unlisted server is not ready");
  // An error body is not an array. Read unchecked it throws `body.find is not a
  // function` inside the wait, hiding the status that explains the run.
  assert.equal(toolsCountOf({ detail: "Not authenticated" }, "srv"), null);
  assert.equal(toolsCountOf(null, "srv"), null);
  assert.equal(toolsCountOf([{ name: "srv", toolsCount: 0 }], "srv"), 0, "zero tools is an answer");
});

test("the failure message separates a dead transport from a server that never served tools", () => {
  const allFailed = missingMcpToolsCountMessage({
    serverName: "srv",
    waitedMs: 120_000,
    probes: 6,
    failedProbes: 6,
    lastProbeError: "apiRequestContext.get: Timeout 45000ms exceeded.",
  });
  assert.match(allFailed, /6 of 6/);
  assert.match(allFailed, /apiRequestContext\.get: Timeout 45000ms exceeded\./);
  assert.match(allFailed, /never answered/i);

  const neverReported = missingMcpToolsCountMessage({
    serverName: "srv",
    waitedMs: 120_000,
    probes: 6,
    failedProbes: 0,
    lastProbeError: null,
  });
  assert.match(neverReported, /never reported a tool count/i);
  assert.match(neverReported, /answered every probe/i);
  assert.doesNotMatch(neverReported, /apiRequestContext/);

  const mixed = missingMcpToolsCountMessage({
    serverName: "srv",
    waitedMs: 120_000,
    probes: 6,
    failedProbes: 2,
    lastProbeError: "HTTP 503 — upstream unavailable",
  });
  assert.match(mixed, /2 of 6/);
  assert.match(mixed, /HTTP 503 — upstream unavailable/);
  assert.match(mixed, /never reported a tool count/i);
});
