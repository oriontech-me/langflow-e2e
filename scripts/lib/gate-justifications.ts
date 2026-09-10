/**
 * Verify that a non-`@stable` spec's written justification still cites a LIVE
 * issue (#1783, split out of #1451).
 *
 * `@stable`'s absence is explained in prose — a `[-]` bullet in
 * `QA-CHECKLIST.md`, or a "no `@stable` because #N" note in the spec doc's
 * mandatory `## Tags` section. Nothing checked whether the `#N` was still open,
 * so a justification outlived its reason **silently**: `agent-tool-inspection`
 * cited #818 for two weeks after #818 closed, and while reviewing PR #1381 the
 * same trap fired twice inside one hour — the commit written to remove one
 * expired justification restated a different expired one as live.
 *
 * This module is the PURE half: given the declared tests, the justification
 * text, the live state of each cited reference and the declarations, it decides
 * what each spec is and renders the report section. Every filesystem and GitHub
 * call lives in `scripts/reconcile-stable-orphans.ts`.
 *
 * ─── Why this shape and not the one #1451 sketched ──────────────────────────
 *
 * #1451 proposed a sweep over `QA-CHECKLIST.md` and `docs/**` for issue refs in
 * a gating construction (`gated on #N`, `blocked on #N`, `until #N lands`).
 * Measured on `main` at `787cd420`, that selects **149 lines across 85 files**,
 * overwhelmingly legitimate history (`tracked in #1600`, `promoted by #682`),
 * and it MISSES real gates that use no gating verb —
 * `general-bugs-agent-sum-duplicate-message-playground.md` reads "its absence is
 * why this spec sat broken on `main` (#1465) — a call the issue asks to revisit
 * once it is green". Precision and recall both fail, so there is no keyword
 * list to tune.
 *
 * Two things replace it. **Scope**: only spec files where NO test carries
 * `@stable` — those are the ones whose absence needs a justification at all —
 * and only the two places the repo requires that justification to be written
 * (`CONTRIBUTING.md` → "Exceptions", and the Part II bullet). **Precision**: a
 * declarations file, the pattern this repo already uses for the same problem
 * (`stable-orphan-exemptions.json`, `http-error-policy`'s `IGNORED`,
 * `expectKnownHttpError`), so a reference cited as PROVENANCE is declared once
 * instead of being guessed at by a regex every run.
 *
 * ─── Five rules the measurement paid for ────────────────────────────────────
 *
 * 1. **A closed reference is not automatically a finding — "every cited
 *    reference is closed" is.** A spec citing #773 (closed) and #1465 (open) is
 *    still owned by #1465. Only when nothing cited is live does the
 *    justification stand on nothing.
 * 2. **An open issue naming the spec does NOT clear the finding — it is shown
 *    as CONTEXT.** The subject here is the written justification, not
 *    ownership: a spec quarantined under a fresh issue whose doc was never
 *    updated still has prose pointing at a dead reason, and the fix is to cite
 *    the live issue. An earlier draft suppressed the finding when any open
 *    issue named the spec, and it produced exactly the self-reference
 *    oscillation `ORPHAN_ISSUE_TITLE` documents as "the one bug this design can
 *    produce on its own": #1783, the issue specifying THIS check, lists every
 *    affected spec in its body, so it marked 10 of the 11 rows owned and
 *    emptied the report. Excluding one title would not have been enough — any
 *    issue that discusses the check names the specs. So the trackers are
 *    rendered beside the finding instead, which is also the more useful report:
 *    they are usually what the prose should have cited.
 * 3. **A bare `#N` is not necessarily ours, and guessing is how this check
 *    would produce a false verdict of its own.** `workflows-v2-job-lifecycle.md`
 *    writes `#14512` for `langflow-ai/langflow#14512`; in this repo that number
 *    does not exist. Resolution is therefore asked of the repo the ref names,
 *    and a bare ref that does not resolve is `unresolved` with that reason —
 *    never "closed", which would report a live upstream gate as dead.
 * 4. **An upstream reference is closed when it is CLOSED *or* MERGED.** Most of
 *    the upstream refs this repo cites are pull requests (#14634, #14512,
 *    #14489 are all PRs), and a merged PR is the strongest possible form of
 *    "this gate is gone".
 * 5. **The declaration is verified in BOTH directions (#1084).** A declaration
 *    whose spec now carries `@stable`, or that no longer cites the reference it
 *    declares, or whose spec has gone, is reported as EXPIRED rather than
 *    honoured — otherwise this check grows the exact silent-expiry problem it
 *    exists to close.
 *
 * And #1012 throughout: a reference that could not be resolved, a doc that
 * could not be read, or a lookup that failed is reported with the reason named.
 * Undecidable is never folded into clean.
 */

import type { DeclaredTest } from "./stable-tests";
import { LANE_TAGS } from "./stable-tests";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Which repository a cited `#N` points at. */
export type RefRepo = "self" | "upstream";

/** One issue/PR reference found in a justification. */
export interface CitedRef {
  repo: RefRepo;
  number: number;
}

/** Where a piece of justification text came from, for the report. */
export interface JustificationSource {
  kind: "doc-tags" | "checklist";
  /** `docs/…md` or `QA-CHECKLIST.md`. */
  file: string;
  /** 1-based line of the first line of this source. */
  line: number;
  text: string;
}

/** Everything read off disk for one candidate spec. */
export interface SpecJustification {
  /** Path under `regression/`, e.g. `core-components/x.spec.ts`. */
  spec: string;
  sources: JustificationSource[];
  /**
   * Set when a source could not be read at all (an unreadable doc). The spec is
   * then undecidable rather than "cites nothing" — #1012.
   */
  readError?: string;
}

/** The live state of one cited reference. */
export type RefState =
  | { kind: "open" }
  | { kind: "closed" }
  | { kind: "merged" }
  | { kind: "unresolved"; reason: string };

/** A declared, deliberate citation that is provenance rather than a gate. */
export interface GateDecl {
  /** Path under `regression/`. */
  spec: string;
  /**
   * The references this declaration covers, as written (`#820`,
   * `langflow-ai/langflow#14512`). Every one of them must still be cited by the
   * spec's justification, or the declaration is reported expired (rule 5).
   */
  refs: string[];
  reason: string;
  /** Where the decision is written down, e.g. `#1783`. */
  ref?: string;
}

export interface GateInput {
  /** Every declared test under `regression/`. */
  tests: DeclaredTest[];
  /** Justification text per candidate spec, keyed by path under `regression/`. */
  justifications: Record<string, SpecJustification>;
  /** Live state per reference, keyed by `refKey()`. */
  refStates: Record<string, RefState>;
  /** Spec paths an OPEN issue names — reuses the reconciler's tracker index. */
  trackedSpecs: Record<string, TrackedBy[]>;
  declarations: GateDecl[];
  /**
   * Set when the reference lookup itself failed. Every row then reads as
   * undecided rather than as "the gate is dead" — the difference between a
   * finding and an outage (#1012).
   */
  lookupError?: string;
}

/** An open issue naming a spec, as the reconciler already resolves it. */
export interface TrackedBy {
  number: number;
  url: string;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

export type GateState = "expired" | "live" | "declared" | "unknown";

export interface ResolvedRef {
  ref: CitedRef;
  state: RefState;
}

export interface GateRow {
  spec: string;
  state: GateState;
  refs: ResolvedRef[];
  sources: JustificationSource[];
  trackedBy: TrackedBy[];
  declaration: GateDecl | null;
  /** Present on `unknown` rows. */
  reason?: string;
}

export interface GateDeclProblem {
  declaration: GateDecl;
  reason: string;
}

export interface GateVerdict {
  /** Every cited reference is closed — the finding. */
  expired: GateRow[];
  /** At least one cited reference could not be resolved. */
  unknown: GateRow[];
  /** At least one cited reference is still open — nothing to do. */
  live: GateRow[];
  /** Covered by a declaration that still holds. */
  declared: GateRow[];
  staleDeclarations: GateDeclProblem[];
  counts: {
    /** Spec files with no `@stable` test and no lane tag. */
    candidateSpecs: number;
    /** Of those, how many cite at least one reference. */
    withRefs: number;
    /** Distinct references resolved. */
    refs: number;
  };
}

// ─── Reference extraction ────────────────────────────────────────────────────

/** This repository, as its own prose sometimes spells it. */
const SELF_SLUG = "oriontech-me/langflow-e2e";
/** The upstream repository this repo's docs cite. */
const UPSTREAM_SLUG = "langflow-ai/langflow";

/**
 * Match `#123` and a `owner/repo#123` written with one of the two slugs this
 * repo's prose actually uses.
 *
 * **Only those two**, and the reason is a measured one rather than laziness:
 * across `docs/` and `QA-CHECKLIST.md` the qualified form appears 88 times, 80
 * of them `langflow-ai/langflow` and 8 of them `oriontech-me/langflow-e2e` —
 * our OWN repo, written out. An earlier version accepted any slug and mapped it
 * to upstream, which would have resolved those 8 self-references against
 * Langflow and produced a confidently wrong verdict on each. Resolving an
 * arbitrary slug for real is the other way out and is worse here: a stray
 * `path/to#34` in prose would then be looked up as a repository, and the lookup
 * failing would take the run with it.
 *
 * A third repository would therefore go unchecked. That is a real gap, named
 * here rather than hidden: it costs a missing row, never a wrong one.
 *
 * The leading boundary is explicit rather than `\b`: `\b` does not fire before
 * `#`, so `abc#12` would otherwise match.
 */
const REF_PATTERN = /(?:^|[^A-Za-z0-9_/-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d{1,7})\b/g;

export function refKey(ref: CitedRef): string {
  return ref.repo === "self" ? `#${ref.number}` : `upstream#${ref.number}`;
}

/** Render a reference the way a human writes it, for the report. */
export function refLabel(ref: CitedRef): string {
  return ref.repo === "self"
    ? `#${ref.number}`
    : `langflow-ai/langflow#${ref.number}`;
}

/**
 * Every issue/PR reference in a piece of prose, de-duplicated, in first-seen
 * order.
 *
 * Markdown links to a GitHub issue are deliberately NOT matched: the repo's
 * prose cites by number, and a URL in an `External dependencies` list is a
 * different kind of statement. Anything that reads as a heading anchor
 * (`#section`) has no digits and cannot match.
 */
export function extractRefs(text: string): CitedRef[] {
  const seen = new Set<string>();
  const out: CitedRef[] = [];
  for (const m of text.matchAll(REF_PATTERN)) {
    const slug = m[1];
    let repo: RefRepo;
    if (!slug || slug === SELF_SLUG) repo = "self";
    else if (slug === UPSTREAM_SLUG) repo = "upstream";
    else continue; // Not a repository this check resolves — see REF_PATTERN.
    const ref: CitedRef = { repo, number: Number(m[2]) };
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * The body of the spec doc's `## Tags` section.
 *
 * Returns `null` when there is no such heading — which is not an error: a spec
 * doc is only required for a spec that has one, and `CONTRIBUTING.md` puts the
 * permanent-absence reason in this section specifically.
 */
export function tagsSection(docText: string): string | null {
  const lines = docText.split("\n");
  const start = lines.findIndex((l) => /^#{2,}\s+Tags\b/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The `QA-CHECKLIST.md` bullets that name a spec.
 *
 * Matched on the BASENAME with a boundary, for the reason
 * `buildTrackerIndex` documents: a bare `includes` on `run-flow.spec.ts` also
 * matches inside `api-run-flow.spec.ts`, and this tree contains three such
 * pairs.
 */
export function checklistBullets(
  checklistText: string,
  specPath: string,
): JustificationSource[] {
  const basename = specPath.split("/").pop() as string;
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_.\\-])${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const out: JustificationSource[] = [];
  checklistText.split("\n").forEach((line, i) => {
    if (!pattern.test(line)) return;
    out.push({
      kind: "checklist",
      file: "QA-CHECKLIST.md",
      line: i + 1,
      text: line,
    });
  });
  return out;
}

// ─── Candidate selection ─────────────────────────────────────────────────────

function laneTagsOf(test: DeclaredTest): string[] {
  return LANE_TAGS.filter((t) => test.tags.includes(t));
}

/**
 * The spec files whose `@stable` absence needs a written justification: no test
 * in the file carries the tag, and the file is not kept out of the daily by a
 * lane selector instead (#1010 — those are excluded by design, not gated).
 *
 * File-level, not test-level, on purpose. The justification the repo requires
 * lives in the doc's `## Tags` section and in a Part II bullet, and both are
 * written per SPEC; a file with one `@stable` test and one without carries a
 * per-test explanation in prose, and deciding which sentence belongs to which
 * test is the prose parsing this design exists to avoid.
 */
export function candidateSpecs(tests: DeclaredTest[]): string[] {
  const bySpec = new Map<string, DeclaredTest[]>();
  for (const t of tests) {
    const list = bySpec.get(t.relativePath) ?? [];
    list.push(t);
    bySpec.set(t.relativePath, list);
  }
  const out: string[] = [];
  for (const [spec, group] of bySpec) {
    if (group.some((t) => t.stable)) continue;
    if (group.every((t) => laneTagsOf(t).length > 0)) continue;
    out.push(spec);
  }
  return out.sort();
}

// ─── Classification ──────────────────────────────────────────────────────────

export function classifyGates(input: GateInput): GateVerdict {
  const {
    tests,
    justifications,
    refStates,
    trackedSpecs,
    declarations,
    lookupError,
  } = input;

  const declBySpec = new Map<string, GateDecl>();
  for (const d of declarations) declBySpec.set(d.spec, d);

  const specs = candidateSpecs(tests);
  const verdict: GateVerdict = {
    expired: [],
    unknown: [],
    live: [],
    declared: [],
    staleDeclarations: [],
    counts: { candidateSpecs: specs.length, withRefs: 0, refs: 0 },
  };

  const allRefs = new Set<string>();

  for (const spec of specs) {
    const j = justifications[spec];
    const declaration = declBySpec.get(spec) ?? null;
    const sources = j?.sources ?? [];
    const refs = extractRefs(sources.map((s) => s.text).join("\n"));
    const trackedBy = trackedSpecs[spec] ?? [];
    const base = { spec, sources, trackedBy, declaration };

    if (j?.readError) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        refs: [],
        reason: j.readError,
      });
      continue;
    }

    // No reference cited ⇒ no justification of this kind to verify. Counted,
    // not listed: most candidate specs are inherited ones with no prose gate,
    // and listing them would drown the findings (#1252's noise lesson).
    if (refs.length === 0) continue;
    verdict.counts.withRefs++;
    for (const r of refs) allRefs.add(refKey(r));

    // Asking failed ⇒ nothing is decided. Rule 1's failure mode from the other
    // side: "we could not look it up" must never render as "the gate is dead".
    if (lookupError) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        refs: refs.map((ref) => ({
          ref,
          state: { kind: "unresolved", reason: lookupError } as RefState,
        })),
        reason: `the reference lookup failed (${lookupError}), so it is unknown whether the cited gate is still open`,
      });
      continue;
    }

    const resolved: ResolvedRef[] = refs.map((ref) => ({
      ref,
      state: refStates[refKey(ref)] ?? {
        kind: "unresolved",
        reason: "no state was produced for this reference",
      },
    }));

    const unresolved = resolved.filter((r) => r.state.kind === "unresolved");
    if (unresolved.length > 0) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        refs: resolved,
        reason: unresolved
          .map(
            (r) =>
              `${refLabel(r.ref)}: ${
                r.state.kind === "unresolved" ? r.state.reason : ""
              }`,
          )
          .join("; "),
      });
      continue;
    }

    // Rule 1: one live reference is enough for the justification to stand.
    if (resolved.some((r) => r.state.kind === "open")) {
      verdict.live.push({ ...base, state: "live", refs: resolved });
      continue;
    }

    if (declaration) {
      verdict.declared.push({ ...base, state: "declared", refs: resolved });
      continue;
    }

    // Rule 2: an open issue naming the spec is CONTEXT on the finding, never a
    // suppressor of it.
    verdict.expired.push({ ...base, state: "expired", refs: resolved });
  }

  verdict.counts.refs = allRefs.size;

  // ─── Rule 5, the other direction ───────────────────────────────────────────
  const candidateSet = new Set(specs);
  const declaredSpecs = new Set(
    tests.map((t) => t.relativePath),
  );
  for (const d of declarations) {
    if (!declaredSpecs.has(d.spec)) {
      verdict.staleDeclarations.push({
        declaration: d,
        reason:
          "no spec with this path declares any test — the declaration protects nothing (a rename needs the declaration updated with it)",
      });
      continue;
    }
    if (!candidateSet.has(d.spec)) {
      verdict.staleDeclarations.push({
        declaration: d,
        reason:
          "the spec now carries `@stable` (or is lane-gated), so there is no absence left for a justification to explain",
      });
      continue;
    }
    const j = justifications[d.spec];
    if (j?.readError) continue; // Undecidable, already reported as an unknown row.
    const cited = new Set(
      extractRefs((j?.sources ?? []).map((s) => s.text).join("\n")).map(refKey),
    );
    const gone = d.refs.filter((r) => !cited.has(normalizeDeclRef(r)));
    if (gone.length > 0) {
      verdict.staleDeclarations.push({
        declaration: d,
        reason: `the justification no longer cites ${gone.join(", ")}, so the declaration covers a citation that is not there any more`,
      });
    }
  }

  return verdict;
}

/**
 * A declaration writes a reference the way prose does (`#820`,
 * `langflow-ai/langflow#14512`); `refKey` is the internal spelling. Normalising
 * here rather than storing the internal form keeps the declarations file
 * readable, which is the only reason anyone will keep it accurate.
 */
export function normalizeDeclRef(raw: string): string {
  const refs = extractRefs(raw.startsWith("#") ? ` ${raw}` : raw);
  return refs.length > 0 ? refKey(refs[0]) : raw;
}

/** Whether the verdict has anything a human must act on. */
export function hasGateFindings(v: GateVerdict): boolean {
  return (
    v.expired.length > 0 ||
    v.unknown.length > 0 ||
    v.staleDeclarations.length > 0
  );
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function refCell(refs: ResolvedRef[]): string {
  if (refs.length === 0) return "—";
  return refs
    .map((r) => {
      const label = refLabel(r.ref);
      switch (r.state.kind) {
        case "open":
          return `${label} — open`;
        case "closed":
          return `${label} — closed`;
        case "merged":
          return `${label} — merged`;
        default:
          return `${label} — **unresolved**`;
      }
    })
    .join("<br>");
}

function sourceCell(sources: JustificationSource[]): string {
  if (sources.length === 0) return "—";
  return sources.map((s) => `\`${s.file}\`:${s.line}`).join("<br>");
}

export interface GateRenderOptions {
  declarationsPath: string;
}

export function renderGateSection(
  v: GateVerdict,
  opts: GateRenderOptions,
): string {
  const lines: string[] = [];

  lines.push("## Gate justifications that no longer cite a live issue");
  lines.push("");
  lines.push(
    `**${v.expired.length} expired**, ${v.unknown.length} undecidable, ` +
      `${v.staleDeclarations.length} expired declaration(s), ` +
      `${v.live.length} live, ${v.declared.length} declared provenance.`,
  );
  lines.push("");
  lines.push(
    "A spec whose tests carry no `@stable` has to say why, in the doc's `## Tags` " +
      "section or in its Part II bullet. This checks the issues that prose cites " +
      "are still open. **Every** cited reference being closed is the finding — one " +
      "live reference means the justification still stands (#1783).",
  );
  lines.push("");

  if (v.expired.length > 0) {
    lines.push("### Expired — nothing cited is still open");
    lines.push("");
    lines.push("| Spec | Cited | Written in | Open issues naming this spec |");
    lines.push("|---|---|---|---|");
    for (const r of v.expired) {
      const context =
        r.trackedBy.length > 0
          ? r.trackedBy.map((t) => `[#${t.number}](${t.url})`).join(", ")
          : "—";
      lines.push(
        `| \`${r.spec}\` | ${refCell(r.refs)} | ${sourceCell(r.sources)} | ${context} |`,
      );
    }
    lines.push("");
    lines.push(
      "Resolve a row by promoting the spec, by re-justifying it against a reason " +
        "that is still live, or — when the citation is PROVENANCE rather than a " +
        `gate — by declaring it in \`${opts.declarationsPath}\`. The last column ` +
        "is CONTEXT, not ownership: an open issue naming the spec does not clear " +
        "the row, but it is usually what the prose should have cited instead.",
    );
    lines.push("");
  }

  if (v.unknown.length > 0) {
    lines.push("### Undecidable — reported, not assumed clean (#1012)");
    lines.push("");
    lines.push("| Spec | Cited | Why |");
    lines.push("|---|---|---|");
    for (const r of v.unknown) {
      lines.push(
        `| \`${r.spec}\` | ${refCell(r.refs)} | ${esc(r.reason ?? "unspecified")} |`,
      );
    }
    lines.push("");
    lines.push(
      "A bare `#N` that does not resolve here is the common case, and it is not a " +
        "dead gate: this repo's prose cites upstream pull requests without their " +
        "`langflow-ai/langflow#` prefix. Add the prefix and the row decides itself.",
    );
    lines.push("");
  }

  if (v.staleDeclarations.length > 0) {
    lines.push("### Declarations that expired");
    lines.push("");
    lines.push(
      "Verified in both directions on purpose (#1084): a declaration that stops " +
        "being true has to surface, or this check grows the silent-expiry problem " +
        `it exists to close. Edit \`${opts.declarationsPath}\`.`,
    );
    lines.push("");
    lines.push("| Spec | Declared refs | Declared reason | Problem |");
    lines.push("|---|---|---|---|");
    for (const p of v.staleDeclarations) {
      lines.push(
        `| \`${p.declaration.spec}\` | ${p.declaration.refs.join(", ")} | ${esc(p.declaration.reason)} | **expired** — ${esc(p.reason)} |`,
      );
    }
    lines.push("");
  }

  if (v.declared.length > 0) {
    lines.push("<details><summary>");
    lines.push(`${v.declared.length} declared-provenance citation(s)</summary>`);
    lines.push("");
    lines.push("| Spec | Declared reason | Ref |");
    lines.push("|---|---|---|");
    for (const r of v.declared) {
      lines.push(
        `| \`${r.spec}\` | ${esc(r.declaration?.reason ?? "")} | ${r.declaration?.ref ?? "—"} |`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push(
    `Scanned ${v.counts.candidateSpecs} spec file(s) with no \`@stable\` test; ` +
      `${v.counts.withRefs} cite an issue in their justification, over ` +
      `${v.counts.refs} distinct reference(s).`,
  );

  return lines.join("\n");
}
