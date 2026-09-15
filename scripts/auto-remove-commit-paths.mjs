#!/usr/bin/env node
/**
 * The staging set of the `@stable` auto-removal commit, and the both-directions
 * check that it actually landed (issue #1822).
 *
 * WHY THIS IS A SCRIPT AND NOT A PATH PREFIX
 *
 * `.github/actions/auto-remove-stable/action.yml` staged one fixed prefix:
 *
 *     git add tests/tests-automations/regression QA-CHECKLIST.md
 *
 * `scripts/remove-stable-from-failures.ts` edits whatever spec the report names,
 * and spec files carrying `@stable` tests live OUTSIDE that prefix: the four
 * `tests/fixtures/*-gate.spec.ts` behavioural gates (27 tests), plus
 * `tests/collect-models.spec.ts` until #1822 took its tag off for reasons of its
 * own. Count them per ref rather than quoting a number — the set moves. An edit
 * to one of them was made in the workspace and then dropped, unstaged, with
 * nothing failing: the step was green because the OTHER file in the same run had
 * something to stage.
 *
 * That is what happened on daily run 34599745145 (2026-09-11). The script's JSON,
 * the commit message and the umbrella issue all said two tests lost the tag;
 * commit `883047fc` carries one. The claim is what is consumed downstream — the
 * umbrella, `create-failure-issue.mjs`, and the triage protocol's closing
 * criterion ("tag absent on `main`") all read the report, none reads the commit —
 * so a test the daily believed it had quarantined kept running and kept failing.
 *
 * So the staging set is DERIVED from what the script reported (`removed[].file`),
 * and no prefix is trusted. Widening the prefix to `git add -A` is not the fix and
 * is called out in the step itself: `results.json`, `payload.json` and
 * `auto-remove-result.json` sit at the repo root and are not git-ignored.
 *
 * VERIFIED IN BOTH DIRECTIONS (#1084's shape)
 *
 * What `verify` compares is FILE-level: the reported path is among the paths the
 * commit changed. It cannot tell "this test's tag was removed" from "this file is
 * in the commit for some other reason", and that limit is stated rather than
 * hidden. It costs nothing today — the only other staged path is QA-CHECKLIST.md,
 * and the remover writes every range of one file in a single `writeFileSync`, so
 * a partial loss WITHIN a file is not a state it can produce. The stronger form
 * (re-parse `git show HEAD:<file>` for the reported titles) is what to reach for
 * if that ever stops being true.
 *
 * Deriving the set is not enough on its own, because the failure mode it fixes was
 * silent: a discarded edit looked exactly like an applied one. `verify` reads the
 * paths the commit actually contains and fails the step naming any reported
 * removal that is not among them. A removal reported and not committed must be a
 * red step, not a green one.
 *
 * Usage:
 *   node scripts/auto-remove-commit-paths.mjs paths  <auto-remove-result.json>
 *       → the paths to stage, NUL-separated, for `git add --pathspec-from-file=-
 *         --pathspec-file-nul`.
 *   node scripts/auto-remove-commit-paths.mjs verify <auto-remove-result.json>
 *       → reads the committed paths on stdin, NUL-separated (`git diff-tree -r
 *         --no-commit-id --name-only -z HEAD`), and fails when one is missing.
 *
 * Exit codes: 0 = ok; 1 = a reported removal is not in the commit (`verify` only);
 * 2 = the report could not be read or does not have the shape this reads. A report
 * this cannot parse must fail the step rather than stage nothing and commit
 * quietly — staging nothing is precisely the defect above (#1012).
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import * as fs from "node:fs";

/** Raised for a report that cannot be turned into a staging set. */
export class UnusableReportError extends Error {}

/**
 * `removed[].file` as `remove-stable-from-failures.ts` writes it:
 * `path.relative(REPO_ROOT, file)`, so repo-relative and `/`-separated.
 *
 * Validated rather than trusted, because every one of these ends up as a git
 * pathspec: an absolute path, a `..` escape or a leading `:` (pathspec magic)
 * would stage something other than the file the report names.
 *
 * The wildcard half is handled by the `:(literal)` prefix `paths` emits rather
 * than by another rejection here, because rejecting `*?[` would refuse a
 * legitimate file name for a risk the prefix removes outright. Measured on git
 * 2.52: `tests/*` through `--pathspec-file-nul` stages every modified file under
 * `tests/` (`--pathspec-file-nul` disables unquoting, NOT wildmatch), while
 * `:(literal)tests/*` is `fatal: … did not match any files`, exit 128 — a widening
 * turned into a loud abort.
 */
function validatePath(raw, index) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UnusableReportError(
      `removed[${index}].file is not a non-empty string (got ${JSON.stringify(raw)})`,
    );
  }
  const file = raw.replace(/\\/g, "/");
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) {
    throw new UnusableReportError(`removed[${index}].file is absolute: ${raw}`);
  }
  if (file.startsWith(":")) {
    throw new UnusableReportError(
      `removed[${index}].file starts with ":", which git would read as pathspec magic: ${raw}`,
    );
  }
  if (file.split("/").some((segment) => segment === "..")) {
    throw new UnusableReportError(
      `removed[${index}].file escapes the repository: ${raw}`,
    );
  }
  return file;
}

/**
 * The spec files the auto-removal edited, deduped and sorted.
 *
 * Sorted for determinism only — `git add` does not care about the order, but a
 * stable one makes the step's log diffable across runs.
 *
 * QA-CHECKLIST.md is deliberately NOT here: it is regenerated by the step rather
 * than reported by the script, it may legitimately produce no diff, and it stays
 * an explicit `git add` in the step. This function answers exactly one question —
 * which paths did the script say it edited.
 */
export function stagingPaths(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new UnusableReportError("the report is not a JSON object");
  }
  const { removed } = result;
  if (!Array.isArray(removed)) {
    throw new UnusableReportError("the report has no `removed` array");
  }
  const files = removed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UnusableReportError(`removed[${index}] is not an object`);
    }
    return validatePath(entry.file, index);
  });
  return [...new Set(files)].sort();
}

/**
 * The reported removals that are NOT in the commit — the whole point of the
 * second direction. `committed` is what git listed for the commit, so the
 * comparison is between two repo-relative spellings of the same tree.
 */
export function missingFromCommit(result, committed) {
  const staged = new Set(committed.map((p) => p.replace(/\\/g, "/")));
  return stagingPaths(result).filter((file) => !staged.has(file));
}

/**
 * Splits git's `-z` stream: NUL-terminated entries, trailing NUL tolerated.
 *
 * NUL and nothing else. An earlier version also split on `\n` and trimmed each
 * entry, which contradicted the very protocol this exists to consume — a newline
 * and a leading space are both legal in a path, so that version corrupted exactly
 * the names `-z` is used to carry, and reported the result as a removal the commit
 * did not contain. A caller that pipes a non-`-z` listing here now gets one long
 * entry, every reported path counted as missing, and a failed step: fail-closed,
 * which is the direction this guard has to err.
 */
export function splitNulList(text) {
  return text.split("\0").filter((entry) => entry !== "");
}

function readReport(path) {
  if (!path) throw new UnusableReportError("no report path given");
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    throw new UnusableReportError(`could not read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UnusableReportError(`malformed ${path}: ${error.message}`);
  }
}

export function main(argv, stdin = "") {
  const [mode, reportPath] = argv.slice(2);
  if (mode !== "paths" && mode !== "verify") {
    process.stderr.write(
      `::error::auto-remove-commit-paths: unknown mode ${JSON.stringify(mode ?? "")} — expected "paths" or "verify"\n`,
    );
    return 2;
  }

  let report;
  try {
    report = readReport(reportPath);
  } catch (error) {
    process.stderr.write(
      `::error::auto-remove-commit-paths: ${error.message}. The @stable removals it reported cannot be staged, so nothing is committed (#1822).\n`,
    );
    return 2;
  }

  if (mode === "paths") {
    let paths;
    try {
      paths = stagingPaths(report);
    } catch (error) {
      process.stderr.write(`::error::auto-remove-commit-paths: ${error.message}\n`);
      return 2;
    }
    // NUL-separated and `:(literal)`-prefixed, for `git add
    // --pathspec-from-file=- --pathspec-file-nul`: the prefix is what makes each
    // entry mean the file it names and nothing else (see validatePath).
    //
    // Nothing but NULs separates them. A trailing newline is not the catastrophe
    // an earlier version of this comment claimed — measured on git 2.52, both
    // `x\0\0` and `x\0\n` abort with `fatal: empty string is not a valid
    // pathspec` / `fatal: pathspec '<LF>' did not match any files`, exit 128,
    // never a silent `git add -A`. It is still wrong, and loudly: it would abort
    // the commit of a removal that was correctly made.
    process.stdout.write(paths.map((p) => `:(literal)${p}\0`).join(""));
    return 0;
  }

  let missing;
  try {
    missing = missingFromCommit(report, splitNulList(stdin));
  } catch (error) {
    process.stderr.write(`::error::auto-remove-commit-paths: ${error.message}\n`);
    return 2;
  }
  if (missing.length > 0) {
    process.stderr.write(
      `::error::The @stable auto-removal reported ${missing.length} removal(s) that the commit does not contain: ` +
        `${missing.join(", ")}. Nothing was pushed. The report is what the umbrella issue, ` +
        `create-failure-issue.mjs and the triage closing criterion read, so a removal that does not ` +
        `reach main must fail this step rather than be reported as done (#1822).\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("auto-remove-commit-paths.mjs")) {
  const stdin =
    process.argv[2] === "verify" && !process.stdin.isTTY
      ? fs.readFileSync(0, "utf8")
      : "";
  // `process.exitCode`, never `process.exit()`: a piped stdout is flushed
  // asynchronously and `exit` discards whatever has not been written yet.
  process.exitCode = main(process.argv, stdin);
}
