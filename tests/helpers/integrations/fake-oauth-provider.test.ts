// Unit tests for the fake OAuth provider's redirect (#2307).
// Run with: npm run test:units
//
// The redirect is the whole of what the test plays: the state handed back must
// be the one the provider was given, the outcome must be exactly the query the
// server reads (`error` present → denied; neither `code` nor `error` → expired),
// and the target must be the lane's own instance, never the registration's
// port-less `redirect_uri`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consentRedirect, holdConnectionList } from "./fake-oauth-provider";

const AUTH = new URL(
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e-fake-client.apps.googleusercontent.com" +
    "&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fv1%2Fconnections%2Foauth%2Fgoogle%2Fcallback" +
    "&response_type=code&state=wwFWkQSvyU6gqk3VS-jWG6iMjMLOhRVdWRosTt0w-c0&scope=openid+email",
);

test("deny hands the state back with error=access_denied, to the lane's instance", () => {
  const location = consentRedirect(AUTH, "google", "http://localhost:7860/", "deny");
  assert.equal(
    location,
    "http://localhost:7860/api/v1/connections/oauth/google/callback" +
      "?state=wwFWkQSvyU6gqk3VS-jWG6iMjMLOhRVdWRosTt0w-c0&error=access_denied",
  );
});

test("no-code hands the state back with neither code nor error", () => {
  const location = new URL(consentRedirect(AUTH, "google", "http://127.0.0.1:7870", "no-code")!);
  assert.equal(location.origin, "http://127.0.0.1:7870");
  assert.deepEqual([...location.searchParams.keys()], ["state"]);
  assert.equal(location.searchParams.get("state"), "wwFWkQSvyU6gqk3VS-jWG6iMjMLOhRVdWRosTt0w-c0");
});

test("the provider in the path is the caller's, not the URL's", () => {
  const location = new URL(consentRedirect(AUTH, "slack", "http://localhost:7860", "deny")!);
  assert.equal(location.pathname, "/api/v1/connections/oauth/slack/callback");
});

test("stall redirects nowhere", () => {
  assert.equal(consentRedirect(AUTH, "google", "http://localhost:7860", "stall"), null);
});

test("an authorization URL without a state is refused, not redirected", () => {
  const bare = new URL("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
  assert.throws(() => consentRedirect(bare, "google", "http://localhost:7860", "deny"), /no state/);
});

// holdConnectionList (#2413): no read the hold took may still be in flight when it
// removes its route. Playwright sends every request still inside a handler on to the
// network when the context's last route goes, and a fulfill that comes after that
// throws "Route is already handled!". The fake context reproduces that rule.
function fakeHoldContext(statuses: number[] = []) {
  let handler: ((route: never) => Promise<void>) | undefined;
  const events: string[] = [];
  const inFlight = new Set<{ handled: boolean }>();
  let fetches = 0;
  const context = {
    async route(_url: unknown, h: (route: never) => Promise<void>) {
      handler = h;
    },
    async unroute() {
      events.push("unroute");
      handler = undefined;
      for (const state of inFlight) state.handled = true; // sent on to the network
    },
  };
  function request(fetchGate: Promise<void>) {
    const state = { handled: false };
    inFlight.add(state);
    const settle = (what: string) => {
      if (state.handled) throw new Error("route.fulfill: Route is already handled!");
      state.handled = true;
      inFlight.delete(state);
      events.push(what);
    };
    const route = {
      request: () => ({ method: () => "GET", url: () => "http://lane/api/v1/connections?provider=google" }),
      fallback: async () => settle("fallback"),
      fetch: async () => {
        fetches += 1;
        await fetchGate;
        const status = statuses.length > 0 ? statuses.shift()! : 200;
        return { status: () => status, headers: () => ({}), body: async () => Buffer.from("[]") };
      },
      fulfill: async (answer: { status: number }) => settle(`fulfill ${answer.status}`),
    };
    const h = handler;
    assert.ok(h, "the hold has a handler registered");
    return h(route as never);
  }
  return { context, request, events, fetches: () => fetches };
}

/** No real waiting: the rate-limit poll sleeps advance a fake clock. */
function instantRateLimit() {
  let clock = 0;
  return { sleep: async (ms: number) => void (clock += ms), now: () => clock, log: () => {} };
}

test("holdConnectionList answers a read still in flight before it removes its route", async () => {
  const { context, request, events } = fakeHoldContext();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let pending: Promise<void> | undefined;
  const result = await holdConnectionList(context as never, async () => {
    pending = request(gate);
    events.push("wait done");
    setTimeout(release, 20);
    return "result";
  });
  assert.equal(result, "result");
  await pending; // would reject with "Route is already handled!" if unroute came first
  assert.deepEqual(events, ["wait done", "fulfill 200", "unroute"]);
});

test("holdConnectionList serves later reads from the first successful one", async () => {
  const { context, request, events } = fakeHoldContext();
  await holdConnectionList(context as never, async () => {
    await request(Promise.resolve());
    await request(new Promise<void>(() => {})); // would hang if it reached the server
  });
  assert.deepEqual(events, ["fulfill 200", "fulfill 200", "unroute"]);
});

test("holdConnectionList waits a 429 out instead of handing it to the page", async () => {
  const { context, request, events, fetches } = fakeHoldContext([429, 429, 200]);
  await holdConnectionList(context as never, async () => {
    await request(Promise.resolve());
  }, instantRateLimit());
  assert.deepEqual(events, ["fulfill 200", "unroute"]);
  assert.equal(fetches(), 3, "two refused reads, then the answer");
});

test("holdConnectionList shares one read between reads that arrive while it is out", async () => {
  const { context, request, events, fetches } = fakeHoldContext();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await holdConnectionList(context as never, async () => {
    const first = request(gate);
    const second = request(gate);
    release();
    await Promise.all([first, second]);
  });
  assert.equal(fetches(), 1, "the second read waited for the first instead of fetching");
  assert.deepEqual(events, ["fulfill 200", "fulfill 200", "unroute"]);
});
