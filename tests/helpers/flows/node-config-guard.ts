import { expect, type Page } from "@playwright/test";
import { pendingSaveQuietMs } from "./autosave-interval";
import { waitForFlowSaveSettled } from "./wait-for-flow-save-settled";

/**
 * Guards a node's configuration against the flow-save race, for specs that
 * configure a node on the canvas and then RUN the flow.
 *
 * Why this exists (#1302). `ollama-provider.spec.ts` selected the model,
 * asserted the widget showed it, opened the Playground, sent a prompt — and
 * waited 180 s for a chat message that never came. The failing attempt's DOM
 * shows the Ollama node reverted to its DEFAULTS: `Model Name` back to
 * "Select an option" and the base URL back to `http://localhost:11434`, while
 * the daily had typed `http://ollama:11434`. `Model Name` is required, so the
 * run could not start — consistently, that attempt produced no flow trace at
 * all and logged zero backend errors in 191 s.
 *
 * The mechanism is the one `wait-for-flow-save-settled.ts` documents:
 * `PATCH /api/v1/flows/{id}` has no version check and the frontend applies
 * whichever response lands LAST, so a stale autosave overwrites the store and
 * the database (the root of #358, #357, #995).
 *
 * **That barrier does not guarantee PATCH quiescence by itself, and this header
 * used to say it does (#1741/#1902).** `waitForFlowSaveSettled` arms its quiet
 * window IMMEDIATELY when nothing is in flight, so at the 700 ms default this
 * module used to pass it returned before a save an edit had merely SCHEDULED —
 * one full debounce later, 2000 ms on `1.13.0.dev15`. The window is derived from
 * the instance now (`nodeConfigDrainQuietMs`), which closes the DEBOUNCED case —
 * not every case: a save upstream deferred into `pendingAutoSaveRef` while the
 * permissions query is loading is bounded by no window at all
 * (`pendingSaveQuietMs`'s header has the mechanism). The rest of the old
 * sentence still stands and is still why this guard exists: quiescence says
 * nothing about whether what survived carries the selection, and the Playground
 * is opened after it.
 *
 * **This reads the WIDGET, never the API, and that is measured rather than
 * conventional:** the run is dispatched as `POST /api/v2/workflows` with a
 * 66 801-byte body — the frontend's in-memory graph, not a reference to the
 * persisted flow. A guard querying `GET /api/v1/flows/{id}` could therefore
 * pass while the run executes the reverted state.
 *
 * Deliberately NOT claimed as infra (the #1262 rule): a node that silently
 * loses its configuration is a real defect and must stay eligible for
 * `@stable` auto-removal, so the message carries no `INFRA_PREFIX` and is
 * pinned as unclassifiable in the unit tests.
 */

/**
 * How long the configuration must hold before the run is allowed to start.
 *
 * Generous relative to its cost, because it is only ever paid on the way to a
 * failure: on the four dailies measured for #1302 the whole playground step —
 * open, send, generate, render — costs 5 408-6 503 ms, so a node whose value
 * is still absent after 15 s is not a slow surface.
 */
export const NODE_CONFIG_SETTLE_TIMEOUT_MS = 15000;

/**
 * Quiet window the editor must hold before the widget's value is trusted.
 *
 * **Derived from the instance, never pasted (#1902).** This was a
 * `NODE_CONFIG_QUIET_MS = 700` constant, and 700 is below every autosave
 * debounce upstream currently ships — `GET /api/v1/config.auto_saving_interval`
 * answered 2000 on `1.13.0.dev15`. Since `waitForFlowSaveSettled` arms its quiet
 * window immediately when nothing is in flight, that window expired before the
 * reverting PATCH was issued at all.
 *
 * **What that cost is RECOVERY, not a false green, and the distinction is the
 * whole point.** The drain returned early, the widget still showed the
 * selection, `classifyConfigOutcome` said `held`, and `waitForNodeConfigSettled`
 * returned WITHOUT ever exercising `reapply` — the one repair it exists to
 * perform. The revert was still caught by `assertNodeConfigHeld`, a pure read
 * placed immediately before the send, so no run ever started against a reverted
 * node; a RECOVERABLE state was simply reported as a hard failure one step
 * later. That is the opposite of the trade this helper was built to make
 * (#1302), and its only consumer is `@stable` in the daily, where a hard failure
 * strips the tag by unreviewed commit.
 *
 * Cost: `pendingSaveQuietMs()` is ~3500 ms against the 700 ms it replaces, so
 * ~+2.8 s per call — at most twice, and the second only on the repair path —
 * against a playground step measured at 5 408-6 503 ms and the 180 s budget this
 * guard protects (#1302). Paid only on the way to a run, and NOT idle time here:
 * measured on `1.13.0.dev15`, this drain observes a real PATCH issued 2433 ms
 * after it arms, on every run, because the model selection itself schedules it.
 */
export function nodeConfigDrainQuietMs(): number {
  return pendingSaveQuietMs();
}

export type ConfigOutcome = "held" | "reverted";

/**
 * Did the widget keep what the test put in it?
 *
 * Substring rather than equality on purpose: these value widgets render the
 * selection inside a larger label (the model dropdown shows the model name
 * among other text), which is the same reason the spec's own assertion uses
 * `toContainText`. An EMPTY observed value is the reverted case that matters —
 * a reverted dropdown reads "Select an option", which contains nothing the
 * caller asked for.
 */
export function classifyConfigOutcome(
  expected: string,
  observed: string | null,
): ConfigOutcome {
  if (observed === null) return "reverted";
  return observed.includes(expected) ? "held" : "reverted";
}

export type RevertedConfigDetail = {
  /** Human name of the field, e.g. "Model Name". */
  field: string;
  /** What the test selected/typed. */
  expected: string;
  /** What the widget shows now — `null` when the widget is gone entirely. */
  observed: string | null;
  /** Testid read, so the reader can find it without grepping the spec. */
  valueTestId: string;
  /** Optional second field read at the same moment (e.g. the base URL). */
  companion?: { field: string; expected: string; observed: string | null };
};

export function revertedConfigMessage(d: RevertedConfigDetail): string {
  const shown =
    d.observed === null
      ? "the widget is GONE from the DOM"
      : d.observed.trim() === ""
        ? 'it is EMPTY ("")'
        : `it now reads "${d.observed}"`;

  // Naming the companion field is what separates "one dropdown misbehaved" from
  // "the whole node reverted" — in #1302 BOTH the model and the base URL were
  // back at their defaults, which is why the run could not start rather than
  // merely running with the wrong model.
  const companion = d.companion
    ? ` Read at the same moment, "${d.companion.field}" expected ` +
      `"${d.companion.expected}" and ` +
      (d.companion.observed === null
        ? "is GONE"
        : `reads "${d.companion.observed}"`) +
      ` — if BOTH reverted, the whole node was reset, not one widget.`
    : "";

  return (
    `[node-config-guard] the node lost its configuration before the run: ` +
    `"${d.field}" was set to "${d.expected}" (asserted at selection time) but ` +
    `${shown}, read from getByTestId("${d.valueTestId}") immediately before ` +
    `sending.${companion} The run ships the frontend's in-memory graph ` +
    `(POST /api/v2/workflows, ~66KB), so it would execute THIS state — a ` +
    `required field left empty means no run starts and no chat message can ` +
    `ever arrive (#1302). This is the flow-save race documented in ` +
    `helpers/flows/wait-for-flow-save-settled.ts: PATCH /api/v1/flows/{id} has ` +
    `no version check and the LAST response wins, so a stale autosave can ` +
    `overwrite the selection in both the store and the database (#358/#357/` +
    `#995). Do NOT read this as a slow model or a short timeout.`
  );
}

const readValue = async (
  page: Page,
  valueTestId: string,
): Promise<string | null> =>
  page
    .getByTestId(valueTestId)
    .innerText()
    .catch(() => null);

/**
 * Waits until the node's configuration is settled: the widget shows what the
 * caller set AND no flow-save PATCH is in flight or still scheduled.
 *
 * The second half of that is what `nodeConfigDrainQuietMs` buys and what the
 * 700 ms window it replaced could not deliver (#1902): a revert issued one
 * debounce after the selection landed AFTER the old drain returned, so this
 * function read a widget that still held the value and returned `held` without
 * repairing anything.
 *
 * When it does not hold, `reapply` is invoked ONCE and the check repeats. The
 * re-apply is bounded and deliberate: this is a known product race that
 * overwrites a value that was already applied and asserted, so re-issuing the
 * selection is recovering from a lost write, not retrying a failed
 * interaction. If it does not hold after that, the caller's guard fails
 * attributed rather than the run being started against a reverted node.
 */
export async function waitForNodeConfigSettled(
  page: Page,
  opts: {
    valueTestId: string;
    expected: string;
    reapply?: () => Promise<void>;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeout = opts.timeoutMs ?? NODE_CONFIG_SETTLE_TIMEOUT_MS;

  await expect(page.getByTestId(opts.valueTestId)).toContainText(opts.expected, {
    timeout,
  });
  await waitForFlowSaveSettled(page, { quietMs: nodeConfigDrainQuietMs() });

  if (
    classifyConfigOutcome(
      opts.expected,
      await readValue(page, opts.valueTestId),
    ) === "held"
  ) {
    return;
  }

  if (opts.reapply) {
    await opts.reapply();
    await expect(page.getByTestId(opts.valueTestId)).toContainText(
      opts.expected,
      { timeout },
    );
    await waitForFlowSaveSettled(page, { quietMs: nodeConfigDrainQuietMs() });
  }
}

/**
 * Fails, attributed, when the node no longer carries its configuration.
 *
 * Call this immediately before the interaction that STARTS the run. Placing it
 * anywhere earlier leaves the very window #1302 is about — the revert was
 * observed with the Playground already open and the canvas node behind it.
 */
export async function assertNodeConfigHeld(
  page: Page,
  opts: {
    valueTestId: string;
    expected: string;
    field: string;
    companion?: { valueTestId: string; expected: string; field: string };
  },
): Promise<void> {
  const observed = await readValue(page, opts.valueTestId);
  if (classifyConfigOutcome(opts.expected, observed) === "held") return;

  const companion = opts.companion
    ? {
        field: opts.companion.field,
        expected: opts.companion.expected,
        observed: await readValue(page, opts.companion.valueTestId),
      }
    : undefined;

  throw new Error(
    revertedConfigMessage({
      field: opts.field,
      expected: opts.expected,
      observed,
      valueTestId: opts.valueTestId,
      companion,
    }),
  );
}
