/**
 * Attribution for the model-toggle persistence write (#1696).
 *
 * A per-model toggle in Settings -> Model Providers updates optimistically and
 * persists through a ~1 s debounced `POST /api/v1/models/enabled_models`
 * (`useModelToggleQueue`). A spec therefore has to arm `page.waitForResponse`
 * BEFORE the click — navigating away first would drop the write — and when that
 * wait times out all the run records is
 *
 *   TimeoutError: page.waitForResponse: Timeout 15000ms exceeded while waiting
 *   for event "response"
 *
 * which cannot distinguish two very different failures. On daily 2026-09-01
 * (run `33511210195`) that exact string appeared on BOTH tests of
 * `model-provider-model-toggle.spec.ts` and said nothing about either.
 *
 * This is ATTRIBUTION, not a fix: the budget is unchanged, and a saturated
 * instance still fails — correctly. What changes is that the failure names
 * which half of the round-trip broke, so the next occurrence is not a fifth
 * nameless signature (#1012/#1626).
 *
 * The classification is PURE so both branches are reachable from a unit test.
 * Producing `not-issued` live would mean breaking the frontend's debounce and
 * `unanswered` would mean wedging the backend — neither is something a spec may
 * do on demand, the same argument `providerRowVerdict` (#1648) and
 * `censusForTarget` (#1464) settled for their own decisions.
 */

/** What the persistence wait observed by the time its budget ran out. */
export type ToggleWriteSnapshot = {
  /** POSTs to the endpoint the page actually issued. */
  requestsSeen: number;
  /** Responses to those POSTs that came back. */
  responsesSeen: number;
  /** `aria-checked` on the toggle when the budget expired (`""` if unreadable). */
  ariaChecked: string;
  /** What the click asked the toggle to become. */
  wantedEnabled: boolean;
  /** The model whose toggle was flipped. */
  model: string;
};

export type ToggleWriteVerdictKind = "not-issued" | "unanswered";

export type ToggleWriteVerdict = {
  kind: ToggleWriteVerdictKind;
  message: string;
};

/**
 * Classifies a persistence write that did not complete.
 *
 * `requestsSeen` decides, never `responsesSeen`: a response counted without its
 * request would flip the diagnosis from "the UI is broken" to "the instance is
 * slow" and send triage the wrong way.
 */
export function toggleWriteVerdict(
  snapshot: ToggleWriteSnapshot,
  endpoint: string,
  timeoutMs: number,
): ToggleWriteVerdict {
  const budget = `${timeoutMs}ms`;
  const wanted = String(snapshot.wantedEnabled);

  if (snapshot.requestsSeen === 0) {
    return {
      kind: "not-issued",
      message:
        `TOGGLE_WRITE_NOT_ISSUED: no POST ${endpoint} was observed at all within ` +
        `${budget} after toggling "${snapshot.model}", so the UI never fired the ` +
        `debounced write. The switch is showing aria-checked "${snapshot.ariaChecked}" ` +
        `against the "${wanted}" that was asked for — flipped with no POST is a ` +
        `debounce or queue defect, unflipped means the click itself did nothing. ` +
        `Either way this is a SUITE or PRODUCT defect, not a slow instance (#1696).`,
    };
  }

  return {
    kind: "unanswered",
    message:
      `TOGGLE_WRITE_UNANSWERED: ${snapshot.requestsSeen} POST ${endpoint} request(s) ` +
      `were issued after toggling "${snapshot.model}" and ${snapshot.responsesSeen} ` +
      `came back within ${budget}, so the write left the page and the INSTANCE did ` +
      `not answer it. The switch is showing aria-checked "${snapshot.ariaChecked}" ` +
      `against the "${wanted}" that was asked for. Do not raise this timeout to make ` +
      `it pass — a saturated instance is something the suite should keep reporting ` +
      `(#1696).`,
  };
}
