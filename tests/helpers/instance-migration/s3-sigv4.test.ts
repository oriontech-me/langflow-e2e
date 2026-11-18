// Unit tests for tests/helpers/instance-migration/s3-sigv4.ts (#2397).
// Run with: npm run test:units
//
// A wrong signature is answered 403, which is also the answer the wrong-key spec asserts
// for a refused key. So the signer is pinned against AWS's own worked example rather than
// against SeaweedFS alone: a signer that only agrees with one server could be wrong in a
// way that server tolerates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amzDate, signS3Get } from "./s3-sigv4";

const AWS_EXAMPLE_KEYS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_EXAMPLE_NOW = new Date("2013-05-24T00:00:00Z");

test("signs AWS's worked example (GET Bucket, List Objects) to the documented signature", () => {
  // Amazon S3 API reference, "Signature Calculations for the Authorization Header",
  // example "GET Bucket (List Objects)": GET /?max-keys=2&prefix=J on examplebucket.
  const headers = signS3Get("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", AWS_EXAMPLE_KEYS, {
    now: AWS_EXAMPLE_NOW,
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(headers.host, "examplebucket.s3.amazonaws.com");
});

test("the query is signed in sorted order, whatever order the URL carries it in", () => {
  const a = signS3Get("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2", AWS_EXAMPLE_KEYS, { now: AWS_EXAMPLE_NOW });
  const b = signS3Get("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", AWS_EXAMPLE_KEYS, { now: AWS_EXAMPLE_NOW });
  assert.equal(a.authorization, b.authorization);
});

test("the host is signed with its port, as the lane's gateway is reached", () => {
  const headers = signS3Get("http://127.0.0.1:58895/langflow-migration?list-type=2", AWS_EXAMPLE_KEYS, { now: AWS_EXAMPLE_NOW });
  assert.equal(headers.host, "127.0.0.1:58895");
});

test("a different secret, path or query changes the signature", () => {
  const base = "http://127.0.0.1:58895/langflow-migration?list-type=2";
  const sig = (url: string, keys = AWS_EXAMPLE_KEYS) =>
    /Signature=([0-9a-f]{64})$/.exec(signS3Get(url, keys, { now: AWS_EXAMPLE_NOW }).authorization)?.[1];
  const reference = sig(base);
  assert.ok(reference);
  assert.notEqual(sig(base, { ...AWS_EXAMPLE_KEYS, secretAccessKey: "other" }), reference);
  assert.notEqual(sig("http://127.0.0.1:58895/other-bucket?list-type=2"), reference);
  assert.notEqual(sig("http://127.0.0.1:58895/langflow-migration?list-type=1"), reference);
});

test("refuses what it would sign wrongly rather than signing it", () => {
  assert.throws(() => signS3Get("ftp://host/bucket", AWS_EXAMPLE_KEYS), /not an http\(s\) URL/);
  assert.throws(() => signS3Get("http://u:p@host/bucket", AWS_EXAMPLE_KEYS), /carrying credentials/);
  assert.throws(() => signS3Get("http://host/bucket", { accessKeyId: "", secretAccessKey: "x" }), /both S3 keys/);
  // The URL parser leaves these unencoded in a path, where SigV4 wants them encoded.
  for (const path of ["/b/a=b", "/b/a+b", "/b/a(b)", "/b/a,b", "/b/a@b"]) {
    assert.throws(() => signS3Get(`http://host${path}`, AWS_EXAMPLE_KEYS), /encode wrongly/, path);
  }
  // And decodes a literal "+" in the query to a space.
  assert.throws(() => signS3Get("http://host/b?prefix=a+b", AWS_EXAMPLE_KEYS), /literal "\+"/);
  // A percent-escaped path and an escaped "+" in the query are fine.
  assert.doesNotThrow(() => signS3Get("http://host/b/a%3Db?prefix=a%2Bb", AWS_EXAMPLE_KEYS));
});

test("amzDate is the compact ISO-8601 form, to the second", () => {
  assert.equal(amzDate(new Date("2026-11-18T21:05:09.123Z")), "20261118T210509Z");
});
