#!/usr/bin/env node
// Upload a Playwright HTML report to the QA Platform's evidence bucket, so the run
// recorded there links to something a human can open.
//
// ## Why this exists
//
// The Actions lane hands the platform an artifact URL (`upload-artifact` gives it one
// for free). The VM lane has no artifact store: `RUN_URL_BASE` falls back to
// `file://$RUNS_ROOT`, so both `run_url` and `evidence_artifact_url` arrive as
// `file:///root/e2e-qa/runs/<id>/...` — a path that resolves on exactly one machine,
// behind a VPN. Measured in production before this existed: the platform accepted the
// run and stored that string (#2013).
//
// ## Why a POST per file rather than one archive
//
// The report is served, not downloaded. `/fn/serve-report/*` reads one object per
// request and streams it with a content type, and the report's own markup asks for its
// siblings by relative path — so the bucket has to hold the tree UNPACKED. Measured on
// the 2026-09-23 run: 35 files, 31 MB, of which `index.html` alone is 3.3 MB.
//
// That size is also why the evidence cannot ride inside the run payload: `POST /fn/:name`
// declares no `bodyLimit` and inherits Fastify's 1 MB default, while the storage route
// accepts 100 MB and exists for this shape — its own header says "Uploads come from
// bash running on GCP VMs".
//
// ## The content type is load-bearing, not cosmetic
//
// Public storage serves `.html` as `text/plain`, so a report fetched from
// `/storage/v1/object/public/...` DOWNLOADS instead of rendering; the platform routes
// reports through `/fn/serve-report/...` for that reason, and that route trusts the
// type stored with the object. An object stored as `application/octet-stream` renders
// as a download prompt whichever route reads it.
//
// ## Failure is reported, never fatal
//
// The caller runs this with `|| warn`. Evidence is an attachment to a verdict, and a
// storage outage must not cost the day its verdict — the same trade `Collect models`
// and the Slack notifier already make (#980). But every failure is COUNTED and named:
// a partially-uploaded report is a broken report, and silence about it would leave a
// link that 404s halfway with nothing in the log to explain it (#1012).
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The extension-to-type map the platform's own uploader uses. Kept in the same shape
 * deliberately: a report uploaded by this lane must be indistinguishable, once stored,
 * from one uploaded by the platform's runner, or `serve-report` would answer the two
 * differently for the same bytes.
 */
const TYPES = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webm: "video/webm",
  zip: "application/zip",
  wasm: "application/wasm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  md: "text/markdown",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
};

/**
 * `application/octet-stream` for the unknown case rather than a guess: an unknown type
 * stored honestly is a file the browser prompts to save, while a wrong type is one it
 * tries to render and mangles.
 *
 * The basename is taken first for legibility, NOT for correctness — measured, and the
 * note is here so nobody spends the same hour twice: reading the extension off the
 * whole path gives the identical answer for every input, because a "extension" that
 * spans a separator (`zip/heartbeat` for `trace.zip/heartbeat`) matches no key in the
 * map and falls through to the same default. The two differ only if a key here ever
 * contains a slash, which would be a different bug.
 */
export function contentTypeFor(path) {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return TYPES[base.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A relative path as a URL path.
 *
 * Its own function so it can be TESTED: on this lane's platform `sep` is already `/`,
 * so calling it inline would be a no-op here and a test for it would pass whether or
 * not the normalisation existed — green, and covering nothing. It matters wherever
 * `sep` is a backslash, because the key becomes a URL path and a backslash in it is a
 * literal character in the object name rather than a directory boundary: the report
 * would upload "successfully" into keys nothing can resolve.
 */
export function toPosixKey(rel) {
  return rel.split(sep).join("/").split("\\").join("/");
}

/** Every file under `dir`, as keys relative to it, with POSIX separators. */
export function collectFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, base, out);
    else out.push({ path: full, key: toPosixKey(relative(base, full)) });
  }
  return out;
}

/**
 * The object key for one report file.
 *
 * `playwright-report` is kept in the key because `REPORT_URL` is built as
 * `$RUN_URL_BASE/$RUN_ID/playwright-report/index.html` (run-e2e.sh) and the two have to
 * agree. Deriving the URL from this function instead would be tidier and wrong: that
 * line also serves the Actions lane, where no upload happens at all.
 */
export function objectKey(prefix, runId, rel) {
  const parts = [prefix, runId, "playwright-report", rel].filter(Boolean);
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/**
 * `env`, `argv` and `fetchImpl` are injectable so a test can ask WHICH credential this
 * sends — the question nothing asked when the first version sent the wrong one and every
 * test stayed green.
 */
export async function main({ env = process.env, argv = process.argv.slice(2), fetchImpl = fetch } = {}) {
  const args = argv;
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
  };

  const dir = get("--dir");
  const base = get("--base").replace(/\/+$/, "");
  const runId = get("--run-id");
  const prefix = get("--prefix");
  // The SERVICE ROLE key, not the automation token — they are different credentials and
  // the storage route accepts only this one: it compares the bearer against
  // env.serviceRoleKey and 401s on anything else, deliberately ("Nothing else may
  // write"). The automation token is a per-endpoint shared secret for the run ingest and
  // has no write access to the bucket.
  //
  // The first version of this script sent the automation token, and nothing caught it:
  // the tests covered key shapes and content types, never WHICH credential goes out.
  // Measured against production on 2026-09-23, in both directions: the service role key
  // (180 chars) gets past auth and stops at the body check, the automation token (64
  // chars) comes back 401. So every file would have failed, the upload would have
  // reported a complete failure, and the run record would still have advertised an
  // evidence URL that 404s in serve-report.
  //
  // It is also what the platform hands the VMs it orchestrates itself
  // (start-execution.ts, run-single.ts: `callbackAuthToken: env.serviceRoleKey`), so
  // this lane is doing what every other uploading VM already does.
  const token = env.SUPABASE_SERVICE_ROLE_KEY || "";

  // Refuse rather than half-upload: a missing base or token would send every file to
  // nowhere and report 35 failures, burying the one fact that matters.
  const missing = [];
  if (!dir) missing.push("--dir");
  if (!base) missing.push("--base");
  if (!runId) missing.push("--run-id");
  if (!token) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    console.error(`[evidence] refusing to upload — not set: ${missing.join(", ")}`);
    return 2;
  }

  let files;
  try {
    files = collectFiles(dir);
  } catch (e) {
    console.error(`[evidence] cannot read ${dir}: ${e?.message ?? e}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`[evidence] ${dir} holds no files — nothing uploaded`);
    return 2;
  }

  let ok = 0;
  const failed = [];
  for (const file of files) {
    const key = objectKey(prefix, runId, file.key);
    try {
      const res = await fetchImpl(`${base}/${key}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-upsert": "true",
          "Content-Type": contentTypeFor(file.key),
        },
        body: readFileSync(file.path),
      });
      if (res.ok) ok++;
      else failed.push(`${file.key} (HTTP ${res.status})`);
    } catch (e) {
      failed.push(`${file.key} (${e?.message ?? e})`);
    }
  }

  console.log(`[evidence] uploaded ${ok}/${files.length} file(s) to ${prefix}/${runId}`);
  if (failed.length) {
    // Named, capped, and the remainder counted — a list of 35 failures is as unreadable
    // as none, but "and 30 more" is the difference between a hiccup and a dead bucket.
    console.error(`[evidence] ${failed.length} file(s) FAILED — the report will be incomplete:`);
    for (const f of failed.slice(0, 5)) console.error(`[evidence]   ${f}`);
    if (failed.length > 5) console.error(`[evidence]   … and ${failed.length - 5} more`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; });
}
