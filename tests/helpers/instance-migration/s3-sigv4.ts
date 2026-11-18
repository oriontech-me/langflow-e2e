/**
 * AWS Signature Version 4 for one bodyless S3 GET (#2397).
 *
 * The `@instance-migration` lane's SeaweedFS gateway accepts only the lane's own keys, so
 * the bucket can no longer be listed unsigned. This signs the one request the specs make —
 * `ListObjectsV2` from the host — with node:crypto, rather than adding an S3 client to
 * the suite for a single GET.
 *
 * Scope is deliberately narrow: GET, an empty payload, path-style URLs, and the three
 * headers S3 needs (`host`, `x-amz-content-sha256`, `x-amz-date`). A path holding
 * anything but unreserved characters, `/` and percent-escapes is refused, and so is a
 * query with a literal `+`: the URL parser leaves the first unencoded where SigV4 wants
 * it encoded, and decodes the second to a space, so both would be signed wrongly — and
 * a wrong signature reads as a refused key, the very answer a wrong-key spec asserts.
 *
 * Pinned by s3-sigv4.test.ts against AWS's own worked example (GET Bucket, List Objects).
 */
import { createHash, createHmac } from "node:crypto";

export interface S3Keys {
  accessKeyId: string;
  secretAccessKey: string;
}

const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hmac(key: Buffer | string, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

/** RFC 3986 encoding, as SigV4 requires: encodeURIComponent leaves `!'()*` unescaped. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20130524T000000Z` from a Date. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The headers that sign a bodyless GET of `url` for S3. `host` is returned because it is
 * signed; a client that derives Host from the URL (Playwright, fetch) sends the same
 * value, so it may drop it, and must not send a different one.
 */
export function signS3Get(url: string, keys: S3Keys, options: { region?: string; now?: Date } = {}): Record<string, string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`not an http(s) URL: ${url}`);
  if (parsed.username || parsed.password) throw new Error("a URL carrying credentials is not signed");
  if (!keys.accessKeyId || !keys.secretAccessKey) throw new Error("both S3 keys are required to sign");
  if (!/^[A-Za-z0-9\-._~/%]*$/.test(parsed.pathname)) throw new Error(`a path this signer would encode wrongly: ${parsed.pathname}`);
  if (parsed.search.includes("+")) throw new Error(`a query with a literal "+", which would be signed as a space: ${parsed.search}`);
  const region = options.region ?? "us-east-1";
  const date = amzDate(options.now ?? new Date());
  const day = date.slice(0, 8);

  const query = [...parsed.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // Only unreserved characters, "/" and percent-escapes reach here (checked above), which
  // is exactly the form SigV4 signs for S3, so the path is signed as sent.
  const path = parsed.pathname;

  const headers: Record<string, string> = {
    host: parsed.host,
    "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
    "x-amz-date": date,
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonicalRequest = [
    "GET",
    path,
    query,
    signedHeaders.map((h) => `${h}:${headers[h]}\n`).join(""),
    signedHeaders.join(";"),
    EMPTY_PAYLOAD_SHA256,
  ].join("\n");

  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  };
}
