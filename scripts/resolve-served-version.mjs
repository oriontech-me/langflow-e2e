#!/usr/bin/env node
// Print the Langflow version that served a sharded run, swept from every shard's
// own answer (#1731). See scripts/lib/served-version.mjs for why the sweep exists
// and why the published image is not the answer to this question.
//
// Usage:
//   node scripts/resolve-served-version.mjs --dir <dir> [--expect-shards N] [--json]
//
//   --dir           directory holding `version-<shard>.json` — the RAW body of
//                   `GET /api/v1/version` as that shard's backend answered it
//   --expect-shards how many shards the run had; a shard that left no file is then
//                   reported as unanswered instead of vanishing from the count
//   --json          the whole verdict, for a caller that wants more than the line
//   --quiet         the report on stdout and nothing else: no $GITHUB_OUTPUT, no
//                   run-summary block, no annotation. For the per-shard call,
//                   which reads ONE file and must not speak for the run
//
//   $GITHUB_OUTPUT       when set, receives `version=`, `source=`, `answered=`,
//                        `expected=`, `disagreement=`, `versions=`
//   $GITHUB_STEP_SUMMARY when set, receives a block ONLY when the sweep has
//                        something to say (unresolved, partial, or disagreeing)
//
// REPORT-ONLY, by design: it exits 0 whether or not a version resolved. The
// consumer that acts on the absence is `compare-lane-verdicts.mjs`, which already
// degrades a missing version to `version parity UNVERIFIED` and says so. Failing
// the day over a diagnostic it can state honestly is #980's trade inverted. The
// only non-zero exit is a USAGE error, where the caller asked something this
// script cannot answer at all — a promise that has to hold against the whole
// input surface, so an unwritable $GITHUB_OUTPUT and an absurd --expect-shards
// are both reported rather than thrown (both were exit 1 with a stack trace in
// the first version; found in review).
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  readVersionDir,
  renderReport,
  resolveServedVersion,
  outputLines,
  stepSummaryMarkdown,
} from "./lib/served-version.mjs";

const USAGE = `usage: resolve-served-version.mjs --dir <dir> [--expect-shards N] [--json]`;

export function parseArgs(argv) {
  const args = { dir: null, expectShards: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
      case "--expect-shards": {
        // A flag with no following argument is a usage error; a flag given an
        // EMPTY value degrades (an unset workflow variable expands to one, and
        // that must not abort the step that carries it — #1812).
        if (i + 1 >= argv.length) return { error: `${arg} needs a value` };
        const value = argv[++i];
        if (arg === "--dir") args.dir = value;
        else args.expectShards = value;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        return { help: true };
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }
  if (!args.dir) return { error: "--dir is required" };
  return { args };
}

function appendOrReport(file, text, what) {
  try {
    fs.appendFileSync(file, text);
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? err.message : err;
    process.stderr.write(
      `::warning::resolve-served-version: the ${what} could not be written to ${file} ` +
        `(${String(message).split("\n")[0].slice(0, 200)}) — the report above is the only copy\n`
    );
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`resolve-served-version: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { args } = parsed;

  const verdict = resolveServedVersion(readVersionDir(args.dir), {
    expectShards: args.expectShards,
  });

  process.stdout.write(
    args.json ? `${JSON.stringify(verdict, null, 2)}\n` : `${renderReport(verdict)}\n`
  );

  // `--quiet` stops here: the shard that captured ONE file would otherwise emit a
  // run-level verdict ("no shard reported…") about a directory holding a single
  // shard's answer, and a surface that overstates its scope is worse than none.
  if (args.quiet) return 0;

  // Both appends are guarded for the same reason: the REPORT is already on
  // stdout by now, so a file that cannot be written costs one surface, and
  // throwing here would cost the step instead — plus the `version=` line the
  // consumer reads, which is the value this whole script exists to carry.
  if (process.env.GITHUB_OUTPUT) {
    appendOrReport(process.env.GITHUB_OUTPUT, `${outputLines(verdict).join("\n")}\n`, "outputs");
  }
  const summary = stepSummaryMarkdown(verdict);
  if (summary && process.env.GITHUB_STEP_SUMMARY) {
    appendOrReport(process.env.GITHUB_STEP_SUMMARY, summary, "run summary");
  }

  // An annotation only where a reader has to act: a row that will carry `null`,
  // or a run that tested two products. A fully-answered sweep is silent.
  if (!verdict.version) {
    process.stderr.write(
      `::warning::resolve-served-version: no shard reported a served Langflow version — ` +
        `this run's history row carries null, and a two-lane comparison cannot verify ` +
        `that both lanes tested the same product\n`
    );
  } else if (verdict.disagreement) {
    process.stderr.write(
      `::warning::resolve-served-version: the shards served ${verdict.versions.join(", ")} — ` +
        `the run did not test one product\n`
    );
  }
  return 0;
}

// `process.exitCode`, never `process.exit()`: a piped stdout is truncated at 8192
// bytes by an immediate exit, because pipe writes are async and what has not
// flushed is discarded (measured, #1812).
// `pathToFileURL`, not a `file://` template: a repo path carrying a space or a
// non-ASCII character is percent-encoded in `import.meta.url` and not in
// `process.argv[1]`, so the naive comparison fails and the CLI exits 0 having
// printed nothing — a null with no diagnostic, which is what this module exists
// to prevent. Eight scripts here already spell it this way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
