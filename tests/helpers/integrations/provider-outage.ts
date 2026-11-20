/**
 * Names a provider outage in a failure message, so the failure is classified as
 * infra and not as the spec's own (#2298).
 *
 * A spec that drives a connector until the PROVIDER answers depends on that
 * provider being up. When it is not, Langflow reports a typed integration error
 * (`lfx/integrations/errors.py`): `provider-unavailable` (a 5xx), `network-error`
 * (DNS, TLS, refused, dropped, timeout) or `rate-limited`. A plain assertion diff
 * on that code (`expected ["auth-expired"], received ["network-error"]`) matches
 * nothing in `scripts/lib/infra-signature-patterns.json`, so the daily's unreviewed
 * `@stable` auto-removal would score it ATTRIBUTABLE and strip the tag for an
 * outage the spec cannot cause — the #1128 lesson.
 *
 * The test still FAILS (#1010/#1012: an unmeasured run is not a pass). What this
 * changes is only the message: it starts with {@link PROVIDER_OUTAGE_MARKER},
 * which the `provider-outage` entry of that file matches, and nothing else
 * writes it. The marker is produced from the typed code alone, never from prose,
 * so a product error whose text happens to mention an outage cannot reach it.
 */

/** Matched verbatim by the `provider-outage` pattern in `infra-signature-patterns.json`. */
export const PROVIDER_OUTAGE_MARKER = "[provider-outage]";

/**
 * The integration error codes that mean the provider, not Langflow and not the
 * spec, decided the outcome. `auth-expired` is deliberately NOT here: a spec that
 * plants a fake token expects exactly that answer.
 */
export const PROVIDER_OUTAGE_CODES: readonly string[] = ["provider-unavailable", "network-error", "rate-limited"];

/**
 * The failure message for a run whose typed codes include an outage code, or
 * `null` when none does (the caller then uses its ordinary message).
 */
export function providerOutageMessage(provider: string, codes: ReadonlyArray<string | null>): string | null {
  const outage = codes.filter((code): code is string => code !== null && PROVIDER_OUTAGE_CODES.includes(code));
  if (outage.length === 0) return null;
  return (
    `${PROVIDER_OUTAGE_MARKER} ${provider} answered ${outage.join(", ")} — the provider was unavailable, ` +
    `unreachable or rate-limiting, so this run measured nothing about Langflow. Re-run once ${provider} ` +
    `is reachable; do not read this as a regression.`
  );
}
