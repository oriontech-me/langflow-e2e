import { expect, type Page } from "@playwright/test";

/**
 * Types a term into the component sidebar's search box and does not return until
 * the input is actually **holding** it (issue #1468).
 *
 * `fill()` returning is not evidence the term landed. Measured on nightly
 * 1.12.0.dev30 with 4 harnesses driving one backend — 23 failures in 220 adds
 * (10.5 %; 0 in 30 on a quiet instance, which is why this never reproduces
 * locally): an in-page probe sampling the input every animation frame recorded
 *
 *     [ 41 ms, "",   "same"     ]   the input is there, empty
 *     [102 ms, null, "absent"   ]   the input NODE is gone
 *     [156 ms, "",   "remounted"]   a NEW input node, empty
 *
 * — the sidebar unmounts and remounts 96–215 ms after the fill and the typed
 * term dies with the old node. Since 1.12 a component row only exists in the DOM
 * under a filter, so the caller's `input_output<Display Name>` never appears and
 * the wait ends as `element(s) not found` with no add ever attempted. That is the
 * whole of #1468's signature, on both of the two tests it was filed for.
 *
 * **The repair is a reload, and that is measured, not chosen.** Re-typing into
 * the remounted input recovered **0 of 4** — it accepts no value at all, for the
 * remaining 30 s of the wait and 10 s past it. A full `reload()` recovered
 * **4 of 4**. So the "type again" repair that fixed the swallowed *click*
 * (#1304, `add-component-from-sidebar.ts`) does not reach this layer, and a
 * longer timeout reaches it even less: nothing is in flight to wait for.
 *
 * **Waiting for the input to be VISIBLE is not the barrier**, which is why the
 * guard already present in `chat-input-output-component-regression.spec.ts`
 * did not help. The input is visible before the remount; the remount comes
 * after. The only observable that distinguishes a working sidebar from an inert
 * one is whether it keeps what you typed — so that is what this asserts.
 *
 * Not folded into `add-component-from-sidebar.ts`: that helper repairs a click
 * the app dropped, one layer later, and its `issueAdd` fills the search as a
 * step of that repair. Both belong on the path (this one first), and merging
 * them would put a `reload()` — which discards a canvas the caller may have
 * already built — inside a helper 34 call sites use after placing nodes.
 */
/**
 * How long the term must survive to count as held. The remount was measured at
 * 96–215 ms after the fill across every reproduction, so 1.5 s spans it with
 * room to spare — and a healthy add never pays it, because the row appearing is
 * itself proof the sidebar kept the term and returns early.
 */
export const SEARCH_VALUE_TIMEOUT_MS = 1500;
export const SEARCH_INPUT_TIMEOUT_MS = 20000;
export const ROW_TIMEOUT_MS = 30000;

export const SEARCH_INPUT_TESTID = "sidebar-search-input";

export type SearchOutcome = "held" | "dropped";

/**
 * Whether the sidebar kept the term. Trailing/leading whitespace is not
 * normalised away: the caller's term is what filters the list, and a sidebar
 * that trimmed it would filter differently.
 */
export function classifySearchOutcome(
  term: string,
  observedValue: string,
): SearchOutcome {
  return observedValue === term ? "held" : "dropped";
}

type SearchFailureDetail = {
  term: string;
  rowTestId: string | null;
  observedValue: string;
  attempts: number;
  reloaded: boolean;
  perAttemptMs: number;
  rowCount: number;
};

export function droppedSearchMessage(d: SearchFailureDetail): string {
  return (
    `the component sidebar dropped the search term: filled ` +
    `getByTestId("${SEARCH_INPUT_TESTID}") with "${d.term}" and the input reads ` +
    `"${d.observedValue}" after ${d.attempts} attempt(s) of ${d.perAttemptMs}ms` +
    `${d.reloaded ? " (including one page reload)" : ""}. ` +
    `Issue #1468 — the sidebar unmounts and remounts 96–215 ms after the fill ` +
    `and the typed term dies with the old node; measured 23 of 220 adds on ` +
    `nightly 1.12.0.dev30 under four-way backend contention, 0 of 30 on a quiet ` +
    `instance. Observed: sidebar rows matching the filter: ${d.rowCount}` +
    `${d.rowTestId ? `; waiting for getByTestId("${d.rowTestId}")` : ""}. ` +
    `This is NOT a slow sidebar — a longer wait cannot fix it, and re-typing ` +
    `recovers 0 of 4 — so treat a reproducible failure here as a real defect in ` +
    `the sidebar, not as a flake to re-run.`
  );
}

/**
 * A term that the sidebar kept but that produced no row is a different failure
 * from a dropped term, and it must not borrow the other's explanation: it means
 * the catalog does not carry that component under that category, which is
 * `globalSetup`'s drift verdict (#1040), not #1468.
 */
export function missingRowMessage(d: SearchFailureDetail): string {
  return (
    `the sidebar held the search term "${d.term}" but no row for ` +
    `getByTestId("${d.rowTestId}") appeared within ${ROW_TIMEOUT_MS}ms ` +
    `(rows matching the filter: ${d.rowCount}). The typed term is in the input, ` +
    `so this is NOT issue #1468's remount. Check the component catalog for this ` +
    `category/display name — a reparented or removed component is reported by ` +
    `globalSetup's drift verdict (#1040), and the testid is ` +
    `\`<category><Display Name>\`.`
  );
}

const readValue = async (page: Page): Promise<string> =>
  page
    .getByTestId(SEARCH_INPUT_TESTID)
    .inputValue()
    .catch(() => "<gone>");

const rowsUnderFilter = async (page: Page): Promise<number> =>
  page
    .locator('[data-testid^="input_output"], [data-testid^="add-component-button-"]')
    .count()
    .catch(() => -1);

const isRowVisible = async (page: Page, rowTestId: string): Promise<boolean> =>
  page
    .getByTestId(rowTestId)
    .isVisible()
    .catch(() => false);

/**
 * Fills, then watches until the term is seen to drop, the row appears, or the
 * settle budget runs out. Polling rather than a single assert: the remount lands
 * ~100–215 ms in, so a value read once right after the fill can be right and
 * then wrong.
 */
const fillAndSettle = async (
  page: Page,
  term: string,
  rowTestId?: string,
): Promise<{ value: string; rowSeen: boolean }> => {
  await expect(page.getByTestId(SEARCH_INPUT_TESTID)).toBeVisible({
    timeout: SEARCH_INPUT_TIMEOUT_MS,
  });
  await page.getByTestId(SEARCH_INPUT_TESTID).fill(term);

  const deadline = Date.now() + SEARCH_VALUE_TIMEOUT_MS;
  let value = await readValue(page);
  for (;;) {
    // The row rendering IS the sidebar keeping the term, so a healthy add
    // returns here in a few hundred ms instead of paying the settle budget.
    if (rowTestId && (await isRowVisible(page, rowTestId))) {
      return { value: term, rowSeen: true };
    }
    if (classifySearchOutcome(term, value) === "dropped") {
      return { value, rowSeen: false };
    }
    if (Date.now() >= deadline) return { value, rowSeen: false };
    await page.waitForTimeout(150);
    value = await readValue(page);
  }
};

/**
 * Fills the sidebar search and — when `rowTestId` is given — waits for that
 * component's row, so the two failures the caller could hit are named apart.
 *
 * @param term       text typed into `sidebar-search-input`
 * @param rowTestId  the sidebar row to wait for, e.g. `input_outputChat Input`
 */
export const fillSidebarSearch = async (
  page: Page,
  term: string,
  rowTestId?: string,
) => {
  let settled = await fillAndSettle(page, term, rowTestId);
  let attempts = 1;
  let reloaded = false;

  if (classifySearchOutcome(term, settled.value) === "dropped") {
    // The only repair with a measured recovery: 4 of 4, against 0 of 4 for
    // re-typing into the inert input.
    await page.reload();
    reloaded = true;
    settled = await fillAndSettle(page, term, rowTestId);
    attempts = 2;
  }
  const value = settled.value;

  const detail: SearchFailureDetail = {
    term,
    rowTestId: rowTestId ?? null,
    observedValue: value,
    attempts,
    reloaded,
    perAttemptMs: SEARCH_VALUE_TIMEOUT_MS,
    rowCount: await rowsUnderFilter(page),
  };

  if (classifySearchOutcome(term, value) === "dropped") {
    throw new Error(droppedSearchMessage(detail));
  }
  if (!rowTestId) return;
  if (settled.rowSeen) return;

  const appeared = await expect(page.getByTestId(rowTestId))
    .toBeVisible({ timeout: ROW_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    throw new Error(
      missingRowMessage({ ...detail, rowCount: await rowsUnderFilter(page) }),
    );
  }
};
