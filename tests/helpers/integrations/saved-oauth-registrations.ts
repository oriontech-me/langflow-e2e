import type { APIRequestContext, APIResponse } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { type ConnectionsOwner, createConnectionsOwner } from "./connections-owner";
import { retryAfterMs } from "./delete-connection";

/**
 * OAuth registrations saved from *Settings › Connections › Manage providers*
 * (langflow-ai/langflow#16251, first in `1.14.0.dev22`; #2421).
 *
 * A saved registration is instance-wide state: the process that handles a save
 * merges it into `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS` at once, so every user's
 * connection wizard can offer it. A spec that saves one must therefore pick a
 * registration no other spec reads. The builder here makes **Slack `bot`**
 * registrations: the wizard spec asserts there is no picker for Google and
 * reconnects through `e2e-microsoft`, and nothing reads the Slack bot registrations.
 * Jira, Confluence, Salesforce and ServiceNow are not an option: each refuses a save
 * until the server names its deployment site (`422`, measured on `1.14.0.dev28`), and
 * no lane sets one.
 */

export const SAVED_REGISTRATIONS = "/api/v1/connections/oauth/registrations/saved";
/** The first build that serves the saved-registration routes and the panel. */
export const MANAGE_PROVIDERS_SINCE = "1.14.0.dev22";
/** The prefix of the `Credential` variable a saved registration is stored in. */
export const REGISTRATION_VARIABLE_PREFIX = "LANGFLOW_OAUTH_REGISTRATION__";
/** The server's own pattern for a registration ID (`REGISTRATION_ID_PATTERN`). */
export const REGISTRATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const REGISTRATION_ID_MAX_LENGTH = 120;
/** A Slack registration's callback; the server accepts loopback HTTP on any port. */
export const SLACK_CALLBACK = "http://localhost/api/v1/connections/oauth/slack/callback";

/** One entry of `GET …/saved`: the registration without its secret fields. */
export interface SavedRegistrationRead {
  id: string;
  registration: Record<string, unknown>;
  has_secret: boolean;
  saved_by: string;
  updated_at: string | null;
  status: "active" | "overridden" | "pending" | "removed";
}

/** One entry of `GET /api/v1/connections/oauth/registrations`, as far as specs read it. */
export interface ActiveRegistrationRead {
  id: string;
  provider: string;
  profile: string;
  scopes: string[];
}

const randomChunk = (length: number) =>
  Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .padEnd(length, "0");

/**
 * A registration ID the server accepts and no parallel worker shares:
 * `e2e-saved-<label>-<base36 time><random>`. The label is folded to `[a-z0-9-]`
 * and truncated, never the discriminator, so two calls cannot collide.
 */
export function uniqueRegistrationId(label: string): string {
  const discriminator = `${Date.now().toString(36)}${randomChunk(6)}`;
  const folded = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = "e2e-saved-";
  const budget = REGISTRATION_ID_MAX_LENGTH - prefix.length - discriminator.length - 1;
  const trimmed = folded.slice(0, Math.max(0, budget)).replace(/-+$/, "");
  return trimmed ? `${prefix}${trimmed}-${discriminator}` : `${prefix}${discriminator}`;
}

/** A sentinel no response may ever echo, unique to the call. */
export function secretSentinel(label: string): string {
  return `E2E-SAVED-SECRET-${label.toUpperCase()}-${Date.now().toString(36)}${randomChunk(8)}`;
}

/** A confidential Slack `bot` registration, in the shape the server stores. */
export function slackBotRegistration({
  clientId,
  scopes = ["chat:write"],
  clientSecret,
  signingSecret,
}: {
  clientId: string;
  scopes?: string[];
  /** Omitted from the body when undefined: a replace keeps the saved one. */
  clientSecret?: string;
  signingSecret?: string;
}): Record<string, unknown> {
  const registration: Record<string, unknown> = {
    provider: "slack",
    profile: "bot",
    client_id: clientId,
    redirect_uri: SLACK_CALLBACK,
    scopes,
  };
  if (clientSecret !== undefined) registration.client_secret = clientSecret;
  if (signingSecret !== undefined) registration.signing_secret = signingSecret;
  return registration;
}

/** `PUT …/saved/{id}`; the caller asserts the status. */
export function putSavedRegistration(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  registration: Record<string, unknown>,
): Promise<APIResponse> {
  return request.put(`${SAVED_REGISTRATIONS}/${id}`, { headers, data: { registration } });
}

/** `GET …/saved`, which must answer `200`. */
export async function listSavedRegistrations(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<{ response: APIResponse; text: string; registrations: SavedRegistrationRead[] }> {
  const response = await request.get(SAVED_REGISTRATIONS, { headers });
  const text = await response.text();
  if (response.status() !== 200) {
    throw new Error(`GET ${SAVED_REGISTRATIONS} answered ${response.status()}: ${text}`);
  }
  return { response, text, registrations: (JSON.parse(text) as { registrations: SavedRegistrationRead[] }).registrations };
}

/** `GET /api/v1/connections/oauth/registrations?provider=`, which must answer `200`. */
export async function listActiveRegistrations(
  request: APIRequestContext,
  headers: Record<string, string>,
  provider: string,
): Promise<{ text: string; registrations: ActiveRegistrationRead[] }> {
  const response = await request.get("/api/v1/connections/oauth/registrations", {
    headers,
    params: { provider },
  });
  const text = await response.text();
  if (response.status() !== 200) {
    throw new Error(`GET /api/v1/connections/oauth/registrations?provider=${provider} answered ${response.status()}: ${text}`);
  }
  return { text, registrations: (JSON.parse(text) as { registrations: ActiveRegistrationRead[] }).registrations };
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Removes a saved registration in teardown: `204` or `404` (already gone) is done.
 *
 * Always through the API, and always before the saver is deleted. A `DELETE` makes
 * the process re-merge its registrations; deleting the saver instead drops the row
 * from the saved list while the process keeps using the registration until the next
 * save or removal by anyone (measured on `1.14.0.dev28`). A `429` is waited out once,
 * as `deleteConnection` does: writes share a per-user bucket of 30/minute.
 */
export async function removeSavedRegistration(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const response = await request.delete(`${SAVED_REGISTRATIONS}/${id}`, { headers });
    if (response.status() === 204 || response.status() === 404) return;
    if (response.status() === 429 && attempt === 0) {
      await sleep(retryAfterMs(response.headers()));
      continue;
    }
    throw new Error(`DELETE ${SAVED_REGISTRATIONS}/${id} answered ${response.status()}: ${await response.text()}`);
  }
}

/** A throwaway superuser: the routes are superuser-only, and its buckets are its own. */
export interface RegistrationsOwner extends ConnectionsOwner {
  username: string;
}

/**
 * A throwaway user, promoted to superuser, that saves this file's registrations.
 *
 * Saving as the shared superuser would spend the write bucket every connections spec
 * shares (30/minute, #2295), and make `saved_by` a name every spec uses. The owner is
 * `createConnectionsOwner`'s user promoted the way
 * `api-connections-resolution-non-interactive.spec.ts` promotes its own. One login.
 */
export async function createRegistrationsOwner(
  request: APIRequestContext,
  newContext: () => Promise<APIRequestContext>,
  prefix: string,
): Promise<RegistrationsOwner> {
  const owner = await createConnectionsOwner(newContext, prefix);
  try {
    const superHeaders = { Authorization: await getAuthToken(request) };
    const promoted = await request.patch(`/api/v1/users/${owner.userId}`, {
      headers: superHeaders,
      data: { is_superuser: true },
    });
    const promotedText = await promoted.text();
    if (promoted.status() !== 200 || (JSON.parse(promotedText) as { is_superuser?: boolean }).is_superuser !== true) {
      throw new Error(`promoting the registrations owner answered ${promoted.status()}: ${promotedText}`);
    }
    const whoami = await request.get("/api/v1/users/whoami", { headers: owner.headers });
    const whoamiText = await whoami.text();
    if (whoami.status() !== 200) throw new Error(`GET /api/v1/users/whoami answered ${whoami.status()}: ${whoamiText}`);
    const me = JSON.parse(whoamiText) as { username: string; is_superuser: boolean };
    if (!me.is_superuser) throw new Error(`the registrations owner does not read as a superuser: ${whoamiText}`);
    return { ...owner, username: me.username };
  } catch (error) {
    await owner.dispose().catch(() => undefined);
    throw error;
  }
}
