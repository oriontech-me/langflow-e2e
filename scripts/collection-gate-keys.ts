#!/usr/bin/env ts-node
/**
 * Report which collection-gating provider keys THIS process resolves (#1813).
 *
 * Run:
 *   npx ts-node scripts/collection-gate-keys.ts
 *
 * Prints a `key=value` block on stdout — see `renderGateLines` for the fields — and
 * nothing else. Every value is a name (env var, provider id) or a boolean; no key's
 * VALUE is ever read out, so the output is safe in a log that ends up in an issue.
 *
 * WHERE IT HAS TO RUN, AND WHY THAT IS THE WHOLE CONTRACT
 *
 * The answer is a property of one process's environment, so this must run in the SAME
 * shell, with the same working directory, as the `--list` it describes. `.env` is read
 * by `dotenv.config()` relative to `process.cwd()`, exactly as `playwright.config.ts`
 * reads it, so a run from another directory truthfully reports a different environment
 * — the one a listing from THAT directory would have had.
 *
 * Exit codes:
 *   0  a report was produced
 *   2  it could not be — the derivation broke, and a caller must not read that as
 *      "nothing is missing". Same rule as ci-change-coverage and resolve-echo-endpoint:
 *      a check that cannot decide must never look like a check that passed.
 */
import * as dotenv from "dotenv";

import { resolveCollectionGate, renderGateLines } from "./lib/collection-gate-keys";

// The same unconditional call `playwright.config.ts` makes, deliberately without a
// path of its own: reading a DIFFERENT `.env` than the listing would is the one way
// this report can be confidently wrong. It is also why the call is safe next to a
// machine-readable stdout — the config already makes it on every `--list`, whose
// stdout is a contract (#1024), so a dotenv that printed there would have broken the
// daily long before this file existed.
dotenv.config();

function main(): number {
  try {
    for (const line of renderGateLines(resolveCollectionGate(process.env))) {
      console.log(line);
    }
    return 0;
  } catch (err) {
    console.error(
      `[collection-gate] ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
}

if (require.main === module) {
  process.exit(main());
}
