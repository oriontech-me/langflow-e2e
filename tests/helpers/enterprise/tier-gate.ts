/**
 * Name the Enterprise licence-tier gate when it is what refused a request.
 *
 * Since the 1.13 line an unlicensed Enterprise instance fails CLOSED on its tier
 * gates (EE PR 336 / LE-2501, EE PR 344 / LE-2488): user, project and custom-role
 * creation and every governance route answer
 * `503 {"detail":"Enterprise license validation is unavailable"}` unless the
 * instance runs with `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`.
 *
 * Every helper that creates something asserts its own status, so without this
 * the same environment problem surfaces as twenty unrelated status mismatches,
 * each inside whichever step happened to create first — and a 503 on a policy
 * route reads exactly like a product outage. The start script sets the flag and
 * probes for it (#2259); this is what names the cause when a run reaches an
 * instance started some other way.
 *
 * Only the LICENCE detail is classified. The same module answers
 * `503 Tier limit enforcement is unavailable` when it cannot count existing
 * rows — a different cause, which the flag does not fix, so it is left to read
 * as the plain 503 it is.
 */

/** The variable that opens the tier gates on an unlicensed instance. */
export const TIER_GATE_FLAG = "LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES";

/** The `detail` Enterprise answers when no licence can be resolved. */
export const LICENCE_UNAVAILABLE_DETAIL = "Enterprise license validation is unavailable";

/**
 * Why `status`/`body` is the tier gate, or `undefined` when it is not.
 *
 * Matched on the detail TEXT rather than on the status alone: a 503 is also what
 * a wedged backend or an unconfigured Control Plane answers, and calling those
 * "the licence" would misdirect the reader just as badly as the bare mismatch.
 */
export function tierGateCause(status: number, body: string): string | undefined {
  if (status !== 503 || !body.includes(LICENCE_UNAVAILABLE_DETAIL)) return undefined;
  return (
    `The Enterprise licence-tier gate refused it ("${LICENCE_UNAVAILABLE_DETAIL}"). ` +
    `An unlicensed instance fails closed on user/project/role creation and on the ` +
    `governance routes unless it runs with ${TIER_GATE_FLAG}=true. ` +
    `scripts/start-langflow-enterprise.sh sets it — restart the instance with that ` +
    `script, or add the variable to however this one was started.`
  );
}

/**
 * Throw a named error when the tier gate refused `what`; return otherwise, so
 * the caller's own status assertion still runs for every other answer.
 */
export function assertNotTierGated(what: string, status: number, body: string): void {
  const cause = tierGateCause(status, body);
  if (cause) throw new Error(`${what} answered 503. ${cause}`);
}
