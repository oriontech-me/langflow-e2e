// Unit tests for requestErrorHead (issue #2485).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "@playwright/test";
import { requestErrorHead, UNREADABLE_REQUEST_ERROR } from "./request-error-head";

const API_KEY = "SECRET-APIKEY-2485";
const BEARER = "SECRET-BEARER-2485";

// The shape Playwright 1.58.2 throws, copied from a real measurement (see the module
// header), with the colour codes it emits around each call-log line.
const PLAYWRIGHT_MESSAGE =
  "apiRequestContext.get: Client network socket disconnected before secure TLS connection was established\n" +
  "Call log:\n" +
  "\u001b[2m  - → GET https://example.invalid/openai/v1/models\u001b[22m\n" +
  "\u001b[2m    - accept: */*\u001b[22m\n" +
  `\u001b[2m    - api-key: ${API_KEY}\u001b[22m\n` +
  `\u001b[2m    - Authorization: Bearer ${BEARER}\u001b[22m\n`;

test("keeps the cause line and drops the call log with its header values", () => {
  const head = requestErrorHead(new Error(PLAYWRIGHT_MESSAGE));
  assert.equal(
    head,
    "apiRequestContext.get: Client network socket disconnected before secure TLS connection was established",
  );
  assert.ok(!head.includes(API_KEY));
  assert.ok(!head.includes(BEARER));
});

// The fixture above is a copy, and a copy can drift from what Playwright really throws.
// This one asks Playwright: a request to a closed port, carrying both header kinds the
// probes send, must not leak either value through the helper. The first assertion is
// what keeps the second one meaningful: if a future Playwright stopped printing headers,
// the leak test would pass vacuously, and this says so.
test("a real Playwright request error carries the headers, and the head does not", async () => {
  const ctx = await request.newContext();
  let thrown: unknown;
  try {
    await ctx.get("http://127.0.0.1:9/models", {
      headers: { "api-key": API_KEY, Authorization: `Bearer ${BEARER}` },
      timeout: 5000,
    });
  } catch (e) {
    thrown = e;
  } finally {
    await ctx.dispose();
  }
  assert.ok(thrown instanceof Error, "the request to a closed port must throw");
  assert.ok(
    thrown.message.includes(API_KEY) && thrown.message.includes(BEARER),
    "Playwright's raw message prints the header values (the premise of #2485)",
  );
  const head = requestErrorHead(thrown);
  assert.match(head, /^apiRequestContext\.get: /);
  assert.ok(!head.includes(API_KEY), head);
  assert.ok(!head.includes(BEARER), head);
});

test("strips colour codes and skips leading blank lines", () => {
  assert.equal(requestErrorHead(new Error("\n  \n\u001b[31mTimeout 15000ms exceeded.\u001b[39m\nCall log:")), "Timeout 15000ms exceeded.");
  assert.equal(requestErrorHead(new Error("a\r\nb")), "a");
});

test("accepts anything thrown, and never throws", () => {
  assert.equal(requestErrorHead("plain string\nsecond"), "plain string");
  assert.equal(requestErrorHead(42), "42");
  assert.equal(requestErrorHead(null), "null");
  assert.equal(requestErrorHead(undefined), "undefined");
  assert.equal(requestErrorHead(Symbol("s")), "Symbol(s)");

  const odd = new Error("x");
  (odd as unknown as { message: unknown }).message = { toString: () => "from object\nmore" };
  assert.equal(requestErrorHead(odd), "from object");

  const hostile = { toString: () => { throw new Error("boom"); } };
  assert.equal(requestErrorHead(hostile), UNREADABLE_REQUEST_ERROR);
  assert.equal(requestErrorHead(Object.create(null)), UNREADABLE_REQUEST_ERROR);
});

test("an empty or blank message is named as unreadable, never returned empty", () => {
  assert.equal(requestErrorHead(new Error("")), UNREADABLE_REQUEST_ERROR);
  assert.equal(requestErrorHead(new Error(" \n\t\n")), UNREADABLE_REQUEST_ERROR);
});
