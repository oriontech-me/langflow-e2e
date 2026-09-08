#!/usr/bin/env node
// Turn the JSON output of remove-stable-from-failures.ts into a Markdown block
// for the triage issue body. Usage: node format-auto-remove-summary.mjs <json-file>
//
// Since #1031 the block has TWO halves, and the order is deliberate: what was
// NOT attributable comes first. A wedged backend produces a list of unrelated
// specs that reads as per-test rot, and triage that starts from that list pays a
// full cycle to rediscover the cause (run 30374528125: 14 of 19 hard failures
// described one wedged backend).
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const lines = [];

/**
 * Make text safe inside a single-backtick code span. An error message is
 * arbitrary product text — one backtick in it closes the span and the rest of
 * the line renders as prose, mid-issue-body.
 */
const code = (text) => String(text).replaceAll("`", "'");

const exempt = Array.isArray(r.exempt) ? r.exempt : [];
// `attributableFailures` is absent on output produced before #1031; fall back to
// the total so an older artifact still renders something truthful.
const attributable = Number.isFinite(r.attributableFailures)
  ? r.attributableFailures
  : r.hardFailures;

if (exempt.length) {
  // The liveness verdict (#1030) only strengthens or weakens the wording — the
  // exemption itself stands on the error signature, so it survives a run where
  // the recorder measured nothing.
  const corroboration =
    r.backendWedged === "true"
      ? " The in-run liveness recorder **measured a mid-run outage** on this run (#1030), which corroborates it."
      : r.backendWedged === "false"
        ? " The in-run liveness recorder measured **no** outage (#1030) — the exemption stands on the error alone, since a transport error is still not a product assertion."
        : " Backend liveness was **not measured** on this run (#1030), so the exemption stands on the error alone.";

  lines.push(
    `🔌 **${exempt.length} hard failure(s) are NOT attributable to their spec** — wedge collateral. ` +
      `Their last error is transport-level (the harness could not reach or talk to the backend), ` +
      `so \`@stable\` was **left in place** regardless of the mass-failure guard (#1031).${corroboration}`,
  );
  lines.push("");
  for (const e of exempt) {
    // #1589: say WHICH attempt carried the signature. An `earlier-attempt`
    // exemption is a different claim from a `last-attempt` one — it only holds
    // because the in-run recorder measured an outage overlapping that very
    // attempt on its own shard — and reading the two as the same would hide
    // that the widened branch fired at all.
    const via =
      e.via === "earlier-attempt"
        ? ` _(attempt ${e.attempt}, corroborated by a measured outage overlapping it — #1589)_`
        : "";
    lines.push(`- \`${e.file}\` — ${e.title} _(${e.signature}: ${e.why})_${via}`);
    lines.push(`  \`${code(String(e.error).split("\n")[0])}\``);
  }
  lines.push("");
  lines.push(
    "**Do not open a per-spec issue for these.** Triage the backend outage instead — start from the " +
      "backend liveness section above and the Langflow service container log (`WORKER TIMEOUT` ⇒ #1048).",
  );
  lines.push("");
}

// #1589's cheap branch, kept as the fallback rather than as the answer: a hard
// failure whose EARLIER attempt classified transport-level but which nothing
// corroborated is still counted as attributable — and named here, because the
// alternative is what run 32827671203 produced, an empty collateral block on a
// day the recorder measured 17.4 % of probes down on the only red shard.
const disagreements = Array.isArray(r.disagreements) ? r.disagreements : [];
if (disagreements.length) {
  lines.push(
    `🕵️ **${disagreements.length} hard failure(s) carried a transport-level signature on an EARLIER attempt** ` +
      "and were still counted as attributable, because the last attempt's error was not transport-level " +
      "and nothing corroborated the earlier one (#1589). Look at these before clustering them as per-test rot: " +
      "an intermittent wedge cycles through the retry budget instead of burning it, so the informative attempt " +
      "is not always the last.",
  );
  lines.push("");
  for (const d of disagreements) {
    lines.push(
      `- \`${d.file}\` — ${d.title} _(attempt ${d.attempt}: ${d.signature} — ${d.why})_`,
    );
    lines.push(`  declined: ${d.declined}`);
    lines.push(`  \`${code(String(d.error).split("\n")[0])}\``);
  }
  lines.push("");
}

if (r.status === "guard_tripped") {
  lines.push(
    `⚠️ **Mass-failure guard tripped** — ${r.hardFailures} hard failures exceed the ` +
      `threshold of ${r.threshold}, so \`@stable\` was **left untouched**. A run where ` +
      `this many stable tests fail at once is almost always infra (Langflow didn't boot, ` +
      `network/model outage), not per-test rot. Triage manually.`,
  );
  if (exempt.length) {
    lines.push("");
    lines.push(
      attributable === 0
        ? `The guard counts **every** hard failure, so it never removes more than it would have before ` +
            `#1031 — but here **all ${r.hardFailures} were collateral** (above). There is no per-spec ` +
            `evidence to triage on this run.`
        : `The guard counts **every** hard failure, collateral included (${exempt.length} of ${r.hardFailures} ` +
            `here), so it never removes more than it would have before #1031 — the ${attributable} attributable ` +
            `failure(s) above are for manual triage.`,
    );
  }
} else if (r.status === "removed") {
  lines.push(`🔻 **Auto-removed \`@stable\`** from ${r.removed.length} hard-failing test(s):`);
  lines.push("");
  for (const t of r.removed) {
    const note = t.soleTag
      ? " — _`@stable` was the only tag; the array was left empty, please review_"
      : "";
    lines.push(`- \`${t.file}\` — ${t.title}${note}`);
  }
  lines.push("");
  lines.push("These were committed to `main` automatically. **Restoring `@stable` is manual**: once the test or Langflow is fixed, re-add the tag via PR.");
} else if (exempt.length && attributable === 0) {
  // Every hard failure was collateral. Saying "nothing was auto-removed" alone
  // would read as a clean triage over a run that was anything but.
  lines.push(
    `No \`@stable\` tag was touched: **all ${r.hardFailures} hard failure(s) were non-attributable** (above). ` +
      "There is no per-spec evidence to triage on this run.",
  );
} else {
  lines.push("No per-test `@stable` hard failures were auto-removed.");
}

if (r.skipped && r.skipped.length) {
  lines.push("");
  lines.push(`⏭️ **Skipped ${r.skipped.length}** (needs manual review):`);
  for (const s of r.skipped) lines.push(`- \`${s.file}\` — ${s.title} _(${s.reason})_`);
}

process.stdout.write(lines.join("\n"));
