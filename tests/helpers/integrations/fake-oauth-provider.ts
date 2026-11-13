import type { BrowserContext, Page, Response, Route } from "@playwright/test";
import { type RateLimitWaitOptions, untilNotRateLimited } from "./oauth-callback";

/**
 * The provider's end of a consent, played by the test (#2307).
 *
 * The Connections dialog opens a popup on the provider's authorization URL and
 * learns the outcome by polling the connection row. This answers that URL inside
 * the browser context the way the provider would at the end of consent: a `302`
 * to the instance's own callback carrying the `state` it was given, or a page that
 * never redirects. The browser then delivers the REAL callback, with the REAL
 * binding cookie, to the real backend. Nothing leaves the machine.
 *
 * The popup must reach the callback through this redirect, never `popup.goto()`.
 * Measured on `1.14.0.dev2`: a browser-initiated navigation of the popup to
 * another site swaps its browsing instance, the dialog's handle on the window
 * then reads as closed, and *Try again* opens nothing.
 *
 * Spec doc: `docs/core-functionality/integrations/connection-oauth-wizard.md`.
 */

/** What the provider does with the next authorization request. */
export type ConsentOutcome =
  /** Redirects with `error=access_denied`. */
  | "deny"
  /** Redirects with neither `code` nor `error`: the server reads it as expired. */
  | "no-code"
  /** Serves a consent page and never redirects: a user who has not answered. */
  | "stall";

/** The authorization endpoints #2301's registrations build, by provider. */
export const PROVIDER_ORIGINS: Record<string, string> = {
  google: "https://accounts.google.com",
  microsoft: "https://login.microsoftonline.com",
  slack: "https://slack.com",
};

/** Body of the `stall` page, so a popup showing it is recognisable. */
export const FAKE_CONSENT_PAGE = "<!doctype html><title>E2E fake consent</title><p>E2E fake consent page</p>";

/**
 * Where the provider sends the browser for `outcome`, or `null` for `stall`.
 *
 * The callback is the instance's, not the registration's `redirect_uri`: #2301
 * registers `http://localhost/…` with no port so one value serves every lane, and
 * a lane's instance listens on its own port.
 */
export function consentRedirect(
  authorizationUrl: URL,
  provider: string,
  baseURL: string,
  outcome: ConsentOutcome,
): string | null {
  if (outcome === "stall") return null;
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error(`the authorization URL carries no state: ${authorizationUrl.href}`);
  const params = new URLSearchParams({ state });
  if (outcome === "deny") params.set("error", "access_denied");
  return `${new URL(`/api/v1/connections/oauth/${provider}/callback`, baseURL).href}?${params}`;
}

export interface FakeOAuthProvider {
  /** Sets what the provider does with every authorization request from now on. */
  answer(outcome: ConsentOutcome): void;
  /** Every authorization URL the browser opened, in order. */
  readonly requests: URL[];
  /**
   * Arms a wait for the next callback the browser delivers. Arm it BEFORE the
   * click that starts consent. A `429` is waited out (see `deliverCallback`).
   */
  nextCallback(options?: { timeout?: number } & RateLimitWaitOptions): Promise<Response>;
}

export async function installFakeOAuthProvider(
  context: BrowserContext,
  baseURL: string,
  provider = "google",
): Promise<FakeOAuthProvider> {
  let outcome: ConsentOutcome = "stall";
  const requests: URL[] = [];
  await context.route(`${PROVIDER_ORIGINS[provider]}/**`, async (route) => {
    const authorizationUrl = new URL(route.request().url());
    requests.push(authorizationUrl);
    const location = consentRedirect(authorizationUrl, provider, baseURL, outcome);
    if (location === null) {
      await route.fulfill({ status: 200, contentType: "text/html", body: FAKE_CONSENT_PAGE });
    } else {
      await route.fulfill({ status: 302, headers: { location } });
    }
  });
  const callbackPath = `/api/v1/connections/oauth/${provider}/callback`;
  const isCallback = (response: Response) => new URL(response.url()).pathname === callbackPath;
  return {
    answer: (next) => {
      outcome = next;
    },
    requests,
    nextCallback: ({ timeout = 30_000, ...wait } = {}) => {
      const first = context.waitForEvent("response", { predicate: isCallback, timeout });
      return first.then((response) => deliverCallback(context, response, isCallback, timeout, wait));
    },
  };
}

/**
 * A callback the popup received, waited past a `429`.
 *
 * The callback is limited to 5/minute per client IP, a bucket the whole lane
 * shares (the API spec exhausts it on purpose). A `429` is answered before the
 * `state` is read and leaves the binding cookie in place, so the popup can simply
 * load the same URL again once the window resets. `location.reload()` runs in the
 * page, so the popup keeps its place in the dialog's browsing instance. Measured:
 * the reloaded callback recorded the denial and the dialog showed it.
 */
async function deliverCallback(
  context: BrowserContext,
  first: Response,
  isCallback: (response: Response) => boolean,
  timeout: number,
  wait: RateLimitWaitOptions,
): Promise<Response> {
  if (first.status() !== 429) return first;
  const popup = first.frame().page();
  const reload = async () => {
    const next = context.waitForEvent("response", { predicate: isCallback, timeout });
    await reloadFromThePage(popup);
    return next;
  };
  const { result } = await holdConnectionList(context, () =>
    untilNotRateLimited("the callback in the consent popup", reload, (response) => response.status(), wait),
  );
  return result;
}

/**
 * Runs `wait` with the connection list served from one snapshot.
 *
 * A dialog waiting for consent reads `GET /api/v1/connections` every 2 s
 * (measured on `1.14.0.dev7`), and list reads are limited to 60/minute per user.
 * Waiting out a callback window with a dialog open therefore spends about half
 * of the superuser's read budget, and at `--workers=2`, where the API spec holds
 * the callback bucket, waits ran long enough to read the list into `429`. The
 * palette spec's canvas tests hold it too: every connector node they place reads
 * the list, and the answer is not what they assert (#2411).
 *
 * Only use it while the list cannot change: until the callback has landed, or
 * in a test that creates no connection. Then the snapshot is what the server
 * would answer. One read goes to the server at a time, a `429` is waited out
 * rather than handed to the page, and the route is gone before this returns, so
 * the read that teaches the page the outcome is a real one.
 */
export async function holdConnectionList<T>(
  context: Pick<BrowserContext, "route" | "unroute">,
  wait: () => Promise<T>,
  rateLimit: RateLimitWaitOptions = {},
): Promise<T> {
  const isList = (url: URL) => url.pathname === "/api/v1/connections";
  type Read = { status: number; headers: Record<string, string>; body: Buffer };
  let snapshot: Read | undefined;
  // The read in progress, shared: reads that arrive while it is out wait for it
  // instead of each going to the server (and, on a drained bucket, each waiting out
  // the window and then reading at once).
  let reading: Promise<Read> | undefined;
  let released = false;
  const taken = new Set<Promise<void>>();
  const read = (route: Route): Promise<Read> =>
    (reading ??= (async () => {
      // A 429 is waited out, never handed to the page: the bucket is shared with
      // whatever else the lane runs, and a refused read answers nothing (#2413).
      const res = await fetchAbsorbingReadLimit(route, rateLimit);
      return { status: res.status(), headers: res.headers(), body: await res.body() };
    })().finally(() => {
      reading = undefined;
    }));
  const answer = async (route: Route) => {
    if (snapshot) return route.fulfill(snapshot);
    const got = await read(route);
    // Only a successful read stands in for the server; anything else passes through as it came.
    if (got.status === 200) snapshot = got;
    await route.fulfill(got);
  };
  const handler = async (route: Route) => {
    if (released || route.request().method() !== "GET") return route.fallback();
    const answering = answer(route);
    taken.add(answering);
    try {
      await answering;
    } finally {
      taken.delete(answering);
    }
  };
  await context.route(isList, handler);
  try {
    return await wait();
  } finally {
    // Removing the context's last route makes Playwright send every request still
    // inside a handler on to the network, so a read still being fetched at that
    // moment is answered twice: its own fulfill then throws "Route is already
    // handled!" into the test (Playwright 1.58, `notifyRoutesInFlightAboutRemovedHandler`).
    // Measured at --workers=2 on the palette spec's canvas tests, which hold the list
    // for a whole test (#2413). So: take no new read, answer every read already taken,
    // and only then remove the route.
    released = true;
    while (taken.size > 0) await Promise.allSettled([...taken]);
    await context.unroute(isList, handler);
  }
}

/**
 * `location.reload()` run inside the popup, once its current answer has loaded.
 *
 * The response event fires before the popup commits that answer, so an
 * evaluation sent straight away can land in the document being replaced and die
 * with it ("Execution context was destroyed": measured, on the first `429` of a
 * validation burst). It waits for the page to load and tries again. The reload
 * itself is deferred so the evaluation returns before it tears the page down.
 */
async function reloadFromThePage(popup: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await popup.waitForLoadState("domcontentloaded");
    try {
      await popup.evaluate(() => void setTimeout(() => location.reload(), 0));
      return;
    } catch (error) {
      if (attempt >= 5 || !/Execution context was destroyed/.test(String(error))) throw error;
    }
  }
}

/**
 * Resends an `oauth/start` the dialog sent and the server refused with `429`.
 *
 * The start limit is 5/minute per user, and a UI under auto-login is always the
 * superuser, so a CI retry or a validation burst refuses the dialog's start and
 * the dialog shows *"Authorization did not complete."*. A refused start mints
 * nothing, so the request is sent again once the window resets, and the dialog
 * receives whatever the server answers then. Anything that is not a `429` passes
 * through untouched.
 */
export async function absorbStartRateLimit(page: Page, wait: RateLimitWaitOptions = {}): Promise<void> {
  await page.route("**/api/v1/connections/*/oauth/start", async (route) => {
    const { result } = await untilNotRateLimited(
      "oauth/start from the dialog",
      () => route.fetch(),
      (response) => response.status(),
      wait,
    );
    await route.fulfill({ response: result });
  });
}

/**
 * The two reads the dialog sends on its own: the connection list it polls and the
 * registration list it loads per provider. Both count against ONE bucket, the
 * server's `connections-read` scope, 60/minute per user (`api/v1/connections.py`,
 * measured on `1.14.0.dev14`), and a UI under auto-login is always the superuser.
 */
export function isConnectionRead(url: URL): boolean {
  return url.pathname === "/api/v1/connections" || url.pathname === "/api/v1/connections/oauth/registrations";
}

/**
 * `route.fetch()`, sent again while the server answers `429`, once its window
 * resets. A refused read changes nothing and does not extend the window, so the
 * read that finally answers is the one the server would have given. For a route
 * that stands in for part of the answer (a mocked registration list) and must
 * not start from a refusal.
 */
export async function fetchAbsorbingReadLimit(route: Route, wait: RateLimitWaitOptions = {}) {
  const { result } = await untilNotRateLimited(
    `GET ${new URL(route.request().url()).pathname} from the page`,
    () => route.fetch(),
    (response) => response.status(),
    wait,
  );
  return result;
}

/**
 * Resends a connection or registration list read the server refused with `429`
 * (#2376).
 *
 * The wizard spec spends the bucket on purpose: each dialog polls the list every
 * 2 s while consent is pending, and from `1.14.0.dev10` every row the dialog
 * creates or discards (langflow#15952) refetches both lists. Measured on
 * `1.14.0.dev14`: 63 reads in the file's first 37 s, so the last test's dialog
 * was refused its registration list and could not offer consent. A refused read
 * costs a wait here, not a red test, the trade `absorbStartRateLimit` makes for
 * starts. Anything that is not a `429` passes through untouched.
 *
 * Registered on the CONTEXT, so `holdConnectionList` (a context route added
 * later) still takes precedence while it holds. A page route that answers these
 * paths itself wins over this one and must call `fetchAbsorbingReadLimit`.
 */
export async function absorbReadRateLimit(context: BrowserContext, wait: RateLimitWaitOptions = {}): Promise<void> {
  await context.route(isConnectionRead, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    let response: Awaited<ReturnType<Route["fetch"]>>;
    try {
      response = await fetchAbsorbingReadLimit(route, wait);
    } catch {
      // The page closed while the read waited: nothing is left to answer.
      return route.abort().catch(() => undefined);
    }
    await route.fulfill({ response }).catch(() => undefined);
  });
}
