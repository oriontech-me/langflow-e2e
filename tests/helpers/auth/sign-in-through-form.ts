import type { Page, Response } from "@playwright/test";
import { waitForAttributedResponse } from "../other/response-barrier";
import { retryAfterMs } from "./login-request";

/**
 * Budget for the login response. Unchanged since the helper was written, and
 * deliberately not widened by #1713: the outages that expire it lasted 92s and
 * 96s, so a barrier long enough to outlast one would report a green run through
 * a broken backend.
 */
const LOGIN_RESPONSE_TIMEOUT_MS = 30000;

/**
 * Fills the login form, submits, and absorbs the endpoint's per-IP rate limit.
 *
 * The browser side of `postLogin` (see login-request.ts): `POST /api/v1/login`
 * is limited to 5/min per client address, fixed window, counted before
 * authentication — so a UI login can be refused purely because of the SUITE's
 * own earlier traffic (the auth directory spends ~15 form+API logins in ~3
 * minutes; measured collision: `logout-flow` timing out on `mainpage_title`
 * right after `auto-login-off`'s three form logins). On a 429 this waits out
 * the window the server names in `retry_after` and clicks again — the form
 * keeps its values. Any other status is the caller's verdict: 200 callers gate
 * on the workspace, 401 callers on the error toast, and neither is hidden.
 *
 * The response is captured via a `waitForResponse` registered BEFORE the click,
 * so the status read cannot race the navigation that a 200 triggers — and it is
 * ATTRIBUTED (#1713): a bare wait fails as `page.waitForResponse: Timeout
 * 30000ms exceeded`, which cannot say whether the backend accepted the POST and
 * never answered or the login form stopped issuing it. On timeout the barrier
 * probes `/api/v1/version` and names the state it observed; see
 * `helpers/other/response-barrier.ts` for the measurement and for why
 * `page.waitForResponse: Timeout` must not be added to the infra-signature list.
 *
 * Returns the final HTTP status, for callers that want to assert it directly.
 */
export async function signInThroughForm(
  page: Page,
  username: string,
  password: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("Password").fill(password);
  // The client-side auto-login mock's flag: removed so the login the user just
  // typed is the one the app performs (same contract as the specs had inline).
  await page.evaluate(() => {
    sessionStorage.removeItem("testMockAutoLogin");
  });

  const submitOnce = async (): Promise<Response> => {
    const responsePromise = waitForAttributedResponse(
      page,
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/v1/login") &&
        response.request().method() === "POST",
      {
        observable: "POST /api/v1/login",
        timeoutMs: LOGIN_RESPONSE_TIMEOUT_MS,
        surface: "login",
      },
    );
    await page.getByRole("button", { name: "Sign In" }).click();
    return responsePromise;
  };

  let response = await submitOnce();
  for (let retry = 0; retry < 2 && response.status() === 429; retry++) {
    const body = await response.json().catch(() => null);
    await sleep(retryAfterMs(body));
    response = await submitOnce();
  }
  return response.status();
}
