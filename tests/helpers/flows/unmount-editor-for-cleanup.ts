// Leaving the flow editor at teardown time, so deleting the flow is quiet (#1288).
//
// NOT `leave-flow-editor.ts`, which is a different job: that one is the UI exit
// around the #1153 SPA-blocker deadlock, with 15 s/30 s budgets and assertions
// about the flows list rendering. This is the teardown's own one-line navigation,
// whose only purpose is that the editor stops polling the flow we are about to
// delete — an editor left mounted over a deleted flow keeps requesting
// `GET /flows/{id}/events`, 404s once the flow is gone, and the fixture logs each
// one as `🚨 Backend Error`.
//
// It exists as a helper rather than as a block copied per spec because both
// obvious ways to write that navigation are wrong, and getting it wrong is
// expensive in a way the copies hide:
//
//   - Letting the failure propagate aborts the teardown BEFORE the deletes.
//     Measured on `human-input-node-config.spec.ts` by dropping the catch: 3
//     failed tests and 3 leaked flows — a permanent leak (in `cleanup()` the ids
//     have already been spliced out of the tracker), traded for a navigation
//     whose only job was to reduce log noise.
//   - Swallowing it discards the one line that attributes the 404 burst that
//     follows to its cause, leaving a run full of unattributable backend-error
//     lines. An advisory log is only worth reading if what makes it noisy is
//     nameable (#1084's rule).
//
// So it warns and carries on, and the caller decides whether to record what it
// returns. One implementation also means one message string and one place where
// the warning is asserted — the three hand-written copies this replaces had
// three different texts, which is the drift #1108 exists to prevent.

/**
 * The `page` surface this needs. Narrow on purpose, so the unit lane can drive it
 * with a fake and so `TrackedPage` (which is itself narrow) is assignable.
 */
export interface NavigablePage {
  goto(url: string): Promise<unknown>;
}

/**
 * Navigate away from the flow editor before a teardown deletes its flow.
 *
 * Never throws — a failure is warned about and returned, so the caller's deletes
 * always run. Returns the **first line** of the failure, or `undefined` when the
 * navigation succeeded.
 *
 * @param page  the page to navigate
 * @param url   where to go. Defaults to `about:blank`, which adds no backend
 *              traffic of its own; a spec that wants the flows list passes `"/"`.
 */
export async function unmountEditorForCleanup(
  page: NavigablePage,
  url = "about:blank",
): Promise<string | undefined> {
  try {
    // `try`/`catch` rather than `.catch()`: the latter attaches to the returned
    // promise only, so a `goto` that throws SYNCHRONOUSLY escapes it and skips
    // the caller's deletes — the exact leak this helper exists to prevent. Real
    // Playwright's `Page.goto` is async, but this repo proxies it (the tracker's
    // own unit tests do) and a fake that throws is a normal thing to write.
    await page.goto(url);
    return undefined;
  } catch (error) {
    // Coerced BEFORE the split. The `?.message?.split(…) ?? String(error)` idiom
    // used elsewhere in this directory leaves its fallback untruncated, and it
    // throws outright on the one shape it was written for — a rejection whose
    // `message` is not a string (`{ message: 42 }` → `.split is not a function`).
    // `||` rather than `??` so an empty `message` falls back to the value too.
    const message = String((error as Error)?.message || error).split("\n")[0];
    console.warn(
      `⚠️  teardown: could not leave the flow editor (${message}) — the deletes ` +
        `still run, so a 404 on the editor's events poll is THAT and not the ` +
        `flow (#1288).`,
    );
    return message;
  }
}
