import type { Locator, Page } from "@playwright/test";

/**
 * Waiting for a provider row without discarding what the product already says
 * (#1648).
 *
 * `ProviderList.tsx` renders FOUR mutually exclusive states, each with its own
 * `data-testid` (measured on `langflow-ai/langflow@release-1.12.0`, lines
 * 82/94/105/119 — one component, shared by the Settings page AND the Agent
 * node's "Model providers" modal, which is why `provider-list-loading` appears
 * exactly once in the 1.12.0.dev44 bundle):
 *
 *   provider-list-loading  still fetching GET /api/v1/models?purpose=configure
 *                          (React Query `paused` renders here too)
 *   provider-list-error    the fetch failed
 *   provider-list-empty    the search box filtered every provider out
 *   provider-list          settled, holding the `provider-item-*` rows
 *
 * Waiting only for `provider-item-<Name>` throws all four away, and the
 * resulting
 *
 *   TimeoutError: locator.click: Timeout 20000ms exceeded.
 *   Call log:
 *     - waiting for getByTestId('provider-item-OpenAI')
 *
 * cannot tell an unresponsive instance from a provider Langflow stopped
 * shipping. That is not hypothetical: across the 25 dailies from 2026-08-04 to
 * 2026-08-31 the bare wait produced **20 attempts** over 12 spec files and three
 * providers (Google 9, OpenAI 8, Anthropic 3), and in **0 of 20** did the call
 * log get past `waiting for <locator>`. The failure-time screenshot of daily
 * 33410643882 shows `Loading providers...` on screen while the aria snapshot
 * captured moments later shows all nine rows — the same artifacts read as a
 * product defect at triage and as an environment stall on review.
 *
 * The cost of that ambiguity is measurable in two places. None of the five
 * patterns in `scripts/lib/infra-signature-patterns.json` matches a locator
 * timeout, so `infra_signature` came back `null` for every one of the 20 and the
 * wedge exemption could not claim them (#1589). And `reports/daily-history.jsonl`
 * stores only the normalized FIRST error line, so searching all 21 August
 * dailies for `provider-item` returns zero while the per-run Playwright JSON
 * returns 20 (#1626).
 *
 * The budgets are passed through UNCHANGED on purpose. Raising them would hide
 * the stall this module exists to name, and the failures are a wedged backend —
 * something the suite should keep reporting, only in words a human and
 * `infra_signature` can both read.
 */

/** The four state testids `ProviderList.tsx` owns, plus the row prefix. */
export const PROVIDER_LIST_TESTIDS = {
  loading: "provider-list-loading",
  error: "provider-list-error",
  empty: "provider-list-empty",
  list: "provider-list",
  search: "provider-search-input",
  rowPrefix: "provider-item-",
} as const;

/** What the provider list was showing at one instant. */
export type ProviderListSnapshot = {
  /** `provider-list-loading` present — the fetch has not answered. */
  loading: boolean;
  /** `provider-list-error` present — the fetch failed. */
  errored: boolean;
  /** `provider-list-empty` present — the search filtered everything out. */
  filteredEmpty: boolean;
  /** `provider-list` present — the list settled. */
  listed: boolean;
  /** Display names of the rows actually rendered (testid minus the prefix). */
  rows: string[];
  /** Current value of `provider-search-input` (`""` when absent or empty). */
  searchTerm: string;
};

export type ProviderRowVerdictKind =
  | "stalled"
  | "errored"
  | "filtered"
  | "absent"
  | "unreached";

export type ProviderRowVerdict = {
  kind: ProviderRowVerdictKind;
  message: string;
};

/** Strips the `provider-item-` prefix; returns the input when it has none. */
export function providerNameFromTestId(testId: string): string {
  return testId.startsWith(PROVIDER_LIST_TESTIDS.rowPrefix)
    ? testId.slice(PROVIDER_LIST_TESTIDS.rowPrefix.length)
    : testId;
}

/**
 * Classifies a provider row that did not arrive. PURE — no page, no clock — so
 * every branch is reachable from a unit test. The branches that matter are
 * otherwise only reachable from an instance misbehaving on purpose, which is
 * exactly the shape `censusForTarget` (#1464) and `decideEntryPoint` (#1465)
 * settled on for the same reason.
 *
 * Order is load-bearing. `loading` is checked FIRST because it is the only
 * state that says "the instance has not answered": every other verdict claims
 * something about the CONTENT of a list, and a list that never arrived has no
 * content to claim anything about. `unreached` is checked LAST for the mirrored
 * reason — absence of all four states is only meaningful once none of them
 * applies.
 */
export function providerRowVerdict(
  snapshot: ProviderListSnapshot,
  wantedTestId: string,
  timeoutMs: number,
): ProviderRowVerdict {
  const name = providerNameFromTestId(wantedTestId);
  const budget = `${timeoutMs}ms`;

  if (snapshot.loading) {
    return {
      kind: "stalled",
      message:
        `PROVIDER_LIST_STALLED: "${name}" never rendered because the provider list is ` +
        `STILL in its "${PROVIDER_LIST_TESTIDS.loading}" state after ${budget} — the ` +
        `instance has not answered GET /api/v1/models?purpose=configure. This is an ` +
        `INSTANCE stall, not a missing provider: the row is not absent, the list never ` +
        `arrived. Do not raise this timeout to make it pass (#1648).`,
    };
  }

  if (snapshot.errored) {
    return {
      kind: "errored",
      message:
        `PROVIDER_LIST_ERROR: "${name}" never rendered because the provider list is in ` +
        `its "${PROVIDER_LIST_TESTIDS.error}" state after ${budget} — the catalog fetch ` +
        `FAILED. That is a backend verdict, not a missing provider; check the run's ` +
        `backend-error log for the response behind it (#1648).`,
    };
  }

  if (snapshot.filteredEmpty || snapshot.searchTerm !== "") {
    return {
      kind: "filtered",
      message:
        `PROVIDER_LIST_FILTERED: "${name}" never rendered because the provider search ` +
        `box holds "${snapshot.searchTerm}", so the list is filtered` +
        (snapshot.filteredEmpty ? " down to nothing" : "") +
        `. This is a SUITE defect — an earlier step left the filter set — not a product ` +
        `finding (#1648).`,
    };
  }

  if (snapshot.listed) {
    const rendered = snapshot.rows.length
      ? `[${snapshot.rows.join(", ")}]`
      : "[] (none)";
    return {
      kind: "absent",
      message:
        `PROVIDER_ABSENT: the provider list SETTLED and rendered ${snapshot.rows.length} ` +
        `provider(s) ${rendered}, and "${name}" is not among them. The list answered, so ` +
        `this is a PRODUCT finding — the image no longer offers this provider, or its ` +
        `display name changed — and not an instance stall (#1648).`,
    };
  }

  return {
    kind: "unreached",
    message:
      `PROVIDER_LIST_UNREACHED: "${name}" never rendered and NONE of the provider ` +
      `list's four states is on the page after ${budget} ` +
      `("${PROVIDER_LIST_TESTIDS.loading}", "${PROVIDER_LIST_TESTIDS.error}", ` +
      `"${PROVIDER_LIST_TESTIDS.empty}", "${PROVIDER_LIST_TESTIDS.list}"). The Settings ` +
      `page or the "Model providers" modal never opened — openProviderPanel() returns ` +
      `"opened" as soon as it clicks, without checking that the panel mounted — or ` +
      `ProviderList.tsx renamed every one of those testids (#1648).`,
  };
}

/** Reads the four states, the rendered rows and the search term in one pass. */
export async function readProviderListState(
  page: Page,
): Promise<ProviderListSnapshot> {
  return page.evaluate((ids) => {
    const has = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`) !== null;
    const search = document.querySelector<HTMLInputElement>(
      `[data-testid="${ids.search}"]`,
    );
    return {
      loading: has(ids.loading),
      errored: has(ids.error),
      filteredEmpty: has(ids.empty),
      listed: has(ids.list),
      rows: Array.from(
        document.querySelectorAll(`[data-testid^="${ids.rowPrefix}"]`),
      )
        .map((el) => el.getAttribute("data-testid") ?? "")
        .filter((id) => id !== "")
        .map((id) => id.slice(ids.rowPrefix.length)),
      searchTerm: search?.value ?? "",
    };
  }, PROVIDER_LIST_TESTIDS as unknown as Record<string, string>);
}

/**
 * Waits for one provider row and returns its locator.
 *
 * On success this is exactly the wait it replaces — same locator, same budget.
 * On timeout it reads the list state ONCE and throws the verdict, so the run
 * records which of the five situations it was in instead of a bare
 * `waiting for getByTestId(...)`.
 *
 * The state read is itself guarded: a page that has navigated away or a context
 * that is closing makes `page.evaluate` throw, and losing the original timeout
 * to a secondary error would replace one unattributed failure with a worse one.
 */
export async function waitForProviderRow(
  page: Page,
  providerTestId: string,
  timeout = 20000,
): Promise<Locator> {
  const row = page.getByTestId(providerTestId);
  try {
    await row.waitFor({ state: "visible", timeout });
    return row;
  } catch (waitError) {
    let snapshot: ProviderListSnapshot;
    try {
      snapshot = await readProviderListState(page);
    } catch (readError) {
      throw new Error(
        `PROVIDER_LIST_UNREADABLE: "${providerNameFromTestId(providerTestId)}" did not ` +
          `render within ${timeout}ms, and the provider list's state could not be read ` +
          `to say why (${readError instanceof Error ? readError.message.split("\n")[0] : String(readError)}). ` +
          `The original wait failed with: ${waitError instanceof Error ? waitError.message.split("\n")[0] : String(waitError)}`,
      );
    }
    throw new Error(providerRowVerdict(snapshot, providerTestId, timeout).message);
  }
}
