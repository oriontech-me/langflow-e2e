// Compare one day's verdict from the two lanes that run the same @stable suite:
// the Actions daily and the VM daily. Pure functions; the CLI is
// scripts/compare-lane-verdicts.mjs.
//
// ## Why this reads daily-history.jsonl and nothing else
//
// Both lanes already write one line per run to the same series through
// scripts/append-weekly-history.mjs, distinguished by `workflow`. That line carries
// the totals AND the per-test failure list with file, title, tags, attempts and
// error signature. So a day's comparison is a diff of two rows in one file - no
// artifact download, no API call, nothing that expires after seven days.
//
// ## The limit of that substrate, stated because it decides how to read the output
//
// A history row names the tests that FAILED or went FLAKY. It does not name the ones
// that passed, and it does not name the ones that were SKIPPED. So:
//
//   - a divergence where one lane fails and the other does not IS visible, which is
//     the case step 14 exists to collect;
//   - a test SKIPPED on one lane and PASSED on the other is INVISIBLE here - the two
//     rows look identical. That is not hypothetical: the VM has no Google, Groq,
//     Mistral or Azure key, so those specs skip there and run in Actions.
//
// The only signal the substrate offers for that class is the `skipped` count, so a
// difference in it is reported as a WARNING that narrows the comparison, never
// swallowed. A comparator that printed "no divergences" while the two lanes ran
// different test sets would be worse than no comparator at all.
//
// ## Blocker vs warning
//
// A BLOCKER means the two rows cannot be compared at all and the divergence list
// below it would be fiction: a lane missing for the day, a lane that reported
// top-level run errors (globalSetup died, so its verdict is not a verdict), or two
// different Langflow versions - which turns the list into the product's changelog,
// the exact failure step 14 is built to avoid. That last one has a per-invocation
// escape hatch (`allowVersionMismatch`), because the day it fires is often a day
// somebody wants to look at; taking it STAMPS the result and the report rather than
// quietly softening the blocker into a warning.
//
// A WARNING means the comparison stands but is narrower than it looks.

export const DEFAULT_CI_WORKFLOW = "daily-stable";
export const DEFAULT_VM_WORKFLOW = "daily-stable-vm";

/** Parse a JSONL history file. Unreadable lines are reported, never skipped in silence. */
export function parseHistory(text) {
  const entries = [];
  const bad = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      bad.push({ line: i + 1, reason: err.message });
    }
  }
  return { entries, bad };
}

/**
 * The identity of a test across the two lanes: file + title + parameterization.
 *
 * LINE IS DELIBERATELY EXCLUDED. The lanes can be one commit apart - the VM pulls
 * through the mirror - and an unrelated edit above a spec shifts every line below it.
 * Keying on line would then report a whole file as "failing only on the VM" while
 * both lanes failed the same test.
 */
export function testKey(entry) {
  // The separator is written as an ESCAPE, not as the literal control character it
  // used to be. The behaviour is the same; what changes is that the source now shows
  // it. Two reviewers spent time on that byte -- one cleared it after checking, one
  // read the rendered diff, saw `join("")` and filed a collision that does not exist.
  // A separator nobody can see is a separator nobody can verify.
  //
  // It has to be SOME separator: joined with nothing, a test "runs agent" with no
  // param and a test "runs" with param "agent" in one file key identically, and
  // `indexOutcomes` would overwrite one with the other -- reporting a genuine
  // one-sided failure as agreement.
  return [entry?.file ?? "", entry?.test ?? "", entry?.param ?? ""].join("\u0001");
}

/** Human-facing name for a keyed test. */
export function describeTest(entry) {
  const param = entry?.param ? ` [${entry.param}]` : "";
  return `${entry?.file ?? "<no file>"} :: ${entry?.test ?? "<no title>"}${param}`;
}

/**
 * Merge several history files into one entry list.
 *
 * THE TWO LANES DO NOT SHARE A FILE, and assuming they did was a real defect.
 * `reports/daily-history.jsonl` is tracked and the Actions daily commits its row back
 * to main every morning; the VM writes to a ledger OUTSIDE the clone, because a line
 * written into the tracked file would leave the tree dirty and break the wrapper's
 * next `git pull --ff-only`. `ledger_seed()` copies the tracked file into the ledger
 * EXACTLY ONCE (`if [ -e "$ledger" ]; then return 0`), so the ledger is a superset for
 * one moment and drifts apart forever after: Actions rows frozen at seed time, VM rows
 * accumulating.
 *
 * Read either file alone and no recent day has both lanes. The comparator would then
 * either block claiming "the Actions lane has nothing to compare against" on a morning
 * Actions ran perfectly, or -- worse -- find the seed day, compare it, and exit 0 with
 * a confident verdict about a week-old day.
 *
 * Rows are deduplicated on `workflow|date|run_id`, because the seeded copy and the
 * tracked original are the same row: without it every seeded day would report "more
 * than one row for this date".
 */
export function mergeEntries(sources) {
  const byKey = new Map();
  for (const { entries = [] } of sources) {
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      byKey.set(`${e.workflow ?? ""}|${e.date ?? ""}|${e.run_id ?? ""}`, e);
    }
  }
  return [...byKey.values()];
}

/**
 * Pick the two rows for a date. Later rows win: a lane re-run on the same day appends
 * again, and the last append is the one that describes the run that finished.
 */
export function selectRuns(entries, { date, ciWorkflow = DEFAULT_CI_WORKFLOW, vmWorkflow = DEFAULT_VM_WORKFLOW } = {}) {
  const byDate = new Map();
  for (const e of entries) {
    if (!e || typeof e !== "object" || !e.date) continue;
    if (e.workflow !== ciWorkflow && e.workflow !== vmWorkflow) continue;
    const slot = byDate.get(e.date) ?? { ci: [], vm: [] };
    (e.workflow === ciWorkflow ? slot.ci : slot.vm).push(e);
    byDate.set(e.date, slot);
  }

  let chosen = date;
  if (!chosen) {
    const bothLanes = [...byDate.entries()]
      .filter(([, s]) => s.ci.length && s.vm.length)
      .map(([d]) => d)
      .sort();
    chosen = bothLanes.at(-1) ?? [...byDate.keys()].sort().at(-1) ?? null;
  }
  const slot = byDate.get(chosen) ?? { ci: [], vm: [] };
  return {
    date: chosen,
    ci: slot.ci.at(-1) ?? null,
    vm: slot.vm.at(-1) ?? null,
    ciExtra: Math.max(0, slot.ci.length - 1),
    vmExtra: Math.max(0, slot.vm.length - 1),
    datesAvailable: [...byDate.keys()].sort(),
  };
}

/** Map a row's failures and flakes to `key -> {status, entry}`. A test in both wins as failed. */
export function indexOutcomes(row) {
  const out = new Map();
  for (const e of row?.flaky ?? []) out.set(testKey(e), { status: "flaky", entry: e });
  for (const e of row?.failures ?? []) out.set(testKey(e), { status: "failed", entry: e });
  return out;
}

const executed = (t) => (t?.passed ?? 0) + (t?.failed ?? 0) + (t?.flaky ?? 0) + (t?.skipped ?? 0);
const shardsOf = (row) => row?.backend?.shard_total ?? null;

/**
 * Classify every test the two lanes disagree about.
 *
 * `agreed` is returned, not discarded: a failure both lanes saw is the product
 * failing, and leaving it out would make the day look like it had fewer findings
 * than it did while hiding the one bucket that needs no environment work at all.
 */
export function compareRuns({
  ci,
  vm,
  date,
  ciExtra = 0,
  vmExtra = 0,
  // Every date the series holds, so a comparison of a day that is NOT the newest one
  // can say so instead of answering a question the reader did not ask.
  datesAvailable = [],
  // The ids the rows were selected by. Taken as arguments rather than read off the
  // constants, because a caller that overrode --ci-workflow / --vm-workflow would
  // otherwise be told a row is missing under a name it never asked for.
  ciWorkflow = DEFAULT_CI_WORKFLOW,
  vmWorkflow = DEFAULT_VM_WORKFLOW,
  allowVersionMismatch = false,
} = {}) {
  const blockers = [];
  const warnings = [];
  let versionMismatch = null;

  if (!ci) blockers.push(`no ${ciWorkflow} row for ${date ?? "that date"} - the Actions lane has nothing to compare against.`);
  if (!vm) blockers.push(`no ${vmWorkflow} row for ${date ?? "that date"} - the VM lane did not record a run.`);
  if (!ci || !vm) return { date, ci, vm, blockers, warnings, divergences: [], agreed: [], versionMismatch, comparable: false };

  for (const [label, row] of [["Actions", ci], ["VM", vm]]) {
    const errs = row.run_errors ?? [];
    if (errs.length) {
      blockers.push(
        `${label} reported ${errs.length} top-level run error(s), so tests were stopped from running at all - ` +
          `its row is not a verdict. First: ${errs[0]}`,
      );
    }
  }

  const ciVersion = ci.langflow_version ?? null;
  const vmVersion = vm.langflow_version ?? null;
  if (ciVersion && vmVersion && ciVersion !== vmVersion) {
    versionMismatch = { ci: ciVersion, vm: vmVersion, allowed: allowVersionMismatch };
    const what =
      `the lanes tested DIFFERENT Langflow versions - Actions ${ciVersion}, VM ${vmVersion}. ` +
      `Every product change between those two lands in this list as an environment difference.`;
    // The escape hatch exists because the day this fires is often a day somebody wants
    // to look at: `:latest` can move between the Actions pull and the VM's resolution,
    // and refusing outright would throw the whole day away. It is per-invocation and
    // STAMPED - the mismatch stays on the object and at the head of the report - so the
    // caveat cannot be lost between running the tool and reading it. A dev-level
    // difference is NOT quietly demoted to a warning: 1.13.0.dev3 against dev4 is a day
    // of commits on the release branch, which is exactly the confusion being guarded.
    if (allowVersionMismatch) warnings.push(`VERSION MISMATCH ACCEPTED (--allow-version-mismatch): ${what}`);
    else blockers.push(what);
  } else if (!ciVersion || !vmVersion) {
    const missing =
      !ciVersion && !vmVersion
        ? "neither row carries"
        : !ciVersion
          ? "the Actions row does not carry"
          : "the VM row does not carry";
    warnings.push(
      `version parity UNVERIFIED: ${missing} a langflow_version. Rows written before that field existed ` +
        `lack it; the comparison below assumes a parity it cannot show.`,
    );
  }

  if (ciExtra || vmExtra) {
    warnings.push(
      `more than one row for this date (Actions +${ciExtra}, VM +${vmExtra}); the last append of each lane was used.`,
    );
  }

  // Staleness. The header carries the date, but a reader running this after last
  // night's run is looking for TODAY, and a silently older answer reads as today's.
  // It happens with nothing broken: the VM's history append is non-blocking (`|| warn`
  // in run-e2e.sh), so a run that produced a verdict can still leave no row.
  const newest = datesAvailable.at(-1);
  if (newest && date && newest !== date) {
    warnings.push(
      `this is NOT the newest day in the series - ${newest} has a row, but not from both lanes. ` +
        `What follows is ${date}.`,
    );
  }

  const skipDelta = (vm.totals?.skipped ?? 0) - (ci.totals?.skipped ?? 0);
  if (skipDelta !== 0) {
    warnings.push(
      `the lanes SKIPPED different numbers of tests (Actions ${ci.totals?.skipped ?? 0}, VM ${vm.totals?.skipped ?? 0}). ` +
        `A history row does not name skipped tests, so those ${Math.abs(skipDelta)} are invisible below - ` +
        `${skipDelta > 0 ? "the VM ran fewer specs than Actions did" : "Actions ran fewer specs than the VM did"}. ` +
        `A missing provider key is the usual cause.`,
    );
  }

  const execDelta = executed(vm.totals) - executed(ci.totals);
  if (execDelta !== 0) {
    warnings.push(
      `the lanes accounted for different test counts (Actions ${executed(ci.totals)}, VM ${executed(vm.totals)}); ` +
        `they may not have run the same suite revision.`,
    );
  }

  const ciShards = shardsOf(ci);
  const vmShards = shardsOf(vm);
  if (ciShards && vmShards && ciShards !== vmShards) {
    warnings.push(
      `different shard counts (Actions ${ciShards}, VM ${vmShards}). The verdict is comparable, but a spec's ` +
        `neighbours - and therefore contention and retry behaviour - differ.`,
    );
  }

  const ciOut = indexOutcomes(ci);
  const vmOut = indexOutcomes(vm);

  for (const [label, index] of [["Actions", ciOut], ["VM", vmOut]]) {
    const infra = [...index.values()].filter((v) => v.entry?.infra_signature).length;
    if (infra) {
      warnings.push(
        `${infra} of ${label}'s listed failures carry an infra_signature - the harness could not reach the ` +
          `backend, so they are not attributable to the spec that reported them.`,
      );
    }
  }

  // Decided here, not earlier, and that placement is the point: a blocked day still
  // has to report that the two lanes skipped different numbers of tests, because that
  // is what tells the reader whether re-running with --allow-version-mismatch buys
  // anything. Every warning above is computed before this returns.
  //
  // A blocked comparison returns NO list - not even to a caller reading `--json`.
  // Leaving the array populated would let the two surfaces tell different stories
  // about one run, and the machine-readable one would be the fiction.
  if (blockers.length) {
    return { date, ci, vm, blockers, warnings, divergences: [], agreed: [], versionMismatch, comparable: false };
  }

  const divergences = [];
  const agreed = [];
  for (const key of new Set([...ciOut.keys(), ...vmOut.keys()])) {
    const c = ciOut.get(key) ?? null;
    const v = vmOut.get(key) ?? null;
    const entry = v?.entry ?? c?.entry;
    const side = (o) =>
      o
        ? {
            status: o.status,
            error: o.entry?.error_signature ?? null,
            infra: o.entry?.infra_signature ?? null,
            attempts: o.entry?.attempts ?? null,
          }
        : null;
    const common = {
      key,
      name: describeTest(entry),
      file: entry?.file ?? null,
      test: entry?.test ?? null,
      param: entry?.param ?? null,
      tags: entry?.tags ?? [],
      ci: side(c),
      vm: side(v),
    };

    if (c && v) {
      if (c.status === v.status) agreed.push({ ...common, kind: `agreed-${c.status}` });
      else divergences.push({ ...common, kind: "severity-differs" });
      continue;
    }
    const only = c ? "ci" : "vm";
    const status = (c ?? v).status;
    divergences.push({ ...common, kind: `${only}-only-${status}` });
  }

  const rank = {
    "vm-only-failed": 0,
    "ci-only-failed": 1,
    "severity-differs": 2,
    "vm-only-flaky": 3,
    "ci-only-flaky": 4,
  };
  divergences.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.name.localeCompare(b.name));
  agreed.sort((a, b) => a.name.localeCompare(b.name));

  return { date, ci, vm, blockers, warnings, divergences, agreed, versionMismatch, comparable: blockers.length === 0 };
}

const KIND_LABEL = {
  "vm-only-failed": "FAILED on the VM only",
  "ci-only-failed": "FAILED on Actions only",
  "severity-differs": "failed on one lane, flaky on the other",
  "vm-only-flaky": "flaky on the VM only",
  "ci-only-flaky": "flaky on Actions only",
};

/** Render the comparison for a person reading it in a terminal at 09:00. */
export function renderReport(result, { sources = [] } = {}) {
  const L = [];
  const { date, ci, vm, blockers, warnings, divergences, agreed } = result;

  L.push(`Lane verdict comparison - ${date ?? "no date"}`);
  for (const s of sources) L.push(`history: ${s}`);

  const line = (label, row) =>
    row
      ? `  ${label.padEnd(8)} run ${row.run_id ?? "?"} | ${row.totals?.passed ?? 0} passed, ${row.totals?.failed ?? 0} failed, ` +
        `${row.totals?.flaky ?? 0} flaky, ${row.totals?.skipped ?? 0} skipped` +
        `${row.langflow_version ? ` | Langflow ${row.langflow_version}` : ""}`
      : `  ${label.padEnd(8)} (no row)`;
  L.push(line("Actions", ci));
  L.push(line("VM", vm));

  // The stamp rides at the head, not buried in the warning list: a report produced
  // across two different products has to say so where it cannot be scrolled past.
  if (result.versionMismatch?.allowed) {
    L.push(
      "",
      `!! VERSION MISMATCH ACCEPTED - Actions ${result.versionMismatch.ci} vs VM ${result.versionMismatch.vm}.`,
      "   Product differences between those two are in the list below.",
    );
  }

  const pushWarnings = () => {
    if (!warnings.length) return;
    L.push("", "Narrowed by:");
    for (const w of warnings) L.push(`  - ${w}`);
  };

  if (blockers.length) {
    L.push("", "NOT COMPARABLE:");
    for (const b of blockers) L.push(`  - ${b}`);
    // Warnings are printed here too. Dropping them under a blocker would make the text
    // and the JSON tell different stories about one run, which is the asymmetry this
    // file refuses everywhere else.
    pushWarnings();
    L.push("", "No divergence list is produced: it would describe something other than the environment.");
    return L.join("\n");
  }

  pushWarnings();

  L.push("", `Divergences: ${divergences.length}`);
  if (!divergences.length) {
    L.push("  none - the two lanes agreed on every test either of them reported.");
  } else {
    let kind = null;
    for (const d of divergences) {
      if (d.kind !== kind) {
        kind = d.kind;
        L.push(`  ${KIND_LABEL[kind] ?? kind}:`);
      }
      L.push(`    ${d.name}`);
      const err = d.vm?.error ?? d.ci?.error;
      if (err) L.push(`      ${err}`);
      if (d.kind === "severity-differs") L.push(`      Actions: ${d.ci.status} | VM: ${d.vm.status}`);
    }
  }

  // Split by kind. A flake both lanes saw is NOT a failure both lanes saw, and one
  // heading over both makes a reader at 09:00 count a retry as a hard failure - the
  // "looks right while being wrong" shape this file is written against.
  const agreedFailed = agreed.filter((a) => a.kind === "agreed-failed");
  const agreedFlaky = agreed.filter((a) => a.kind === "agreed-flaky");
  L.push("", `Failed on BOTH lanes (the product, not the environment): ${agreedFailed.length}`);
  for (const a of agreedFailed) L.push(`  ${a.name}`);
  L.push("", `Flaky on BOTH lanes (unstable in both, not a lane difference): ${agreedFlaky.length}`);
  for (const a of agreedFlaky) L.push(`  ${a.name}`);

  L.push(
    "",
    "Not visible here: tests that PASSED or were SKIPPED are not named on a history row, so a spec",
    "skipped on one lane and passed on the other cannot be told apart from agreement. The skipped",
    "counts above are the only signal for that class.",
  );
  return L.join("\n");
}
