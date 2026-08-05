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
 * renders in well under a second, and the cost of calling a merely-slow add
 * "swallowed" is a second click — which, if the first one then arrives late,
 * leaves two nodes on the canvas and fails the run (see `duplicatedAddMessage`).
 */
export const ADD_LANDED_TIMEOUT_MS = 12000;

// React Flow's own node class, which is what most callers already count
// (`.react-flow__node` appears in 15+ specs). Counting is what makes the
// post-condition work for callers that add to a canvas that already has nodes.
const NODE_SELECTOR = ".react-flow__node";

const POLL_INTERVAL_MS = 200;

export type AddOutcome = "landed" | "swallowed" | "duplicated" | "lost";

export function classifyAddOutcome(before: number, after: number): AddOutcome {
  if (after === before + 1) return "landed";
  if (after === before) return "swallowed";
  if (after < before) return "lost";
  return "duplicated";
}

type AddFailureDetail = {
  searchTerm: string;
  addButtonTestId: string;
  before: number;
  after: number;
  attempts: number;
  perAttemptMs: number;
  buttonStillVisible: boolean;
  searchValue: string;
};

const observedState = (d: AddFailureDetail) =>
  `node count: ${d.before} before, ${d.after} after; ` +
  `"+" button still visible: ${d.buttonStillVisible ? "yes" : "no"}; ` +
  `sidebar search input: "${d.searchValue}"`;

const clickSummary = (d: AddFailureDetail) =>
  `${d.attempts} attempt(s) of ${d.perAttemptMs}ms each on ` +
  `getByTestId("${d.addButtonTestId}") after filling the sidebar search with ` +
  `"${d.searchTerm}"`;

export function swallowedAddMessage(d: AddFailureDetail): string {
  return (
    `the sidebar add was swallowed: no node reached the canvas after ` +
    `${clickSummary(d)}. The click(s) were accepted by the DOM and the app never ` +
    `registered the add (issue #1304 — measured 4/20 on nightly 1.12.0.dev17, ` +
    `the swallowed-click class of #420/#966 on the sidebar surface of #537). ` +
    `Observed: ${observedState(d)}. This is NOT a slow surface — a longer wait ` +
    `cannot fix it — so treat a reproducible failure here as a real defect in ` +
    `adding components, not as a flake to re-run.`
  );
}

export function duplicatedAddMessage(d: AddFailureDetail): string {
  return (
    `the sidebar add left ${d.after - d.before} nodes on the canvas instead of 1 ` +
    `after ${clickSummary(d)}. Two readings, and the evidence here cannot separate ` +
    `them: the first click was delivered LATE, right as the re-issued second click ` +
    `landed (the re-issue exists because that click usually never arrives at all — ` +
    `issue #1304), or the app genuinely added twice for one click. Either way this ` +
    `run's canvas is not what the caller asked for, so it fails rather than ` +
    `handing on ${d.after} nodes. Observed: ${observedState(d)}.`
  );
}

export function lostNodeMessage(d: AddFailureDetail): string {
  return (
    `the canvas LOST nodes while adding a component: ${clickSummary(d)} ended with ` +
    `fewer nodes than it started with. Nothing in this helper deletes a node, so ` +
    `the canvas was mutated from elsewhere (a cross-worker cleanup, or a reload ` +
    `mid-add). Observed: ${observedState(d)}.`
  );
}

const issueAdd = async (
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) => {
  await page.getByTestId("sidebar-search-input").fill(searchTerm);
  await page.getByTestId(addButtonTestId).click();
};

// Polls until the node count moves off `before`, so a landed add returns as soon
// as it renders and only a real drop pays the whole budget.
const waitForCountChange = async (
  page: Page,
  before: number,
  budgetMs: number,
) => {
  const nodes = page.locator(NODE_SELECTOR);
  const deadline = Date.now() + budgetMs;
  let count = await nodes.count();
  while (count === before && Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    count = await nodes.count();
  }
  return count;
};

export const addComponentFromSidebar = async (
  page: Page,
  searchTerm: string,
  addButtonTestId: string,
) => {
  const before = await page.locator(NODE_SELECTOR).count();

  await issueAdd(page, searchTerm, addButtonTestId);
  let after = await waitForCountChange(page, before, ADD_LANDED_TIMEOUT_MS);
  let attempts = 1;

  if (classifyAddOutcome(before, after) === "swallowed") {
    await issueAdd(page, searchTerm, addButtonTestId);
    after = await waitForCountChange(page, before, ADD_LANDED_TIMEOUT_MS);
    attempts = 2;
  }

  const outcome = classifyAddOutcome(before, after);
  if (outcome === "landed") return;

  // Captured only on the failure path, and before throwing: these three facts are
  // what separate "the click did nothing" from "the sidebar was gone", and they
  // are unrecoverable from the trace after the fact.
  const detail: AddFailureDetail = {
    searchTerm,
    addButtonTestId,
    before,
    after,
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
  };

  if (outcome === "duplicated") throw new Error(duplicatedAddMessage(detail));
  if (outcome === "lost") throw new Error(lostNodeMessage(detail));
  throw new Error(swallowedAddMessage(detail));
};
