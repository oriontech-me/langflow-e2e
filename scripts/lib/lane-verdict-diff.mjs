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
 * The identity of a SPEC across the two lanes, with the parameterization dropped.
 *
 * `testKey` is right for the diff and wrong for one question. The day's provider is
 * resolved AT RUN TIME by `select-daily-model-target.mjs`, which walks forward from the
 * weekday's slot past whatever `collect-models` probed inactive. So the two lanes can
 * pin DIFFERENT providers on the same morning — and did on 2026-09-08: Actions landed
 * on google and the VM on anthropic, because the shared Anthropic balance drained
 * between 08:04 and 12:41. Every provider-parametrized spec then carries a different
 * `param` on each side, keys as two identities, and lands in the report as two
 * one-sided differences.
 *
 * That is a FALSE NEGATIVE in the class this comparator exists to find. On that day the
 * `agent-component-regression` suite flaked on BOTH lanes and the report printed
 * `Flaky on BOTH lanes: 0`. It held the evidence and could not say it.
 *
 * What the pairing does NOT buy is a conclusion. This docblock used to argue that a
 * failure reproducing on gemini and on claude "has ELIMINATED the provider as its
 * cause, by construction" — and that argument outlived the code, which stopped drawing
 * it. The inference is sound and unverifiable here, for the reason `pairCrossTarget`
 * gives: the row never records which provider the lane PINNED, so the file cannot tell
 * a two-provider pair from a two-model pair without being told. Read that docblock
 * before reintroducing a claim on this one's authority.
 */
export function specKey(entry) {
  // Same separator, same reason as testKey: joined with nothing, a file ending in a
  // title's first characters could collide with another pair.
  return [entry?.file ?? "", entry?.test ?? ""].join("\u0001");
}

/** SGR escapes, as an escape rather than the literal byte — same rule as the key's separator. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The comparable form of a signature, or `null` when there is nothing to compare.
 *
 * Two strings that LOOK present must not be compared, and both were reachable:
 *
 *  - **`"unknown"`.** It is what `append-weekly-history.mjs` records when a failure
 *    carries no message at all (`firstFailedSignature || "unknown"`), and that file's
 *    own comment already says what it is: *"`unknown` is not a signature but the
 *    absence of one: triage's recurrence rule matches on it, so message-less failures
 *    clustered together across unrelated specs"*. It fixed that for its own selection;
 *    comparing it here reintroduced it one file over. **15 of the 764 signatures in
 *    `reports/daily-history.jsonl` are `unknown`** — two message-less failures of one
 *    spec folded as a matching pair and was headlined as the product, back when the
 *    fold still drew conclusions.
 *  - **the SGR escapes.** 255 of those 764 rows carry them, and the colorization is
 *    environment-derived: nothing in this repo sets `FORCE_COLOR` or `NO_COLOR`, and
 *    supports-color keys on `GITHUB_ACTIONS`, which the VM does not have. Comparing
 *    raw strings would make one failure, colorized on one lane and plain on the other,
 *    read as two different causes — the exact false negative this pairing exists to
 *    remove. Both series carry escapes at the same rate today, so this is a latent
 *    inversion rather than an observed one; normalizing costs nothing and removes it.
 */
export function comparableSignature(signature) {
  const bare = String(signature ?? "")
    .replace(ANSI, "")
    .trim();
  if (!bare || bare === "unknown") return null;
  return bare;
}

/**
 * Does this signature carry a cause, or is it an assertion shell?
 *
 * `expect(received).toBe(expected)` is the most generic string this suite produces and
 * establishes NOTHING about same-causeness on its own (#1626). Triage settles recurrence
 * by reading the expected/received pair out of `results.json`; a history row carries
 * only the signature. So a match between two shells is a LEAD and has to say so — #1759,
 * filed the same week, rests its entire "why these are one cause" section on the pair
 * and explicitly not on the signature.
 *
 * Deliberately narrow: an `Error: expect(...)` prefix and nothing else. Anything with a
 * message of its own — the guards naming #751, the tracing precondition, a timeout
 * naming its URL — carries a cause and is not a shell.
 */
export function isGenericSignature(signature) {
  const bare = comparableSignature(signature);
  if (!bare) return false;
  // ANY subject, not just `received`. Requiring `expect(received)` covered the
  // MINORITY: measured over both series, `expect(locator)` shells are 158 of 764
  // signatures against 97 for `expect(received)`, and `expect(locator).toBeVisible()
  // failed` alone is 115 — the single most frequent signature the suite produces. A
  // pair agreeing only on "some locator was not visible" was taking the head stamp
  // with no LEAD caveat, which is the false confidence this guard exists to prevent,
  // on the dominant shell class of an e2e suite.
  //
  // Checked against the corpus rather than reasoned: of the 115 DISTINCT signatures in
  // the two series, this matches 21 and every one of them is a bare matcher; nothing
  // carrying a message of its own matches, and no signature starting with `expect(`
  // escapes it.
  return /^Error:\s*expect\([^)]*\)\s*\.\s*(not\s*\.\s*)?[A-Za-z]+\s*\(/.test(bare);
}

/**
 * The provider named by a `param` label, or `null` when the label does not name one.
 *
 * The labels are written by `select-daily-model-target.mjs` and by the specs' own target
 * resolution. Counted over both series — 97 param-carrying entries, 8 distinct labels —
 * every one is `provider / model` (`google / gemini-3.5-flash` 55, `openai / gpt-4o-mini`
 * 13, `google / gemini-2.5-flash` 12, `google / gemini-flash-latest` 7,
 * `anthropic / claude-haiku-4-5` 6, `anthropic / claude-sonnet-5` 2, `google / default` 1)
 * except one `provider:openai (fallback)`, which `test-targets.ts` emits when the
 * catalog was frozen empty. An earlier version of this comment claimed a bare `google`
 * was one of the shapes; it appears ZERO times, and no `label:` in `test-targets.ts` can
 * produce it. The bare branch below stays as tolerance, not as a documented input.
 *
 * `model:<id>` — `test-targets.ts` emits it when the target model is absent from the
 * catalog — names no provider, and returning its whole string as one was the same
 * overclaim this file spent three reviews removing: against `openai / gpt-4o-mini` it
 * rendered `providers DIFFER (Actions openai, VM model:gpt-4o-mini)`. It answers `null`,
 * which routes the pair to "cannot be told from these two rows".
 *
 * It exists because comparing the WHOLE label answers a different question than the
 * one the report was asking. Two labels differ whenever the MODEL differs, and the
 * model differs routinely: google shows four distinct labels across the series, nine
 * specs have been recorded under two different google models, and one 2026-09-08 smoke
 * on the VM settled `gemini-2.5-flash` while the Actions lane of the same morning
 * pinned `gemini-3.5-flash` — same provider, same catalog size, different key. Every
 * conclusion this file used to draw from a fold said "different providers"; on those
 * pairs it was false.
 */
export function paramProvider(param) {
  const bare = String(param ?? "").trim();
  if (!bare) return null;
  const fallback = bare.match(/^provider:([A-Za-z0-9_-]+)/);
  if (fallback) return fallback[1];
  if (/^model:/.test(bare)) return null;
  const head = bare.split("/")[0].trim();
  return head || null;
}

/**
 * Fold one-sided differences that are the SAME spec under different targets into one
 * entry.
 *
 * Only an exact pair folds — one entry from each lane. Three or more one-sided entries
 * for one spec means some lane ran more than one parameterization, and which pairs with
 * which is then a guess; the honest outcome is to leave them alone.
 *
 * ## What the fold establishes, and what it does not
 *
 * It establishes ONE thing: these two lines are the same spec, and the report should
 * show them side by side instead of as two unrelated one-sided differences. That was a
 * real false negative — on 2026-09-08 `agent-component-regression` was in both lanes'
 * lists and the report printed `Flaky on BOTH lanes: 0`.
 *
 * It establishes NOTHING about cause, and this file stopped claiming otherwise. Three
 * review rounds found sixteen defects in this function and every one was in what the
 * fold CLAIMED, none in the folding: the report asserted "the provider is eliminated
 * as the cause" over pairs that shared a provider, over signatures that were assertion
 * shells, over failures the harness could not attribute to the spec, and over a hard
 * failure paired with a retry. The pattern is the design, not the wording: the claim
 * needs facts the row does not carry — which provider the lane PINNED, and whether the
 * lane ran one variant or several.
 *
 * So the entry now reports and the reader concludes. It carries the facts —
 * `providersDiffer`, `signaturesMatch`, `generic`, `infra`, both targets, both statuses
 * and both signatures — and the report prints them without a verdict, a ranking above
 * the one-sided failures, or a head stamp.
 *
 * **The conclusion is deferred, not abandoned.** "A failure reproducing on gemini AND
 * on claude has eliminated the provider" is a sound inference; it is simply not
 * checkable from a row that never says which provider was pinned. When that field
 * lands (it waits on #1731, whose matrix-output path would otherwise record the
 * provider of whichever shard finished last), the claim can come back as something the
 * file can verify rather than assume.
 *
 * Two kinds, split by severity only, because a retry that passed is not a red — the
 * distinction `agreed-failed`/`agreed-flaky` already exists in this file for the same
 * reason:
 *
 *  - `cross-target-failed`  hard failure on at least one lane. Ranked with the
 *                           one-sided failures, never above them.
 *  - `cross-target-flaky`   both lanes retried and passed. Ranked with the flakes.
 */
export function pairCrossTarget(divergences) {
  const ONE_SIDED = /^(ci|vm)-only-(failed|flaky)$/;
  const groups = new Map();
  for (const d of divergences) {
    if (!ONE_SIDED.test(d.kind)) continue;
    const k = specKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }

  const folded = new Set();
  const pairs = [];
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const ci = group.find((d) => d.kind.startsWith("ci-"));
    const vm = group.find((d) => d.kind.startsWith("vm-"));
    if (!ci || !vm) continue; // both from the same lane: not a pair
    const ciParam = ci.param ?? null;
    const vmParam = vm.param ?? null;
    // Identical labels cannot key differently, so this is defensive only: the exact
    // diff would already have had them as one entry.
    if (ciParam === vmParam) continue;

    // Normalized on BOTH sides before the equality, never raw: see comparableSignature.
    const ciErr = comparableSignature(ci.ci?.error);
    const vmErr = comparableSignature(vm.vm?.error);
    const signaturesMatch = Boolean(ciErr) && ciErr === vmErr;
    const generic = signaturesMatch && isGenericSignature(ciErr);
    // OR, and the rendered text names WHICH side rather than asserting both: one-sided
    // is the ordinary case (2026-09-07: one on Actions against five on the VM), and the
    // narrowing block printed above the list already reports the per-lane counts.
    const infraCi = Boolean(ci.ci?.infra);
    const infraVm = Boolean(vm.vm?.infra);
    // FACTS about the two labels, not a licence to conclude anything from them. THREE
    // states, not two: `providersDiffer` is false both when the providers are equal and
    // when a side names none, and the render used to collapse those into "SAME
    // provider" — printing `VM [no target]` and `SAME provider (google)` on adjacent
    // lines, over a row that never said it ran google.
    const ciProvider = paramProvider(ciParam);
    const vmProvider = paramProvider(vmParam);
    const providersKnown = Boolean(ciProvider) && Boolean(vmProvider);
    const providersDiffer = providersKnown && ciProvider !== vmProvider;

    folded.add(ci);
    folded.add(vm);
    pairs.push({
      // NOTE for `--json` consumers: a folded row is shaped differently from every
      // other divergence. `key` is a 2-segment specKey (not the 3-segment testKey),
      // `param` is null because there are two, and the labels live in `params`.
      key: specKey(ci),
      name: describeTest({ file: ci.file, test: ci.test }),
      file: ci.file ?? null,
      test: ci.test ?? null,
      param: null,
      params: { ci: ciParam, vm: vmParam },
      providers: { ci: ciProvider, vm: vmProvider },
      // The UNION, not the CI side. `??` falls through on null and not on `[]`, so a
      // CI entry tagged `[]` used to erase tags the VM entry had — and the lanes can
      // sit one commit apart, which is exactly how the two sides come to disagree
      // about tags (PR 1745 restored `@stable` to four specs between two runs). This
      // entry describes the pair, and `--json` consumers filter on it.
      tags: [...new Set([...(ci.tags ?? []), ...(vm.tags ?? [])])],
      ci: ci.ci,
      vm: vm.vm,
      kind:
        ci.ci?.status === "failed" || vm.vm?.status === "failed"
          ? "cross-target-failed"
          : "cross-target-flaky",
      crossTarget: {
        signaturesMatch,
        generic,
        infraCi,
        infraVm,
        providersKnown,
        providersDiffer,
      },
    });
  }

  return [...divergences.filter((d) => !folded.has(d)), ...pairs];
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
  let gateMismatch = null;

  if (!ci) blockers.push(`no ${ciWorkflow} row for ${date ?? "that date"} - the Actions lane has nothing to compare against.`);
  if (!vm) blockers.push(`no ${vmWorkflow} row for ${date ?? "that date"} - the VM lane did not record a run.`);
  if (!ci || !vm) return { date, ci, vm, blockers, warnings, divergences: [], agreed: [], versionMismatch, gateMismatch, comparable: false };

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

  // WHICH SUITE EACH LANE LISTED, before any count below is read as a product fact.
  //
  // These keys gate COLLECTION, not execution: a spec file whose every test is
  // generated from a provider key collects zero tests without it, never enters the
  // file-level partition, and is run by no shard - no row, no skip, no error, just a
  // smaller total (#1764). So two lanes with different key sets are not comparable by
  // count, and the difference has to be STATED here: the 2026-09-07 and 09-08
  // comparisons recorded exactly this delta as "no catalog on the Actions side", which
  // is the hypothesis a reader reaches for when the row carries no cause.
  //
  // A warning, never a blocker. The VM has no GOOGLE_API_KEY and lists two of the three
  // variants on purpose (#1764); blocking would throw away every comparison this lane
  // exists to produce, to report a state both lanes already agreed to.
  const gateOf = (row) => {
    const gate = row?.collection_gate_keys;
    return gate && Array.isArray(gate.present) ? gate : null;
  };
  const ciGate = gateOf(ci);
  const vmGate = gateOf(vm);
  const named = (keys) => (keys.length ? keys.join(", ") : "no provider key");
  if (ciGate && vmGate) {
    const ciOnly = ciGate.present.filter((k) => !vmGate.present.includes(k));
    const vmOnly = vmGate.present.filter((k) => !ciGate.present.includes(k));
    if (ciOnly.length || vmOnly.length) {
      gateMismatch = { ci: ciGate.present, vm: vmGate.present, ciOnly, vmOnly };
      warnings.push(
        `the lanes LISTED DIFFERENT SUITES - Actions resolved ${named(ciGate.present)}, VM resolved ${named(vmGate.present)}. ` +
          `${[ciOnly.length ? `Only Actions had ${ciOnly.join(", ")}` : null, vmOnly.length ? `only the VM had ${vmOnly.join(", ")}` : null]
            .filter(Boolean)
            .join("; ")}. ` +
          `Whole spec files are generated from those keys at collection time, so the lane without one has fewer ` +
          `tests for a reason that is not the product and appears nowhere as a failure or a skip.`,
      );
    }
  } else {
    const missing =
      !ciGate && !vmGate
        ? "neither row carries"
        : !ciGate
          ? "the Actions row does not carry"
          : "the VM row does not carry";
    warnings.push(
      `collection-gate parity UNVERIFIED: ${missing} a collection_gate_keys block. A listing without a provider ` +
        `key drops whole spec files from its matrix silently (#1764), and a row written before that field existed ` +
        `cannot say whether it did.`,
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
        // DELIBERATELY not pointed at the gate, and this line is the reason the
        // distinction is worth stating twice. A skip happens at RUN time;
        // `collection_gate_keys` records the LISTING environment, and those are not
        // the same environment. On Actions the listing is the `prep` job, carrying
        // exactly the three collection-gating secrets (#1796), while its shard jobs
        // carry those plus Groq, Mistral and the Azure trio - so the gate is silent
        // about most of what can skip, and a skip difference read off it names a lane
        // narrow on an axis this field never measured. Pointing a reader at the wrong
        // machine is exactly the failure the field was added to end, so it is better
        // to keep offering the honest guess here.
        `A missing provider key is the usual cause.`,
    );
  }

  const execDelta = executed(vm.totals) - executed(ci.totals);
  if (execDelta !== 0) {
    warnings.push(
      `the lanes accounted for different test counts (Actions ${executed(ci.totals)}, VM ${executed(vm.totals)}); ` +
        // This one the gate CAN explain: collection decides which spec files enter the
        // matrix at all, so a file only one lane listed is missing from the other's
        // total outright - no skip, no error, nothing to subtract it from.
        (gateMismatch
          ? `the listing keys above differ, so the two matrices did not contain the same spec files.`
          : `they may not have run the same suite revision.`),
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
    return { date, ci, vm, blockers, warnings, divergences: [], agreed: [], versionMismatch, gateMismatch, comparable: false };
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

  // Fold the provider-split pairs BEFORE ranking, so the strongest entry the day can
  // produce is ranked as what it is instead of as two one-sided flakes.
  const paired = pairCrossTarget(divergences);
  divergences.length = 0;
  divergences.push(...paired);

  // A folded pair ranks WITH the severity it has, never above it. Ranking it first was
  // the promotion the cold review caught: a pair that hard-failed on one lane and
  // flaked on the other outranked a genuine two-lane red.
  const rank = {
    "vm-only-failed": 0,
    "ci-only-failed": 1,
    "cross-target-failed": 2,
    "severity-differs": 3,
    "vm-only-flaky": 4,
    "ci-only-flaky": 5,
    "cross-target-flaky": 6,
  };
  divergences.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.name.localeCompare(b.name));
  agreed.sort((a, b) => a.name.localeCompare(b.name));

  return { date, ci, vm, blockers, warnings, divergences, agreed, versionMismatch, gateMismatch, comparable: blockers.length === 0 };
}

const KIND_LABEL = {
  "cross-target-failed": "same spec on both lanes under DIFFERENT targets, hard failure on at least one lane",
  "cross-target-flaky": "same spec on both lanes under DIFFERENT targets, a retry passed on both",
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
  // The key set rides with the counts, on its own line under the lane it belongs to.
  // The whole point of recording it is that a reader looking at two different totals
  // sees the listing difference in the same glance, instead of reaching for the
  // catalog explanation the two mis-attributed comparisons reached for (#1764).
  const pushLane = (label, row) => {
    L.push(line(label, row));
    const gate = row?.collection_gate_keys;
    if (!gate || !Array.isArray(gate.present)) return;
    const absent = Array.isArray(gate.absent) ? gate.absent : [];
    L.push(
      `${" ".repeat(11)}listed with ${gate.present.length ? gate.present.join(", ") : "no provider key"}` +
        (absent.length ? ` | absent: ${absent.join(", ")}` : ""),
    );
  };
  pushLane("Actions", ci);
  pushLane("VM", vm);

  // The stamp rides at the head, not buried in the warning list: a report produced
  // across two different products has to say so where it cannot be scrolled past.
  if (result.versionMismatch?.allowed) {
    L.push(
      "",
      `!! VERSION MISMATCH ACCEPTED - Actions ${result.versionMismatch.ci} vs VM ${result.versionMismatch.vm}.`,
      "   Product differences between those two are in the list below.",
    );
  }

  // NO head stamp for the folded pairs, deliberately. The version mismatch earns one
  // because it is a fact about the run; a fold is an observation whose meaning depends
  // on facts the row does not carry, and a stamp is exactly the surface that cannot be
  // qualified. Three rounds of review found the stamp asserting what the entry beneath
  // it declined to assert.

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
      if (d.kind.startsWith("cross-target")) {
        // Facts only, every one of them read off the two rows: both targets, both
        // statuses, both signatures, and what the two labels have in common. No line
        // here concludes anything about cause — see pairCrossTarget's docblock for why
        // this file stopped trying.
        const x = d.crossTarget ?? {};
        L.push(`      Actions [${d.params.ci ?? "no target"}] ${d.ci?.status ?? "?"}: ${d.ci?.error ?? "(no signature)"}`);
        L.push(`      VM      [${d.params.vm ?? "no target"}] ${d.vm?.status ?? "?"}: ${d.vm?.error ?? "(no signature)"}`);
        if (!x.providersKnown) {
          // The honest third state. Saying "same" here would assert a provider for a
          // row that never named one, and this is the only line in the block that
          // touches cause at all.
          L.push(
            `      one side does not name a provider (Actions ${d.providers?.ci ?? "—"}, VM ${d.providers?.vm ?? "—"}):`,
            "      whether the provider differs cannot be told from these two rows",
          );
        } else if (x.providersDiffer) {
          L.push(`      providers DIFFER (Actions ${d.providers?.ci}, VM ${d.providers?.vm})`);
        } else {
          L.push(`      SAME provider (${d.providers?.ci}), different target — the provider is NOT ruled out`);
        }
        if (x.signaturesMatch) {
          L.push(
            x.generic
              ? "      signatures match, but the shared one is an assertion shell: it names no cause (#1626)"
              : "      signatures match",
          );
        } else {
          L.push("      signatures do NOT match (or one is absent)");
        }
        if (x.infraCi || x.infraVm) {
          const which = x.infraCi && x.infraVm ? "both lanes" : x.infraCi ? "Actions" : "the VM";
          L.push(`      an infra_signature is present on ${which}: the harness could not reach the backend there,`);
          L.push("      so that side's signature is not attributable to this spec (see the narrowing above)");
        }
        continue;
      }
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

  // A line of their own rather than a `+N` on the two above. Those two tallies mean
  // "the same test id, on both lanes" and adding pairs to them was how an infra pair
  // and an assertion-shell pair ended up counted under "the product, not the
  // environment". But the count cannot be absent either: a day whose only finding is a
  // pair used to end with two zeroes and no mention of it.
  const crossPairs = divergences.filter((d) => d.kind.startsWith("cross-target"));
  L.push(
    "",
    `Same spec, DIFFERENT targets (counted in neither tally above): ${crossPairs.length}`,
  );
  for (const d of crossPairs) L.push(`  ${d.name}`);

  L.push(
    "",
    "Not visible here: tests that PASSED or were SKIPPED are not named on a history row, so a spec",
    "skipped on one lane and passed on the other cannot be told apart from agreement. The skipped",
    "counts above are the only signal for that class.",
  );
  return L.join("\n");
}
