/**
 * Renders the diagnosis that `agent-max-iterations.spec.ts` attaches to its limit
 * assertion (#1991).
 *
 * Sibling of `describe-missing-uuid.ts`, for the other half of the same spec and
 * for the same reason: the artifact a triage reads has to say WHICH thing happened.
 *
 * The cause it exists to name: `max_iterations` can be enforced and never explained.
 * Measured on 1.13.0.dev19 (#1991, Actions run 35731146480, `claude-haiku-4-5`) —
 * the model answered with a sentence announcing the tool call, the tool ran and
 * returned its value, the cap stopped the run before a second model call, and the
 * persisted message carried `state: complete`, `error: false` and NO mention of the
 * limit anywhere in its text, its content blocks or the API. A cap-terminated run
 * was indistinguishable from a successful one.
 *
 * Read from the outside that is identical to "the cap is broken", and it was read
 * that way for three occurrences across two issues (#1264, then here). The number
 * that separates them is the model call count: the cap fires on the SECOND
 * `before_model`, so enforcement means the run stopped AT one call having entered
 * the tool loop — while a declined tool call is one call with no tool use at all.
 *
 * The I/O half — reading the persisted message — stays in the spec, so this module
 * takes readings and returns text, and nothing here can throw on a wedged backend.
 */

export interface MissingLimitReading {
  /** What the message bubble rendered. */
  rendered: string;
  /** What the backend persisted for that same message. */
  stored: string;
  /** Tool names the persisted message recorded as used. */
  toolNames: string[];
  /** Model calls the run's usage reports, when it reports them. */
  calls?: number;
  /** The message's `state`, printed as received. */
  state?: string;
  /**
   * Did a text block precede the first `tool_use` in the persisted content blocks?
   * `undefined` when the blocks could not be read — which must NOT be scored as
   * "no preamble", or the diagnosis states the absence of the very thing it failed
   * to look at.
   */
  preambled?: boolean;
  /** The model recorded on the persisted message. */
  model?: string;
  /** The message's usage block, printed as received. */
  usage?: unknown;
}

/**
 * Did this run enter the tool loop and stop at one model call — the shape only a
 * fired cap produces?
 *
 * Kept separate from the rendering, and exported, because it is the whole
 * discrimination: everything downstream is wording. `calls` is optional on purpose —
 * a run whose usage never reported a count must NOT score as enforced, or the
 * diagnosis invents the one fact it exists to establish.
 */
export function capWasEnforced(reading: MissingLimitReading): boolean {
  return reading.toolNames.length > 0 && reading.calls === 1;
}

export function describeMissingLimit(reading: MissingLimitReading): string {
  const { rendered, stored, toolNames, calls, state, preambled, model, usage } = reading;
  const enforced = capWasEnforced(reading);

  // Three heads, and only the first one names a product defect. The other two are
  // the readings that have historically been mistaken for it, so they say what they
  // are instead of deferring to the first — a diagnosis that guesses is worth less
  // than the bare pattern mismatch it replaces.
  // The enforced head states the MECHANISM only when the content blocks show it. The
  // first version asserted "the model emitted text alongside its tool call" on every
  // enforced render, without looking — and a force-fail probe printed that sentence
  // over a message that WAS the limit message (#1991, run 35755303028). Naming a cause
  // the reading does not carry is the failure this diagnosis exists to remove; it is
  // the same correction `describe-missing-uuid.ts` records for its own middle branch.
  const enforcedHead =
    `the cap FIRED and the run says nothing about it (#1991). The run entered the tool ` +
    `loop and stopped at ONE model call — the shape only an enforced max_iterations ` +
    `produces, since the cap trips on the SECOND \`before_model\` — and the message ` +
    `asserted on does not carry the limit. This is NOT a broken cap and NOT a declined ` +
    `tool call: it is a cap-terminated run that reads as a successful one.`;
  const preambleNote =
    preambled === true
      ? ` The persisted blocks show text BEFORE the tool call, which is the shape that ` +
        `takes the message: that text is what landed in it.`
      : preambled === false
        ? ` The persisted blocks show NO text before the tool call, so the preamble ` +
          `mechanism (#1991) does not explain this one — the cause is undetermined here.`
        : ` The content blocks could not be read, so nothing is claimed about why.`;

  const head = enforced
    ? enforcedHead + preambleNote
    : toolNames.length === 0
      ? `the model answered WITHOUT calling any tool, so the cap was never reachable — it ` +
        `fires only on the second model call and the graph reaches that only through the ` +
        `tools node. This is model non-compliance with the Agent Instructions, not a broken ` +
        `max_iterations (#1264).`
      : `the tool loop WAS entered but the run did not stop at one model call ` +
        `(calls: ${calls ?? "not reported"}). That is neither the enforced shape nor the ` +
        `declined-tool shape, and this message does not choose between them — the readings ` +
        `below are what the run recorded.`;

  const provenance =
    stored.trim() === rendered.trim()
      ? "identical to the rendered text — the message is what the backend stored, not a render artifact"
      : `DIFFERENT from the rendered text: ${JSON.stringify(stored.slice(-80))}`;

  const lines = [
    head,
    `  rendered   : ${JSON.stringify(rendered.slice(-80))}`,
    `  persisted  : ${provenance}`,
    `  tools used : ${toolNames.length ? toolNames.join(", ") : "none"}`,
    `  model calls: ${calls ?? "not reported"}`,
    `  state      : ${state ?? "unknown"}`,
    `  preamble   : ${preambled === undefined ? "blocks unreadable" : preambled ? "text before the tool call" : "none"}`,
    `  model      : ${model ?? "unknown"} · usage ${JSON.stringify(usage ?? {})}`,
  ];

  // Only the enforced head earns the upstream pointer. Printed under the others it
  // would send a triage to the product for a failure the run has just attributed to
  // the model declining a tool call.
  if (enforced) {
    lines.push(
      `The enforcement is upstream's to surface: the test asserts the user-visible limit ` +
        `message because that is the only signal a cap-terminated run ever had, and this run ` +
        `carries none. Lanes differ here only by whether the model preambled, which is ` +
        `sampling — not the machine, not the deployment shape.`,
    );
  }

  return lines.join("\n");
}
