#!/usr/bin/env node
/**
 * Renders the triage dataset as a section of the umbrella issue (#2031).
 *
 *   node scripts/render-triage-summary.mjs <dataset.json>   → markdown on stdout
 *
 * ## Why this exists
 *
 * Since the cut of 2026-09-20 the umbrella of a red day is born from the VM run, and
 * it named the failed specs but said nothing about RECURRENCE: which flakes recur
 * under the same cause, which are exempt as wedge collateral, which are first seen.
 * `build-triage-dataset.mjs` computes all of it, but on the Actions lane it reaches a
 * reader through the triage-dispatch Phase 1 comment, whose trigger is a
 * `workflow_run` of the Actions daily — it never fires for the VM. On 2026-09-21, the
 * first red day with consequence, rebuilding this by hand from the ledger was most of
 * the triage's cost.
 *
 * ## What this decides, and what it does not
 *
 * Nothing. Every verdict below is the dataset's (`actionable`, `infra_excluded`,
 * `outage_excluded`, `recurrence`), rendered with the protocol's action beside it.
 * That is the line between layer A and layer B of the split: a deterministic
 * rendering of a deterministic computation, with no model in the lane that carries
 * the verdict. Clustering, dedup against open issues and the prose proposal stay out.
 *
 * `declared_fix_candidates` are not repeated: the umbrella already names them in its
 * own #2009 section, from the report rather than from the ledger.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Backticks would close the code span a value is printed in. */
const safe = (text) => String(text ?? "").replaceAll("`", "'");

/** How many skips are listed one by one before the rest are counted. */
export const SKIPS_LISTED = 15;

function where(e) {
  return `\`${safe(e.file)}${e.line ? `:${e.line}` : ""}\``;
}

function variant(e) {
  const parts = [e.provider, e.model].filter(Boolean);
  return parts.length ? ` _(${safe(parts.join(" / "))})_` : "";
}

/**
 * The recurrence, as the protocol reads it: the same-cause runs are the figure, and
 * a date whose row predates the #1626 keys is counted but must be checked against
 * that run's log before it is cited. Said on the line that cites it, or the count
 * reads as verified.
 */
export function recurrenceText(r) {
  if (!r || !(r.count > 0)) return "no occurrence recorded in the window";
  const dates = r.dates.join(", ");
  // RUNS, not dates: the ledger holds one row per run, and a day can carry two (a
  // re-run, or two lanes writing the same file) — "5 date(s)" over four distinct days
  // would be a figure the list beside it contradicts.
  const head = r.count === 1 ? "first occurrence in the window" : `same cause on ${r.count} run(s): ${dates}`;
  const unverified = r.unverified_dates?.length
    ? ` — ${r.unverified_dates.length} of them ${r.unverified_dates.length === 1 ? "predates" : "predate"} the recurrence keys (${r.unverified_dates.join(", ")}): check that run's log before citing the figure`
    : "";
  const others = r.total_count > r.count ? ` · ${r.total_count - r.count} other run(s) with a different cause` : "";
  return `${head}${unverified}${others}`;
}

/** What the run measured about the backend while this entry failed, when it measured. */
function outageText(o) {
  if (!o || o.state !== "overlapped") return "";
  const pct = (x) => `${Math.round(Number(x) * 100)}%`;
  const shard = o.shard_down_pct !== undefined ? `, shard ${pct(o.shard_down_pct)} down` : "";
  return ` · every failed attempt at least ${pct(o.min_coverage)} inside a measured outage${shard}`;
}

function entryLines(e, extra = "") {
  return [
    `- ${where(e)} — ${safe(e.test)}${variant(e)}`,
    `  - \`${safe(e.error_signature || "(no signature recorded)")}\``,
    `  - ${recurrenceText(e.recurrence)}${outageText(e.outage_overlap)}${extra}`,
  ];
}

export function renderTriageSummary(dataset, { windowDays = 30 } = {}) {
  const hard = dataset.hard_failures ?? [];
  const flakes = dataset.flakes ?? [];
  const skips = dataset.skips ?? [];

  const actionable = flakes.filter((f) => f.actionable === true);
  const exempt = flakes.filter((f) => f.actionable !== true && (f.infra_excluded || f.outage_excluded));
  const noted = flakes.filter((f) => f.actionable !== true && !f.infra_excluded && !f.outage_excluded);

  const lines = [
    `### Triage dataset — computed from the ledger over ${windowDays} days`,
    "",
    `Deterministic: \`build-triage-dataset.mjs\` over this machine's history, the same computation`,
    "the triage skill starts from. It classifies; it does not file, quarantine or dedup (#2031).",
    "",
  ];

  if (dataset.guard_tripped) {
    lines.push(
      "**The mass-failure guard tripped on this run.** Decide first whether the day was environmental;",
      "only durable cross-day clusters get a dedicated issue, and today-only collateral is noted.",
      "",
    );
  }
  if (dataset.infra_classification_gap) {
    lines.push(
      `**${dataset.infra_classification_gap.entries} entry(ies) reached no infra verdict**, so the wedge-collateral`,
      "exemption could not be applied to them: an unclassified entry is not a cleared one (#1012).",
      "",
    );
  }

  lines.push(`**Hard failures (${hard.length})**`, "");
  if (hard.length) {
    for (const e of hard) {
      const infra = e.infra_signature ? ` · transport-level (\`${safe(e.infra_signature)}\`)` : "";
      lines.push(...entryLines(e, infra));
    }
  } else {
    lines.push("None.");
  }
  lines.push("");

  lines.push(`**Flakes (${flakes.length})**`, "");
  if (!flakes.length) lines.push("None.", "");
  if (actionable.length) {
    lines.push(
      `_Recurrent under the same cause (${actionable.length}): open a dedicated issue and quarantine via PR (remove \`@stable\` and add \`test.fixme\`)._`,
      "",
    );
    for (const f of actionable) lines.push(...entryLines(f));
    lines.push("");
  }
  if (exempt.length) {
    lines.push(
      `_Recurrent, but exempt as backend collateral (${exempt.length}): note against the run's outage; do not file or quarantine._`,
      "",
    );
    for (const f of exempt) {
      const why = f.infra_excluded
        ? ` · exempt: transport-level \`${safe(f.infra_excluded.signature)}\` (#1310)`
        : ` · exempt: measured outage overlap (#1763) — read the coverage against the shard's downtime before accepting it`;
      lines.push(...entryLines(f, why));
    }
    lines.push("");
  }
  if (noted.length) {
    lines.push(`_Not recurrent (${noted.length}): note only; the retry budget absorbs single-run noise._`, "");
    for (const f of noted) lines.push(...entryLines(f));
    lines.push("");
  }

  // Only the clusters the dataset marks provider-wide (>= 2 spec files): two failures
  // of one file under one provider are that file's problem, not the provider's.
  const clusters = (dataset.provider_wide_clusters ?? []).filter((c) => c.provider_wide);
  if (clusters.length) {
    lines.push("**Provider-wide signal**", "");
    for (const c of clusters) {
      lines.push(`- **${safe(c.provider)}**: ${c.count} entries across ${c.files.length} spec files — ${c.files.map((f) => `\`${safe(f)}\``).join(", ")}`);
    }
    lines.push("");
  }

  // `skips_read` is fail-closed: a dataset that does not say the report was read did
  // not read it, and an empty list from it is not "no skips".
  if (dataset.skips_read !== true) {
    lines.push("**Skips (not read)**", "", "The run's `results.json` was not read, so no skip is listed — which is not the same as none.");
    return lines.join("\n");
  }
  lines.push(`**Skips (${skips.length})**`, "");
  if (skips.length) {
    for (const s of skips.slice(0, SKIPS_LISTED)) {
      lines.push(`- \`${safe(s.file)}\` — ${safe(s.test)}: ${s.reason ? safe(s.reason) : "_no reason recorded_"}`);
    }
    if (skips.length > SKIPS_LISTED) lines.push(`- …and ${skips.length - SKIPS_LISTED} more, in the run's \`results.json\`.`);
  } else {
    lines.push("None.");
  }

  return lines.join("\n");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: render-triage-summary.mjs <dataset.json>");
    process.exit(2);
  }
  // A dataset this cannot read is an error, not an empty section: the caller turns a
  // non-zero exit into a line that says the dataset could not be rendered.
  const dataset = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(`${renderTriageSummary(dataset)}\n`);
}
