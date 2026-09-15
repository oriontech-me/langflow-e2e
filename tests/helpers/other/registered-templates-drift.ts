/**
 * The registered starter-template set, and the drift verdict the registration
 * spec asserts on (#1862).
 *
 * `GET /api/v1/flows/basic_examples/` is the listing the New Flow gallery reads.
 * Which templates are in it is decided at startup by
 * `filter_starter_projects_by_available_components`
 * (`src/backend/base/langflow/initial_setup/setup.py`): a starter project whose
 * node types are not all in the live component registry is dropped, with one
 * exemption — a node carrying its own `template.code` and no `metadata.module`
 * is an embedded custom component and never counts as missing. That exemption is
 * why *Meeting Summary* is registered although `AssemblyAITranscriber` is absent
 * from `GET /api/v1/all`, and therefore why the expectation is derived from THE
 * LISTING and never from the component catalog.
 *
 * ## Why the comparison keys on `name_key`
 *
 * The endpoint is localized by `Accept-Language` (#1400). Measured on
 * `1.13.0.dev12`, the same 26 entries answer with a translated `name` while
 * `name_key` is unchanged:
 *
 *     en-US  name="Basic Prompting"    name_key="basic_prompting"
 *     pt-BR  name="Sugestões básicas"  name_key="basic_prompting"
 *
 * `name_key` is a persisted column — "Stable i18n key derived from the original
 * English name" (`services/database/models/flow/model.py`), produced by
 * `safe_flow_key` (`utils/i18n_keys.py`) — and it is the key upstream's own
 * catalog blocklist filters on. So the set comparison keys on it: an identity
 * must not depend on a request header any caller can set.
 *
 * **Two wrong reasons were written here before the right one, and both are worth
 * knowing because each pointed at a trap that does not exist.** What is measured
 * on `1.13.0.dev12` is only this:
 *
 *  - `Accept-Language: pt-BR` really does translate `name`, leaving `name_key`
 *    untouched — the localization is real;
 *  - **no header at all answers English**, because `set_locale` defaults to `en`;
 *  - `PW_LOCALE=pt-BR` does **not** change this endpoint's answer. Playwright does
 *    carry the context's `locale` into the `APIRequestContext`, but it never
 *    reaches the wire as `Accept-Language`, so the first wrong version — "keying
 *    on `name` would report 26 missing plus 26 extra under `PW_LOCALE=pt-BR`" —
 *    describes a run that cannot happen;
 *  - **deleting the `Accept-Language` pin from the spec leaves it GREEN** (all
 *    three pins removed, 2 passed). So the second wrong version — "the `name`
 *    comparison is what goes red when the pin breaks" — is false too: the pin is
 *    explicitness, not a gate, as long as the backend's default stays `en`.
 *
 * What the `name` comparison actually buys, then, is an upstream **rename** —
 * which is the signal that matters, because S1 (`templates-instantiate`, #1864)
 * picks a template's card by its display name and would report a rename as an
 * unexplained click timeout. It would also catch a locale that genuinely reached
 * the request by some future route (a lane adding `extraHTTPHeaders`, a proxy, an
 * upstream change to the default) — but that is a hypothesis, not a measurement,
 * and it is written as one here on purpose.
 *
 * ## Layering
 *
 * Everything here is pure and `registrationVerdict` **cannot throw**, so the spec
 * holds nothing but I/O. Copied from `component-catalog-drift.ts` and
 * `api-surface-drift.ts` because that split is what made their guarantee
 * unit-testable rather than asserted — and because a comparison that sat outside
 * its guards once aborted `globalSetup` with zero tests executed.
 *
 * There is no fourth verdict state: a listing that cannot be read is UNKNOWN with
 * the reason named, never clean (#1012).
 */

/** One template as the baseline records it. */
export interface BaselineTemplate {
  /** `safe_flow_key(name)` — locale-invariant, the comparison key. */
  nameKey: string;
  /** The English display name, as answered under `Accept-Language: en-US`. */
  name: string;
}

/**
 * A template the image is known NOT to register, with the reason it does not.
 *
 * Verified in both directions (#1084): the day the template comes back, the spec
 * FAILS naming the declaration to delete, because an exemption whose
 * justification expired silently is worse than no exemption at all.
 */
export interface DeclaredAbsence extends BaselineTemplate {
  /** Why this image does not register it. Rendered in the failure message. */
  reason: string;
  /** The issue that tracks lifting it, e.g. `#1744`. */
  issue: string;
  /**
   * The component types whose absence drops the template, when that is the
   * cause. Documentation carried into the failure message so a reader does not
   * have to re-derive it; never used as a gate — deriving the expectation from
   * the catalog is exactly what *Meeting Summary* shows to be wrong.
   */
  unavailableComponents?: string[];
}

/** The committed baseline — `tests/assets/templates/registered-templates-baseline.json`. */
export interface RegisteredTemplatesBaseline {
  /** Langflow version it was captured from, for the report line. Never asserted. */
  version?: string;
  templates: BaselineTemplate[];
  declaredAbsences: DeclaredAbsence[];
}

/** One entry of the live listing, reduced to what the comparison needs. */
export interface ListedTemplate {
  nameKey: string;
  name: string;
}

export interface RegistrationVerdict {
  /**
   * `clean` — the registered set is the baseline's (extras excepted, which are
   * reported). `drift` — something is missing, renamed, or a declaration
   * expired. `unknown` — no comparison was possible, with `reason` naming why.
   */
  kind: "clean" | "drift" | "unknown";
  /** Baseline templates absent from the listing and NOT declared absent. Failing. */
  missing: BaselineTemplate[];
  /** Declared absences the listing now carries. Failing (#1084). */
  staleDeclarations: DeclaredAbsence[];
  /**
   * Templates present whose English name differs from the baseline's. Failing:
   * either upstream renamed it, or the `Accept-Language` pin stopped being
   * honoured — and the second would silently break S1's card click.
   */
  renamed: Array<{ nameKey: string; expected: string; actual: string }>;
  /**
   * Templates the baseline does not know. **Reported, never failed** (#980's
   * trade): a new upstream template costs nobody a test, and accepting it is a
   * reviewed baseline refresh.
   */
  extra: ListedTemplate[];
  /** Why no verdict was possible. Set iff `kind === "unknown"`. */
  reason?: string;
  /** Baseline templates actually compared. 0 when unknown. */
  comparedCount: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * The templates `GET /api/v1/flows/basic_examples/` carries.
 *
 * `null` means **no signal**, which the verdict turns into UNKNOWN. Three bodies
 * produce it, and each would otherwise diff as "every template was removed":
 *
 *  - a body that is not an array (an error envelope, `{"detail": …}`);
 *  - an empty array, which is what a still-starting instance answers;
 *  - an entry with no usable `name_key`. The column is nullable on the flow
 *    model, so an image that stopped populating it must be UNKNOWN rather than
 *    26 spurious removals.
 */
export function listedTemplates(body: unknown): ListedTemplate[] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const out: ListedTemplate[] = [];
  for (const entry of body) {
    if (!isRecord(entry)) return null;
    const nameKey = entry.name_key;
    if (!isNonEmptyString(nameKey)) return null;
    out.push({
      nameKey,
      name: isNonEmptyString(entry.name) ? entry.name : "",
    });
  }
  return out;
}

/**
 * Whether a parsed baseline is usable, and why it is not when it is not.
 *
 * Returns `null` when it is fine. A malformed baseline is the failure mode the
 * catalog guard paid for once: the most natural hand-repair parsed, passed the
 * shape check and then threw out of the comparison. Every field the verdict
 * reads is validated here, so `registrationVerdict` can be total.
 */
export function describeBaselineDefect(
  baseline: unknown,
): string | null {
  if (!isRecord(baseline)) return "the baseline is not a JSON object";
  if (!Array.isArray(baseline.templates)) {
    return "the baseline has no `templates` array";
  }
  if (baseline.templates.length === 0) {
    return "the baseline's `templates` array is empty — refusing to report every registered template as extra";
  }
  for (const [i, t] of baseline.templates.entries()) {
    if (!isRecord(t) || !isNonEmptyString(t.nameKey) || !isNonEmptyString(t.name)) {
      return `the baseline's templates[${i}] is not { nameKey, name } with non-empty strings`;
    }
  }
  if (!Array.isArray(baseline.declaredAbsences)) {
    // Absent is a different claim from empty, and only the second is a decision.
    return "the baseline has no `declaredAbsences` array (use [] to declare there are none)";
  }
  for (const [i, d] of baseline.declaredAbsences.entries()) {
    if (!isRecord(d) || !isNonEmptyString(d.nameKey) || !isNonEmptyString(d.name)) {
      return `the baseline's declaredAbsences[${i}] is not { nameKey, name, reason, issue } with non-empty strings`;
    }
    if (!isNonEmptyString(d.reason) || !isNonEmptyString(d.issue)) {
      return `the baseline's declaredAbsences[${i}] (${d.nameKey}) carries no reason or no issue — a declaration without either is the silent exemption #1084 forbids`;
    }
    // Optional, but `describeStaleDeclarations` joins it. Left unvalidated, the
    // plausible hand-edit `"unavailableComponents": "ArXivComponent"` (a string
    // where an array belongs) passed this check and then threw
    // `TypeError: d.unavailableComponents.join is not a function` out of the
    // stale-declaration branch — losing the "close #N and delete the declaration"
    // message on the exact failure it exists to report.
    if (
      d.unavailableComponents !== undefined &&
      (!Array.isArray(d.unavailableComponents) ||
        !d.unavailableComponents.every((c) => isNonEmptyString(c)))
    ) {
      return `the baseline's declaredAbsences[${i}] (${d.nameKey}) has an unavailableComponents that is not an array of non-empty strings`;
    }
  }
  const keys = new Set<string>();
  for (const t of baseline.templates as BaselineTemplate[]) {
    if (keys.has(t.nameKey)) return `the baseline lists ${t.nameKey} twice`;
    keys.add(t.nameKey);
  }
  for (const d of baseline.declaredAbsences as DeclaredAbsence[]) {
    if (keys.has(d.nameKey)) {
      return `the baseline both expects and declares absent ${d.nameKey} — it cannot be checked either way`;
    }
    keys.add(d.nameKey);
  }
  return null;
}

/**
 * Whether the listing side is usable. `null` when it is.
 *
 * `listedTemplates` already guarantees this for its own output, so within this
 * module the check is redundant — and it is here anyway because the guarantee
 * above is stated unconditionally and S1 (#1864) parametrizes over this module.
 * Without it, `registrationVerdict(baseline, [null])` threw a `TypeError`, which
 * makes "cannot throw" a claim about one call site rather than a property.
 */
function describeListingDefect(listed: ListedTemplate[]): string | null {
  if (!Array.isArray(listed)) return "the listing side is not an array";
  for (const [i, t] of listed.entries()) {
    if (!isRecord(t) || !isNonEmptyString(t.nameKey)) {
      return `the listing side's entry [${i}] is not { nameKey, name } with a non-empty nameKey`;
    }
  }
  return null;
}

/**
 * The drift verdict. **Cannot throw** — every unusable input becomes UNKNOWN,
 * on both sides, for any caller and not only for `listedTemplates`' output.
 *
 * `listed` is `null` when the listing carried no signal (see `listedTemplates`).
 */
export function registrationVerdict(
  baseline: unknown,
  listed: ListedTemplate[] | null,
): RegistrationVerdict {
  const empty = {
    missing: [] as BaselineTemplate[],
    staleDeclarations: [] as DeclaredAbsence[],
    renamed: [] as RegistrationVerdict["renamed"],
    extra: [] as ListedTemplate[],
  };

  const defect = describeBaselineDefect(baseline);
  if (defect) {
    return { kind: "unknown", ...empty, reason: defect, comparedCount: 0 };
  }
  if (listed === null) {
    return {
      kind: "unknown",
      ...empty,
      reason:
        "GET /api/v1/flows/basic_examples/ carried no readable template list " +
        "(not an array, empty, or an entry with no name_key) — an unreadable listing is unknown, never clean",
      comparedCount: 0,
    };
  }
  const listingDefect = describeListingDefect(listed);
  if (listingDefect) {
    return { kind: "unknown", ...empty, reason: listingDefect, comparedCount: 0 };
  }

  const b = baseline as RegisteredTemplatesBaseline;
  const byKey = new Map(listed.map((t) => [t.nameKey, t]));

  const missing: BaselineTemplate[] = [];
  const renamed: RegistrationVerdict["renamed"] = [];
  for (const expected of b.templates) {
    const live = byKey.get(expected.nameKey);
    if (!live) {
      missing.push(expected);
      continue;
    }
    if (live.name !== expected.name) {
      renamed.push({ nameKey: expected.nameKey, expected: expected.name, actual: live.name });
    }
  }

  const staleDeclarations = b.declaredAbsences.filter((d) => byKey.has(d.nameKey));

  const known = new Set<string>([
    ...b.templates.map((t) => t.nameKey),
    ...b.declaredAbsences.map((d) => d.nameKey),
  ]);
  const extra = listed.filter((t) => !known.has(t.nameKey));

  const drifted =
    missing.length > 0 || staleDeclarations.length > 0 || renamed.length > 0;

  return {
    // `extra` deliberately does not make the verdict drift: it is reported, and
    // reporting it is what keeps a green run honest about being narrower.
    kind: drifted ? "drift" : "clean",
    missing,
    staleDeclarations,
    renamed,
    extra,
    comparedCount: b.templates.length,
  };
}

/** One human line per missing template, for the assertion message. */
export function describeMissing(missing: BaselineTemplate[]): string {
  return missing
    .map((t) => `  • ${t.nameKey} ("${t.name}") is in the baseline but not in the listing`)
    .join("\n");
}

/** One human line per stale declaration, naming both remedies (#1084). */
export function describeStaleDeclarations(stale: DeclaredAbsence[]): string {
  return stale
    .map(
      (d) =>
        `  • ${d.nameKey} ("${d.name}") is declared absent but the image registers it.\n` +
        `      declared because: ${d.reason}\n` +
        `      tracked by: ${d.issue}` +
        (d.unavailableComponents?.length
          ? `\n      the declaration names these components as unavailable: ${d.unavailableComponents.join(", ")}`
          : "") +
        `\n      Either the image gained what it lacked — close ${d.issue} and delete this declaration —\n` +
        `      or this is not the nightly the baseline was captured from, in which case refresh the\n` +
        `      baseline against this image (npm run templates:baseline).`,
    )
    .join("\n");
}

/** One human line per renamed template, for the assertion message. */
export function describeRenamed(renamed: RegistrationVerdict["renamed"]): string {
  return renamed
    .map(
      (r) =>
        `  • ${r.nameKey} answers "${r.actual}" where the baseline recorded "${r.expected}".\n` +
        `      Either upstream renamed the template, or Accept-Language: en-US stopped being honoured —\n` +
        `      the second silently breaks every spec that picks a template card by its display name.`,
    )
    .join("\n");
}

/** The report line for extras. Never a failure (#980). */
export function describeExtra(extra: ListedTemplate[]): string {
  if (extra.length === 0) return "";
  return (
    `📌 ${extra.length} template(s) the baseline does not know — reported, not failed:\n` +
    extra.map((t) => `  • ${t.nameKey} ("${t.name}")`).join("\n") +
    `\n  Accept them with: npm run templates:baseline (a committed diff, reviewed like any other).`
  );
}
