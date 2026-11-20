#!/usr/bin/env node
// Remove secret values from a run's artifacts before they are published (#2486).
//
// ## Why this exists
//
// A Playwright report carries every credential a test handled, and nothing in
// Playwright redacts any of them. Measured on 1.58.2, and again on 1.65.1 (#2167):
//
//   - a trace records each `APIRequestContext` request with its headers and body,
//     whether the context is the `request` fixture or `playwright.request.newContext()`;
//   - a trace records the text of every `fill()` in the action's parameters, password
//     inputs included;
//   - an `APIRequestContext` error prints every request header in its call log, and the
//     HTML report embeds error messages, annotations and stdout (#2485);
//   - on 1.65.1, unlike 1.58.2, the blob also carries each failed attempt's `error-context` markdown
//     (the error and the test's source) as a plain-text file under `resources/`, so a
//     value can reach a blob in plain text, not only as base64 in `report.jsonl`. It is
//     an ordinary text entry in a zip, which the pass below already scrubs (measured:
//     every planted value gone from the blob, the results and the merged HTML report).
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
// Every file under the paths given, recursively, in the order given: a caller that
// passes results.json first gets it rewritten even if a later file crashes the run. A
// zip (a trace, a blob report, the report's attachments) is opened and its entries scrubbed, nested zips included, then
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
//     name -> value. On Actions this is `${{ toJSON(secrets) }}`, so a credential added
//     later is covered with no edit here. The same name rule applies: the repository
//     also keeps configuration as secrets (an Azure deployment name, an endpoint, a
//     project id), and a deployment name that is also a model id would otherwise be
//     replaced inside test titles and parameters, which the history and the @stable
//     auto-removal match on.
//
// Each value is searched in four forms: as given, trimmed (a secret saved with a
// trailing newline reaches the report without it, because the helpers trim), percent-
// encoded (a query string, a form body), and base64 at each of the three byte
// alignments, standard and URL-safe. Playwright stores an inline attachment body and a
// Buffer written to stdout as base64 in results.json and in the blob's report.jsonl.
// A base64 hit is overwritten with a run of `A` of the same length, so the surrounding
// base64 still decodes, to zero bytes where the value was.
//
// A value shorter than MIN_SECRET_LENGTH is not scrubbed and is named in the report:
// replacing a short common string would corrupt the artifact, and a credential that
// short is not one this suite uses.
//
// ## Failure
//
// `--require-secrets` turns "no secret is known" into exit 1. The Actions lanes pass it:
// there `toJSON(secrets)` always carries the run's token, so an empty set is a wiring
// fault, and a clean exit over it would certify artifacts nobody checked.
//
// After writing, every file is read again and searched for every value. Exit 1 when
// any value is still present, or when a zip could not be read (its content could not be
// checked, so it cannot be called clean). The caller must not publish on exit 1. Exit 2
// is a usage error. The report names secrets by their variable NAME, never by value.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const MIN_SECRET_LENGTH = 12;
// An optional `_N` suffix: the repository keeps `ANTHROPIC_API_KEY_2`.
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_\d+)?$/i;
// An SGR colour code, raw or as JSON writes it. Playwright's assertion diff puts these
// INSIDE a value (inverse video on the differing characters), so a key in an
// `expect(…).toBe(key)` failure is not contiguous in results.json or the report, while
// the report renders it whole and build-run-payload.mjs strips the codes and rejoins it.
const ANSI_GAP = String.raw`(?:(?:\x1b|\\u001b)\[[0-9;]*m)*`;
const EMBEDDED_ZIP = /(data:application\/zip;base64,)([A-Za-z0-9+/=]+)/g;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function redactionMarker(name) {
  return `[REDACTED:${name}]`;
}

/**
 * Parse a dotenv file with `dotenv` itself: the shards get their keys from
 * `playwright.config.ts`'s `dotenv.config()`, and a parser that disagreed with it about
 * a value (an unquoted `#`, say) would search for a value the shards never sent.
 */
export function parseEnvFile(text) {
  return require("dotenv").parse(text);
}

/** The base64 text that encodes `value` at byte offset k (0..2), with only the
 * characters that depend on `value` alone, so it matches wherever the value sits. */
function base64Cores(value) {
  const bytes = Buffer.from(value, "utf8");
  const out = [];
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    const start = [0, 2, 3][k];
    const end = Math.floor(((k + bytes.length) * 8) / 6);
    out.push(b64.slice(start, end));
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
  for (const vars of [json, env, ...envFiles]) {
    for (const [name, value] of Object.entries(vars)) {
      if (SECRET_NAME.test(name)) add(name, value);
    }
  }
  const secrets = [];
  const seen = new Set();
  // Every form is matched as its UTF-8 bytes read under latin1, which is how the files
  // are read: a value with `ç` is two bytes on disk, never the one JS character.
  const push = (name, value, replacement, ansi = false) => {
    const read = asRead(value);
    if (read.length === 0 || seen.has(read)) return;
    seen.add(read);
    secrets.push({ name, value: read, replacement, ansi });
  };
  for (const [value, name] of byValue) {
    const marker = redactionMarker(name);
    for (const form of new Set([value, value.trim()])) {
      push(name, form, marker, true);
      // As JSON writes it: a `"`, a `\` or a newline in the value is escaped in
      // results.json, in a trace and in the report's data.
      push(name, JSON.stringify(form).slice(1, -1), marker, true);
      // A value in a URL query string or a form body is written percent-encoded.
      push(name, encodeURIComponent(form), marker);
      for (const core of base64Cores(form)) {
        push(name, core, "A".repeat(core.length));
        push(name, core.replace(/\+/g, "-").replace(/\//g, "_"), "A".repeat(core.length));
      }
    }
  }
  secrets.sort((a, b) => b.value.length - a.value.length);
  return { secrets, tooShort: [...tooShort].sort() };
}

/** The text a value's UTF-8 bytes read as under latin1, which is how files are read. */
function asRead(value) {
  return Buffer.from(value, "utf8").toString("latin1");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isZip(buf) {
  return buf.length >= 4 && (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 4).equals(EMPTY_ZIP_MAGIC));
}

function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

function replaceText(text, secrets, counts) {
  let out = text;
  for (const { name, value, replacement } of secrets) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    counts[name] = (counts[name] ?? 0) + parts.length - 1;
    out = parts.join(replacement ?? redactionMarker(name));
  }
  // A value with colour codes between its characters (an assertion diff). Only searched
  // when the text has a code at all, so a report without one pays nothing.
  if (out.includes("\u001b[") || out.includes("\\u001b[")) {
    for (const { name, value, replacement, ansi } of secrets) {
      if (!ansi) continue;
      const pattern = new RegExp([...value].map(escapeRegExp).join(ANSI_GAP), "g");
      out = out.replace(pattern, () => {
        counts[name] = (counts[name] ?? 0) + 1;
        return replacement ?? redactionMarker(name);
      });
    }
  }
  return out;
}

// yauzl and yazl are our own exact-pinned devDependencies. They started at the
// versions Playwright 1.65.1 bundles (yauzl 3.4.0, yazl 3.3.1); Dependabot bumps them
// on their own from here, so read package.json for the current pins. Until #2167
// they came from `playwright-core/lib/zipBundle`, an internal path: 1.65.1 dropped it
// from the package's `exports` map and the require threw
// ERR_PACKAGE_PATH_NOT_EXPORTED, which would have failed every scrub, and every
// report upload behind one. 1.65.1 still exposes both through the exported
// `playwright-core/lib/utilsBundle`, but owning the packages keeps the scrub off
// Playwright's internals entirely.
function readZip(buf) {
  const yauzl = require("yauzl");
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
  const yazl = require("yazl");
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
  const opts = { envFiles: [], jsonEnv: null, requireSecrets: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dotenv" || a === "--secrets-json-env") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--dotenv") opts.envFiles.push(v);
      else opts.jsonEnv = v;
    } else if (a === "--require-secrets") {
      opts.requireSecrets = true;
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
    log("usage: scrub-secrets.mjs [--dotenv F]... [--secrets-json-env NAME] [--require-secrets] <path>...");
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
    // On Actions the JSON always carries at least the run's own token, so an empty set
    // there means the wiring dropped it, not that there is nothing to hide.
    if (opts.requireSecrets) {
      log("scrub-secrets: FAILED — --require-secrets was given and no secret value reached this step");
      return 1;
    }
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

// pathToFileURL, not a template: import.meta.url is percent-encoded, so a path with a
// space made the two differ, main() never ran, and the caller read exit 0 as verified.
// realpath too, since Node resolves a symlinked entry point to its target.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
