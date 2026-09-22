// Unit tests for uniqueConnectionName and createConnectionViaApi (#1966).
// Run with: npm run test:units
//
// Two properties a green spec cannot show. The NAME must satisfy a pattern the
// repo's own `uniqueName` idiom violates (`-` is refused with a 422), and must stay
// unique inside 64 characters — or every parallel worker collides on the
// `(owner, provider_key, name)` unique index with a 409. And the CREATE must seed
// a `ready` connection by default (a planted credential), because that is the
// state every UI spec in the batch starts from, while still letting a caller ask
// for a credential-free `pending` one.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  createConnectionViaApi,
  uniqueConnectionName,
} from "./create-connection";
import { RETRY_AFTER_MARGIN_MS } from "./delete-connection";

interface Call {
  method: string;
  url: string;
  data?: any;
  headers?: Record<string, string>;
}

/**
 * A fake APIRequestContext. POST answers `postStatuses` in order (the last
 * repeats), echoing the body back as a ConnectionRead-like row; DELETE answers 204.
 */
function fakeRequest(postStatuses: number[] = [201], retryAfter = "60") {
  const calls: Call[] = [];
  let i = 0;
  const request = {
    post: async (url: string, o: { data?: any; headers?: Record<string, string> } = {}) => {
      calls.push({ method: "POST", url, data: o.data, headers: o.headers });
      const status = postStatuses[Math.min(i++, postStatuses.length - 1)];
      const body =
        status === 201
          ? {
              id: "11111111-1111-4111-8111-111111111111",
              name: o.data.name,
              display_name: o.data.display_name,
              status: o.data.credentials ? "ready" : "pending",
              has_credentials: Boolean(o.data.credentials),
              allow_non_interactive: o.data.allow_non_interactive ?? false,
            }
          : { detail: `status ${status}` };
      return {
        ok: () => status >= 200 && status < 300,
        status: () => status,
        headers: () => (status === 429 ? { "retry-after": retryAfter } : {}),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
    delete: async (url: string, o: { headers?: Record<string, string> } = {}) => {
      calls.push({ method: "DELETE", url, headers: o.headers });
      return {
        ok: () => true,
        status: () => 204,
        headers: () => ({}),
        text: async () => "",
      };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const HEADERS = { Authorization: "Bearer t" };

test("uniqueConnectionName satisfies the server's name pattern and length", () => {
  const name = uniqueConnectionName("lifecycle");
  assert.match(name, CONNECTION_NAME_PATTERN);
  assert.ok(name.length <= CONNECTION_NAME_MAX_LENGTH);
  assert.ok(name.startsWith("lifecycle_"), name);
});

test("uniqueConnectionName folds hyphens, spaces and case into the pattern", () => {
  // The repo's uniqueName idiom joins with "-", which the server refuses with a
  // 422 string_pattern_mismatch — a caller's label must never reintroduce it.
  const name = uniqueConnectionName("Row Actions--UI!");
  assert.match(name, CONNECTION_NAME_PATTERN);
  assert.ok(name.startsWith("row_actions_ui_"), name);
});

test("uniqueConnectionName keeps its discriminator when the label is too long", () => {
  const label = "a".repeat(200);
  const a = uniqueConnectionName(label);
  const b = uniqueConnectionName(label);
  assert.ok(a.length <= CONNECTION_NAME_MAX_LENGTH, `${a.length} > ${CONNECTION_NAME_MAX_LENGTH}`);
  assert.match(a, CONNECTION_NAME_PATTERN);
  // Truncation must cut the LABEL, never the part that makes two calls differ.
  assert.notEqual(a, b);
});

test("uniqueConnectionName still yields a valid name from an empty or symbol-only label", () => {
  for (const label of ["", "---", "  "]) {
    const name = uniqueConnectionName(label);
    assert.match(name, CONNECTION_NAME_PATTERN, JSON.stringify(label));
  }
});

test("uniqueConnectionName differs across calls", () => {
  const names = new Set(Array.from({ length: 50 }, () => uniqueConnectionName("x")));
  assert.equal(names.size, 50);
});

test("createConnectionViaApi seeds a ready google connection with a planted credential by default", async () => {
  const { request, calls } = fakeRequest();
  const created = await createConnectionViaApi(request, HEADERS, { label: "seed" });

  assert.equal(calls.length, 1);
  const { url, data, headers } = calls[0];
  assert.equal(url, "/api/v1/connections");
  assert.deepEqual(headers, HEADERS);
  assert.equal(data.provider_key, "google");
  assert.match(data.name, CONNECTION_NAME_PATTERN);
  assert.ok(data.name.startsWith("seed_"));
  assert.equal(typeof data.display_name, "string");
  assert.ok(data.display_name.length > 0);
  assert.deepEqual(data.executing_identity, { identity: "user_delegated" });
  assert.equal(typeof data.credentials?.access_token, "string");
  assert.ok(data.credentials.access_token.length > 0);

  assert.equal(created.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(created.name, data.name);
  assert.equal(created.connection.status, "ready");
});

test("createConnectionViaApi leaves the non-interactive opt-in to the server's default", async () => {
  // The opt-in's default is a security property (#1970: a default flipped to on
  // is a silent privilege grant). A seed that always sent `false` would make any
  // "fresh connection reads false" assertion an echo of the helper's own body —
  // green even if the server's default flipped. Only an explicit request sends it.
  const { request, calls } = fakeRequest();
  await createConnectionViaApi(request, HEADERS, { label: "default" });
  assert.equal("allow_non_interactive" in calls[0].data, false);
  // Nor the other server-defaulted fields: what the server fills in is what a
  // caller relying on the default is testing.
  assert.equal("ownership_mode" in calls[0].data, false);
  assert.equal("granted_scopes" in calls[0].data, false);
});

test("createConnectionViaApi sends no credentials key when asked for a pending connection", async () => {
  // `credentials: null` on the wire is not the same as absent — the schema
  // accepts null today, but the intent here is "no credential at all".
  const { request, calls } = fakeRequest();
  const created = await createConnectionViaApi(request, HEADERS, { credentials: null });
  assert.equal("credentials" in calls[0].data, false);
  assert.equal(created.connection.status, "pending");
});

test("createConnectionViaApi passes every override through", async () => {
  const { request, calls } = fakeRequest();
  await createConnectionViaApi(request, HEADERS, {
    label: "over",
    providerKey: "slack",
    displayName: "Custom display",
    identity: "bot",
    account: { id: "acct", display: "qa@example.com", tenant_id: "example.com" },
    grantedScopes: ["chat:write"],
    allowNonInteractive: true,
    ownershipMode: "instance",
    credentials: { access_token: "SENTINEL-A", refresh_token: "SENTINEL-R" },
  });
  const { data } = calls[0];
  assert.equal(data.provider_key, "slack");
  assert.equal(data.display_name, "Custom display");
  assert.deepEqual(data.executing_identity, {
    identity: "bot",
    account: { id: "acct", display: "qa@example.com", tenant_id: "example.com" },
  });
  assert.deepEqual(data.granted_scopes, ["chat:write"]);
  assert.equal(data.allow_non_interactive, true);
  assert.equal(data.ownership_mode, "instance");
  assert.deepEqual(data.credentials, { access_token: "SENTINEL-A", refresh_token: "SENTINEL-R" });
});

test("createConnectionViaApi fails naming the status and the body on a refusal", async () => {
  const { request } = fakeRequest([409]);
  await assert.rejects(
    createConnectionViaApi(request, HEADERS, { label: "dup" }),
    /409.*status 409/,
  );
});

test("createConnectionViaApi waits out one 429 and retries the same body", async () => {
  const { request, calls } = fakeRequest([429, 201], "60");
  const { waits, sleep } = recordingSleep();
  const created = await createConnectionViaApi(request, HEADERS, { label: "budget", sleep });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].data, calls[0].data, "the retry must not mint a new name");
  assert.deepEqual(waits, [60_000 + RETRY_AFTER_MARGIN_MS]);
  assert.equal(created.name, calls[0].data.name);
});

test("createConnectionViaApi refuses a second 429", async () => {
  const { request, calls } = fakeRequest([429, 429]);
  const { waits, sleep } = recordingSleep();
  await assert.rejects(createConnectionViaApi(request, HEADERS, { sleep }), /429/);
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
});

test("the returned deleteConnection removes exactly the created id, with the same headers", async () => {
  const { request, calls } = fakeRequest();
  const created = await createConnectionViaApi(request, HEADERS);
  await created.deleteConnection();
  assert.deepEqual(calls[1], {
    method: "DELETE",
    url: "/api/v1/connections/11111111-1111-4111-8111-111111111111",
    headers: HEADERS,
  });
});
