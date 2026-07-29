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
    lines.push(`- \`${e.file}\` — ${e.title} _(${e.signature}: ${e.why})_`);
    lines.push(`  \`${String(e.error).split("\n")[0]}\``);
  }
  lines.push("");
  lines.push(
    "**Do not open a per-spec issue for these.** Triage the backend outage instead — start from the " +
      "backend liveness section above and the Langflow service container log (`WORKER TIMEOUT` ⇒ #1048).",
  );
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
      `The guard counts **every** hard failure, collateral included (${exempt.length} of ${r.hardFailures} ` +
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
