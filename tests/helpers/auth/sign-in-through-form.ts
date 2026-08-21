import type { Page, Response } from "@playwright/test";
import { retryAfterMs } from "./login-request";

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
 * The response is captured via `waitForResponse` registered BEFORE the click,
 * so the status read cannot race the navigation that a 200 triggers.
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
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/v1/login") &&
        response.request().method() === "POST",
      { timeout: 30000 },
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
