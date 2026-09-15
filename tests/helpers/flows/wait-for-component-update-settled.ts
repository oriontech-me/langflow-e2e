/**
 * Block until no node update (`POST /api/v1/custom_component/update`) is in flight.
 *
 * Several canvas actions make a node round-trip through that endpoint — closing the
 * Tool Mode actions editor, switching a component into Tool Mode, connecting a tool
 * edge — and the node is re-rendered from each response. A response issued BEFORE a
 * later edit and still in flight when that edit lands is applied on top of it:
 *
 *  - #1519: a round trip in flight across the actions editor's close came back with
 *    the pre-edit `tools_metadata` and overwrote the edits, which the autosave then
 *    persisted.
 *  - #1855: with updates in flight after Tool Mode and a new tool edge, a click on
 *    `button_open_actions` opened nothing, and the two runs of four where that
 *    happened were exactly the two where the Agent then made no tool call at all —
 *    one of them answering that the tool was "not available in my current
 *    environment", on a canvas where the spec had already asserted the edge.
 *
 * Waiting the round trips out is what a human user does by being slow; automation has
 * to ask. Extracted from `core-components/edit-tools.spec.ts` when #1855 became its
 * second caller, as that file's own comment asked.
 *
 * Tracks REQUESTS, not just responses: a request already issued whose response is slow
 * under load is exactly the case this has to cover, and a response-only probe would
 * arm its quiet timer while that request was still open — the same reasoning as
 * `wait-for-flow-save-settled.ts` (#995).
 *
 * One known limit, kept rather than hidden: a request already open when this attaches
 * is invisible until it finishes. Its `requestfinished` still re-arms the quiet window,
 * so it is covered whenever it finishes inside `quietMs` of the attach — not beyond.
 */

/** Matched on the pathname: the endpoint gained a `?flow_id=` query in late August 2026 (#1644). */
export const COMPONENT_UPDATE_PATH = "/api/v1/custom_component/update";

/** The `Request` surface the barrier reads. */
export interface UpdateSettleRequest {
  method(): string;
  url(): string;
}

type UpdateSettleListener = (request: UpdateSettleRequest) => void;

/**
 * The `Page` surface the barrier uses — narrow so the unit lane can drive it with a
 * fake. Method shorthand (not property-arrow), so a real Playwright `Page`, whose
 * listeners take the full `Request`, is assignable (bivariant parameter check, as in
 * `track-created-flows.ts`).
 */
export interface UpdateSettlePage {
  on(event: "request", listener: UpdateSettleListener): unknown;
  on(event: "requestfinished", listener: UpdateSettleListener): unknown;
  on(event: "requestfailed", listener: UpdateSettleListener): unknown;
  off(event: "request", listener: UpdateSettleListener): unknown;
  off(event: "requestfinished", listener: UpdateSettleListener): unknown;
  off(event: "requestfailed", listener: UpdateSettleListener): unknown;
}

export interface UpdateSettleOptions {
  /** How long no update may be in flight before the node counts as settled. */
  quietMs?: number;
  /** Upper bound on the whole wait. */
  timeout?: number;
}

export function isComponentUpdate(request: UpdateSettleRequest): boolean {
  if (request.method() !== "POST") return false;
  try {
    return new URL(request.url()).pathname.includes(COMPONENT_UPDATE_PATH);
  } catch {
    return false;
  }
}

/**
 * Resolves `true` once no node update has been in flight for `quietMs`, or `false`
 * when `timeout` ended the wait first. The listeners are detached either way.
 */
export function waitForComponentUpdateSettled(
  page: UpdateSettlePage,
  { quietMs = 700, timeout = 15_000 }: UpdateSettleOptions = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = 0;

    const onRequest = (request: UpdateSettleRequest) => {
      if (!isComponentUpdate(request)) return;
      inFlight++;
      clearTimeout(quietTimer);
    };

    // A request that was already open when this attached would decrement below zero;
    // clamping keeps the counter honest and still re-arms the quiet window.
    const onSettled = (request: UpdateSettleRequest) => {
      if (!isComponentUpdate(request)) return;
      inFlight = Math.max(0, inFlight - 1);
      arm();
    };

    const finish = (settled: boolean) => {
      clearTimeout(quietTimer);
      clearTimeout(cap);
      page.off("request", onRequest);
      page.off("requestfinished", onSettled);
      page.off("requestfailed", onSettled);
      resolve(settled);
    };

    const arm = () => {
      clearTimeout(quietTimer);
      if (inFlight === 0) quietTimer = setTimeout(() => finish(true), quietMs);
    };

    const cap = setTimeout(() => finish(false), timeout);
    page.on("request", onRequest);
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);
    arm();
  });
}
