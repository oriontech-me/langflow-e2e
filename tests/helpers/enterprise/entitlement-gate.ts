import { test, type APIRequestContext } from "@playwright/test";

/** The route whose answer decides whether this instance can validate a licence. */
const ENTITLEMENTS = "/api/v1/sso/entitlements";

/** What an instance that cannot validate a licence answers, everywhere. */
export const LICENCE_UNAVAILABLE_STATUS = 503;

/**
 * Skip unless the instance has **no** licence.
 *
 * The mirror of `requireEnvironmentPolicy()`: an Enterprise spec cannot create
 * the state it needs, so it asserts against the instance it was handed. Here the
 * needed state is the absence of an entitlement, which is the default for a
 * locally built image and the reason most of the SSO surface is untestable.
 *
 * The gate matters in the direction people forget. Every assertion in the
 * fail-closed spec describes the UNLICENSED behaviour — a `503`, an empty
 * connection list, a refused creation. Run them against a correctly licensed
 * deployment and they all fail, reporting a working instance as broken, which is
 * the failure mode this lane is most exposed to (a red about the environment
 * wearing the clothes of a red about the product).
 *
 * Skipping rather than failing, for that same reason: "this instance has a
 * licence" is a statement about the environment, not about Langflow.
 */
export async function requireNoEnterpriseLicence(
  request: APIRequestContext,
  auth: string,
): Promise<void> {
  const response = await request.get(ENTITLEMENTS, {
    headers: { Authorization: auth },
  });

  test.skip(
    response.status() !== LICENCE_UNAVAILABLE_STATUS,
    `${ENTITLEMENTS} answered ${response.status()}, not ${LICENCE_UNAVAILABLE_STATUS} — ` +
      `this instance can validate a licence. This spec describes what an ` +
      `instance WITHOUT one must do, so every assertion in it would fail here ` +
      `for the wrong reason. The entitled behaviour is a separate spec, and the ` +
      `plan records it as blocked on a licence key.`,
  );
}
