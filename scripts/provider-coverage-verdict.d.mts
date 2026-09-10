// Types for `provider-coverage-verdict.mjs`, so the TypeScript lane can run the ONE
// implementation against the ONE producer of the skip reason it parses (#1456) — the
// same reason `scripts/lib/tmp-dir.d.mts` exists (#1732): a declaration file, never a
// second copy, because a fork of the parser would be a fork of the contract it pins.
//
// Only the surface `provider-health.test.ts` needs is declared. The CLI, the renderer
// and the exit-code policy are exercised from `provider-coverage-verdict.test.mjs`,
// which is plain ESM and needs no types.

export interface ProviderCoverageEntry {
  provider: string;
  reason: string;
  skipped: number;
}

export interface ProviderUsability {
  known: boolean;
  active: string[];
}

export interface ProviderCoverageVerdict {
  level: "covered" | "degraded" | "uncovered" | "unknown";
  unverified: ProviderCoverageEntry[];
  skipped: number;
  executed: number;
  gatedFiles: string[];
  totalTests: number;
  usableProviders: string[];
  usabilityKnown: boolean;
}

export declare const PROVIDER_INACTIVE_SKIP: RegExp;

export declare function providerCoverageVerdict(
  report: unknown,
  usability?: ProviderUsability,
): ProviderCoverageVerdict;
