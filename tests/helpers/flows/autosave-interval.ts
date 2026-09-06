/**
 * The flow autosave debounce, resolved once per run (#1741).
 *
 * ## Why this is a run-scoped value and not a constant
 *
 * Every flow-mutating edit schedules a debounced `PATCH /api/v1/flows/{id}`. The
 * delay is NOT the 300 ms `SAVE_DEBOUNCE_TIME` that upstream's frontend constant
 * names — that is only the store's pre-fetch default. The effective value is
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
 * How long to allow for a save that an edit has just scheduled to be ISSUED.
 *
 * The debounce is trailing and restarted by every flow mutation, so the earliest
 * a PATCH can appear is one full interval after the last edit; the slack covers
 * the render and the request setup that follow it.
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
