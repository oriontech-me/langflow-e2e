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
// what three healthy shards resolved — is NOT documented, in either direction,
// and the evidence says it does not happen: the runner appears to skip an empty
// output from a matrix leg (community discussion #38088, the behaviour the
// conditional-matrix-output idiom depends on), and of the 11 rows in
// `reports/daily-history.jsonl` carrying a version, EIGHT are `backend.wedged`
// days and not one is null. Treat the erasure as refuted, not as the motive.
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
  return { version, reason: null };
}

// GitHub's own ceiling: "A matrix will generate a maximum of 256 jobs per
// workflow run." An expectation above it cannot describe a real run, and honouring
// it materialises one entry per expected shard — `--expect-shards 1e9` threw
// `RangeError: Set maximum size exceeded` out of a CLI whose header promises the
// only non-zero exit is a usage error (measured). Refused and REPORTED, never
// silently dropped: an expectation the sweep ignored changes what its counts mean.
const MAX_EXPECTED_SHARDS = 256;

function normalizeExpected(expectShards) {
  if (expectShards === null || expectShards === undefined || `${expectShards}`.trim() === "")
    return { value: null, reason: null };
  const n = Number(expectShards);
  if (!Number.isInteger(n) || n < 1)
    return { value: null, reason: `the expected shard count ${JSON.stringify(String(expectShards))} is not a positive integer — the sweep reports only the files it found` };
  if (n > MAX_EXPECTED_SHARDS)
    return { value: null, reason: `the expected shard count ${n} is above GitHub's ${MAX_EXPECTED_SHARDS}-job matrix cap, so it cannot describe a real run — the sweep reports only the files it found` };
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
  if (
    verdict.version &&
    !verdict.disagreement &&
    verdict.unanswered.length === 0 &&
    !verdict.expectedIgnored
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
  if (verdict.directoryReason) lines.push(`- directory: ${verdict.directoryReason}`);
  for (const { shard, reason } of verdict.unanswered) lines.push(`- shard ${shard}: ${reason}`);
  for (const { shard, version } of verdict.answered) lines.push(`- shard ${shard}: \`${version}\``);
  return `${lines.join("\n")}\n`;
}
