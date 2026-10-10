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
// The forbidden band is (1500, 2500) ms, exclusive. The measured window is far
// narrower than that (1950 and 2050 were clean), so the band is margin, not the
// measurement. `expect.poll` sleeps AFTER the callback returns, so the idle gap
// the server sees is the interval PLUS the client's own processing of the last
// response — on a heavy read (the full `GET /api/v1/flows/` listing) that can
// add hundreds of ms. 1500 ms is therefore allowed by the guard but is the
// closest clean value, measured clean on light reads only; prefer `[500, 1000]`,
// or ≥3000 ms where the cadence must back off. Gaps of 3000 ms and longer are
// clean against the gunicorn (Linux) instance, where the close is at 2 s; a
// uvicorn-direct instance (`langflow run` on macOS) closes at uvicorn's default
// 5 s instead, which no band here models — the `retryOnDroppedConnection` wrap
// is what covers that.
//
// Limits, stated so the guard is not read as stronger than it is:
//  - it reads LITERAL interval arrays only. `intervals: SOME_CONSTANT` and a
//    hand-written loop that sleeps 2 s between reads are invisible to it;
//  - it flags UI-only polls too, which cannot hit the edge. That is deliberate:
//    telling the two apart from source is a judgement this test cannot make, and
//    the cost of not using 2000 ms in a UI poll is nothing.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BAND_LOW_MS = 1500;
export const BAND_HIGH_MS = 2500;

export interface CadenceViolation {
  line: number;
  value: number;
  text: string;
}

/** Every literal `intervals: [...]` value inside the forbidden band. */
export function findKeepAliveEdgeIntervals(source: string): CadenceViolation[] {
  const violations: CadenceViolation[] = [];
  for (const match of source.matchAll(/intervals\s*:\s*\[([^\]]*)\]/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    for (const token of match[1].split(",")) {
      const trimmed = token.trim().replace(/_/g, "");
      if (!/^\d+$/.test(trimmed)) continue;
      const value = Number(trimmed);
      if (value > BAND_LOW_MS && value < BAND_HIGH_MS) {
        violations.push({ line, value, text: match[0].replace(/\s+/g, " ") });
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
