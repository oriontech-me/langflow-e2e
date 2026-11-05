import type { APIRequestContext, APIResponse } from "@playwright/test";

/**
 * Driving a Dedicated Integrations OAuth authorization from the outside (#2307):
 * `POST /api/v1/connections/{id}/oauth/start` and the provider's callback,
 * `GET /api/v1/connections/oauth/{provider}/callback`.
 *
 * Needs #2301's fake registrations on the instance. Without them `oauth/start`
 * answers `400 "OAuth registration ID is not configured."` and `startOAuth`
 * throws, so a lane that lost the variable fails instead of skipping (#1010).
 *
 * Measured on `1.14.0.dev2`; spec doc
 * `docs/api/connections/api-connections-oauth-callback.md`.
 */

/** The one body every refused callback answers, whatever the cause. */
export const OAUTH_FAILURE_BODY = "OAuth authorization failed. Return to connections and start again.";

/** The headers `oauth/start`, the callback and its `429` page all carry. */
export const OAUTH_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

/** Title and heading of the HTML `429` the two browser-facing OAuth routes answer. */
export const OAUTH_RATE_LIMIT_TITLE = "Too many OAuth attempts";

/** The binding cookie `oauth/start` sets: `lf_connection_oauth_` + 24 hex of the state's digest. */
export const BINDING_COOKIE_NAME = /^lf_connection_oauth_[0-9a-f]{24}$/;

export interface BindingCookie {
  name: string;
  value: string;
  /** Lower-cased attribute names; a flag (`HttpOnly`) maps to `true`. */
  attributes: Record<string, string | true>;
}

/**
 * The binding cookie among a response's `Set-Cookie` values.
 *
 * A callback answers with a deletion of the cookie it was sent (`Max-Age=0`),
 * so only a cookie that is being SET counts. Exactly one must be: two would mean
 * a start bound two browsers, and the caller could not know which to send.
 */
export function parseBindingCookie(setCookies: string[]): BindingCookie {
  const parsed = setCookies.map((raw) => {
    const [pair, ...rest] = raw.split(";");
    const eq = pair.indexOf("=");
    const attributes: Record<string, string | true> = {};
    for (const part of rest) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const at = trimmed.indexOf("=");
      if (at === -1) attributes[trimmed.toLowerCase()] = true;
      else attributes[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim();
    }
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes };
  });
  const bindings = parsed.filter(
    (cookie) => BINDING_COOKIE_NAME.test(cookie.name) && cookie.attributes["max-age"] !== "0",
  );
  if (bindings.length !== 1) {
    throw new Error(
      `expected exactly one binding cookie being set, found ${bindings.length} in: ${JSON.stringify(setCookies)}`,
    );
  }
  return bindings[0];
}

/** Every `Set-Cookie` value of a response; `headers()` would join them. */
export function setCookiesOf(response: Pick<APIResponse, "headersArray">): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);
}

export interface StartedOAuth {
  response: APIResponse;
  authorizationUrl: URL;
  /** The one-shot `state`, as the provider would hand it back. */
  state: string;
  cookie: BindingCookie;
}

/** `oauth/start` for a connection the caller owns; throws on anything but `200`. */
export async function startOAuth(
  request: APIRequestContext,
  headers: Record<string, string>,
  connectionId: string,
  { registrationId, scopes }: { registrationId: string; scopes: string[] },
): Promise<StartedOAuth> {
  const response = await request.post(`/api/v1/connections/${connectionId}/oauth/start`, {
    headers,
    data: { registration_id: registrationId, scopes },
  });
  if (response.status() !== 200) {
    throw new Error(
      `oauth/start answered ${response.status()}: ${await response.text()} — ` +
        "does this instance carry #2301's fake registrations (LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS)?",
    );
  }
  const authorizationUrl = new URL(((await response.json()) as { authorization_url: string }).authorization_url);
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error(`the authorization URL carries no state: ${authorizationUrl.href}`);
  return { response, authorizationUrl, state, cookie: parseBindingCookie(setCookiesOf(response)) };
}

/** The per-minute windows the OAuth buckets use; a refused hit does not extend one. */
export const RATE_LIMIT_POLL_MS = 5_000;
/**
 * Two whole windows plus slack: a bucket still refusing after this is not a
 * timing accident. One window is not enough, because the API spec exhausts the
 * per-IP callback bucket on purpose. A waiter in the wizard spec can lose the
 * first reset to that spec and then has to sit out the window it just used
 * (measured at `--workers=2`: still refused after 80 s).
 */
export const RATE_LIMIT_CAP_MS = 135_000;

export interface RateLimitWaitOptions {
  /** **Unit tests only.** */
  sleep?: (ms: number) => Promise<void>;
  /** **Unit tests only.** */
  now?: () => number;
  /** Where the wait is reported; the default is the run log. */
  log?: (line: string) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends until the answer is not a `429`, for at most one rate-limit window.
 *
 * Safe only for a request whose `429` consumes nothing, which holds for the OAuth
 * callback and `oauth/start`: the limit check is their first line, before the
 * `state` is read or minted. Their buckets are shared with the rest of the lane
 * (the callback's per client IP, a start's per user), so a refusal says nothing
 * about the code under test. A `429` that outlives the cap is returned as is,
 * for the caller's assertion to name.
 */
export async function untilNotRateLimited<T>(
  label: string,
  send: () => Promise<T>,
  statusOf: (result: T) => number,
  { sleep = realSleep, now = Date.now, log = (line) => console.log(line) }: RateLimitWaitOptions = {},
): Promise<{ result: T; waitedMs: number }> {
  const startedAt = now();
  let result = await send();
  if (statusOf(result) !== 429) return { result, waitedMs: 0 };
  while (statusOf(result) === 429 && now() - startedAt < RATE_LIMIT_CAP_MS) {
    await sleep(RATE_LIMIT_POLL_MS);
    result = await send();
  }
  const waitedMs = now() - startedAt;
  const outcome = statusOf(result) === 429 ? "still refused" : "answered";
  log(`[oauth] ${label} was rate-limited; ${outcome} after ${Math.round(waitedMs / 1000)}s of waiting`);
  return { result, waitedMs };
}

export interface CallbackOptions extends RateLimitWaitOptions {
  provider: string;
  state: string;
  /** `null` sends an explicit empty `Cookie`, so the context's jar cannot add the binding. */
  cookie: BindingCookie | null;
  /** `error`, `code`, … appended after `state`. */
  query?: Record<string, string>;
  /** `false` returns a `429` as is: for the test whose subject it is. */
  absorbRateLimit?: boolean;
}

export interface CallbackResult {
  response: APIResponse;
  body: string;
  waitedMs: number;
}

/**
 * One callback, as the provider's redirect would deliver it.
 *
 * The `Cookie` header is always explicit. A Playwright request context keeps a
 * jar: it stores the binding from `oauth/start` and drops it when a callback
 * answers `Max-Age=0`. Left to the jar, a "no cookie" call could carry it and a
 * replay could not. Measured on `1.14.0.dev2`: an explicit empty header leaves
 * the jar's cookie unsent.
 */
export async function sendOAuthCallback(
  request: APIRequestContext,
  { provider, state, cookie, query = {}, absorbRateLimit = true, ...wait }: CallbackOptions,
): Promise<CallbackResult> {
  const params = new URLSearchParams({ state, ...query });
  const send = () =>
    request.get(`/api/v1/connections/oauth/${provider}/callback?${params}`, {
      headers: { Cookie: cookie ? `${cookie.name}=${cookie.value}` : "" },
      maxRedirects: 0,
    });
  const { result: response, waitedMs } = absorbRateLimit
    ? await untilNotRateLimited(`the ${provider} callback`, send, (res) => res.status(), wait)
    : { result: await send(), waitedMs: 0 };
  return { response, body: await response.text(), waitedMs };
}
