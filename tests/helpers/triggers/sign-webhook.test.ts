// Unit tests for the inbound webhook signing helper (#2449).
// Run with: npm run test:units
//
// The signature is pinned against vectors computed by an INDEPENDENT
// implementation (Python's `hmac`, the same library the server verifies with),
// never against this module's own output: a vector produced by the code under
// test would pass whatever the code did. The delivery helper is pinned on the
// property the ingress depends on, that the bytes sent are the bytes signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  deliverSignedWebhook,
  jsonBody,
  mintSigningSecret,
  signedWebhookHeaders,
  webhookSignature,
} from "./sign-webhook";

// python3 -I -c "import hmac,hashlib; print(hmac.new(b'whsec_test',
//   b'v1:1700000000:'+b'{\"text\":\"hi\"}', hashlib.sha256).hexdigest())"
const BODY = Buffer.from('{"text":"hi"}');
const VECTOR = "ad7c792ff2327883c4a4e47a914b86c7ba96cd1d63c784fa23eda2c2a161a391";
const VECTOR_NEXT_SECOND = "fbd3e8d94012eeda8ee6dad1de2fab002dcec2a71578f93a590339a14bc1d98c";
const VECTOR_OTHER_SECRET = "553f0f216d7869085e7b9f0d0c1183527ecceb40702528a0cf00b94f8b283d55";

test("webhookSignature matches an HMAC computed by Python's hmac", () => {
  assert.equal(webhookSignature("whsec_test", 1_700_000_000, BODY), `v1=${VECTOR}`);
});

test("webhookSignature covers the timestamp and the secret", () => {
  assert.equal(webhookSignature("whsec_test", 1_700_000_001, BODY), `v1=${VECTOR_NEXT_SECOND}`);
  assert.equal(webhookSignature("other", 1_700_000_000, BODY), `v1=${VECTOR_OTHER_SECRET}`);
});

test("signedWebhookHeaders carries the JSON type, the signature and the timestamp as a string", () => {
  assert.deepEqual(signedWebhookHeaders("whsec_test", 1_700_000_000, BODY), {
    "content-type": "application/json",
    "X-Langflow-Signature": `v1=${VECTOR}`,
    "X-Langflow-Timestamp": "1700000000",
  });
});

test("jsonBody is the compact serialisation the vector above was computed over", () => {
  assert.deepEqual(jsonBody({ text: "hi" }), BODY);
});

interface Call {
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}

function fakeRequest(status: number, body: unknown) {
  const calls: Call[] = [];
  const request = {
    post: async (url: string, o: { headers?: Record<string, string>; data?: unknown } = {}) => {
      calls.push({ url, headers: o.headers, data: o.data });
      return { status: () => status, text: async () => JSON.stringify(body) };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

const MINTED = {
  public_id: "pub123",
  ingress_url: "http://localhost:7860/api/v1/triggers/ingress/webhook/pub123",
  signing_secret: "whsec_test",
};

test("mintSigningSecret posts to the trigger's signing-secret route and returns the path", async () => {
  const { request, calls } = fakeRequest(200, MINTED);
  const minted = await mintSigningSecret(request, "t-1", { Authorization: "Bearer x" });
  assert.deepEqual(minted, {
    path: "/api/v1/triggers/ingress/webhook/pub123",
    publicId: "pub123",
    ingressUrl: MINTED.ingress_url,
    secret: "whsec_test",
  });
  assert.equal(calls[0].url, "/api/v1/triggers/t-1/signing-secret");
  assert.deepEqual(calls[0].headers, { Authorization: "Bearer x" });
});

test("mintSigningSecret throws naming the status on a refusal", async () => {
  const { request } = fakeRequest(404, { detail: "Trigger not found" });
  await assert.rejects(mintSigningSecret(request, "t-1", {}), /answered 404: .*Trigger not found/);
});

test("mintSigningSecret throws when the answer carries no plaintext", async () => {
  const { request } = fakeRequest(200, { ...MINTED, signing_secret: null });
  await assert.rejects(mintSigningSecret(request, "t-1", {}), /missing the secret/);
});

test("mintSigningSecret throws when the URL does not name the public id it returned", async () => {
  const { request } = fakeRequest(200, { ...MINTED, public_id: "other" });
  await assert.rejects(mintSigningSecret(request, "t-1", {}), /does not name the webhook provider and other/);
});

test("deliverSignedWebhook sends the exact buffer it signed and returns the status", async () => {
  const { request, calls } = fakeRequest(202, "");
  const status = await deliverSignedWebhook(request, "/api/v1/triggers/ingress/webhook/pub123", "whsec_test", BODY, 1_700_000_000);
  assert.equal(status, 202);
  assert.equal(calls[0].url, "/api/v1/triggers/ingress/webhook/pub123");
  assert.equal(calls[0].data, BODY, "the same Buffer instance, never a re-serialised copy");
  assert.equal(calls[0].headers?.["X-Langflow-Signature"], `v1=${VECTOR}`);
  assert.equal(calls[0].headers?.["X-Langflow-Timestamp"], "1700000000");
});
