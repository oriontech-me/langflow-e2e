// Unit tests for scripts/lib/outage-overlap.mjs (#1763).
//
// The property under test is not "the numbers are right" but "the three states
// never read alike": `clear` is a measurement, `unmeasured` is the absence of
// one, and an absent block means the lane does not measure at all. Every
// degradation below asserts which of the three it lands in, because the whole
// mechanism exists to stop a wedge-caused failure from reading as a clean one.
import { test } from "node:test";
import assert from "node:assert/strict";

import { attemptKey, loadOutagePayload, overlapForEntry } from "./outage-overlap.mjs";

const SPEC = "tests-automations/regression/i18n/locale-resilience.spec.ts";
const TITLE = "the application boots into a shipped language for every unsupported or regional preference";

/** A payload as `collateralPayload()` writes it, with the fields #1763 added. */
function payloadFile(overrides = {}) {
  return JSON.stringify({
    measured: true,
    wedged: true,
    reportRead: true,
    specMeasured: { [SPEC]: true },
    attempts: [
      { file: SPEC, title: TITLE, retry: 0, shard: "2", coverage: 0.66, downSeconds: 109, shardDownPct: 41.2 },
    ],
    ...overrides,
  });
}

const reader = (text) => () => text;
const throwing = () => {
  throw new Error("ENOENT: no such file or directory, open 'outage-attempts.json'");
};

test("loadOutagePayload names every failure mode instead of swallowing it", () => {
  assert.equal(loadOutagePayload("", reader("{}")).available, false);
  assert.match(loadOutagePayload("", reader("{}")).reason, /no outage-attempts file/);

  const unreadable = loadOutagePayload("outage-attempts.json", throwing);
  assert.equal(unreadable.available, false);
  assert.match(unreadable.reason, /could not be read \(ENOENT/);

  const malformed = loadOutagePayload("f.json", reader('{"measured":true}'));
  assert.equal(malformed.available, false);
  assert.match(malformed.reason, /no `attempts` array/);

  const notJson = loadOutagePayload("f.json", reader("<html>404</html>"));
  assert.equal(notJson.available, false);
  assert.match(notJson.reason, /could not be read/);
});

test("a payload that does not claim BOTH measured and reportRead corroborates nothing", () => {
  // The same guard remove-stable-from-failures.ts carries: today's producer
  // cannot emit attempts without both claims, and a guarantee that holds only
  // because the other side behaves is the shape #1084 was raised about.
  for (const claim of [{ measured: false }, { reportRead: false }]) {
    const p = loadOutagePayload("f.json", reader(payloadFile(claim)));
    assert.equal(p.available, true, "the file itself is still readable");
    assert.equal(p.byKey.size, 0, `attempts must be dropped for ${JSON.stringify(claim)}`);
  }
});

test("an attempt measured deep inside an outage is reported with its fraction", () => {
  const p = loadOutagePayload("f.json", reader(payloadFile()));
  const block = overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, p);
  assert.equal(block.state, "overlapped");
  assert.equal(block.failed_attempts, 1);
  assert.equal(block.min_coverage, 0.66);
  assert.equal(block.max_coverage, 0.66);
  assert.equal(block.shard, "2");
  assert.equal(block.shard_down_pct, 41.2);
  assert.deepEqual(block.attempts, [{ retry: 0, coverage: 0.66, down_seconds: 109 }]);
});

test("min_coverage is the WEAKEST attempt, so one clean attempt cannot be hidden", () => {
  // The rule that consumes this requires EVERY failed attempt to clear the
  // threshold. A test that failed once inside an outage and once while the
  // backend was answering failed on its own the second time, and reporting the
  // maximum would launder that into a fully corroborated collateral failure.
  const p = loadOutagePayload(
    "f.json",
    reader(
      payloadFile({
        attempts: [
          { file: SPEC, title: TITLE, retry: 0, shard: "2", coverage: 0.87, downSeconds: 112, shardDownPct: 41.2 },
        ],
      }),
    ),
  );
  const block = overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0, 1] }, p);
  assert.equal(block.state, "overlapped");
  assert.equal(block.failed_attempts, 2);
  assert.equal(block.min_coverage, 0, "retry 1 is in no window at all");
  assert.equal(block.max_coverage, 0.87);
});

test("measured with no overlap is `clear`; never measured is `unmeasured` WITH a reason", () => {
  const measuredClean = loadOutagePayload("f.json", reader(payloadFile({ attempts: [] })));
  const clear = overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, measuredClean);
  assert.equal(clear.state, "clear");
  assert.equal(clear.min_coverage, 0);
  assert.equal(clear.why, undefined, "a measurement does not need an excuse");
  assert.equal("shard" in clear, false, "no overlapping attempt means no shard is knowable");

  const cases = [
    [{ reportRead: false }, /did not report reading the merged report/],
    [{ measured: false }, /no shard produced liveness probes/],
    [{ specMeasured: {} }, /no shard summary claims this spec/],
    [{ specMeasured: { [SPEC]: false } }, /produced no liveness probes/],
  ];
  for (const [override, why] of cases) {
    const p = loadOutagePayload("f.json", reader(payloadFile(override)));
    const block = overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, p);
    assert.equal(block.state, "unmeasured", `${JSON.stringify(override)} must not read as clear`);
    assert.match(block.why, why);
    assert.equal(block.min_coverage, undefined, "an unmeasured entry has no coverage to report");
  }
});

test("an unavailable payload omits the field entirely rather than recording a clean one", () => {
  const p = loadOutagePayload("", reader("{}"));
  assert.equal(overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, p), null);
  assert.equal(overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, null), null);
});

test("an entry with no failed attempt has no question to answer", () => {
  const p = loadOutagePayload("f.json", reader(payloadFile()));
  assert.equal(overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [] }, p), null);
});

test("the join key is normalised on BOTH sides, so a `tests/` prefix still matches", () => {
  // A near-miss here corroborates nothing, exempts nothing and is invisible —
  // the reason spec-path.mjs exists at all (#1589).
  const p = loadOutagePayload(
    "f.json",
    reader(
      payloadFile({
        specMeasured: { [`tests/${SPEC}`]: true },
        attempts: [
          { file: `./tests/${SPEC}`, title: TITLE, retry: 0, shard: "2", coverage: 0.82, downSeconds: 108, shardDownPct: 41.2 },
        ],
      }),
    ),
  );
  const block = overlapForEntry({ specPath: `tests/${SPEC}`, title: TITLE, failedRetries: [0] }, p);
  assert.equal(block.state, "overlapped");
  assert.equal(block.min_coverage, 0.82);
  assert.equal(attemptKey(`./tests/${SPEC}`, TITLE, 0), attemptKey(SPEC, TITLE, "0"));
});

// ─── The variant is part of the key (#1763, review finding D1) ───────────────

test("one provider variant's outage never corroborates another's failure", () => {
  // A parameterized spec emits one `spec` per provider with the SAME file, the
  // SAME spec.title and the SAME line — the variant lives only in the enclosing
  // describe. Without it in the key, the openai record below answers for google,
  // which failed 28 minutes clear of any window. Five of the 55 committed history
  // rows already carry a duplicate (file, test) pair.
  const p = loadOutagePayload(
    "f.json",
    reader(
      payloadFile({
        attempts: [
          { file: SPEC, title: TITLE, retry: 0, param: "openai / gpt-4o-mini", shard: "2", coverage: 1, downSeconds: 60, shardDownPct: 3.3 },
        ],
      }),
    ),
  );
  const openai = overlapForEntry({ specPath: SPEC, title: TITLE, param: "openai / gpt-4o-mini", failedRetries: [0] }, p);
  const google = overlapForEntry({ specPath: SPEC, title: TITLE, param: "google / gemini-3.5-flash", failedRetries: [0] }, p);
  assert.equal(openai.state, "overlapped");
  assert.equal(openai.min_coverage, 1);
  assert.equal(google.state, "clear", "google failed while the backend was answering");
  assert.equal(google.min_coverage, 0);
});

test("a non-parameterized spec keys on the empty variant on BOTH sides", () => {
  // The overwhelmingly common case must be unaffected: the payload writes
  // `param: null` and the entry passes none.
  const p = loadOutagePayload(
    "f.json",
    reader(payloadFile({ attempts: [{ file: SPEC, title: TITLE, retry: 0, param: null, coverage: 0.7, downSeconds: 70, shard: "2", shardDownPct: 10 }] })),
  );
  assert.equal(overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, p).state, "overlapped");
  assert.equal(attemptKey(SPEC, TITLE, 0), attemptKey(SPEC, TITLE, 0, null));
});

// ─── The state follows the REPORTER, not the rounded coverage (finding D3) ───

test("an attempt the reporter listed is `overlapped` even when its coverage rounds to 0", () => {
  // `overlapsAny` is inclusive at both ends and `round3` floors anything under
  // ~0.05 % of the span. An attempt starting exactly at a window's end is named
  // in the umbrella's "Specs failing inside an outage" list, so calling it
  // `clear` here would make two surfaces built from the same data disagree
  // (#1012) — while the THRESHOLD is what keeps it from exempting anything.
  const p = loadOutagePayload(
    "f.json",
    reader(payloadFile({ attempts: [{ file: SPEC, title: TITLE, retry: 0, coverage: 0, downSeconds: 0, shard: "2", shardDownPct: 12 }] })),
  );
  const block = overlapForEntry({ specPath: SPEC, title: TITLE, failedRetries: [0] }, p);
  assert.equal(block.state, "overlapped", "the reporter counted it as collateral");
  assert.equal(block.min_coverage, 0, "and the coverage still says it is worth nothing as evidence");
  assert.equal(block.shard, "2");
});
