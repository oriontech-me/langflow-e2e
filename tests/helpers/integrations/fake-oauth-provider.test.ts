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
import { consentRedirect } from "./fake-oauth-provider";

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
