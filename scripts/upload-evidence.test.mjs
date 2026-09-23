import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "./lib/tmp-dir.mjs";

import { contentTypeFor, collectFiles, objectKey, toPosixKey } from "./upload-evidence.mjs";

test("index.html is text/html — the type that decides render vs download", () => {
  assert.equal(contentTypeFor("index.html"), "text/html");
  assert.equal(contentTypeFor("a/b/index.html"), "text/html");
});

test("the report's own asset types are recognised", () => {
  assert.equal(contentTypeFor("app.js"), "application/javascript");
  assert.equal(contentTypeFor("style.css"), "text/css");
  assert.equal(contentTypeFor("shot.png"), "image/png");
  assert.equal(contentTypeFor("video.webm"), "video/webm");
  assert.equal(contentTypeFor("trace.zip"), "application/zip");
});

test("an unknown extension is octet-stream, never a guess", () => {
  assert.equal(contentTypeFor("data.unknownext"), "application/octet-stream");
});

test("an extensionless file inside a dotted directory is not typed by the directory", () => {
  // Documents the contract, and deliberately not claimed as a guard: reading the
  // extension off the whole path answers the same here, because `zip/heartbeat`
  // matches no key either. See the note on contentTypeFor.
  assert.equal(contentTypeFor("trace.zip/heartbeat"), "application/octet-stream");
  assert.equal(contentTypeFor("LICENSE"), "application/octet-stream");
});

test("a dotfile is not read as an extension", () => {
  assert.equal(contentTypeFor(".gitkeep"), "application/octet-stream");
});

test("the extension match is case-insensitive", () => {
  assert.equal(contentTypeFor("INDEX.HTML"), "text/html");
});

test("collectFiles walks nested directories and keys them relative to the root", () => {
  const root = makeTempDir("upload-evidence");
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "trace", "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "x");
  writeFileSync(join(root, "data", "a.png"), "x");
  writeFileSync(join(root, "trace", "assets", "b.js"), "x");

  const keys = collectFiles(root).map((f) => f.key).sort();
  assert.deepEqual(keys, ["data/a.png", "index.html", "trace/assets/b.js"]);
});

test("toPosixKey turns a backslash path into a URL path", () => {
  // Tested on the function rather than through collectFiles: on this platform `sep`
  // is already "/", so a walk-based test passes whether or not the normalisation
  // exists — it was green against its own mutation before this was split out.
  assert.equal(toPosixKey("data\\a.png"), "data/a.png");
  assert.equal(toPosixKey("trace\\assets\\b.js"), "trace/assets/b.js");
});

test("toPosixKey leaves an already-POSIX key untouched", () => {
  assert.equal(toPosixKey("data/a.png"), "data/a.png");
});

test("objectKey keeps the playwright-report segment REPORT_URL expects", () => {
  // run-e2e.sh builds: $RUN_URL_BASE/$RUN_ID/playwright-report/index.html
  assert.equal(
    objectKey("vm", "20260923T080042Z", "index.html"),
    "vm/20260923T080042Z/playwright-report/index.html",
  );
});

test("objectKey tolerates an empty prefix without leaving a leading slash", () => {
  assert.equal(
    objectKey("", "RUN1", "index.html"),
    "RUN1/playwright-report/index.html",
  );
});

test("objectKey collapses duplicate slashes a sloppy prefix would introduce", () => {
  assert.equal(
    objectKey("vm/", "RUN1", "index.html"),
    "vm/RUN1/playwright-report/index.html",
  );
});

// ---------------------------------------------------------------------------
// WHICH credential goes out (#2019)
// ---------------------------------------------------------------------------
// The storage route compares the bearer against the SERVICE ROLE key and 401s on
// anything else, deliberately. The first version of this script sent the run-ingest
// automation token instead, and every test here stayed green — because none of them
// asked what was in the Authorization header.

import { main } from "./upload-evidence.mjs";

/** A fixture report and a fetch that records what it was asked to send. */
function harness(env) {
  const root = makeTempDir("upload-cred");
  writeFileSync(join(root, "index.html"), "x");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return { ok: true, status: 200 };
  };
  const argv = ["--dir", root, "--base", "https://platform.example/storage/v1/object/playwright-evidence",
                "--run-id", "RUN1", "--prefix", "vm"];
  return { calls, run: () => main({ env, argv, fetchImpl }) };
}

test("the upload sends the SERVICE ROLE key, not the automation token", async () => {
  const h = harness({ SUPABASE_SERVICE_ROLE_KEY: "service-role-value", QA_E2E_AUTOMATION_TOKEN: "automation-value" });
  assert.equal(await h.run(), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].auth, "Bearer service-role-value");
  assert.doesNotMatch(h.calls[0].auth, /automation-value/,
    "the automation token has no write access to the bucket — the route 401s on it");
});

test("with only the automation token set, it refuses instead of uploading 401s", async () => {
  // Refusing names the missing variable once; uploading would produce one 401 per file
  // and bury the single fact that matters.
  const h = harness({ QA_E2E_AUTOMATION_TOKEN: "automation-value" });
  assert.equal(await h.run(), 2, "a missing credential is a refusal (2), not a partial upload (1)");
  assert.equal(h.calls.length, 0, "nothing may be sent without the service role key");
});
