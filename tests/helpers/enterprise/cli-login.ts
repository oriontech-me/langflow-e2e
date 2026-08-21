import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";

/**
 * The Enterprise CLI sign-in flow: authorization code + PKCE.
 *
 * Lives in a helper because every negative case needs its OWN authorization.
 * A failed exchange CONSUMES the code — measured: after a refused attempt, the
 * correct exchange of the same code is refused too. Reusing one authorization
 * across cases would make every assertion after the first pass for the wrong
 * reason, so "one fresh authorization per case" has to be the easy path.
 */
export interface CliAuthorization {
  code: string;
  state: string;
  redirectUri: string;
  codeVerifier: string;
}

/** RFC 7636 requires 43..128 characters; below that the API rejects on length. */
export function createVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function scrape(html: string, field: string): string {
  const match = html.match(new RegExp(`name="${field}" value="([^"]+)"`));
  if (!match) {
    throw new Error(`the consent page carries no ${field} — the flow changed shape`);
  }
  return match[1];
}

/**
 * Drive consent + approval and return an unspent authorization code.
 *
 * `redirectUri` is never fetched: it is echoed into the `302` and compared at
 * exchange time, which is what makes this reachable with no listener.
 */
export async function authorizeCliLogin(
  request: APIRequestContext,
  auth: string,
  { state, redirectUri = "http://127.0.0.1:9999/callback" }: { state: string; redirectUri?: string },
): Promise<CliAuthorization> {
  const codeVerifier = createVerifier();

  const consent = await request.get("/api/v1/auth/cli-login", {
    headers: { Authorization: auth },
    params: {
      redirect_uri: redirectUri,
      state,
      code_challenge: challengeFor(codeVerifier),
      code_challenge_method: "S256",
    },
  });
  if (!consent.ok()) {
    throw new Error(`the consent page answered ${consent.status()}`);
  }
  const html = await consent.text();

  const approval = await approveCliLogin(request, auth, {
    requestId: scrape(html, "request_id"),
    csrfToken: scrape(html, "csrf_token"),
  });
  if (approval.status() !== 302) {
    throw new Error(`approval answered ${approval.status()} instead of redirecting`);
  }

  const location = approval.headers()["location"];
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`the approval redirect carried no code: ${location}`);
  }

  return { code, state, redirectUri, codeVerifier };
}

/**
 * POST the approval form. Exposed on its own so the CSRF and origin cases can
 * drive it with deliberately wrong values.
 *
 * `maxRedirects: 0` is load-bearing: following the redirect would hand the code
 * to a listener that does not exist and lose it from the response.
 */
export function approveCliLogin(
  request: APIRequestContext,
  auth: string,
  {
    requestId,
    csrfToken,
    origin = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7890",
  }: { requestId: string; csrfToken: string; origin?: string },
): Promise<APIResponse> {
  return request.post("/api/v1/auth/cli-login/approve", {
    headers: { Authorization: auth, Origin: origin },
    form: { request_id: requestId, csrf_token: csrfToken },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
}

/**
 * Exchange an authorization for tokens. Overrides drive the negative cases.
 *
 * `code` is overridable so a caller can send a value that was never issued —
 * needed to assert that an unknown code and an EXPIRED one are refused
 * identically, which is the property that keeps this endpoint from being an
 * oracle.
 */
export function exchangeCliCode(
  request: APIRequestContext,
  auth: string,
  authorization: CliAuthorization,
  overrides: Partial<
    Pick<CliAuthorization, "code" | "state" | "redirectUri" | "codeVerifier">
  > = {},
): Promise<APIResponse> {
  return request.post("/api/v1/auth/cli-login/token", {
    headers: { Authorization: auth },
    data: {
      code: overrides.code ?? authorization.code,
      state: overrides.state ?? authorization.state,
      redirect_uri: overrides.redirectUri ?? authorization.redirectUri,
      code_verifier: overrides.codeVerifier ?? authorization.codeVerifier,
    },
    failOnStatusCode: false,
  });
}

/** Read the consent page's raw response, for the header assertions. */
export function fetchConsentPage(
  request: APIRequestContext,
  auth: string,
  { state, redirectUri = "http://127.0.0.1:9999/callback" }: { state: string; redirectUri?: string },
): Promise<APIResponse> {
  const verifier = createVerifier();
  return request.get("/api/v1/auth/cli-login", {
    headers: { Authorization: auth },
    params: {
      redirect_uri: redirectUri,
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: "S256",
    },
    failOnStatusCode: false,
  });
}
