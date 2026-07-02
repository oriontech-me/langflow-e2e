#!/usr/bin/env node
// Turn the JSON output of remove-stable-from-failures.ts into a Markdown block
// for the triage issue body. Usage: node format-auto-remove-summary.mjs <json-file>
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const lines = [];

if (r.status === "guard_tripped") {
  lines.push(
    `⚠️ **Mass-failure guard tripped** — ${r.hardFailures} hard failures exceed the ` +
      `threshold of ${r.threshold}, so \`@stable\` was **left untouched**. A run where ` +
      `this many stable tests fail at once is almost always infra (Langflow didn't boot, ` +
      `network/model outage), not per-test rot. Triage manually.`,
  );
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
} else {
  lines.push("No per-test `@stable` hard failures were auto-removed.");
}

if (r.skipped && r.skipped.length) {
  lines.push("");
  lines.push(`⏭️ **Skipped ${r.skipped.length}** (needs manual review):`);
  for (const s of r.skipped) lines.push(`- \`${s.file}\` — ${s.title} _(${s.reason})_`);
}

process.stdout.write(lines.join("\n"));
