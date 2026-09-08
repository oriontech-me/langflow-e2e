/**
 * The failure text of `setup-playground.ts`'s graph-commit gate.
 *
 * Split out of the helper so the wording is a pure function with assertions on
 * its output rather than a template literal nobody can test (#1695).
 *
 * The gate gives up for four disjoint reasons and, until #1695, printed one
 * sentence for all of them — the one blaming the autosave-overtake race of
 * #988. That was measured wrong in both directions on a healthy 1.13.0.dev5
 * image: `docker pause` at t=7.5s produced the "stale graph" wording and the
 * same freeze at t=8.0s produced the "no successful read" wording, 500ms apart,
 * with no product defect in either. The daily then read the product-shaped
 * sentence and auto-removed `@stable` from a test that was never measured.
 *
 * So the wording is load-bearing twice over: a human triaging the daily reads
 * it, and so does `classifyInfraError` (`scripts/lib/infra-signatures.ts`),
 * which `remove-stable-from-failures.ts` uses to decide whether a hard failure
 * costs a test its tag. Both directions are pinned in the sibling unit test —
 * the transport wordings must carry the real error so they classify as infra,
 * and the stale-graph wording must NOT, or a genuine #988 recurrence would
 * exempt itself.
 */

/** What the commit gate's probes actually observed before the budget expired. */
export type CommitProbeOutcome =
  /** No probe ever completed — every request threw, or the first one outlived the budget. */
  | { kind: "no-read" }
  /** The last completed probe answered a non-2xx status. */
  | { kind: "http-error"; status: number; statusText: string }
  /** The last completed probe answered 2xx with a body that would not parse. */
  | { kind: "unreadable-body"; detail: string }
  /** The last completed probe returned a graph — this is the only stale-read case. */
  | { kind: "graph"; nodes: number; edges: number };

import type { AutosaveEvidence } from "./watch-autosave-writes";

export interface CommitFailureInput {
  /** What the gate was waiting for, e.g. "2 nodes" — phrased by the caller. */
  expected: string;
  /** The budget that expired, in milliseconds. */
  timeoutMs: number;
  outcome: CommitProbeOutcome;
  /**
   * Text of the last error a probe request threw, when one was captured. Never
   * synthesised: with nothing captured the message says so instead, because a
   * fabricated transport signature would exempt the failure from the `@stable`
   * removal on no evidence at all.
   */
  transportError?: string;
  /**
   * What the wire says about this flow's autosave. REQUIRED, and required as a
   * three-state record rather than a failure list, because the caller's natural
   * shortcut — no failures, therefore every write landed — is precisely the
   * false verdict this function exists to stop (#1012, #1695). Only
   * `issued > 0 && settled === issued && failures.length === 0` licenses the
   * #988 reading.
   */
  autosave: AutosaveEvidence;
}

/** The prefix every variant keeps — triage and `git grep` both key on it. */
const PREFIX = "setupPlayground: a canvas edit never reached the database";

export function describeCommitFailure(input: CommitFailureInput): string {
  const { expected, timeoutMs, outcome } = input;
  const head = `${PREFIX} — expected ${expected}, `;
  const { failures, issued, settled } = input.autosave;
  const inFlight = Math.max(0, issued - settled);

  switch (outcome.kind) {
    case "no-read":
      return (
        head +
        `no read of GET /api/v1/flows/{id} completed within ${timeoutMs}ms. ` +
        `This is the instance, not the flow: ${input.transportError ?? "the request never returned"}`
      );

    case "http-error":
      return (
        head +
        `the last read answered GET /api/v1/flows/{id} → ${outcome.status} ${outcome.statusText} ` +
        `within ${timeoutMs}ms. This is the instance, not the flow.`
      );

    case "unreadable-body":
      return (
        head +
        `the last read answered 2xx within ${timeoutMs}ms but its body could not be parsed: ` +
        `${outcome.detail}. This is the instance, not the flow.`
      );

    case "graph": {
      const seen = `last saw ${outcome.nodes} node(s), ${outcome.edges} edge(s) after ${timeoutMs}ms.`;
      // A write that FAILED explains the lag on its own, and is the most
      // actionable thing we know, so it outranks the counts.
      if (failures.length > 0) {
        return (
          head +
          `${seen} The autosave write never landed: ${failures.join("; ")} — the graph is behind ` +
          `because the write FAILED, not because a stale one overtook it.`
        );
      }
      // Issued and unanswered is the wedge shape: the instance took the write
      // and never came back. #988 needs two writes that both COMPLETED.
      if (inFlight > 0) {
        return (
          head +
          `${seen} ${inFlight} autosave write(s) for this flow were still in flight when the budget ` +
          `expired — the instance never answered them, so this is not the overtake race.`
        );
      }
      if (issued === 0) {
        return (
          head +
          `${seen} No autosave write was issued for this flow at all — the canvas edit never left ` +
          `the browser, so nothing was there to commit.`
        );
      }
      return (
        head +
        `${seen} Every autosave write for this flow answered 2xx, so the usual cause is a stale ` +
        `autosave PATCH committed after a newer one, which rolls the graph back for good (#988).`
      );
    }
  }
}
