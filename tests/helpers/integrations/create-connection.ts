import type { APIRequestContext } from "@playwright/test";
import { deleteConnection, retryAfterMs } from "./delete-connection";

/**
 * Seeds a Dedicated Integrations connection via `POST /api/v1/connections` and
 * returns its id plus an id-scoped teardown callback — the connection-level
 * sibling of `createProjectViaApi`, and what every spec in the integrations batch
 * (#1966–#1970) seeds through.
 *
 * **No OAuth app, no tenant, no provider account.** `ConnectionCreate` accepts
 * `credentials` directly, so a planted token reaches `status: "ready"` with no
 * provider in play (measured on `1.13.0.dev19`). That is the default here,
 * because a connected row is the state the Connections page and its row actions
 * start from; pass `credentials: null` for a credential-free `pending` one, or a
 * sentinel of your own when the token itself is the subject (#1967).
 *
 * **Server-defaulted fields are left to the server.** `allow_non_interactive`,
 * `ownership_mode` and `granted_scopes` are sent only when the caller asks. The
 * opt-in's default is a security property — upstream's risk #8, and #1970's first
 * assertion — and a seed that always sent `false` would turn "a fresh connection
 * reads false" into an echo of this helper's own body, green even if the server's
 * default flipped to on.
 *
 * **A `429` is waited out once.** Connection writes share one per-user bucket of
 * 30/minute and the suite shares one superuser (see `delete-connection.ts`), so a
 * batch neighbour can exhaust it. Seeding is a precondition, not the subject, so
 * the refusal is absorbed ONCE with a logged warning and the SAME body is resent —
 * a new name would leave the first attempt's row unowned if the refusal came after
 * the write. A spec whose subject is `POST /api/v1/connections` issues its own raw
 * request instead (`api/connections/api-connections-lifecycle.spec.ts`).
 *
 * Failures throw an `Error` built here rather than a Playwright `expect`: outside
 * the runner the custom message of an `expect` is dropped, and the message is the
 * whole point of a seeding failure.
 */

/** The server's `CONNECTION_NAME_PATTERN` (`lfx.integrations.models`). */
export const CONNECTION_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** `ConnectionCreate.name` is `max_length=64`. */
export const CONNECTION_NAME_MAX_LENGTH = 64;

/** Credential material as `ConnectionCredentialWrite` accepts it. Write-only. */
export interface ConnectionCredentials {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  /** ISO-8601; the server stores it inside the encrypted envelope. */
  expires_at?: string;
}

/** `ConnectionAccount`: the non-secret account shown by connection pickers. */
export interface ConnectionAccount {
  id: string;
  display?: string;
  tenant_id?: string;
}

/** The 16 fields of `ConnectionRead`, as `1.13.0.dev19` returns them. */
export interface ConnectionRead {
  id: string;
  owner_id: string | null;
  ownership_mode: "user" | "instance";
  provider_key: string;
  name: string;
  display_name: string;
  status: "pending" | "ready" | "expired" | "revoked" | "error";
  status_reason: "credential-missing" | "credential-undecryptable" | null;
  health: "unknown" | "healthy" | "unhealthy";
  granted_scopes: string[];
  executing_identity: {
    identity: "user_delegated" | "bot" | "service";
    account: ConnectionAccount | null;
  };
  allow_non_interactive: boolean;
  has_credentials: boolean;
  health_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionOptions {
  /** Readable prefix of the generated `name`; folded into the server's pattern. */
  label?: string;
  /** Defaults to `google`, a provider the nightly's manifest lists. */
  providerKey?: string;
  /** Defaults to `E2E <name>`, so the row is recognisable in a shared instance. */
  displayName?: string;
  identity?: "user_delegated" | "bot" | "service";
  account?: ConnectionAccount;
  /** Sent only when given — the server defaults it to `[]`. */
  grantedScopes?: string[];
  /** Sent only when given — the server's default is the thing under test in #1970. */
  allowNonInteractive?: boolean;
  /** Sent only when given — the server defaults it to `"user"`. */
  ownershipMode?: "user" | "instance";
  /** Omitted: a planted credential (`ready`). `null`: no credential (`pending`). */
  credentials?: ConnectionCredentials | null;
  /** Override how a `429` is waited out. **Unit tests only.** */
  sleep?: (ms: number) => Promise<void>;
}

export interface CreatedConnection {
  id: string;
  name: string;
  displayName: string;
  /** The `201` body, as the server returned it. */
  connection: ConnectionRead;
  /** Deletes this connection; `404` counts as done. Safe to call in `finally`. */
  deleteConnection: (reqOverride?: APIRequestContext) => Promise<void>;
}

const randomChunk = (length: number) =>
  Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .padEnd(length, "0");

/**
 * A `name` the server accepts and no parallel worker shares.
 *
 * The repo's `uniqueName(label)` idiom joins with `-`, which the pattern refuses
 * (`422 string_pattern_mismatch`), so the label is folded to `[a-z0-9]` runs
 * joined by `_`. The discriminator — a base36 timestamp plus six random base36
 * characters, the same convention as `uniqueProjectName` — is appended last and
 * the LABEL is what gets truncated, so two calls can never collapse onto the same
 * 64-character prefix and collide on the `(owner, provider_key, name)` index.
 */
export function uniqueConnectionName(label: string): string {
  const discriminator = `${Date.now().toString(36)}_${randomChunk(6)}`;
  const folded = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const budget = CONNECTION_NAME_MAX_LENGTH - discriminator.length - 1;
  const trimmed = folded.slice(0, Math.max(0, budget)).replace(/_+$/, "");
  return trimmed ? `${trimmed}_${discriminator}` : discriminator;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function createConnectionViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  {
    label = "e2e_connection",
    providerKey = "google",
    displayName,
    identity = "user_delegated",
    account,
    grantedScopes,
    allowNonInteractive,
    ownershipMode,
    credentials,
    sleep = realSleep,
  }: CreateConnectionOptions = {},
): Promise<CreatedConnection> {
  const name = uniqueConnectionName(label);
  const data: Record<string, unknown> = {
    provider_key: providerKey,
    name,
    display_name: displayName ?? `E2E ${name}`,
    executing_identity: account ? { identity, account } : { identity },
  };
  if (grantedScopes !== undefined) data.granted_scopes = grantedScopes;
  if (allowNonInteractive !== undefined) data.allow_non_interactive = allowNonInteractive;
  if (ownershipMode !== undefined) data.ownership_mode = ownershipMode;
  if (credentials !== null) {
    data.credentials = credentials ?? {
      access_token: `E2E-PLANTED-${Date.now().toString(36)}${randomChunk(8)}`,
    };
  }

  let waitedForBudget = false;
  for (;;) {
    const res = await request.post("/api/v1/connections", { headers, data });
    const status = res.status();
    if (status === 201) {
      const connection = (await res.json()) as ConnectionRead;
      if (!connection?.id) {
        throw new Error(`POST /api/v1/connections answered 201 without an id: ${JSON.stringify(connection)}`);
      }
      return {
        id: connection.id,
        name,
        displayName: connection.display_name,
        connection,
        deleteConnection: (reqOverride?: APIRequestContext) =>
          deleteConnection(reqOverride ?? request, connection.id, { headers }),
      };
    }
    if (status === 429 && !waitedForBudget) {
      waitedForBudget = true;
      const wait = retryAfterMs(res.headers());
      console.warn(
        `⚠️ Seeding connection "${name}" hit the per-user write limit (429) — waiting ${wait} ms for the window to reset`,
      );
      await sleep(wait);
      continue;
    }
    throw new Error(`POST /api/v1/connections failed for "${name}": ${status} — ${await res.text()}`);
  }
}
