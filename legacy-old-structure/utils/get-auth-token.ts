import type { APIRequestContext } from "@playwright/test";

/**
 * Retrieves a Langflow authentication token.
 * In auto_login mode (default), uses /api/v1/auto_login.
 * Returns the Authorization header ready for use.
 */
export async function getAuthToken(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/v1/auto_login");

  if (res.ok()) {
    const body = await res.json();
    if (body?.access_token) {
      return `Bearer ${body.access_token}`;
    }
  }

  // fallback: no token (environment without auth)
  return "";
}
