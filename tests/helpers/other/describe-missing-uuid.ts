/**
 * Renders the diagnosis that `agent-max-iterations.spec.ts` attaches to its UUID
 * assertion (#1830).
 *
 * It lives here, pure and pinned by tests, because the rendered message IS the
 * deliverable of that fix: a missing UUID has causes that read identically from
 * the pattern alone, and the whole point is that the artifact a triage reads says
 * which one happened. A renderer that nothing asserts on is how the wrong sentence
 * survives — the #1226 lesson, applied one layer down.
 *
 * The I/O half — reading the persisted message — stays in the spec, so this module
 * takes readings and returns text, and nothing here can throw on a wedged backend.
 */

/** Below this many characters a shared run of hex is chance, not a cut UUID. */
export const TRUNCATION_MIN_OVERLAP = 8;

export interface MissingUuidReading {
  /** What the message bubble rendered. */
  rendered: string;
  /** What the backend persisted for that same message. */
  stored: string;
  /** The UUID the tool itself returned, when its output carries one. */
  fetchedUuid?: string;
  /** The model recorded on the persisted message. */
  model?: string;
  /** The message's usage block, printed as received. */
  usage?: unknown;
}

/**
 * Length of the longest suffix of `rendered` that is a prefix of `fetched` — i.e.
 * how much of the fetched value the answer had spelled out before it stopped.
 *
 * Case-insensitive on purpose: `UUID_SHAPE` is `/i`, so a model that spells the
 * value in uppercase satisfies the assertion. A case-sensitive comparison here
 * would score that answer 0 and report "the model answered without using what it
 * fetched" — the exact misdiagnosis this diagnosis exists to eliminate, and silent.
 */
export function uuidPrefixOverlap(rendered: string, fetched: string): number {
  const a = rendered.toLowerCase();
  const b = fetched.toLowerCase();
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (b.startsWith(a.slice(a.length - n))) return n;
  }
  return 0;
}

export function describeMissingUuid(reading: MissingUuidReading): string {
  const { rendered, stored, fetchedUuid, model, usage } = reading;
  const overlap = fetchedUuid ? uuidPrefixOverlap(rendered, fetchedUuid) : 0;
  const truncated = !!fetchedUuid && overlap >= TRUNCATION_MIN_OVERLAP;

  const head = truncated
    ? `the answer is TRUNCATED, not wrong: it ends in a ${overlap}-character prefix of the UUID ` +
      `the tool actually fetched. This is neither a max_iterations failure nor a fetch failure (#1830).`
    : fetchedUuid
      ? `the tool DID fetch a UUID and the answer does not carry it — the model answered without ` +
        `using what it fetched.`
      : `no UUID appears in the tool output either, so the fetch itself did not deliver one.`;

  const provenance =
    stored.trim() === rendered.trim()
      ? "identical to the rendered text — the cut is upstream of the UI, not a render"
      : `DIFFERENT from the rendered text: ${JSON.stringify(stored.slice(-80))}`;

  const lines = [
    head,
    `  rendered   : ${JSON.stringify(rendered.slice(-80))}`,
    `  persisted  : ${provenance}`,
    `  tool output: ${fetchedUuid ?? "no UUID found"}`,
    `  model      : ${model ?? "unknown"} · usage ${JSON.stringify(usage ?? {})}`,
  ];

  // Only the truncation branch earns this sentence. Printed unconditionally it
  // asserts a cause the other two heads have just ruled out — which, in a diagnosis
  // whose product is honesty, is the next day of misread triage.
  if (truncated) {
    lines.push(
      `A model that spends its output budget before finishing the answer produces exactly this, ` +
        `and lanes that settle a different model do not reproduce it.`,
    );
  }

  return lines.join("\n");
}
