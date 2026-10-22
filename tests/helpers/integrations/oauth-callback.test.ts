// Unit tests for the OAuth start/callback helpers (#2307).
// Run with: npm run test:units
//
// Two properties carry the spec's evidence. The binding cookie must be the one
// being SET, never the deletion a callback answers with. And a callback must
// send exactly the cookie it was given: the spec's "no cookie" and "replay"
// cases are only what they claim if the request context's jar cannot change
// them. The rate-limit wait is the third: it must stop at one window and hand a
// lasting 429 back, never loop on a saturated instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  RATE_LIMIT_CAP_MS,
  RATE_LIMIT_POLL_MS,
  parseBindingCookie,
  sendOAuthCallback,
  setCookiesOf,
  untilNotRateLimited,
} from "./oauth-callback";

const NAME = "lf_connection_oauth_e42fc33a4d82c7098d167680";
const SET = `${NAME}=AefWdXe_mhWqKnUZAi_Av5VvdgqzyJNkw446_maDXik; HttpOnly; Max-Age=600; Path=/api/v1/connections/oauth; SameSite=lax`;
const DELETED = `${NAME}=""; expires=Thu, 22 Oct 2026 18:41:55 GMT; Max-Age=0; Path=/api/v1/connections/oauth; SameSite=lax`;

test("parseBindingCookie reads the name, the value and every attribute", () => {
  const cookie = parseBindingCookie([SET]);
  assert.equal(cookie.name, NAME);
  assert.equal(cookie.value, "AefWdXe_mhWqKnUZAi_Av5VvdgqzyJNkw446_maDXik");
  assert.deepEqual(cookie.attributes, {
    httponly: true,
    "max-age": "600",
    path: "/api/v1/connections/oauth",
    samesite: "lax",
  });
});

test("parseBindingCookie ignores a deletion and any other cookie", () => {
  const cookie = parseBindingCookie(["access_token_lf=abc; Path=/", DELETED, SET]);
  assert.equal(cookie.value, "AefWdXe_mhWqKnUZAi_Av5VvdgqzyJNkw446_maDXik");
});

test("parseBindingCookie refuses none, or two, being set", () => {
  assert.throws(() => parseBindingCookie([DELETED]), /exactly one binding cookie/);
  assert.throws(() => parseBindingCookie([]), /found 0/);
  const other = SET.replace("e42fc33a4d82c7098d167680", "0123456789abcdef01234567");
  assert.throws(() => parseBindingCookie([SET, other]), /found 2/);
});

test("setCookiesOf keeps every Set-Cookie value apart", () => {
  const response = {
    headersArray: () => [
      { name: "content-type", value: "application/json" },
      { name: "Set-Cookie", value: "a=1" },
      { name: "set-cookie", value: "b=2" },
    ],
  };
  assert.deepEqual(setCookiesOf(response), ["a=1", "b=2"]);
});

/** A fake clock the sleeps advance, so the cap is checked without real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("untilNotRateLimited returns at once, and logs nothing, when the first answer is not a 429", async () => {
  const lines: string[] = [];
  const statuses = [400];
  const { result, waitedMs } = await untilNotRateLimited("x", async () => statuses.shift()!, (s) => s, {
    ...clock(),
    log: (line) => lines.push(line),
  });
  assert.equal(result, 400);
  assert.equal(waitedMs, 0);
  assert.deepEqual(lines, []);
});

test("untilNotRateLimited polls through 429s and reports the wait", async () => {
  const lines: string[] = [];
  const statuses = [429, 429, 429, 400];
  const c = clock();
  const { result, waitedMs } = await untilNotRateLimited("the google callback", async () => statuses.shift()!, (s) => s, {
    ...c,
    log: (line) => lines.push(line),
  });
  assert.equal(result, 400);
  assert.equal(waitedMs, 3 * RATE_LIMIT_POLL_MS);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /the google callback was rate-limited; answered after 15s/);
});

test("untilNotRateLimited hands a lasting 429 back after one window", async () => {
  let sent = 0;
  const lines: string[] = [];
  const { result, waitedMs } = await untilNotRateLimited("x", async () => (sent++, 429), (s) => s, {
    ...clock(),
    log: (line) => lines.push(line),
  });
  assert.equal(result, 429);
  assert.ok(waitedMs >= RATE_LIMIT_CAP_MS && waitedMs < RATE_LIMIT_CAP_MS + RATE_LIMIT_POLL_MS);
  assert.equal(sent, 1 + RATE_LIMIT_CAP_MS / RATE_LIMIT_POLL_MS);
  assert.match(lines[0], /still refused/);
});

interface Sent {
  url: string;
  headers: Record<string, string>;
}

function fakeRequest(statuses: number[]) {
  const sent: Sent[] = [];
  const request = {
    get: async (url: string, options: { headers: Record<string, string> }) => {
      sent.push({ url, headers: options.headers });
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return { status: () => status, text: async () => `body ${status}` };
    },
  } as unknown as APIRequestContext;
  return { request, sent };
}

test("sendOAuthCallback sends the given cookie, and an explicit empty one for null", async () => {
  const { request, sent } = fakeRequest([400]);
  const cookie = parseBindingCookie([SET]);
  await sendOAuthCallback(request, { provider: "google", state: "s1", cookie, query: { error: "access_denied" } });
  await sendOAuthCallback(request, { provider: "slack", state: "s2", cookie: null, query: { code: "c" } });
  assert.equal(sent[0].url, "/api/v1/connections/oauth/google/callback?state=s1&error=access_denied");
  assert.deepEqual(sent[0].headers, { Cookie: `${NAME}=AefWdXe_mhWqKnUZAi_Av5VvdgqzyJNkw446_maDXik` });
  assert.equal(sent[1].url, "/api/v1/connections/oauth/slack/callback?state=s2&code=c");
  assert.deepEqual(sent[1].headers, { Cookie: "" });
});

test("sendOAuthCallback waits out a 429 by default and returns it raw when asked", async () => {
  const absorbed = fakeRequest([429, 400]);
  const result = await sendOAuthCallback(absorbed.request, {
    provider: "google",
    state: "s",
    cookie: null,
    ...clock(),
    log: () => {},
  });
  assert.equal(result.response.status(), 400);
  assert.equal(result.waitedMs, RATE_LIMIT_POLL_MS);
  assert.equal(absorbed.sent.length, 2);

  const raw = fakeRequest([429, 400]);
  const refused = await sendOAuthCallback(raw.request, {
    provider: "google",
    state: "s",
    cookie: null,
    absorbRateLimit: false,
  });
  assert.equal(refused.response.status(), 429);
  assert.equal(refused.body, "body 429");
  assert.equal(raw.sent.length, 1);
});
