import { expect, type Page } from "@playwright/test";

/**
 * Budget for a registered MCP server's tool list to reach the node's `tool`
 * dropdown — issue #1422.
 *
 * This is the budget the spec files used to hang on
 * `[data-testid="dropdown_str_tool"]:not([disabled])`, where it was never spent:
 * measured on nightly 1.12.0.dev24, that control is enabled **113–145 ms** after
 * the add-server modal closes, while the tool option itself appears at ~2 s on a
 * cold npm cache — and, when the stdio server fails to start, never. So the
 * enabled state says nothing about the list, and the 120 s belongs HERE, on the
 * observable that actually resolves late.
 */
export const MCP_TOOL_LIST_TIMEOUT_MS = 120_000;

/**
 * How many times the in-dropdown "Refresh list" affordance is exercised before
 * the wait gives up.
 *
 * A failed stdio start is TERMINAL in the UI: the node keeps
 * "Error loading server: …" and the dropdown keeps "No options found" forever —
 * measured, it does not retry itself. The daily's 2026-08-11 red (#1422) was
 * exactly that state on all 3 attempts, so a longer wait alone cannot clear it;
 * only re-querying can. Bounded on purpose: a server that genuinely never comes
 * up must still fail the test, and it does — every refresh returns the same
 * error and the wait ends in `missingMcpToolOptionMessage`.
 */
export const MCP_TOOL_LIST_MAX_REFRESHES = 3;

/**
 * Minimum spacing between two "Refresh list" clicks.
 *
 * Without it the three attempts are spent in the first ~2 s of a 120 s budget —
 * measured on the first version of this helper — which is the worst possible
 * placement: a stdio start that failed because the runner was momentarily
 * unable to fetch or spawn is exactly the case that needs the retries SPREAD.
 * At 10 s the loop still re-queries a state that Langflow itself never re-queries,
 * and it covers the first ~30 s of the budget rather than the first ~2 s.
 */
export const MCP_TOOL_LIST_REFRESH_INTERVAL_MS = 10_000;

/** The node's own error label, and the one the dropdown renders in its place. */
const NODE_ERROR_PATTERN = /Error loading (server|tools)/i;

/**
 * Names the cause when the tool never gets listed — the attribution the 10 s
 * `page.waitForSelector` this replaced could not give.
 *
 * On the 2026-08-11 daily all three attempts died as
 * `TimeoutError: … waiting for locator('[data-testid="sequentialthinking-0-option"]')`,
 * which reads as "the UI was slow". The `error-context` snapshot told the real
 * story — `Error loading server: Connection closed` on the node — and that
 * string is what decides whether the next reader looks at the spec, at Langflow,
 * or at the runner's npm path. It belongs in the failure message, not in an
 * artifact somebody has to know to download.
 */
export function missingMcpToolOptionMessage(d: {
  optionTestId: string;
  waitedMs: number;
  refreshes: number;
  nodeError: string | null;
  boundServer?: string | null;
  expectedServer?: string | null;
}): string {
  // Checked first: a node still bound to another server explains BOTH other
  // branches wrongly. Measured on 1.12.0.dev25 — the node kept
  // `lf-starter_project` after the modal created a new server, so the dropdown
  // listed that project's flows (new_flow, basic_prompting) with no error at
  // all, and the "wrong tool set" branch below would have blamed the package.
  if (
    d.expectedServer &&
    d.boundServer &&
    d.boundServer !== d.expectedServer
  ) {
    return (
      `[waitForMcpToolOption] "${d.optionTestId}" was never listed in ` +
      `dropdown_str_tool within ${d.waitedMs}ms, across ${d.refreshes} ` +
      `"Refresh list" attempt(s). The node is bound to MCP server ` +
      `"${d.boundServer}", NOT "${d.expectedServer}" — it is serving another ` +
      `server's tools, so the tool list is correct for the wrong server. ` +
      `Langflow did not switch the component to the server the modal just ` +
      `created; no refresh of this list can fix that.`
    );
  }

  const cause = d.nodeError
    ? `The node reported: "${d.nodeError}". The MCP server never served a tool ` +
      `list, so no wait can help — the stdio subprocess died (a package that ` +
      `cannot be installed, or a runner without a working npm path) or the ` +
      `server is unreachable. Langflow does NOT retry this by itself.`
    : `The node reported no error, so the server answered — it just does not ` +
      `serve this tool. Treat it as the package serving a different tool set, ` +
      `not as a timing problem.`;

  return (
    `[waitForMcpToolOption] "${d.optionTestId}" was never listed in ` +
    `dropdown_str_tool within ${d.waitedMs}ms, across ${d.refreshes} ` +
    `"Refresh list" attempt(s). ${cause}`
  );
}

/** Reads the node's error label, if it is showing one. */
async function readNodeError(page: Page): Promise<string | null> {
  const label = page.getByText(NODE_ERROR_PATTERN).first();
  if ((await label.count()) === 0) return null;
  return (await label.textContent().catch(() => null))?.trim() ?? null;
}

/**
 * Opens `dropdown_str_tool` and waits until it lists `optionTestId`, refreshing
 * the list when the node reports a load error.
 *
 * Pass `serverName` whenever the caller has just registered or re-selected a
 * server: the wait then starts by requiring the NODE to be bound to it. That
 * binding — not the tool control's enabled state — is the readiness signal this
 * surface actually has. Measured on 1.12.0.dev25: the tool control is
 * interactive ~140 ms after the add-server modal closes while the component can
 * still be pointing at the previously selected server, and a run that starts
 * refreshing there re-queries the WRONG server's list, which resolves happily
 * and never contains the expected tool.
 *
 * The dropdown is left OPEN on success, so the caller can click the option — the
 * same state the `page.getByTestId(...).click()` sequences already expected.
 */
export async function waitForMcpToolOption(
  page: Page,
  optionTestId: string,
  options: {
    timeout?: number;
    maxRefreshes?: number;
    refreshIntervalMs?: number;
    serverName?: string;
  } = {},
): Promise<void> {
  const timeout = options.timeout ?? MCP_TOOL_LIST_TIMEOUT_MS;
  const maxRefreshes = options.maxRefreshes ?? MCP_TOOL_LIST_MAX_REFRESHES;
  const refreshInterval =
    options.refreshIntervalMs ?? MCP_TOOL_LIST_REFRESH_INTERVAL_MS;
  const deadline = Date.now() + timeout;

  const serverWidget = page.getByTestId("mcp-server-dropdown");
  if (options.serverName) {
    // Fails HERE, naming the server the node actually holds, instead of 120 s
    // later as "this package does not serve that tool".
    await expect(serverWidget).toContainText(options.serverName, {
      timeout: Math.min(30_000, timeout),
    });
  }

  const dropdown = page.getByTestId("dropdown_str_tool");
  const option = page.getByTestId(optionTestId).first();
  // `refresh-dropdown-list-tool` lives inside the dropdown's popover, so its
  // visibility doubles as "the popover is open" — read from the 1.12.0.dev24
  // bundle (`data-testid`: `refresh-dropdown-list-${fieldName}`).
  const refresh = page.getByTestId("refresh-dropdown-list-tool");

  await dropdown.waitFor({
    state: "visible",
    timeout: Math.min(30_000, timeout),
  });

  let refreshes = 0;
  let lastRefreshAt = 0;
  let nodeError: string | null = null;

  while (Date.now() < deadline) {
    if (await option.isVisible().catch(() => false)) return;

    // Sticky, deliberately: the label is torn down while a refresh is in flight
    // and while the node re-renders, so the LAST read is routinely `null` on a
    // server that has been reporting "Connection closed" for two minutes.
    // Overwriting with that null is how the first version of this helper ended a
    // failed-stdio wait with "the server answered, it just does not serve this
    // tool" — the exact mis-attribution the message exists to prevent.
    const observed = await readNodeError(page);
    if (observed) nodeError = observed;

    if (!(await refresh.isVisible().catch(() => false))) {
      // Popover closed (first pass, or a refresh that re-rendered it): open it.
      await dropdown.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }

    // Not gated on the error being visible AT THIS INSTANT, for the same reason
    // the read above is sticky: measured, a repaired server was never re-queried
    // because the label happened to be absent on every tick after the first
    // refresh, and the wait then sat out its whole 120 s. The option check above
    // already means the list is not serving what we need, which is reason enough
    // to re-query — a refresh of a healthy-but-slow list only costs a request.
    if (refreshes < maxRefreshes && Date.now() - lastRefreshAt >= refreshInterval) {
      refreshes += 1;
      lastRefreshAt = Date.now();
      // eslint-disable-next-line no-console
      console.warn(
        `⚠️  MCP tool list not serving ${optionTestId}` +
          (nodeError ? ` (node reported "${nodeError}")` : "") +
          ` — "Refresh list" attempt ${refreshes}/${maxRefreshes} (#1422)`,
      );
      await refresh.click({ timeout: 10_000 }).catch(() => {});
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    missingMcpToolOptionMessage({
      optionTestId,
      waitedMs: timeout,
      refreshes,
      nodeError: nodeError ?? (await readNodeError(page)),
      expectedServer: options.serverName ?? null,
      boundServer:
        (await serverWidget
          .first()
          .textContent()
          .catch(() => null))?.trim() ?? null,
    }),
  );
}
