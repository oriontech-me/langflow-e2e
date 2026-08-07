import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Mints a Langflow API key via `POST /api/v1/api_key/` and returns the plaintext
 * value plus the id needed to delete it.
 *
 * **The plaintext is returned only once, on the creation response.** `GET
 * /api/v1/api_keys/` lists keys with the value masked, so a test that does not
 * capture it here cannot recover it — which is why this returns both halves
 * together rather than just the id.
 *
 * The key authenticates through the **`x-api-key`** header, not
 * `Authorization: Bearer`. Under `AUTO_LOGIN` the two are not interchangeable for
 * endpoints that gate on an API key specifically: the A2A JSON-RPC route calls
 * `authenticate_api_key` directly rather than `api_key_security`, precisely
 * because the latter returns the superuser for a *missing* key and would silently
 * bypass the gate. A bearer token therefore does not satisfy that check.
 *
 * Delete with `deleteApiKey` in the caller's teardown — a key outlives the test
 * that created it.
 */

export interface CreatedApiKey {
  /** The plaintext key, for the `x-api-key` header. Only available here. */
  key: string;
  /** The key's id, for `DELETE /api/v1/api_key/{id}`. */
  id: string;
}

export async function createApiKey(
  request: APIRequestContext,
  headers: Record<string, string>,
  { namePrefix = "e2e-key" }: { namePrefix?: string } = {},
): Promise<CreatedApiKey> {
  const name = `${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const res = await request.post("/api/v1/api_key/", { headers, data: { name } });
  expect(res.status(), `POST /api/v1/api_key/ — ${await res.text()}`).toBe(200);

  const body = await res.json();
  // Asserted rather than assumed: a creation that returned no plaintext would
  // surface downstream as an unexplained 401 from the endpoint under test.
  expect(body.api_key, "creation returns the plaintext key").toBeTruthy();
  expect(body.id, "creation returns the key id").toBeTruthy();

  return { key: body.api_key as string, id: body.id as string };
}

/**
 * Deletes an API key by id. Tolerates `404` (already gone) so it is safe in a
 * `finally` that may run twice, and surfaces any other failure — a silently
 * ignored status is how keys accumulate on the shared superuser account.
 */
export async function deleteApiKey(
  request: APIRequestContext,
  id: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await request.delete(`/api/v1/api_key/${id}`, { headers });
  if (res.ok() || res.status() === 404) return;
  throw new Error(
    `API key cleanup failed: ${res.status()} — ${await res.text()}`,
  );
}
