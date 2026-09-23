// The recurrence key: what "the same cause" means when the triage asks whether a
// flake RECURRED (#1626).
//
// Recurrence used to compare `error_signature` — line 1 of the recorded attempt's
// message — for equality. That string has the wrong granularity in BOTH directions,
// and each direction was measured on a real daily:
//
//   - Too coarse. `TimeoutError: page.waitForSelector: Timeout 3000ms exceeded.`
//     names neither the element nor the call site, so a spec issuing several waits
//     at one budget collides with itself: `filterSidebar.spec.ts` waited for
//     `sidebar-search-input` (:56) and `handle-apirequest-shownode-url-left` (:73)
//     under one signature (#1623), and `model-provider-model-toggle.spec.ts` stalled
//     on two different `locator.click` targets under one (#1694). Both were scored
//     `same_signature: true`, which is the threshold for a dedicated issue AND a
//     quarantine.
//   - Too fine. A marker assertion interpolates the model and counters into its
//     message — `MODEL_PICKER_DEFECT: "gpt-4o-mini" …` against
//     `MODEL_PICKER_DEFECT: "gemini-3.5-flash" …`, `29 toggle(s) clicked` against
//     `30 toggle(s)` — so one cause never matches itself and stays
//     `actionable: false` however many dailies it takes down (#1649, #1679).
//
// So the key is four fields rather than one string, and each answers one of those:
//
//   head     the KIND of failure: line 1 with its volatile parts masked, or the
//            marker alone when the message leads with one (`MODEL_PICKER_DEFECT`).
//   locator  the element or request the failing call was waiting on, read from
//            Playwright's `Locator:` line or the first `waiting for` / `→ METHOD`
//            call-log entry. The discriminator for the too-coarse direction.
//   file     where it failed (the error's own location, a helper as often as the
//            spec), repo-relative so the Actions and VM lanes spell it alike.
//   source   the failing line's SOURCE TEXT, from the code frame — deliberately not
//            the line number, which moves with every unrelated edit above it and
//            would reset the 30-day window on a refactor.
//
// A test records the key of EVERY failed attempt, not only the one
// `error_signature` reads. The history reads a flake's FIRST failed attempt and a
// hard failure's LAST, so a cause that sat on attempt 0 of a hard failure was
// invisible to a flake of the same cause a week earlier (#1626, run 33630411848).
// Two occurrences match when any attempt of one shares all four fields with any
// attempt of the other.
//
// Pure and I/O-free: the appender derives the keys, `triage-core.mjs` compares
// them, and both read this one module so the two cannot drift apart.

import { normalizeSpecPath } from "./spec-path.mjs";

/**
 * Bumped whenever the derivation changes. Two keys of different versions are
 * never compared field by field — only by head, and the match is reported
 * `unverified` — because a changed derivation would otherwise read as a changed
 * cause and silently reset every window it touched.
 */
export const RECURRENCE_KEY_VERSION = 1;

// Kept in step with `triage-core.mjs`'s ANSI_RE: the ESC is required, or the
// bare control byte survives and a coloured recording never equals a plain one.
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

// A marker is an UPPER_SNAKE code leading the message, optionally behind the
// `Error:` prefix `new Error()` adds. At least one underscore, so `HTTP` or
// `ECONNREFUSED` never qualify. Measured on the history file: MODEL_TOGGLE_WRITE_STALLED,
// MODEL_PICKER_DEFECT, PROVIDER_LIST_STALLED, TOGGLE_WRITE_UNANSWERED,
// MODEL_NOT_AVAILABLE — every one followed by prose that interpolates the target.
const MARKER_RE = /^(?:[A-Za-z]*Error:\s*)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=:|\s|$)/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Six or more digits is a timestamp or a generated id (`sync-session-1790002468600`),
// never a budget or a status code.
const LONG_NUMBER_RE = /\d{6,}/g;

// A generated token inside a test id: six or more alphanumerics mixing letters
// and digits, bounded by anything that is not alphanumeric (so `_`-joined parts
// count separately). Measured on the 2026-09-23 daily: `a2a-target-9bbd49b7-0-option`,
// `connection-row-page_row_mue51qw0_83sqzi` — a fresh id per run, which made each
// occurrence of one cause a different locator. Named ids (`provider-item-OpenAI`,
// `llm-toggle-gpt-4o-mini`, `sidebar-search-input`) have no such segment.
const GENERATED_TOKEN_RE = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,}(?![A-Za-z0-9])/g;

/** Masks that apply to every field that can carry a generated value. */
function maskIds(s) {
  return s.replace(UUID_RE, "<uuid>").replace(LONG_NUMBER_RE, "<n>");
}

/** A locator additionally loses the generated tokens a test id embeds. */
function maskLocator(s) {
  return maskIds(s).replace(GENERATED_TOKEN_RE, "<id>");
}

/** First non-empty line, trimmed and capped — `errorSignature()`'s exact rule in
 *  the appender, so a head derived here from the full message equals the head
 *  derived later from the stored `error_signature`. */
function firstLine(message) {
  const line = String(message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 240) : "";
}

/**
 * The failure's kind, from its first line.
 *
 * Every digit run is masked, not only the long ones. A number left in the head
 * mostly makes one cause unequal to itself: `page-entry barrier … answered GET
 * /api/v1/version with HTTP 200 in 1023ms` — 23 occurrences in the history on
 * 2026-09-23, each carrying a measured latency, so none could ever match another.
 * A budget (`Timeout 3000ms` against `Timeout 20000ms`) is a property of the call
 * site, which `source` keeps. The price is paid in the other direction: one
 * source line that interpolates an HTTP status now reads a 403 and a 500 as one
 * kind. That is the rarer of the two, and it errs toward an unverified match a
 * human reads rather than toward a cause that can never recur.
 */
export function recurrenceHead(signature) {
  const line = stripAnsi(signature).replace(/\s+/g, " ").trim();
  if (!line) return "";
  const marker = MARKER_RE.exec(line);
  if (marker) return marker[1];
  return line
    .replace(UUID_RE, "<uuid>")
    .replace(/\d+/g, "#")
    .toLowerCase();
}

/**
 * What the failing call was waiting on, or null.
 *
 * Three shapes, in the order Playwright prints them: an assertion's `Locator:`
 * line; an action's `- waiting for <locator>` call-log entry (with the
 * `to be visible` tail dropped, since the state is the call's, not the target's);
 * and a request's `- → POST <url>` entry, origin stripped so the lanes' different
 * ports agree and ids masked so each run's flow id does not.
 */
export function recurrenceLocator(message) {
  const text = stripAnsi(message);
  const assertion = /^\s*Locator:\s*(.+?)\s*$/m.exec(text);
  if (assertion) return maskLocator(assertion[1]);
  const waiting = /^\s*-\s*waiting for (.+?)\s*$/m.exec(text);
  if (waiting) {
    return maskLocator(waiting[1].replace(/\s+to be (?:visible|hidden|attached|detached)$/, ""));
  }
  const request = /^\s*-\s*→\s*([A-Z]+)\s+(\S+)/m.exec(text);
  if (request) {
    const path = request[2].replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
    return maskLocator(`${request[1]} ${path}`);
  }
  return null;
}

/**
 * Repo-relative, `tests/`-stripped path of the error's own location, or null.
 *
 * `root` is the working directory the report was produced under; when the path is
 * not below it (a report merged on another machine), the last `/tests/` segment
 * anchors it instead — both lanes lay the repo out the same way beneath that.
 */
export function recurrenceFile(location, root = "") {
  const file = String(location?.file ?? "");
  if (!file) return null;
  let rel = file;
  const prefix = root ? root.replace(/\/+$/, "") + "/" : "";
  if (prefix && file.startsWith(prefix)) rel = file.slice(prefix.length);
  else if (file.startsWith("/")) {
    const at = file.lastIndexOf("/tests/");
    if (at !== -1) rel = file.slice(at + 1);
  }
  return normalizeSpecPath(rel) || null;
}

/**
 * The failing line's source text, from the code frame's `>` row, or null.
 *
 * The merged report usually leaves `snippet` empty and prints the frame inside
 * the message instead (measured on runs 33105369510 and 33511210195), so both are
 * read.
 *
 * A statement spanning several lines is followed into the rows below the `>` row
 * until it closes, because its first line alone is often nothing:
 * `await expect` heads 11 of the 127 keys the last ten dailies produce, and a
 * value assertion (`expect(received)…`, `expect.poll`) has no locator to tell two
 * such sites apart — so without the continuation, two different assertions in one
 * spec collided exactly the way #1623 did. The frame only prints a few rows past
 * the failing one, so a long statement is cut where the frame is; that cut is the
 * same on every run, which is all a key needs.
 */
export function recurrenceSource(error) {
  for (const text of [error?.snippet, error?.message, error?.value]) {
    const source = frameStatement(stripAnsi(text));
    if (source) return cap(source);
  }
  return null;
}

const FRAME_ROW = /^\s*(>)?\s*\d+\s*\|(.*)$/;
const QUOTED = /(["'`])(?:\\.|(?!\1).)*\1/g;

/** Net bracket depth of a code fragment, string literals ignored. */
function bracketDepth(code) {
  let depth = 0;
  for (const ch of code.replace(QUOTED, "")) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  return depth;
}

/** The failing statement from a code frame: the `>` row plus the rows it continues onto. */
function frameStatement(text) {
  const lines = String(text).split("\n");
  const at = lines.findIndex((l) => {
    const m = FRAME_ROW.exec(l);
    return m && m[1] === ">";
  });
  if (at === -1) return null;
  const parts = [FRAME_ROW.exec(lines[at])[2].trim()];
  for (let i = at + 1; i < lines.length && parts.length < 5; i++) {
    const joined = parts.join(" ");
    const open = bracketDepth(joined) > 0 || /(?:\bexpect|[(,.{]|=>)$/.test(joined);
    const row = FRAME_ROW.exec(lines[i]);
    if (!row) {
      if (/^\s*\|/.test(lines[i])) continue; // the caret row under the failing one
      break;
    }
    const next = row[2].trim();
    if (!open && !next.startsWith(".")) break;
    parts.push(next);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim() || null;
}

// Locator and source are otherwise unbounded — the longest measured was 434
// characters — and they are written into every row of a committed file.
const cap = (s) => (s.length > 240 ? s.slice(0, 240) : s);

const TEST_TIMEOUT_HEAD = /^test timeout of #ms exceeded/;

/**
 * The key of ONE failed attempt's error object, or null when it has none.
 *
 * `inFlight` is the attempt's NEXT error. A test that runs out of its own budget
 * reports `Test timeout of 300000ms exceeded.` first and carries neither locator
 * nor frame — every such attempt of a test would be one cause — while the action
 * that was waiting when the budget ran out is reported right after it. So for
 * that head the site is read from the in-flight error, and the head stays the
 * timeout's.
 */
export function recurrenceKey(error, root = "", inFlight = null) {
  if (!error) return null;
  const message = error.message || error.value || "";
  const head = recurrenceHead(firstLine(message));
  if (!head) return null;
  const site = TEST_TIMEOUT_HEAD.test(head) && inFlight ? inFlight : error;
  const siteMessage = site.message || site.value || "";
  const locator = recurrenceLocator(siteMessage);
  return {
    head,
    locator: locator === null ? null : cap(locator),
    file: recurrenceFile(site.location, root),
    source: recurrenceSource(site),
  };
}

const sameKey = (a, b) =>
  a.head.toLowerCase() === b.head.toLowerCase() &&
  a.locator === b.locator &&
  a.file === b.file &&
  a.source === b.source;

/**
 * The distinct keys of every failed attempt of one Playwright test, oldest first.
 * `passed` and `skipped` results are excluded for the reason the appender gives:
 * a `describe.serial` abort turns retries into skipped results that never ran.
 */
export function recurrenceKeysForTest(test, root = "") {
  const keys = [];
  for (const result of test?.results || []) {
    if (result?.status === "passed" || result?.status === "skipped") continue;
    const errors = result?.errors || [];
    const key = recurrenceKey(result?.error || errors[0], root, errors[1] || null);
    if (key && !keys.some((k) => sameKey(k, key))) keys.push(key);
  }
  return keys;
}

/** True when the entry was written with keys of the current derivation. */
function currentForm(entry) {
  return (
    Array.isArray(entry?.recurrence_keys) &&
    entry.recurrence_key_version === RECURRENCE_KEY_VERSION
  );
}

/** Every head an entry can answer for: its keys' and its stored signature's. */
function headsOf(entry) {
  const heads = new Set();
  if (Array.isArray(entry?.recurrence_keys)) {
    for (const k of entry.recurrence_keys) if (k?.head) heads.add(k.head.toLowerCase());
  }
  const own = recurrenceHead(entry?.error_signature).toLowerCase();
  if (own) heads.add(own);
  return heads;
}

/**
 * Do two history entries record the same cause?
 *
 *   `match`       both carry current-form keys and some attempt of one shares all
 *                 four fields with some attempt of the other.
 *   `unverified`  at least one side predates the keys (or carries another
 *                 version), so only the heads could be compared, and they agree.
 *                 That is exactly the collision #1626 was raised about, so it is
 *                 COUNTED — reading a legacy row as "no recurrence" would silently
 *                 reset every window on the day this shipped — but named, so the
 *                 proposal checks the call logs before it cites the figure.
 *   `none`        different causes.
 *
 * An entry with an empty key list (an unexpected pass, or a failure whose error
 * was lost) is compared by the head of its stored signature, with every other
 * field null — so it matches another keyless entry of the same head, and never a
 * keyed row, whose fields are not null. In practice empty keys mean `unknown`, so
 * that only ever pairs `unknown` with `unknown`, which is what it did before.
 */
export function compareRecurrence(a, b) {
  if (currentForm(a) && currentForm(b)) {
    const ka = a.recurrence_keys.length ? a.recurrence_keys : [headOnly(a)];
    const kb = b.recurrence_keys.length ? b.recurrence_keys : [headOnly(b)];
    return ka.some((x) => kb.some((y) => sameKey(x, y))) ? "match" : "none";
  }
  const ha = headsOf(a);
  for (const h of headsOf(b)) if (ha.has(h)) return "unverified";
  return "none";
}

function headOnly(entry) {
  return { head: recurrenceHead(entry?.error_signature), locator: null, file: null, source: null };
}
