// Signing an inbound webhook delivery exactly as the server verifies it (#2449).
//
// Extracted from `api-triggers-webhook-ingress.spec.ts` (#2308), which owned the
// signature while it was the only caller. #2449 adds two more: the node-controls
// spec must sign with the value the UI's secret dialog showed, and the events
// drawer spec sends real deliveries into the list it pages. A copy per spec would
// give the suite three spellings of one wire contract to keep in step with
// upstream's `services/triggers/ingress/verifiers.py`, and a copy that drifted
// would read as a product refusal: every ingress refusal is the same `404`.
//
// The contract, as `verify_webhook` checks it on `1.14.0.dev28`:
//
//   X-Langflow-Timestamp: <unix seconds>            (±300 s tolerance)
//   X-Langflow-Signature: v1=<hex HMAC-SHA256(secret, "v1:" + ts + ":" + raw body)>
//
// The HMAC is over the RAW bytes sent, which is why every function here takes a
// `Buffer` and the delivery helper sends that same buffer: re-serialising the
// body between signing and sending would change the bytes the MAC covers.

import { createHmac } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

/** Unix seconds, the unit `X-Langflow-Timestamp` is read in. */
export const unixNow = (): number => Math.floor(Date.now() / 1000);

/** A JSON value as the exact bytes a delivery sends and signs. */
export const jsonBody = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

/** `X-Langflow-Signature` for `body` at `timestamp`: `v1=` HMAC-SHA256 over `v1:{ts}:{body}`. */
export function webhookSignature(secret: string, timestamp: number, body: Buffer): string {
  const mac = createHmac("sha256", secret).update(`v1:${timestamp}:`).update(body).digest("hex");
  return `v1=${mac}`;
}

/** The three headers a signed JSON delivery carries. */
export function signedWebhookHeaders(secret: string, timestamp: number, body: Buffer): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Langflow-Signature": webhookSignature(secret, timestamp, body),
    "X-Langflow-Timestamp": String(timestamp),
  };
}

/** What `POST /api/v1/triggers/{id}/signing-secret` returns, the only read that carries the plaintext. */
export interface MintedSecret {
  /** The ingress URL's pathname, `/api/v1/triggers/ingress/webhook/{public_id}`. */
  path: string;
  publicId: string;
  ingressUrl: string;
  secret: string;
}

/**
 * Mint (or rotate) a trigger's signing secret through the API.
 *
 * Throws, rather than asserting with `expect`, so the cause survives outside the
 * Playwright runner too: a non-`200`, an answer with no plaintext, or a URL that
 * does not name the webhook provider and the public id it returned.
 */
export async function mintSigningSecret(
  request: APIRequestContext,
  triggerId: string,
  headers: Record<string, string>,
): Promise<MintedSecret> {
  const res = await request.post(`/api/v1/triggers/${triggerId}/signing-secret`, { headers });
  const text = await res.text();
  if (res.status() !== 200) {
    throw new Error(`minting the signing secret of trigger ${triggerId} answered ${res.status()}: ${text}`);
  }
  const body = JSON.parse(text) as { public_id?: string; ingress_url?: string; signing_secret?: string };
  if (!body.signing_secret || !body.public_id || !body.ingress_url) {
    throw new Error(`the signing-secret answer is missing the secret, the public id or the URL: ${text}`);
  }
  const path = new URL(body.ingress_url).pathname;
  const expected = `/api/v1/triggers/ingress/webhook/${body.public_id}`;
  if (path !== expected) {
    throw new Error(`the ingress URL ${body.ingress_url} does not name the webhook provider and ${body.public_id}`);
  }
  return { path, publicId: body.public_id, ingressUrl: body.ingress_url, secret: body.signing_secret };
}

/**
 * POST `body` to an ingress path, signed with `secret`. Returns the status: `202`
 * accepted, `404` for every refusal. The caller asserts which one it expects.
 */
export async function deliverSignedWebhook(
  request: APIRequestContext,
  path: string,
  secret: string,
  body: Buffer,
  timestamp: number = unixNow(),
): Promise<number> {
  const res = await request.post(path, { headers: signedWebhookHeaders(secret, timestamp, body), data: body });
  return res.status();
}
