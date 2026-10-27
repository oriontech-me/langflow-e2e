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
 * the callback bucket, waits ran long enough to read the list into `429`.
 *
 * Only use it while the callback has not landed. Until then the row cannot
 * change, so the snapshot is what the server would answer. The route is gone
 * before this returns, so the read that teaches the dialog the outcome is a
 * real one.
 */
export async function holdConnectionList<T>(context: BrowserContext, wait: () => Promise<T>): Promise<T> {
  const isList = (url: URL) => url.pathname === "/api/v1/connections";
  let snapshot: { status: number; headers: Record<string, string>; body: Buffer } | undefined;
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (snapshot) return route.fulfill(snapshot);
    const res = await route.fetch();
    const answer = { status: res.status(), headers: res.headers(), body: await res.body() };
    // Only a successful read stands in for the server; anything else passes through as it came.
    if (answer.status === 200) snapshot = answer;
    await route.fulfill(answer);
  };
  await context.route(isList, handler);
  try {
    return await wait();
  } finally {
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
