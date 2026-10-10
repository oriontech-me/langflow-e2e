// Detector for polls that wait on the backend's 2 s keep-alive edge (#2243).
// The guard over the whole tests/ tree is poll-keepalive-cadence.test.ts, beside
// this file; run it with `npm run test:units`.
//
// On Linux Langflow runs under gunicorn, whose `UvicornWorker` closes an idle
// keep-alive connection after gunicorn's default `keepalive` of 2 s. A request
// that reuses the pooled socket at that instant dies with `socket hang up` /
// `read ECONNRESET` (#2236). Measured on `1.13.0.dev35`, 15 reads per idle gap:
// 5 of 15 dropped at 2000 ms, none at 1500, 1950, 2050 or 3000 ms.
//
// The commonest shape was `intervals: [500, 1000, 2000]`, which repeats its last
// value, so every such poll that ran past 3.5 s sat on that edge; the others put a
// 2000 elsewhere in a backoff (`[2000]`, `[1000, 2000, 3000, 5000]`, `2_000`). On
// `main` before #2236 there were 31 such call sites in 27 files:
// `general-bugs-save-changes-on-node` was quarantined for one and fixed first
// (#2236), and #2243 fixed the other 30. This guard is what stops a 32nd.
//
// The forbidden band is (1000, 2100) ms, exclusive, and it is deliberately NOT
// centred on the edge. `expect.poll` sleeps AFTER the callback returns, so the idle
// gap the server sees is the interval PLUS the client's own processing of the last
// response -- never less than the interval. The risk therefore sits BELOW 2000: a
// 1500 plus a few hundred ms of parsing a heavy body (the full `GET /api/v1/flows/`
// listing) on a loaded runner lands on the edge. Above 2000 the gap only grows away
// from it, so the upper bound is a thin margin over the measured-clean 2050. Prefer
// `[500, 1000]`, or >=3000 ms where the cadence must back off -- and not a repeated
// 5000: a uvicorn-direct instance (`langflow run` on macOS) closes at uvicorn's
// default 5 s, which no band here models; `retryOnDroppedConnection` covers that.
//
// What it reads: every array literal assigned to `intervals` or to any identifier
// whose name contains "intervals" (`CREDENTIAL_SETTLE_INTERVALS_MS = [...]` sat on
// the edge for that reason alone). Brackets are matched, so a nested `[...]` does
// not end the array early, and an element it cannot evaluate as a whole number
// (`2 * 1000`, `TWO_SECONDS`, `2e3`) is reported rather than read as clean.
//
// Limits, stated so the guard is not read as stronger than it is:
//  - an interval passed by reference (`intervals: SOME_CONSTANT` where the constant
//    has no "intervals" in its name) and a hand-written loop that sleeps a bare
//    number between reads are invisible to it;
//  - it flags UI-only polls too, which cannot hit the edge. That is deliberate:
//    telling the two apart from source is a judgement this test cannot make, and
//    the cost of not using 2000 ms in a UI poll is nothing.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BAND_LOW_MS = 1000;
export const BAND_HIGH_MS = 2100;

export interface CadenceViolation {
  line: number;
  /** The interval in ms, or null when the element is not a whole-number literal. */
  value: number | null;
  /** The element as written. */
  element: string;
  text: string;
}

const ARRAY_START = /\b\w*intervals\w*\s*[:=]\s*\[/gi;
const OPEN = "[({";
const CLOSE = "])}";

/** The source between the `[` ending at `from` and its matching `]`. */
function arrayBody(source: string, from: number): string {
  let depth = 1;
  let i = from;
  for (; i < source.length && depth > 0; i++) {
    if (OPEN.includes(source[i])) depth++;
    else if (CLOSE.includes(source[i])) depth--;
  }
  return source.slice(from, depth === 0 ? i - 1 : i);
}

/** Split on the commas at nesting depth 0 only. */
function topLevelElements(body: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      elements.push(current);
      current = "";
    } else current += ch;
  }
  elements.push(current);
  return elements.map((e) => e.trim()).filter((e) => e.length > 0);
}

/**
 * Every interval array element inside the forbidden band, and every element that
 * cannot be evaluated (reported with `value: null`: unknown is not clean).
 */
export function findKeepAliveEdgeIntervals(source: string): CadenceViolation[] {
  const violations: CadenceViolation[] = [];
  for (const match of source.matchAll(ARRAY_START)) {
    const start = (match.index ?? 0) + match[0].length;
    const body = arrayBody(source, start);
    const line = source.slice(0, match.index).split("\n").length;
    const text = (match[0] + body + "]").replace(/\s+/g, " ");
    for (const element of topLevelElements(body)) {
      const digits = element.replace(/(\d)_(?=\d)/g, "$1");
      if (!/^\d+$/.test(digits)) {
        violations.push({ line, value: null, element, text });
        continue;
      }
      const value = Number(digits);
      if (value > BAND_LOW_MS && value < BAND_HIGH_MS) {
        violations.push({ line, value, element, text });
      }
    }
  }
  return violations;
}

export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}
