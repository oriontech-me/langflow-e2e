// The ONE spelling of the reason a provider-health skip carries (issue #1456).
//
// ## Why a shared module and not a regex at the reading end
//
// `collect-models` records a provider `inactive` when its key is dead, and the gate
// in `tests/helpers/provider-setup/provider-health.ts` turns that record into a
// `test.skip` whose description is the whole product of the skip — it is what lands
// in the Playwright report and what a human reads. Until #1456 nothing else read it
// back, so the wording lived in one place and a change to it cost nothing.
//
// It is now a CONTRACT: `scripts/lane-coverage-verdict.mjs` classifies a run by
// asking which skips were provider-health skips, and it can only ask that of the
// text. A consumer with its own copy of the pattern is the failure #1226 recorded in
// another shape — a guard that pins a spelling rather than a behaviour goes green the
// day the spelling moves, and here it would go green by finding NO provider-health
// skip at all, i.e. by reporting the run as fully covered. So producer and consumer
// read one formatter and one parser, and the round trip is unit-tested: a change to
// the wording is then either made in both directions at once or fails the lane.
//
// ## Why `.mjs` under `scripts/lib/`
//
// Same reason `spec-path.mjs` lives there (#1589): the two sides run in different
// worlds. The producer is TypeScript loaded by Playwright's own transform at spec
// collection time; the consumer is a dependency-free script the workflows run with
// plain `node`, with no ts-node available in the merge job. A `.mjs` with a
// hand-written `.d.mts` is the only shape both can import, and it is the shape this
// repo already uses for exactly this problem.
//
// Deliberately NOT covered here: the OTHER reason `provider-health.ts` can produce,
// `"<KEY> required to run this test"` (an env key absent altogether). That is a
// different failure — the key is missing, not dead — and on both lanes wired to the
// verdict the keys come from repo secrets, so its meaning there is a workflow
// misconfiguration, which `globalSetup`'s credential pre-flight (#884) already
// hard-fails on and #1764's collection gate already guards. Recognising it here
// would widen the verdict's trigger to a case that cannot reach a green run.

/** What an `inactive` record with no `error` reads as. Kept identical to the string
 *  `provider-health.ts` has always emitted, so no skip line changes wording. */
export const NO_REASON_RECORDED = "no reason recorded by collect-models";

/**
 * The skip description for one `inactive` provider record.
 *
 * `error` is passed through with `??` rather than a falsy check, so an empty string
 * stays an empty string — that is what the gate did before this module existed, and
 * a refactor must not change what the report says.
 *
 * @param {string} provider provider name as `collect-models` recorded it
 * @param {string|null|undefined} error the reason it measured
 * @returns {string}
 */
export function formatProviderInactiveReason(provider, error) {
  return `Provider "${provider}" inactive — ${error ?? NO_REASON_RECORDED}`;
}

// The separator is matched as `\s*—\s*` rather than as the literal " — " the
// formatter writes: the description reaches the parser through a JSON report and a
// `.trim()`, and an `error` that is empty leaves the trailing space with nothing
// after it. Tolerating that shape is what keeps a hand-edited providers.json from
// reading as "not a provider-health skip at all" — the one classification error that
// would put the run back to the silent green this exists to remove.
const INACTIVE_REASON = /^Provider "([^"]+)" inactive\s*—\s*([\s\S]*)$/;

/**
 * Reads a skip description back, or `null` when it is not a provider-health skip.
 *
 * `null` is the answer for every other skip a run legitimately carries — `fixme`, a
 * lane selector, `MODEL_NOT_AVAILABLE`, the capability reasons in `test-targets.ts`
 * — and the verdict counts those as ordinary skips. Being strict here is what keeps
 * "this lane did not cover openai" from being claimed about a spec that skipped
 * because the model cannot see images.
 *
 * @param {unknown} description a `skip` annotation's description
 * @returns {{ provider: string, error: string }|null}
 */
export function parseProviderInactiveReason(description) {
  if (typeof description !== "string") return null;
  const match = INACTIVE_REASON.exec(description.trim());
  if (!match) return null;
  return { provider: match[1], error: match[2] };
}
