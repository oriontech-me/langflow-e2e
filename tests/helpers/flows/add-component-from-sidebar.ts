import { type Page } from "@playwright/test";

/**
 * Adds a component to the canvas via the sidebar: types the search term to
 * filter the list, clicks the component's "+" button, and — since #1304 — does
 * not return until a node actually landed.
 *
 * It used to be a deliberately "dumb" primitive that performed the mechanism and
 * asserted nothing, leaving the post-condition to each caller. Twenty-three spec
 * files call it, and Langflow drops that click outright a measurable fraction of
 * the time: the DOM click is accepted, no node is created, and no flow write
 * follows. Measured on nightly 1.12.0.dev17 with an instrumented scout — 4 of 20
 * adds of the Language Model component produced no node within 4 s, and in ALL 4
 * an identical second fill+click produced it, with the "+" button still visible,
 * the search input still holding the term, and zero POST/PATCH /api/v1/flows in
 * between for 3 of the 4. So this is the swallowed-click class (#420/#966) one
 * layer later, on the very surface #537 recorded as re-rendering while its
 * component catalog streams in.
 *
 * Two things follow, and both are the point of this helper.
 *
 * **A dropped click is repaired, not waited out.** The first attempt's failure is
 * not slowness — nothing is in flight to wait for — so the fix re-issues the
 * interaction ONCE and then hard-fails. Raising a caller's timeout could never
 * work: `modelInputComponent.spec.ts:106` already waited 15 s and failed on all
 * three attempts of the 2026-08-05 daily (run 30997773754).
 *
 * **The failure is named where it happens.** Before this, a drop surfaced as
 * whatever the caller happened to assert next, which produced three unrelated
 * messages for one mechanism inside 100 s on that daily —
 * `stop-building.spec.ts:24` on `div-generic-node`, `langflowShortcuts.spec.ts:47`
 * on "the Chat Output component should be on the canvas", and
 * `modelInputComponent.spec.ts:106` on `[data-testid^="rf__node-"]` — none of them
 * naming the add. The message built here says the click was swallowed, which
 * click, and what the sidebar looked like when it happened.
 *
 * **The post-condition is a SET DIFFERENCE over node ids, never a count delta**,
 * and that distinction was paid for. The first version of this helper required
 * `after === before + 1` and hard-failed anything else as a duplicated add; CI run
 * 31048371247 refuted it on the first try. `agent-context-id-isolation.spec.ts:512`
 * navigates to an API-seeded flow and waits only for `sidebar-search-input`, so the
 * canvas is still mounting the flow's OWN nodes when the baseline is taken: one
 * legitimate click took the count 0 → 3 and a healthy add was reported as "left 3
 * nodes on the canvas instead of 1". A baseline that can grow on its own is no
 * evidence of a double add, so this helper judges only whether a node that was not
 * there before is there now. Exact counts stay with the callers, which assert them
 * anyway (`toHaveCount(1 | 2 | before + 1)`).
 *
 * Deliberately NOT claimed as infra (the #1262 rule): a genuine regression in
 * adding components must stay eligible for `@stable` auto-removal, so the message
 * carries no `INFRA_PREFIX` and is pinned as unclassifiable by
 * `scripts/lib/infra-signatures.ts` in the unit tests.
 *
 * @param searchTerm        text typed into `sidebar-search-input` to filter the sidebar
 * @param addButtonTestId   testid of the component's "+" button, e.g. `add-component-button-chat-input`
 */

/**
 * Per-attempt budget for the node to land. Generous on purpose: a healthy add
 * renders in well under a second, and calling a merely-slow add "swallowed" costs
 * a second click — which, on a canvas that is genuinely idle, leaves an extra node
 * for the caller's own count assertion to trip over.
 */
export const ADD_LANDED_TIMEOUT_MS = 12000;

// Every canvas node carries this testid, and its value is the node's own id — so
// one read gives both the count and the identity. Both this and the `data-id`
// fallback are established in-repo (`rf__node-` in the agent specs, `data-id` in
// `rag-pipeline.spec.ts`).
const NODE_SELECTOR = '[data-testid^="rf__node-"]';

const POLL_INTERVAL_MS = 200;

export type AddOutcome = "landed" | "swallowed";

/** Node ids present after the click that were not present before it. */
export function newNodeIds(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
}

export function classifyAddOutcome(
  before: string[],
  after: string[],
): AddOutcome {
  return newNodeIds(before, after).length > 0 ? "landed" : "swallowed";
}

type AddFailureDetail = {
  searchTerm: string;
  addButtonTestId: string;
  beforeCount: number;
  afterCount: number;
  attempts: number;
  perAttemptMs: number;
  buttonStillVisible: boolean;
  searchValue: string;
};

export function swallowedAddMessage(d: AddFailureDetail): string {
  return (
    `the sidebar add was swallowed: no new node reached the canvas after ` +
    `${d.attempts} attempt(s) of ${d.perAttemptMs}ms each on ` +
    `getByTestId("${d.addButtonTestId}") after filling the sidebar search with ` +
    `"${d.searchTerm}". The click(s) were accepted by the DOM and the app never ` +
    `registered the add (issue #1304 — measured 4/20 on nightly 1.12.0.dev17, ` +
    `the swallowed-click class of #420/#966 on the sidebar surface of #537). ` +
    `Observed: node count: ${d.beforeCount} before, ${d.afterCount} after; ` +
    `"+" button still visible: ${d.buttonStillVisible ? "yes" : "no"}; ` +
    `sidebar search input: "${d.searchValue}". This is NOT a slow surface — a ` +
    `longer wait cannot fix it — so treat a reproducible failure here as a real ` +
    `defect in adding components, not as a flake to re-run.`
  );
}

const nodeIds = async (page: Page): Promise<string[]> =>
  page
    .locator(NODE_SELECTOR)
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.getAttribute("data-testid") ?? el.getAttribute("data-id") ?? "",
      ),
    );

const issueAdd = async (
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) => {
  await page.getByTestId("sidebar-search-input").fill(searchTerm);
  await page.getByTestId(addButtonTestId).click();
};

// Polls until a node id appears that was not in `before`, so a landed add returns
// as soon as it renders and only a real drop pays the whole budget.
const waitForNewNode = async (
  page: Page,
  before: string[],
  budgetMs: number,
) => {
  const deadline = Date.now() + budgetMs;
  let after = await nodeIds(page);
  while (classifyAddOutcome(before, after) === "swallowed" && Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    after = await nodeIds(page);
  }
  return after;
};

export const addComponentFromSidebar = async (
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) => {
  const before = await nodeIds(page);

  await issueAdd(page, searchTerm, addButtonTestId);
  let after = await waitForNewNode(page, before, ADD_LANDED_TIMEOUT_MS);
  let attempts = 1;

  if (classifyAddOutcome(before, after) === "swallowed") {
    await issueAdd(page, searchTerm, addButtonTestId);
    after = await waitForNewNode(page, before, ADD_LANDED_TIMEOUT_MS);
    attempts = 2;
  }

  if (classifyAddOutcome(before, after) === "landed") return;

  // Captured only on the failure path, and before throwing: these three facts are
  // what separate "the click did nothing" from "the sidebar was gone", and they
  // are unrecoverable from the trace after the fact.
  throw new Error(
    swallowedAddMessage({
      searchTerm,
      addButtonTestId,
      beforeCount: before.length,
      afterCount: after.length,
      attempts,
      perAttemptMs: ADD_LANDED_TIMEOUT_MS,
      buttonStillVisible: await page
        .getByTestId(addButtonTestId)
        .isVisible()
        .catch(() => false),
      searchValue: await page
        .getByTestId("sidebar-search-input")
        .inputValue()
        .catch(() => "<gone>"),
    }),
  );
};
