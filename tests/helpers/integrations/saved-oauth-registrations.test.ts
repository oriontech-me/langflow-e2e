// Unit tests for the saved OAuth registration helpers (#2421).
// Run with: npm run test:units
//
// Two properties carry the specs that use these helpers. An ID the server refuses
// fails every save before it reaches what the spec asserts, and two parallel
// workers that draw the same ID overwrite each other's instance-wide row. And the
// teardown must remove every registration through the API: one left behind stays
// in use by the process, where every user's connection wizard can offer it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { RETRY_AFTER_MARGIN_MS } from "./delete-connection";
import {
  REGISTRATION_ID_MAX_LENGTH,
  REGISTRATION_ID_PATTERN,
  SAVED_REGISTRATIONS,
  SLACK_CALLBACK,
  removeSavedRegistration,
  slackBotRegistration,
  uniqueRegistrationId,
} from "./saved-oauth-registrations";

test("uniqueRegistrationId matches the server's pattern, even from a label it would refuse", () => {
  for (const label of ["lifecycle", "Upper Case & spaces", "--edge--", "", "ünïcode"]) {
    const id = uniqueRegistrationId(label);
    assert.match(id, REGISTRATION_ID_PATTERN, `${label} → ${id}`);
    assert.ok(id.startsWith("e2e-saved-"), id);
  }
});

test("uniqueRegistrationId truncates the label, never the discriminator", () => {
  const id = uniqueRegistrationId("x".repeat(500));
  assert.ok(id.length <= REGISTRATION_ID_MAX_LENGTH, `${id.length}`);
  assert.match(id, /-[a-z0-9]{12,}$/);
});

test("uniqueRegistrationId does not repeat across calls", () => {
  const ids = new Set(Array.from({ length: 200 }, () => uniqueRegistrationId("same")));
  assert.equal(ids.size, 200);
});

test("slackBotRegistration sends no secret field it was not given", () => {
  const registration = slackBotRegistration({ clientId: "c" });
  assert.deepEqual(registration, {
    provider: "slack",
    profile: "bot",
    client_id: "c",
    redirect_uri: SLACK_CALLBACK,
    scopes: ["chat:write"],
  });
  assert.equal("client_secret" in registration, false);
  assert.equal("signing_secret" in registration, false);
});

test("slackBotRegistration carries both secrets when given", () => {
  const registration = slackBotRegistration({ clientId: "c", clientSecret: "s1", signingSecret: "s2", scopes: ["a"] });
  assert.equal(registration.client_secret, "s1");
  assert.equal(registration.signing_secret, "s2");
  assert.deepEqual(registration.scopes, ["a"]);
});

/** A fake APIRequestContext whose DELETE answers the given statuses in order, recording every URL. */
function fakeRequest(statuses: number[]) {
  const urls: string[] = [];
  let i = 0;
  const request = {
    delete: async (url: string) => {
      urls.push(url);
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return {
        status: () => status,
        headers: () => (status === 429 ? { "retry-after": "3" } : {}),
        text: async () => JSON.stringify({ detail: `status ${status}` }),
      };
    },
  } as unknown as APIRequestContext;
  return { request, urls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("removeSavedRegistration treats 204 and 404 as done, with one request", async () => {
  for (const status of [204, 404]) {
    const { request, urls } = fakeRequest([status]);
    const { waits, sleep } = recordingSleep();
    await removeSavedRegistration(request, {}, "e2e-saved-x", sleep);
    assert.deepEqual(urls, [`${SAVED_REGISTRATIONS}/e2e-saved-x`]);
    assert.deepEqual(waits, []);
  }
});

test("removeSavedRegistration waits out one 429 for the advertised window, then retries", async () => {
  const { request, urls } = fakeRequest([429, 204]);
  const { waits, sleep } = recordingSleep();
  await removeSavedRegistration(request, {}, "e2e-saved-x", sleep);
  assert.equal(urls.length, 2);
  assert.deepEqual(waits, [3_000 + RETRY_AFTER_MARGIN_MS]);
});

test("removeSavedRegistration refuses to loop on a second 429", async () => {
  const { request, urls } = fakeRequest([429, 429]);
  const { sleep } = recordingSleep();
  await assert.rejects(removeSavedRegistration(request, {}, "e2e-saved-x", sleep), /answered 429/);
  assert.equal(urls.length, 2);
});

test("removeSavedRegistration throws on any other status, naming it", async () => {
  for (const status of [403, 422, 500]) {
    const { request } = fakeRequest([status]);
    const { sleep } = recordingSleep();
    await assert.rejects(removeSavedRegistration(request, {}, "e2e-saved-x", sleep), new RegExp(`answered ${status}`));
  }
});
