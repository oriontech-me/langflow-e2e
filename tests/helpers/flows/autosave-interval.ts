/**
 * The flow autosave debounce, resolved once per run (#1741).
 *
 * ## Why this is a run-scoped value and not a constant
 *
 * Every flow-mutating edit schedules a debounced `PATCH /api/v1/flows/{id}`. The
 * delay is NOT the 300 ms `SAVE_DEBOUNCE_TIME` that upstream's frontend constant
 * names — that constant is used elsewhere; the store's own pre-fetch default is
 * `AUTOSAVE_DEBOUNCE_TIME = 2000` (`flowsManagerStore.ts:57`, corrected in #1902
 * against `release-1.13.0`, where this header and
 * `wait-for-flow-save-settled.ts` both said 300). The effective value is
 * `autoSavingInterval`, seeded from `GET /api/v1/config.auto_saving_interval`
 * (`use-get-config.ts`), and the server has already moved it: this repo measured
 * **1000** while writing `SimpleAgentTemplatePage.ts` and **2000** on
 * `1.13.0.dev4`. Any number pasted into our source goes stale the next time
 * upstream edits its default, and the failure is silent — a barrier that expires
 * early still returns, it just returns on a save that was never issued.
 *
 * So it is read from the instance under test, once, in `globalSetup`, and passed
 * to the workers through the environment. That is the same channel and the same
 * reason as the frozen model catalog (`provider-setup/catalog-snapshot.ts`):
 * `globalSetup` runs before the load task, workers are forked after it and
 * inherit `process.env`, and a module-level cache could not cross the process
 * boundary.
 *
 * ## Unknown is not a default
 *
 * A run that could not read the config gets `null`, never a fabricated number,
 * and every consumer states which of the two it is using (#1012). The fallback
 * below is deliberately larger than any interval upstream has shipped: when the
 * value is unknown the safe direction is to wait too long, because the failure
 * of waiting too little is a test that asserts against a save that never left
 * the browser.
 */

/** Environment variable carrying the resolved interval to the workers. */
export const AUTOSAVE_INTERVAL_ENV = "PW_AUTOSAVE_INTERVAL_MS";

/**
 * Used when the interval could not be read. Above every value upstream has
 * shipped (300 → 1000 → 2000), because over-waiting costs seconds and
 * under-waiting costs a false green.
 */
export const AUTOSAVE_INTERVAL_FALLBACK_MS = 3000;

/** Publish the resolved interval for the workers. `null` clears it. */
export function publishAutosaveInterval(intervalMs: number | null): void {
  if (intervalMs === null) {
    delete process.env[AUTOSAVE_INTERVAL_ENV];
    return;
  }
  process.env[AUTOSAVE_INTERVAL_ENV] = String(intervalMs);
}

/**
 * The interval resolved for this run, or `null` when it is unknown.
 *
 * Anything that is not a positive finite integer reads as unknown rather than as
 * a value: a `0` here would collapse every derived deadline to "already due",
 * which is the one state no caller can recover from.
 */
export function readAutosaveIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[AUTOSAVE_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * How long to allow a save to COMPLETE once it has been issued.
 *
 * Deliberately separate from the issuance budget below, and deliberately
 * generous. They are different failures: a save that is late to be *issued* is
 * usually a follow-on mutation restarting the trailing debounce, while a save
 * that is late to *complete* is a slow backend. Folding them into one budget
 * makes a healthy-but-slow round trip indistinguishable from an edit that never
 * marked the node dirty, and reports the wrong one. Over-waiting costs a slow
 * red on a run that is already failing; under-waiting costs a red on a healthy
 * save — and the first call sites to migrate are `@stable` specs in the daily,
 * where a hard failure removes the tag by unreviewed commit.
 */
export const SAVE_COMPLETION_BUDGET_MS = 10000;

/**
 * How long the editor must be quiet before no DEBOUNCED save can still be
 * pending.
 *
 * The gap `waitForFlowSaveSettled` leaves open is a save that is scheduled but
 * not yet issued, and the only window that closes it is one longer than the
 * debounce itself. Callers that must start from a clean slate — including
 * anything arming `watchFlowSave` after an earlier mutation — pass this as that
 * helper's `quietMs`.
 *
 * **What no window of any length closes**, stated here so the consumers can
 * stop claiming otherwise (#1902): upstream `use-autosave-flow.ts:92-111` runs
 * the debounce callback and, when `usePermissions().isLoading` is true or a
 * blocked component pauses it, stores the save in `pendingAutoSaveRef` and
 * returns WITHOUT issuing anything; the `useEffect` at :126-151 re-issues it
 * whenever that flips. Such a save is neither in flight nor on a timer, so its
 * issuance is not bounded by a quiet window at all. The path is live in
 * `renameFlow`, whose #1005 notes record the permissions query re-entering
 * `isLoading` on every save. A drain closes the debounced case; that is the
 * claim to make.
 *
 * ## Why the slack is 1500 and not 500
 *
 * The window has to cover the debounce PLUS the render and request setup that
 * follow it, which is the same latency `saveScheduledDeadlineMs` below already
 * budgets 1500 ms for — the two were inconsistent, and this one was the
 * optimistic half. Measured on `1.13.0.dev15` with the drain instrumented
 * (#1902): at `waitForNodeConfigSettled`'s barrier the PATCH was issued
 * **2433 ms** after the drain armed, against a 2000 ms interval — i.e. **433 ms
 * of latency on an idle local box**, inside a 500 ms budget. A 67 ms margin on
 * the one measurement backing a window is not a margin, and under-waiting fails
 * silently (that is the whole of #1741). Over-waiting costs seconds on a path
 * that is already waiting.
 */
export function pendingSaveQuietMs(
  intervalMs: number | null = readAutosaveIntervalMs(),
  { slackMs = 1500 }: { slackMs?: number } = {},
): number {
  return (intervalMs ?? AUTOSAVE_INTERVAL_FALLBACK_MS) + slackMs;
}

/**
 * How long to allow for a save that an edit has just scheduled to be ISSUED.
 *
 * The debounce is trailing and restarted by every flow mutation, so the earliest
 * a PATCH can appear is one full interval after the last edit; the slack covers
 * the render and the request setup that follow it.
 *
 * Numerically identical to `pendingSaveQuietMs` since #1902 reconciled the two
 * slacks, and deliberately still two functions: this one is a DEADLINE a watcher
 * fails at, that one is a WINDOW a drain waits out. They answer different
 * questions about the same latency, and collapsing them would make the next
 * change to either silently a change to both.
 */
export function saveScheduledDeadlineMs(
  intervalMs: number | null = readAutosaveIntervalMs(),
  { slackMs = 1500 }: { slackMs?: number } = {},
): number {
  return (intervalMs ?? AUTOSAVE_INTERVAL_FALLBACK_MS) + slackMs;
}

/** One line naming the interval and where it came from, for a run's output. */
export function describeAutosaveInterval(
  intervalMs: number | null = readAutosaveIntervalMs(),
): string {
  return intervalMs === null
    ? `autosave debounce UNKNOWN for this run — using the ${AUTOSAVE_INTERVAL_FALLBACK_MS} ms fallback`
    : `autosave debounce ${intervalMs} ms (GET /api/v1/config.auto_saving_interval)`;
}
