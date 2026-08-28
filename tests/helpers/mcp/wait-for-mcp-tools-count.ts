import type { Page } from "@playwright/test";

/**
 * Waits until a registered MCP server reports a tool count — issue #1266.
 *
 * `GET /api/v2/mcp/servers?action_count=true` is the only readiness signal
 * Langflow offers for "this server is up and its tools are known", and it is an
 * expensive one: `langflow/api/v2/mcp.py` builds a fresh MCP client for EVERY
 * registered server on EVERY call and disconnects it in `finally`, with no cache
 * and no concurrency cap, so a stdio server costs one `npx` subprocess per
 * request. Measured on nightly `1.12.0.dev39` (4 CPU, `LANGFLOW_WORKERS=1`) with
 * four registered servers: 1.25 s at one caller, 1.74-1.78 s at two, 3.03-4.09 s
 * at three, 4.16-6.52 s at four and 137.9 s at six — after which the instance's
 * own `lf-starter_project` stays "Error loading server: Connection closed" and
 * does not recover. A cold first call is 2.98 s at one server and 5.30 s at two.
 *
 * A caller is never alone on that curve: the page it has open queries the same
 * endpoint itself (`useGetMCPServers` issues both `?action_count=false` and
 * `?action_count=true`), and the daily runs `workers: 2` per shard over ten
 * `@stable` MCP files sharing one Langflow.
 *
 * So the probe must be allowed to be slow, and the wait must survive it. The
 * shape this replaces could do neither: an `expect.poll` over a bare
 * `page.request.get(...)` with no explicit timeout inherits the suite's
 * `actionTimeout: 20000` (`playwright.config.ts`), and `expect.poll` PROPAGATES a
 * throw from its poller instead of polling again — so the first probe to exceed
 * 20 s aborted a poll that declared 120 s. Measured: on the three dailies where
 * `mcp-server.spec.ts`'s tool-mode test ran `@stable`, attempt 0 failed at
 * 33 s / 35 s / 34 s — one probe, then out — 3 out of 3, always as
 * `TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.`
 *
 * What is NOT loosened: a server that never reports a count still fails the
 * test, now naming whether the probes failed or the server simply never served
 * a list.
 *
 * The remedy is the one `mcp-client-agent-gemini-tool-regression.spec.ts`
 * already carried inline; it lives here so the area has one copy.
 */

/** The readiness endpoint, with the query that makes Langflow actually connect. */
export const MCP_SERVERS_ACTION_COUNT_URL =
  "/api/v2/mcp/servers?action_count=true";

/**
 * Budget for ONE probe.
 *
 * Its only job is to be larger than `actionTimeout` — a probe that inherits the
 * 20 s action budget is the defect — while still bounding a request that has
 * stopped coming back, so the wait can retry it. 45 s sits above every latency
 * measured at a realistic caller count (6.5 s worst case at four concurrent
 * callers over four servers) and well below the 137.9 s pathological case, which
 * no probe should ever sit through.
 */
export const MCP_TOOLS_COUNT_PROBE_TIMEOUT_MS = 45_000;

/** Default budget for the whole wait, matching the family sibling's. */
export const MCP_TOOLS_COUNT_TIMEOUT_MS = 150_000;

/** Spacing between probes — the interval the polls this replaces already used. */
export const MCP_TOOLS_COUNT_INTERVAL_MS = 3_000;

/**
 * The tool count `serverName` currently reports, or `null` when it reports none.
 *
 * Everything that is not a number for THIS server is "not ready yet": the server
 * absent from the list, `toolsCount: null` (Langflow lists a server the moment it
 * is registered and fills the count only once it has connected), and a body that
 * is not an array at all. That last case is checked rather than assumed — an
 * error body such as `{"detail": "Not authenticated"}` read unchecked throws
 * `body.find is not a function` from inside the wait, hiding the status that
 * would have explained the run.
 */
export function toolsCountOf(body: unknown, serverName: string): number | null {
  if (!Array.isArray(body)) return null;
  const entry = (body as Array<{ name?: string; toolsCount?: number | null }>).find(
    (s) => s?.name === serverName,
  );
  return typeof entry?.toolsCount === "number" ? entry.toolsCount : null;
}

/**
 * Names why the wait gave up.
 *
 * The split that matters is whether the probes themselves failed. "Every probe
 * timed out" points at the endpoint under load; "the server answered every probe
 * and never reported a count" points at the server that was registered. A single
 * message covering both would send the next reader at the wrong layer — the
 * mis-attribution #1422 already paid for on this file's other wait.
 */
export function missingMcpToolsCountMessage(d: {
  serverName: string;
  waitedMs: number;
  probes: number;
  failedProbes: number;
  lastProbeError: string | null;
}): string {
  const head =
    `[waitForMcpToolsCount] MCP server "${d.serverName}" was not ready within ` +
    `${d.waitedMs}ms, across ${d.probes} probe(s) of ` +
    `${MCP_SERVERS_ACTION_COUNT_URL}.`;

  if (d.failedProbes === d.probes && d.probes > 0) {
    return (
      `${head} The endpoint never answered: ${d.failedProbes} of ${d.probes} ` +
      `probes failed, the last with "${d.lastProbeError}". This is a transport ` +
      `or backend-load problem, not a statement about the server that was ` +
      `registered — read it against the endpoint's cost, which grows with how ` +
      `many servers are registered and how many callers are in flight.`
    );
  }

  if (d.failedProbes > 0) {
    return (
      `${head} The server answered but never reported a tool count, and ` +
      `${d.failedProbes} of ${d.probes} probes also failed outright, the last ` +
      `with "${d.lastProbeError}". Both layers were unhealthy — decide which ` +
      `before changing either.`
    );
  }

  return (
    `${head} The endpoint answered every probe and the server never reported a ` +
    `tool count, so no probe budget can help: it was registered but never ` +
    `served a tool list — the stdio subprocess died, or the configured URL is ` +
    `unreachable or refused the stored credential. Langflow does not retry this ` +
    `by itself.`
  );
}

/**
 * Polls the readiness endpoint until `serverName` reports a tool count.
 *
 * A probe that throws or answers non-2xx is recorded and treated as "not ready
 * yet" — it costs one interval, never the wait. Resolves with the count.
 */
export async function waitForMcpToolsCount(
  page: Page,
  serverName: string,
  options: {
    timeout?: number;
    probeTimeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<number> {
  const timeout = options.timeout ?? MCP_TOOLS_COUNT_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? MCP_TOOLS_COUNT_PROBE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? MCP_TOOLS_COUNT_INTERVAL_MS;
  const deadline = Date.now() + timeout;

  let probes = 0;
  let failedProbes = 0;
  // Sticky on purpose: the last probe is routinely a healthy one that simply
  // reported no count, and overwriting with `null` there is how a wait that
  // spent its whole budget on timeouts ends up reporting "the server never
  // served a tool list".
  let lastProbeError: string | null = null;

  for (;;) {
    probes += 1;
    try {
      const resp = await page.request.get(MCP_SERVERS_ACTION_COUNT_URL, {
        timeout: probeTimeoutMs,
      });
      if (!resp.ok()) {
        failedProbes += 1;
        lastProbeError = `HTTP ${resp.status()} — ${await resp.text()}`;
      } else {
        const count = toolsCountOf(await resp.json(), serverName);
        if (count !== null) return count;
      }
    } catch (e) {
      failedProbes += 1;
      lastProbeError = String(e).split("\n")[0];
    }

    if (Date.now() >= deadline) break;
    await page.waitForTimeout(intervalMs);
  }

  throw new Error(
    missingMcpToolsCountMessage({
      serverName,
      waitedMs: timeout,
      probes,
      failedProbes,
      lastProbeError,
    }),
  );
}
