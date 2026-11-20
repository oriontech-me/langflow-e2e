import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * An accessibility scan of one surface, judged against a declared baseline of the
 * violations the product ships today (#2304).
 *
 * The baseline follows #1084's two-sided rule, the one `expectKnownHttpError`
 * applies to HTTP errors: a violation that is not declared fails the test, and so
 * does a declared one that no longer fires. A stale entry is the failure that rule
 * exists for — an exemption whose reason expired and still hides the next real
 * violation of the same rule.
 */

/**
 * The rule set: WCAG 2.0, 2.1 and 2.2 at levels A and AA. axe's `best-practice`
 * rules are left out on purpose. Measured on 1.14.0.dev32, the one they add on
 * `/settings/connections` is `page-has-heading-one`, which is about the page
 * shell and not about any Connections surface, and a scan scoped to a surface
 * cannot judge a page-level rule anyway.
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export interface KnownViolation {
  /** The axe rule id, e.g. `color-contrast`. */
  rule: string;
  /** Why it is accepted, and where it is tracked. */
  reason: string;
}

/** One axe violation, reduced to what the verdict needs. */
export interface FoundViolation {
  rule: string;
  impact: string | null;
  /** The CSS targets of the offending nodes. */
  targets: string[];
}

export interface BaselineVerdict {
  /** Found and not declared. */
  unexpected: FoundViolation[];
  /** Declared and not found. */
  stale: KnownViolation[];
}

export function baselineVerdict(found: FoundViolation[], known: KnownViolation[]): BaselineVerdict {
  const declared = new Set(known.map((k) => k.rule));
  const fired = new Set(found.map((f) => f.rule));
  return {
    unexpected: found.filter((f) => !declared.has(f.rule)),
    stale: known.filter((k) => !fired.has(k.rule)),
  };
}

export function baselineMessage(surface: string, verdict: BaselineVerdict): string {
  const lines: string[] = [];
  for (const v of verdict.unexpected) {
    lines.push(
      `${surface}: undeclared violation ${v.rule} (${v.impact ?? "no impact"}) on ` +
        `${v.targets.length} node(s): ${v.targets.slice(0, 5).join(" | ")}`,
    );
  }
  for (const k of verdict.stale) {
    lines.push(
      `${surface}: declared violation ${k.rule} no longer fires — delete it from the ` +
        `baseline (it was accepted because: ${k.reason})`,
    );
  }
  return lines.join("\n");
}

/**
 * Waits until every running animation on the page has finished.
 *
 * Load-bearing, not defensive. Measured on 1.14.0.dev32: the Add dialog fades and
 * zooms in, and a scan taken while it is still animating reads its muted text at
 * partial opacity — 12 `color-contrast` violations that are gone once the
 * animation ends.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}

export interface SurfaceScan {
  violations: FoundViolation[];
  /**
   * How many rules applied to the scoped nodes (passed or violated). axe throws
   * when the scope matches no element at all (`No elements found for include`,
   * measured on 4.13.0); this count covers the quieter case, a scope that matched
   * an element no WCAG rule applies to, which would otherwise read as clean.
   */
  rulesApplied: number;
  /**
   * Rules axe could not decide on these nodes (its `incomplete` bucket, e.g. a
   * `color-contrast` over a gradient or partial opacity). Not judged by the
   * baseline; returned so a caller can record them instead of dropping them.
   */
  needsReview: FoundViolation[];
}

/** Scans the elements matching `include` against the WCAG rule set. */
export async function scanSurface(page: Page, include: string): Promise<SurfaceScan> {
  await settleAnimations(page);
  const result = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).include(include).analyze();
  return {
    violations: result.violations.map((v) => ({
      rule: v.id,
      impact: v.impact ?? null,
      targets: v.nodes.map((n) => n.target.join(" ")),
    })),
    rulesApplied: result.passes.length + result.violations.length,
    needsReview: result.incomplete.map((v) => ({
      rule: v.id,
      impact: v.impact ?? null,
      targets: v.nodes.map((n) => n.target.join(" ")),
    })),
  };
}
