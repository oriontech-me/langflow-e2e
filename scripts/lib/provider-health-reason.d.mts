// Types for provider-health-reason.mjs — see scripts/lib/tmp-dir.d.mts for why the
// `.mjs` helpers carry a hand-written declaration rather than being compiled.
export declare const NO_REASON_RECORDED: string;
export declare function formatProviderInactiveReason(
  provider: string,
  error: string | null | undefined,
): string;
export declare function parseProviderInactiveReason(
  description: unknown,
): { provider: string; error: string } | null;
