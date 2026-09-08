import type { Page, Request, Response } from "@playwright/test";

/**
 * Records the autosave writes for ONE flow that did not succeed.
 *
 * Exists because the persisted graph cannot tell you why it is behind (#1695).
 * When `setup-playground.ts`'s commit gate expires on a stale read, two very
 * different causes leave the same database row: the write FAILED (the instance
 * — a wedge, a restart, a 5xx), or every write answered 2xx and an older one
 * was committed after a newer one (#988, the autosave-overtake race). Only the
 * wire distinguishes them, and the failure text is the only record that
 * survives into the daily's artifacts.
 *
 * Scoped to a single flow id on purpose: workers share one backend, so a
 * neighbour's failing write is not evidence about this flow.
 */

/** Langflow's autosave is a whole-graph PATCH of the flow (see setup-playground.ts). */
const AUTOSAVE_METHOD = "PATCH";

/** `pathname`, never the raw URL — autosave gained a `?flow_id=` query once already (#1644). */
function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

/**
 * What the wire says about this flow's autosave, at one moment.
 *
 * `failures` alone is not enough, and reading its emptiness as "every write
 * answered 2xx" is how a frozen backend got blamed on #988 (#1695): a write
 * against a wedged instance is ISSUED and then hangs, so it neither fails nor
 * answers. Absence of failure is three states — nothing issued, something still
 * in flight, everything settled cleanly — and only the last is evidence for the
 * overtake race.
 */
export interface AutosaveEvidence {
  /** Writes that failed or answered non-2xx, oldest first. */
  failures: string[];
  /** Writes started for this flow. */
  issued: number;
  /** Writes that reached an outcome — an answer of any status, or a failure. */
  settled: number;
}

export interface AutosaveWatcher {
  /** A snapshot. A copy — callers cannot mutate the record. */
  evidence(): AutosaveEvidence;
  /** Detaches every listener. Idempotent. */
  dispose(): void;
}

export function watchAutosaveWrites(page: Page, flowId: string): AutosaveWatcher {
  const path = `/api/v1/flows/${flowId}`;
  const recorded: string[] = [];
  let issued = 0;
  let settled = 0;

  const isAutosave = (method: string, url: string): boolean =>
    method.toUpperCase() === AUTOSAVE_METHOD && pathnameOf(url) === path;

  const onRequest = (request: Request) => {
    if (!isAutosave(request.method(), request.url())) return;
    issued += 1;
  };

  const onRequestFailed = (request: Request) => {
    if (!isAutosave(request.method(), request.url())) return;
    settled += 1;
    recorded.push(
      `${AUTOSAVE_METHOD} ${path} → ${request.failure()?.errorText ?? "request failed"}`,
    );
  };

  const onResponse = (response: Response) => {
    const request = response.request();
    if (!isAutosave(request.method(), request.url())) return;
    settled += 1;
    if (response.ok()) return;
    recorded.push(
      `${AUTOSAVE_METHOD} ${path} → ${response.status()} ${response.statusText()}`,
    );
  };

  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  let disposed = false;
  return {
    evidence: () => ({ failures: [...recorded], issued, settled }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    },
  };
}
