// Resolve the Langflow version that ACTUALLY SERVED a sharded run, by sweeping
// every shard's own answer instead of trusting one of them (#1731).
//
// WHY THIS EXISTS. `langflow_version` rides on the `daily-history.jsonl` row and
// `scripts/compare-lane-verdicts.mjs` BLOCKS a two-lane comparison when the two
// rows disagree about it — a guarantee worth exactly what the value is worth. On
// the Actions side the value was an output of the 4-way `test` matrix, resolved
// per shard against that shard's own service container, best-effort.
//
// WHAT WAS ACTUALLY WRONG WITH THAT, stated carefully, because #1731 and the
// first version of this module both overstated it. GitHub documents exactly one
// thing about matrix outputs: *"Actions does not guarantee the order that matrix
// jobs will run in. Ensure that the output name is unique, otherwise the last
// matrix job that runs will override the output value."* So the row carried
// whichever shard finished last — by documentation, non-deterministic.
//
// The issue's headline harm — a WEDGED shard writing an empty value and erasing
// what three healthy shards resolved — is NOT DEMONSTRATED, and is not the
// motive. GitHub documents nothing about an empty output, in either direction.
// The only evidence for the mechanism is a forum post (community discussion
// #38088: *"Empty job outputs of matrix legs are skipped"*, the behaviour the
// conditional-matrix-output idiom depends on). And this repo's own series cannot
// settle it either way, which a first correction of this comment got wrong by
// treating it as refutation: of the 11 rows in `reports/daily-history.jsonl`
// carrying a version, EIGHT are `backend.wedged` days and not one is null — but
// nothing ever recorded a per-shard curl OUTCOME, so those rows are equally
// consistent with "no shard's curl ever failed". On 4 of those 8 days the whole
// run's measured downtime was 6-32 s and the curl ran at the END of the shard.
// The honest reading is that the erasure has never been observed here and the
// fix does not rest on it.
//
// What is left is motive enough, and all of it is observable:
//   - the pick was non-deterministic exactly where it matters — four shards pull
//     `:latest` independently, so a nightly published mid-run really can leave
//     two shards on two products, and the row then named whichever finished last
//     while nothing recorded that the run straddled two;
//   - a `null` could only mean "every shard failed", and it said so nowhere: no
//     count, no reason, no shard named. Unknown that cannot say why is the shape
//     #1012 rules out;
//   - the guarantee that a wedged shard does NOT erase the value rests on runner
//     behaviour GitHub documents nowhere, for the one field that gates the
//     comparison;
//   - and the two lanes resolved one field into one series two different ways.
//
// WHY NOT RESOLVE IT ONCE, UP FRONT, FROM THE PUBLISHED IMAGE. Because that
// answers a different question. `scripts/resolve-target-version.mjs` says which
// Langflow a lane SHOULD be testing; this says which one ANSWERED. The mid-run
// publish above is precisely the case where the two differ, and it is the case
// only a sweep can see. The VM lane already keeps both: an expected version
// (`langflow_version_resolution` / `langflow_version_match`) and a served one.
//
// THREE STATES, NEVER TWO. A version, or no version WITH the reason each shard
// could not give one, or a directory that could not be read at all.
//
// Both lanes read this one module — `daily-stable.yml`'s merge job over the
// per-shard token artifacts, and `scripts/run-e2e.sh` over its own run dir — for
// the reason #1731 was raised: two lanes writing the same field to the same
// series should not have different odds of writing it at all, and two
// implementations of "sweep the shards" is how that comes back.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The name both lanes write, and the only one this module reads. */
export const versionFileName = (shard) => `version-${shard}.json`;

// 1-based and without leading zeros, because that is what both lanes write
// (`matrix.shard`, `$idx`). It keeps `version-0.json` from being pickable and
// `version-01.json` from colliding with shard 1 in the map below — neither is a
// file either lane can produce, and both would answer silently.
const VERSION_FILE_RE = /^version-([1-9]\d*)\.json$/;

const NO_FILE =
  "no file — the shard wrote none (it never reached the step), or its artifact never arrived";

/**
 * The first non-blank line of a thrown value, capped.
 *
 * Tolerant of a non-`Error` throw on purpose: `Error.message` is a plain own
 * property, so a thrown object can carry anything there, and this runs inside the
 * one helper whose job is to keep a failure legible (`tests/fixtures/http-error-body.ts`
 * records the same trap one layer up).
 */
function firstLine(value) {
  const raw =
    value && typeof value === "object" && "message" in value ? value.message : value;
  const text = typeof raw === "string" ? raw : String(raw);
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 200);
}

/**
 * Read every `version-<shard>.json` in `dir`, in ascending shard order.
 *
 * The glob lives HERE and not in the caller's shell, so "one file of four", "an
 * empty directory" and "no directory at all" are three assertable states rather
 * than one silent one (the lesson `lane-coverage-verdict.mjs --providers-dir`
 * records). `readdir`/`readFile` are injectable so the module stays unit-testable
 * without a fixture tree; the CLI passes none and gets `node:fs`.
 */
export function readVersionDir(dir, io = {}) {
  const readdir = io.readdir ?? readdirSync;
  const readFile = io.readFile ?? readFileSync;
  if (!dir) return { available: false, reason: "no directory was given", files: [] };
  let names;
  try {
    names = readdir(dir);
  } catch (err) {
    return {
      available: false,
      reason: `the directory could not be read (${firstLine(err)})`,
      files: [],
    };
  }
  const files = [];
  for (const name of names) {
    const match = VERSION_FILE_RE.exec(String(name));
    if (!match) continue;
    const shard = Number(match[1]);
    try {
      files.push({ shard, name: String(name), raw: readFile(join(dir, String(name)), "utf8") });
    } catch (err) {
      files.push({ shard, name: String(name), raw: null, error: `the file could not be read (${firstLine(err)})` });
    }
  }
  files.sort((a, b) => a.shard - b.shard);
  return { available: true, reason: null, files };
}

/**
 * The raw `GET /api/v1/version` body a shard captured → a version, or a reason.
 *
 * A body that is not one line is REFUSED rather than trimmed into shape: the
 * value is emitted as `key=value` into `$GITHUB_OUTPUT`, where an embedded
 * newline stops being a value and becomes another key. The shell this replaces
 * spelled that guarantee as `tr -d '\r\n'`, where nothing could test it.
 */
export function parseVersionBody(raw) {
  if (raw == null) return { version: null, reason: "nothing was captured" };
  const text = String(raw).trim();
  if (text === "")
    return {
      version: null,
      reason: "the captured body is empty — the backend answered nothing",
    };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: null, reason: "the captured body is not JSON" };
  }
  const value = parsed && typeof parsed === "object" ? parsed.version : undefined;
  if (typeof value !== "string" || value.trim() === "")
    return { version: null, reason: "the captured body carries no `version` field" };
  const version = value.trim();
  if (/[\r\n]/.test(version))
    return { version: null, reason: "the `version` field is not a single line" };
  // A COMMA is refused for the same reason and one layer further out: the distinct
  // versions travel to the history row as `versions=a,b` and the appender re-splits on
  // the comma (#1964), so a version containing one arrives as two — which `sweepOf`
  // then reads as a duplicate and reports UNREADABLE instead of naming the straddle it
  // is looking at. No `/api/v1/version` body has ever carried one; refusing it here is
  // what keeps that a fact about the carrier rather than a hope.
  if (version.includes(","))
    return { version: null, reason: "the `version` field carries a comma, which is the list separator" };
  return { version, reason: null };
}

// GitHub's own ceiling: "A matrix will generate a maximum of 256 jobs per
// workflow run." An expectation above it cannot describe a real run, and honouring
// it materialises one entry per expected shard — `--expect-shards 1e9` threw
// `RangeError: Set maximum size exceeded` out of a CLI whose header promises the
// only non-zero exit is a usage error (measured, on a value above ~2^24).
//
// The cap is REACHABLE, and an earlier version of this comment argued the opposite
// from a mechanism that does not hold: `prep` will happily print `shard_total=300`
// — `buildShards` partitions today's files into 300 bins in milliseconds — and
// `merge` reads it whatever the `test` job did, being `needs: [prep, test]` with
// `if: always()`. What refuses a 300-job matrix is GitHub, at the `test` job, not
// anything here. So a dispatch with `shards: 300` really does hand this reader an
// expectation that cannot describe a run, and the cap turns it into a reported
// refusal instead of a count that lies. It REPORTS rather than silently dropping,
// since an expectation the sweep ignored changes what every count means.
const MAX_EXPECTED_SHARDS = 256;

const IGNORED_TAIL = "the sweep reports only the files it found";

/** How long any echoed value may render. `firstLine`'s cap, for the same reason. */
const MAX_SHOWN = 200;

/**
 * Name the offending value in a message: short, balanced, and TOTAL.
 *
 * Total by construction rather than by `try`/`catch`, which is the correction worth
 * carrying. The first version stringified whatever it was handed and caught the
 * throw — `JSON.stringify` rejects a BigInt and a circular object — and the second
 * capped the result. Both were branch-local, and review measured all three leaks:
 * an object capped AFTER stringifying rendered `{"a":"xxx…` with an odd number of
 * quotes (the exact defect the cap was added to fix), a 400-digit input rendered as
 * a complete-looking 200-digit number, and 200 control characters rendered a
 * 1293-character line because the cap was on the INPUT, not the output.
 *
 * So nothing arbitrary is stringified at all. A string is quoted and capped, with
 * the quoting checked after the fact; anything longer is described by its size; and
 * a structured value is named by its `typeof`, which is all any caller needs — the
 * CLI only ever passes an argv string, and a JS caller that passed an object learns
 * that it did.
 */
function describeValue(value) {
  if (typeof value === "string") {
    const quoted = JSON.stringify(
      value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}…` : value
    );
    // Escaping can multiply the length sixfold (`\u0001` per control character), so
    // the check is on what will actually be PRINTED.
    return quoted.length <= MAX_SHOWN ? quoted : `a ${value.length}-character string`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const text = String(value);
    return text.length <= MAX_SHOWN ? text : `a ${text.length}-digit number`;
  }
  return typeof value;
}

const refuse = (shown) => ({
  value: null,
  reason: `the expected shard count ${describeValue(shown)} cannot describe a run — ${IGNORED_TAIL}`,
});

function normalizeExpected(expectShards) {
  // Only a string or a number is an expectation at all. Without this, `[]`
  // stringifies to "" and reads as "no expectation was given", which is the one
  // state this pair exists to keep apart from "an expectation was refused".
  if (typeof expectShards !== "string" && typeof expectShards !== "number")
    return expectShards === null || expectShards === undefined
      ? { value: null, reason: null }
      : refuse(expectShards);
  const text = `${expectShards}`.trim();
  if (text === "") return { value: null, reason: null };
  // DECIMAL DIGITS ONLY, which is exactly what both lanes produce (`matrix.shard`
  // from partition-shards' `i + 1`, `$idx` from `seq 1 "$SHARD_TOTAL"`). `Number`
  // alone silently reinterpreted `0x10` as 16 and `4.0`/`+4` as 4 — an input nobody
  // meant, honoured without a word. Leading zeros still pass (`04` is 4), because
  // `\d+` accepts them and they are unambiguous; an earlier version of this comment
  // listed `04` among the refusals, which the regex never did.
  if (!/^\d+$/.test(text)) return refuse(text);
  const n = Number(text);
  if (n < 1) return refuse(text);
  if (n > MAX_EXPECTED_SHARDS)
    return {
      value: null,
      // `describeValue(text)`, not `${n}`: a 400-digit argument passes the digit
      // test and `Number` turns it into `Infinity`, so the message named a value
      // nobody passed (found in review) — and `describeValue` then names it by its
      // size rather than printing 200 of its digits, which reads just as false.
      reason: `the expected shard count ${describeValue(text)} is above GitHub's ${MAX_EXPECTED_SHARDS}-job matrix cap, so it cannot describe a real run — ${IGNORED_TAIL}`,
    };
  return { value: n, reason: null };
}

/**
 * The verdict: which version served, which shard said so, and — for every shard
 * that did not — why.
 *
 * The pick is the LOWEST shard index that answered, so the same run resolves the
 * same way twice. `expectShards` only widens the sweep: a file whose index sits
 * outside the expected range still answers, because an expectation that is wrong
 * must not silently drop the evidence it failed to predict.
 */
export function resolveServedVersion(read, { expectShards = null } = {}) {
  const { value: expected, reason: expectedIgnored } = normalizeExpected(expectShards);
  const files = read && Array.isArray(read.files) ? read.files : [];
  const seen = new Map(files.map((f) => [f.shard, f]));

  const shards = new Set();
  if (expected) for (let i = 1; i <= expected; i++) shards.add(i);
  for (const shard of seen.keys()) shards.add(shard);
  const ordered = [...shards].sort((a, b) => a - b);

  const answered = [];
  const unanswered = [];
  const unexpected = [];
  for (const shard of ordered) {
    if (expected && (shard < 1 || shard > expected) && seen.has(shard)) unexpected.push(shard);
    const file = seen.get(shard);
    if (!file) {
      unanswered.push({
        shard,
        reason: read && read.available === false ? read.reason : NO_FILE,
      });
      continue;
    }
    if (file.error) {
      unanswered.push({ shard, reason: file.error });
      continue;
    }
    const { version, reason } = parseVersionBody(file.raw);
    if (version) answered.push({ shard, version });
    else unanswered.push({ shard, reason });
  }

  const versions = [...new Set(answered.map((a) => a.version))];
  const pick = answered[0] ?? null;
  return {
    version: pick ? pick.version : null,
    source: pick ? pick.shard : null,
    answered,
    unanswered,
    unexpected,
    versions,
    disagreement: versions.length > 1,
    expected,
    expectedIgnored,
    directoryAvailable: !read || read.available !== false,
    directoryReason: read && read.available === false ? read.reason : null,
  };
}

/** One line, always printed — the resolution, or the fact that there is none. */
export function summaryLine(verdict) {
  // The denominator is what the sweep reasoned about — every expected shard plus
  // any file outside that range — never `expected` alone, which printed "3/2".
  const total = verdict.answered.length + verdict.unanswered.length;
  // Without an expectation the sweep has no idea how many shards the run had, so
  // it does not print a ratio that reads like one (the per-shard call, #1731 review).
  const scope = !total
    ? "no shard answered"
    : verdict.expected === null
      ? `${verdict.answered.length} answer(s) found`
      : `${verdict.answered.length}/${total} shard(s) answered`;
  if (!verdict.version) return `Langflow version: UNRESOLVED — ${scope}`;
  return `Langflow version: ${verdict.version} (from shard ${verdict.source}; ${scope})`;
}

/** The whole report: the line above, then every shard that could not answer. */
export function renderReport(verdict) {
  const lines = [summaryLine(verdict)];
  if (verdict.expectedIgnored) lines.push(`  IGNORED: ${verdict.expectedIgnored}`);
  if (verdict.directoryReason) lines.push(`  directory: ${verdict.directoryReason}`);
  for (const { shard, reason } of verdict.unanswered) lines.push(`  shard ${shard}: ${reason}`);
  if (verdict.disagreement)
    lines.push(
      `  DISAGREEMENT: the shards served ${verdict.versions.join(", ")} — ` +
        `the run tested more than one product, and this row names only the first.`
    );
  if (verdict.unexpected.length)
    lines.push(
      `  note: shard ${verdict.unexpected.join(", ")} reported although the run expected ` +
        `${verdict.expected} — counted anyway, but the expectation and the matrix disagree.`
    );
  return lines.join("\n");
}

/**
 * `$GITHUB_OUTPUT` lines. Emitted from HERE and asserted on this output, never
 * spelled in a workflow's `run:` — a `node -e` in the YAML is where a mutation
 * survives the whole unit suite (#1812's own finding, in the code written for it).
 *
 * Four of the six now have a consumer. `version` rides the history row alone, and
 * `expected`, `answered` and `versions` ride it together as `langflow_version_sweep`
 * (#1964), which is what lets `compare-lane-verdicts.mjs` stop reading two equal
 * single versions as proof the lanes tested the same product. `source` and
 * `disagreement` remain diagnostic, for a human reading a step's outputs — the
 * comparator derives the straddle from `versions` itself rather than trusting a
 * boolean it cannot recompute.
 *
 * One consequence is now CARRIED into that series rather than merely printed here:
 * `expected=` is empty both when no expectation was given and when one was refused,
 * a distinction the report and the run-summary block draw and the row does not.
 * `reports/README.md` discloses it on the field.
 */
export function outputLines(verdict) {
  return [
    `version=${verdict.version ?? ""}`,
    `source=${verdict.source ?? ""}`,
    `answered=${verdict.answered.length}`,
    `expected=${verdict.expected ?? ""}`,
    `disagreement=${verdict.disagreement ? "true" : "false"}`,
    `versions=${verdict.versions.join(",")}`,
  ];
}

/**
 * A run-summary block, or `null` when there is nothing a reader needs to know.
 *
 * A fully-answered, unanimous sweep says nothing: the version is already on the
 * history row and in the step log, and a block printed every day is a block
 * nobody reads by the time it matters (`mode=count`, #1252).
 */
export function stepSummaryMarkdown(verdict) {
  // Every anomaly the verdict can carry has to be on this list, or it reaches
  // stdout only — and the run log is not a surface anybody comes back to. An
  // out-of-range shard file means `prep`'s count and the matrix disagree, which
  // is exactly the kind of thing that must not be stdout-only (#1012).
  if (
    verdict.version &&
    !verdict.disagreement &&
    verdict.unanswered.length === 0 &&
    !verdict.expectedIgnored &&
    verdict.unexpected.length === 0
  )
    return null;
  const lines = ["### Langflow version", "", summaryLine(verdict), ""];
  if (!verdict.version)
    lines.push(
      "No shard reported a served version, so the run's history row carries `null` and a " +
        "two-lane comparison cannot verify that both lanes tested the same Langflow.",
      ""
    );
  if (verdict.disagreement)
    lines.push(
      `**The shards did not agree:** ${verdict.versions.join(", ")}. One nightly was published ` +
        "mid-run, or the shards did not pull the same image.",
      ""
    );
  if (verdict.expectedIgnored) lines.push(`- ${verdict.expectedIgnored}`);
  if (verdict.unexpected.length)
    lines.push(
      `- shard ${verdict.unexpected.join(", ")} reported although the run expected ` +
        `${verdict.expected} — counted anyway, but the expectation and the matrix disagree.`
    );
  if (verdict.directoryReason) lines.push(`- directory: ${verdict.directoryReason}`);
  for (const { shard, reason } of verdict.unanswered) lines.push(`- shard ${shard}: ${reason}`);
  for (const { shard, version } of verdict.answered) lines.push(`- shard ${shard}: \`${version}\``);
  return `${lines.join("\n")}\n`;
}
