#!/usr/bin/env node
// Remove secret values from a run's artifacts before they are published (#2486).
//
// ## Why this exists
//
// A Playwright report carries every credential a test handled, and nothing in
// Playwright redacts any of them. Measured on 1.58.2:
//
//   - a trace records each `APIRequestContext` request with its headers and body,
//     whether the context is the `request` fixture or `playwright.request.newContext()`;
//   - a trace records the text of every `fill()` in the action's parameters, password
//     inputs included;
//   - an `APIRequestContext` error prints every request header in its call log, and the
//     HTML report embeds error messages, annotations and stdout (#2485).
//
// So a provider key reaches the report through request headers, through the body of a
// variable write, through the frontend's own POST when a spec saves the key in the UI,
// and through the field a spec types it into. Moving one route out of Playwright closes
// that route only. A scan of this repository's live Actions artifacts on 2026-11-18
// found provider keys in 56 of 91 reports, blobs and JSON reports, most of them in the
// report data rather than in a trace.
//
// The one place every route passes through is the artifact itself, so that is where
// the values are removed: by VALUE, not by shape. A pattern for "what a key looks like"
// misses a provider whose keys have no prefix (Azure), while the values are known to
// the run that used them.
//
// ## What it reads
//
// Every file under the paths given, recursively. A zip (a trace, a blob report, the
// report's attachments) is opened and its entries scrubbed, nested zips included, then
// written back. The HTML report's `index.html` embeds its data as a base64 zip, which is
// decoded, scrubbed and re-encoded. Any other file without a NUL byte is treated as text.
// A binary file (a screenshot, a video) is left alone and counted: a key typed into a
// plain-text field can still be visible in a screenshot, and nothing here can remove it.
//
// ## Where the values come from
//
//   - `process.env`, for names that end like a secret (`_KEY`, `_TOKEN`, `_SECRET`,
//     `PASSWORD`, …);
//   - each `--dotenv FILE`, with the same name rule (the VM lane reads the clone's
//     `.env`). Not `--env-file`: Node 20 takes that flag for itself even when it comes
//     after the script name, and exits 9 when the file is absent (measured, v20.20.2);
//   - `--secrets-json-env NAME`: an environment variable holding a JSON object of
//     name -> value, every entry taken whatever its name. On Actions this is
//     `${{ toJSON(secrets) }}`, so a secret added later is covered with no edit here.
//
// A value shorter than MIN_SECRET_LENGTH is not scrubbed and is named in the report:
// replacing a short common string would corrupt the artifact, and a credential that
// short is not one this suite uses.
//
// ## Failure
//
// After writing, every file is read again and searched for every value. Exit 1 when
// any value is still present, or when a zip could not be read (its content could not be
// checked, so it cannot be called clean). The caller must not publish on exit 1. Exit 2
// is a usage error. The report names secrets by their variable NAME, never by value.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const MIN_SECRET_LENGTH = 12;
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;
const EMBEDDED_ZIP = /(data:application\/zip;base64,)([A-Za-z0-9+/=]+)/g;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function redactionMarker(name) {
  return `[REDACTED:${name}]`;
}

/** Parse a dotenv file: KEY=VALUE lines, optional `export`, optional quotes, `#` comments. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]] = value;
  }
  return out;
}

/**
 * The values to remove, longest first so a value that contains another is replaced
 * whole. Returns `{ secrets: [{name, value}], tooShort: [name] }`.
 */
export function collectSecrets({ env = {}, envFiles = [], json = {} } = {}) {
  const byValue = new Map();
  const tooShort = new Set();
  const add = (name, value) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (value.trim().length < MIN_SECRET_LENGTH) {
      tooShort.add(name);
      return;
    }
    if (!byValue.has(value)) byValue.set(value, name);
  };
  for (const [name, value] of Object.entries(json)) add(name, value);
  for (const vars of [env, ...envFiles]) {
    for (const [name, value] of Object.entries(vars)) {
      if (SECRET_NAME.test(name)) add(name, value);
    }
  }
  const secrets = [];
  for (const [value, name] of byValue) {
    secrets.push({ name, value });
    // A value in a URL query string or a form body is written percent-encoded.
    const encoded = encodeURIComponent(value);
    if (encoded !== value && !byValue.has(encoded)) secrets.push({ name, value: encoded });
  }
  secrets.sort((a, b) => b.value.length - a.value.length);
  return { secrets, tooShort: [...tooShort].sort() };
}

function isZip(buf) {
  return buf.length >= 4 && (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 4).equals(EMPTY_ZIP_MAGIC));
}

function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

function replaceText(text, secrets, counts) {
  let out = text;
  for (const { name, value } of secrets) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    counts[name] = (counts[name] ?? 0) + parts.length - 1;
    out = parts.join(redactionMarker(name));
  }
  return out;
}

function readZip(buf) {
  const { yauzl } = require("playwright-core/lib/zipBundle");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          entries.push({ name: entry.fileName, dir: true, mtime: entry.getLastModDate() });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks), mtime: entry.getLastModDate() });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function writeZip(entries) {
  const { yazl } = require("playwright-core/lib/zipBundle");
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) {
      if (e.dir) zip.addEmptyDirectory(e.name, { mtime: e.mtime });
      else zip.addBuffer(e.data, e.name, { mtime: e.mtime });
    }
    const chunks = [];
    zip.outputStream.on("data", (c) => chunks.push(c));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/**
 * Scrub one buffer. Returns `{ data, changed }`; records replacements in `stats.counts`,
 * skipped binaries in `stats.binary` and unreadable zips in `stats.unreadable`.
 */
export async function scrubBuffer(buf, secrets, stats, where = "") {
  if (isZip(buf)) {
    let entries;
    try {
      entries = await readZip(buf);
    } catch (e) {
      stats.unreadable.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      return { data: buf, changed: false };
    }
    let changed = false;
    for (const entry of entries) {
      if (entry.dir) continue;
      const r = await scrubBuffer(entry.data, secrets, stats, `${where}!${entry.name}`);
      if (r.changed) {
        entry.data = r.data;
        changed = true;
      }
    }
    return changed ? { data: await writeZip(entries), changed } : { data: buf, changed };
  }
  if (isBinary(buf)) {
    stats.binary.push(where);
    // Not rewritten (an image or a video would be corrupted), but searched: a value
    // stored literally in a binary file is still there after this pass, and the
    // verification reads these counts as residue.
    for (const { name, value } of secrets) {
      if (buf.includes(value)) stats.binaryHits[name] = (stats.binaryHits[name] ?? 0) + 1;
    }
    return { data: buf, changed: false };
  }
  // latin1 maps every byte to one code unit and back, so text that is not valid UTF-8
  // survives the round trip byte for byte. The values searched for are ASCII.
  const text = buf.toString("latin1");
  let out = replaceText(text, secrets, stats.counts);
  const embedded = [];
  for (const m of out.matchAll(EMBEDDED_ZIP)) embedded.push(m);
  for (const m of embedded.reverse()) {
    const inner = Buffer.from(m[2], "base64");
    const r = await scrubBuffer(inner, secrets, stats, `${where}#base64`);
    if (!r.changed) continue;
    const start = m.index + m[1].length;
    out = out.slice(0, start) + r.data.toString("base64") + out.slice(start + m[2].length);
  }
  return out === text ? { data: buf, changed: false } : { data: Buffer.from(out, "latin1"), changed: true };
}

function walk(path, files) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(join(path, name), files);
  } else if (st.isFile()) {
    files.push(path);
  }
}

export function newStats() {
  return { counts: {}, binaryHits: {}, binary: [], unreadable: [], files: 0, changed: 0 };
}

/** Scrub every file under `paths` in place, then verify. Returns the stats plus `residue`. */
export async function scrubPaths(paths, secrets) {
  const files = [];
  for (const p of paths) if (existsSync(p)) walk(p, files);
  const stats = newStats();
  stats.files = files.length;
  for (const file of files) {
    const r = await scrubBuffer(readFileSync(file), secrets, stats, file);
    if (r.changed) {
      writeFileSync(file, r.data);
      stats.changed += 1;
    }
  }
  // Verify by running the same pass again: a second pass that still finds a value means
  // the first one did not remove it.
  const verify = newStats();
  for (const file of files) await scrubBuffer(readFileSync(file), secrets, verify, file);
  stats.residue = { ...verify.counts };
  for (const [name, n] of Object.entries(verify.binaryHits)) stats.residue[name] = (stats.residue[name] ?? 0) + n;
  return stats;
}

function parseArgs(argv) {
  const opts = { envFiles: [], jsonEnv: null, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dotenv" || a === "--secrets-json-env") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--dotenv") opts.envFiles.push(v);
      else opts.jsonEnv = v;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}`);
    } else {
      opts.paths.push(a);
    }
  }
  if (opts.paths.length === 0) throw new Error("no path to scrub");
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(`scrub-secrets: ${e.message}`);
    log("usage: scrub-secrets.mjs [--dotenv F]... [--secrets-json-env NAME] <path>...");
    return 2;
  }
  const envFiles = [];
  for (const f of opts.envFiles) {
    if (existsSync(f)) envFiles.push(parseEnvFile(readFileSync(f, "utf8")));
    else log(`scrub-secrets: env file ${f} not found, skipped`);
  }
  let json = {};
  if (opts.jsonEnv) {
    const raw = env[opts.jsonEnv];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") json = parsed;
      } catch {
        log(`scrub-secrets: ${opts.jsonEnv} is not valid JSON — the values in it are NOT scrubbed`);
        return 1;
      }
    } else {
      log(`scrub-secrets: ${opts.jsonEnv} is empty, only the environment and env files are used`);
    }
  }
  const { secrets, tooShort } = collectSecrets({ env, envFiles, json });
  const names = [...new Set(secrets.map((s) => s.name))].sort();
  log(`scrub-secrets: ${names.length} secret value(s) to remove (${names.join(", ") || "none"})`);
  if (tooShort.length) log(`scrub-secrets: not scrubbed, shorter than ${MIN_SECRET_LENGTH} characters: ${tooShort.join(", ")}`);
  if (secrets.length === 0) {
    log("scrub-secrets: nothing to remove — no secret is known to this step, so nothing was checked");
    return 0;
  }
  const stats = await scrubPaths(opts.paths, secrets);
  const counts = Object.entries(stats.counts).map(([n, c]) => `${n}×${c}`).join(", ");
  log(`scrub-secrets: ${stats.files} file(s) read, ${stats.changed} rewritten; removed: ${counts || "nothing"}`);
  if (stats.binary.length) {
    log(`scrub-secrets: ${stats.binary.length} binary file(s) not scrubbed (screenshots, videos): a key typed into a plain-text field can still be visible in them`);
  }
  let failed = false;
  if (stats.unreadable.length) {
    failed = true;
    log(`scrub-secrets: ${stats.unreadable.length} zip(s) could not be read, so their content was not checked:`);
    for (const u of stats.unreadable.slice(0, 20)) log(`  ${u}`);
  }
  const residue = Object.entries(stats.residue);
  if (residue.length) {
    failed = true;
    log(`scrub-secrets: values STILL present after scrubbing: ${residue.map(([n, c]) => `${n}×${c}`).join(", ")}`);
  }
  if (failed) log("scrub-secrets: FAILED — do not publish these artifacts");
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
