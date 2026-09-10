// Could ANY provider have served a call on this run? (issue #1800)
//
// ## The question the report cannot answer
//
// `lane-coverage-verdict.mjs` classifies a run from its Playwright report, which is
// the right substrate for "what did this run cover": a skip carries its reason, and
// the reason names the provider that could not serve it. What a report structurally
// cannot say is whether ANY provider was alive — a healthy provider leaves no trace
// in it at all. Its absence of evidence and a dead account's are the same bytes.
//
// That gap is what made `executed === 0` stand in for it, and the substitution has a
// false positive that reddens a PR (#1800): the PR lane's "run" is whatever the
// import graph selected, frequently ONE spec file, so a PR editing a single wholly-
// gated spec during a drain of that spec's provider executes nothing and scores
// `uncovered` — while two other providers were alive and the rest of the suite would
// have run fine. Two specs reach that today, both `@agents`, both one test, both
// gated on openai: `chatInputOutputUser-shard-2.spec.ts` and
// `general-bugs-agent-images-playground.spec.ts`.
//
// So the account axis is read where it is actually recorded: `providers.json`, the
// file `collect-models` writes and every provider gate in this repo already consumes.
//
// ## Union, not intersection
//
// The daily collects health per SHARD — four sweeps, four files, and they can
// legitimately disagree when a key recovers (or drains) mid-run. A provider counts as
// usable if ANY shard reached it, because one shard reaching it proves the ACCOUNT
// could. The opposite reading would let one shard's transient failure report the
// account as dead and fail a run the other three covered.
//
// ## Unknown is a third state, and it must not fail a lane
//
// `providers.json` is gitignored and only exists after `collect-models`, which is
// legitimately skipped (an LLM-free PR) and legitimately allowed to fail (a canary,
// #1159). So "no readable file" is UNKNOWN, never "dry" — the verdict reports the gap
// and declines to fail on it. This is the one place the coverage guard does not fail
// closed, and the reason is asymmetric: a wrong `dry` blocks a merge over a file that
// was never meant to be there, while a wrong `unknown` costs one loud warning.
//
// Deliberately NOT re-declared here: the record shape. Only `provider` and `status`
// are read, both defensively, because this consumes a file written by a different
// process on a different machine and a shape it does not recognise must degrade to
// UNKNOWN rather than throw inside a reporting step.

import fs from "node:fs";

/** @typedef {{ known: boolean, active: string[], unread: string[] }} ProviderUsability */

/**
 * Fold parsed `providers.json` payloads into one answer about the account.
 *
 * @param {unknown[]} payloads parsed file contents, in any order
 * @returns {{ known: boolean, active: string[] }}
 */
export function foldUsability(payloads = []) {
  const readable = payloads.filter((payload) => Array.isArray(payload));
  if (readable.length === 0) return { known: false, active: [] };

  const active = new Set();
  for (const records of readable) {
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (record.status !== "active") continue;
      const provider = String(record.provider ?? "").trim();
      if (provider) active.add(provider);
    }
  }
  return { known: true, active: [...active].sort() };
}

/**
 * Read every given `providers.json` and fold them.
 *
 * A path that does not exist, does not parse, or is not an array is reported in
 * `unread` and contributes nothing — the caller says so out loud rather than letting
 * a silently-dropped file decide a verdict (#1012).
 *
 * @param {string[]} paths
 * @param {{ readFile?: (p: string) => string }} [io]
 * @returns {ProviderUsability}
 */
export function readUsability(paths = [], io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const payloads = [];
  const unread = [];

  for (const path of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(path));
    } catch {
      unread.push(path);
      continue;
    }
    if (!Array.isArray(parsed)) {
      unread.push(path);
      continue;
    }
    payloads.push(parsed);
  }

  return { ...foldUsability(payloads), unread };
}

/**
 * The account's state as one word, which is what the outputs and the summary speak.
 *
 * @param {{ known: boolean, active: string[] }} usability
 * @returns {"dry"|"alive"|"unknown"}
 */
export function usabilityState(usability) {
  if (!usability?.known) return "unknown";
  return usability.active.length > 0 ? "alive" : "dry";
}
