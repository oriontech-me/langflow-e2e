// The suite's id-scoped flow cleanup, as one implementation (issue #1108).
//
// The block this replaces — "capture every flow the page creates from its
// `POST /api/v1/flows` → 201 responses and delete those ids in `afterEach`" — was
// hand-copied into 51 spec files. It is the standard cleanup (#490/#681/#515),
// never the delete-all of #553, which wipes flows other parallel workers are
// actively driving. With no shared implementation every copy drifted, and a fix to
// one reached none of the other 50.
//
// Four axes re-measure cleanly against this branch's merge base: of the 51 files,
// **one** uses a `Set`, **one** settles its pending body reads (so 50 can drop an id
// that resolves a tick late), **two** navigate off the canvas before deleting, and
// **four** match the creation endpoint by exact pathname. On each of those this
// helper takes the strict option unconditionally.
//
// The fifth axis — what happens to a failed `deleteFlow` — is **three**-way, not the
// two-way split the issue's table describes, and no query I tried reproduced a
// defensible count, so none is restated here. The shapes are: swallow it
// (`.catch(() => {})`), log it, or let it THROW and fail the teardown. Throwing is
// the strongest signal of the three and some files choose it deliberately
// (`component-breaking-change-alert.spec.ts`: "Cleanup is load-bearing here … so the
// throw is intentionally NOT swallowed"), so `cleanup` defaults to log-and-return
// per the issue's instruction and takes `{ strict: true }` for those callers. A
// migration must not silently downgrade a spec that was failing on a failed cleanup.
//
// This is a helper, deliberately opt-in per spec, rather than a fixture:
// `tests/fixtures/**` is
// suite-wide for `impacted-specs-by-import.mjs`, so a fixture would resolve to
// every spec and demand a full `manual.yml` run on each change (#1054).

import type { APIRequestContext } from "@playwright/test";
import { deleteFlow } from "./delete-flow";
import { getAuthToken } from "../auth/get-auth-token";

/**
 * The `Page` surface the tracker uses. Narrow on purpose: it is what lets the unit
 * lane drive the tracker with a fake instead of a browser.
 *
 * Declared with method shorthand (not property-arrow) so the listener parameter is
 * checked bivariantly — that is what makes a real Playwright `Page`, whose listener
 * takes the full `Response`, assignable here.
 */
export interface TrackedPage {
  on(event: "response", listener: (response: TrackedResponse) => void): unknown;
  off(event: "response", listener: (response: TrackedResponse) => void): unknown;
  goto(url: string): Promise<unknown>;
}

/** The `Response` surface the listener reads, for the same reason. */
export interface TrackedResponse {
  url(): string;
  status(): number;
  statusText(): string;
  request(): { method(): string };
  json(): Promise<unknown>;
}

/**
 * Is this the flow-CREATION endpoint?
 *
 * Exact pathname, not `.includes("/api/v1/flows")`: `/api/v1/flows/batch/` and
 * `/api/v1/flows/upload/` also answer 201, with a list body that carries no
 * top-level `id`. That made the loose match fragility rather than a live bug — the
 * captured id was simply `undefined` and dropped — but it is the reason the four
 * stricter copies exist, and a future endpoint under `/flows/` that DOES return an
 * `id` would turn it into one.
 */
export function isFlowCreateUrl(url: string): boolean {
  try {
    return /^\/api\/v1\/flows\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The created flow's id, or `undefined` for any body shape that has none. */
export function flowIdFrom(body: unknown): string | undefined {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface FlowCleanupResult {
  /** Ids whose DELETE succeeded (or that were already gone). */
  deleted: string[];
  /** Ids whose DELETE failed, with the first line of the error. */
  failed: Array<{ id: string; error: string }>;
  /**
   * Set when the token could not be obtained, so the DELETEs below ran on the
   * browser session alone. Reported separately because a 401 that follows is THAT,
   * not a problem with the flow — see the note at the call site.
   */
  authError?: string;
}

export interface FlowCleanupOptions {
  /**
   * Re-throw the first failed `deleteFlow` instead of logging it.
   *
   * For the specs whose cleanup is load-bearing and which failed their teardown on a
   * failed delete BEFORE this helper existed — migrating one of those without this
   * would trade a red test for a warning line nothing asserts on.
   */
  strict?: boolean;
}

export interface FlowTracker {
  /** Ids captured so far. Settled reads only — call `settle()` first to be sure. */
  ids(): string[];
  /**
   * Creation POSTs that answered 4xx/5xx, as `"<status> <statusText>"` (#1114).
   *
   * Recorded synchronously and without the body: the body is what the fixture
   * already prints on its `🚨 Backend Error` line, and reading it here would land a
   * tick later than the setup step that needs to consult this.
   */
  failedCreations(): string[];
  /** Await the in-flight body reads, so `ids()` is complete. */
  settle(): Promise<void>;
  /** Clear both lists — for a `beforeEach` on a file-scoped tracker. */
  reset(): void;
  /**
   * Settle, navigate off the canvas, then delete every captured flow id-scoped.
   * Never throws unless `{ strict: true }`: by default a failed delete is logged and
   * returned, so it cannot fail an otherwise-green test while still being visible.
   */
  cleanup(
    request: APIRequestContext,
    options?: FlowCleanupOptions,
  ): Promise<FlowCleanupResult>;
  /** Detach the response listener. */
  dispose(): void;
}

/**
 * Start capturing the flows `page` creates.
 *
 * ```ts
 * const flows = trackCreatedFlows(page);          // in beforeEach, or at file scope
 * test.afterEach(async ({ request }) => { await flows.cleanup(request); });
 * ```
 */
export function trackCreatedFlows(page: TrackedPage): FlowTracker {
  // A Set, the minority choice: the same POST can be observed twice (a redirected
  // or replayed response), and deleting an id twice turns the second DELETE into a
  // 404 that `deleteFlow` treats as done — harmless, but it hides a real double
  // creation behind noise. Dedup at capture instead.
  const ids = new Set<string>();
  const failed: string[] = [];
  // Each capture reads a body asynchronously, so the id lands a tick later. Hold
  // those reads and settle them before cleaning up — otherwise a body that resolves
  // after the teardown starts is dropped and its flow leaks for good: the last test
  // in a worker has no later hook to sweep it. Exactly ONE of the 51 copies did this
  // (`api/flows/api-component-regression.spec.ts`, added in #1105).
  const pending: Array<Promise<void>> = [];

  const onResponse = (response: TrackedResponse) => {
    if (response.request().method() !== "POST") return;
    if (!isFlowCreateUrl(response.url())) return;
    if (response.status() >= 400) {
      failed.push(`${response.status()} ${response.statusText()}`);
      return;
    }
    if (response.status() !== 201) return;
    pending.push(
      response
        .json()
        .then((body) => {
          const id = flowIdFrom(body);
          if (id) ids.add(id);
        })
        .catch(() => {}), // non-JSON / already-consumed body
    );
  };

  page.on("response", onResponse);

  const settle = async () => {
    // Splice, so a read that arrives during cleanup is still awaited by a second
    // call rather than awaited twice.
    await Promise.allSettled(pending.splice(0));
  };

  return {
    ids: () => [...ids],
    failedCreations: () => [...failed],
    settle,
    reset: () => {
      ids.clear();
      failed.length = 0;
      pending.length = 0;
    },
    dispose: () => page.off("response", onResponse),
    async cleanup(
      request: APIRequestContext,
      { strict = false }: FlowCleanupOptions = {},
    ): Promise<FlowCleanupResult> {
      await settle();
      const result: FlowCleanupResult = { deleted: [], failed: [] };
      const captured = [...ids];
      ids.clear();
      if (captured.length === 0) return result;

      // Take the page off the flow canvas BEFORE deleting anything (#1023/#1103):
      // an editor left mounted over a flow that is being deleted keeps polling
      // `GET /flows/{id}/events?since=`, 404s once the flow is gone, and the
      // fixture logs each one as `🚨 Backend Error` — which the deterministic
      // pipeline's VALIDATE gate hard-stops on. `about:blank` rather than `/` so the
      // teardown adds no backend traffic of its own.
      //
      // Honest scope: this does NOT fire in every spec. A probe on
      // `api-component-regression.spec.ts` — failure forced after the component run,
      // editor mounted, flow deleted underneath — logged zero backend errors either
      // way, because the build's event stream is already closed by then. It bites
      // the specs whose editor is still polling, and costs nothing in the rest.
      // Two of the 51 copies did this; #1103 added it to the folder specs.
      await page.goto("about:blank").catch(() => {});

      // `page.request` carries only browser cookies, so the flows API answers 401 —
      // pass the bearer explicitly.
      //
      // The throw is CAUGHT but never turned into an empty token silently, which is
      // what `get-auth-token.ts` forbids (#1086: "it must never degrade into the
      // empty-token fallback — the callers would carry on unauthenticated and fail
      // somewhere far less diagnosable"). `cleanup` still may not throw, so the
      // failure is named here and carried on the result: without this, a backend
      // wedged during teardown (#1077) produces a `401` per flow and a report that
      // blames the flows.
      let options: { headers: Record<string, string> } | undefined;
      let authError: string | undefined;
      try {
        const bearer = await getAuthToken(request);
        options = bearer ? { headers: { Authorization: bearer } } : undefined;
      } catch (error) {
        authError = (error as Error)?.message?.split("\n")[0] ?? String(error);
        result.authError = authError;
        console.warn(
          `⚠️  cleanup: no auth token — the deletes below run on the browser session ` +
            `alone, so a 401 here is THAT and not the flow (#1086/#1077): ${authError}`,
        );
      }

      for (const id of captured) {
        try {
          await deleteFlow(request, id, options);
          result.deleted.push(id);
        } catch (error) {
          // `deleteFlow` throws on purpose — it already absorbs 404-as-done and one
          // transient 5xx, so anything left is a real failure (401/403/422). The
          // copies that wrote `.catch(() => {})` turned exactly the signal the
          // helper exists to raise back into a silent leak. Report it without
          // failing an otherwise-green test.
          const message = (error as Error)?.message?.split("\n")[0] ?? String(error);
          result.failed.push({ id, error: message });
          console.warn(`⚠️  cleanup: flow ${id} was NOT deleted — ${message}`);
          if (strict) throw error;
        }
      }
      return result;
    },
  };
}
