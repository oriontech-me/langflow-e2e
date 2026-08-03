// Unit tests for the A2A precondition guard (issue #1242).
// Run with: npm run test:units
//
// Why this helper is asserted rather than trusted: A2A ships OFF by default and its
// router is ALWAYS mounted, so a per-request guard answers 404 on every
// /api/v1/a2a/* route while the flag is off — a disabled server is deliberately
// indistinguishable from an unmounted one. #1240 set the flag on every CI lane, but
// a lane is not an instance: a local Langflow started before that PR, or any host
// PLAYWRIGHT_BASE_URL points at, can still have it off. Without this guard the A2A
// specs fail on a bare "expected 200, got 404", which reads as a product regression.
//
// The subtle half is WHICH config response is read. `GET /api/v1/config` returns two
// different shapes: authenticated (`type: "full"`, ~31 keys, carries `a2a_enabled`)
// and anonymous (`type: "public"`, ~13 keys, omits it entirely — measured on
// 1.12.0.dev14). Reading the anonymous one yields `undefined` and would make the
// guard throw on a perfectly configured instance, so the failure mode of getting
// this wrong is a suite that cannot run at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { requireA2aEnabled } from "./require-a2a-enabled";

interface FakeCall {
  url: string;
  options?: { headers?: Record<string, string> };
}

/** Minimal APIRequestContext double: records the GET and replays one response. */
function fakeRequest(
  response: { ok: boolean; status: number; body: unknown },
  calls: FakeCall[] = [],
): APIRequestContext {
  return {
    get: async (url: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ url, options });
      return {
        ok: () => response.ok,
        status: () => response.status,
        json: async () => response.body,
        text: async () => JSON.stringify(response.body),
      };
    },
  } as unknown as APIRequestContext;
}

test("resolves silently when the instance has A2A enabled", async () => {
  const req = fakeRequest({ ok: true, status: 200, body: { type: "full", a2a_enabled: true } });
  await requireA2aEnabled(req, { Authorization: "Bearer t" });
});

test("throws naming the env var when A2A is disabled", async () => {
  const req = fakeRequest({ ok: true, status: 200, body: { type: "full", a2a_enabled: false } });
  await assert.rejects(
    () => requireA2aEnabled(req, { Authorization: "Bearer t" }),
    (err: Error) => {
      assert.match(err.message, /LANGFLOW_A2A_ENABLED/);
      assert.match(err.message, /a2a_enabled=false/);
      return true;
    },
  );
});

test("an absent a2a_enabled field is treated as disabled, not as enabled", async () => {
  // The anonymous config response omits the field. Defaulting to "enabled" would
  // turn a misconfigured instance back into a silent 404 — the whole point of the
  // guard is that unknown is not clean.
  const req = fakeRequest({ ok: true, status: 200, body: { type: "public" } });
  await assert.rejects(
    () => requireA2aEnabled(req, { Authorization: "Bearer t" }),
    /LANGFLOW_A2A_ENABLED/,
  );
});

test("mentions the anonymous-response trap when the field is missing entirely", async () => {
  // Getting the auth wrong and getting the flag wrong produce the SAME symptom, so
  // the message has to distinguish them or the reader debugs the wrong thing.
  const req = fakeRequest({ ok: true, status: 200, body: { type: "public" } });
  await assert.rejects(
    () => requireA2aEnabled(req, {}),
    (err: Error) => {
      assert.match(err.message, /authenticated/i);
      return true;
    },
  );
});

test("a non-2xx config response fails with the status, not with a flag verdict", async () => {
  const req = fakeRequest({ ok: false, status: 503, body: { detail: "unavailable" } });
  await assert.rejects(
    () => requireA2aEnabled(req, { Authorization: "Bearer t" }),
    (err: Error) => {
      assert.match(err.message, /503/);
      assert.doesNotMatch(err.message, /a2a_enabled=false/);
      return true;
    },
  );
});

test("passes the caller's auth headers through to /api/v1/config", async () => {
  const calls: FakeCall[] = [];
  const req = fakeRequest({ ok: true, status: 200, body: { type: "full", a2a_enabled: true } }, calls);
  await requireA2aEnabled(req, { Authorization: "Bearer abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/config");
  assert.equal(calls[0].options?.headers?.Authorization, "Bearer abc");
});
