// Suppressing the assistant onboarding tooltip, as one mechanism (issue #1220).
//
// Extracted from `helpers/flows/open-flow-by-id.ts` (#1214), which owned the seed
// because it was the first thing that needed it. Seven more specs need it now and
// none of them enters the editor by id, so importing it from there would attach
// them to a module whose canvas/writable deadlines they never use — and, since the
// impacted lane selects specs by transitive import (#1054), it would make every
// edit to the ENTRY helper select those seven specs as well. Splitting the seed out
// keeps each edit's blast radius equal to what it actually affects.
//
// What this replaces: `dismissOnboardingIfPresent`, a probe four call sites ran
// after entry, which #1220 measured on 1.12.0.dev15 and found to be a no-op in
// every one of 82 executions. The numbers, because "it was too early" is the kind
// of claim that gets re-litigated:
//
//   | Call site                        | n  | When it fired                     | Caught the tooltip |
//   |----------------------------------|----|-----------------------------------|--------------------|
//   | `expand-focused-node.ts:24`      | 39 | 0.92–3.70 s after the mount       | 0/39               |
//   | `expand-focused-node.ts:40`      | 39 | +5 ms on the line above           | 0/39               |
//   | `langflowShortcuts.spec.ts:82`   |  3 | BEFORE the bar had mounted at all |  0/3               |
//   | `update-component-action.spec.ts`|  1 | 0.54 s after the mount            |  0/1               |
//
// The deadline they were racing is exact, not approximate: upstream reads the flag
// ONCE at mount of the canvas-controls bar and arms a 10 s timer when it comes back
// false, so the tooltip appears at mount + 10 000 ms — measured to the millisecond
// off the absolute in-page clock (`canvasMounts=…972903` → `tooltipAppear=…982903`).
// Every probe therefore fired 6.3–9.1 s before the earliest instant it could have
// seen anything.
//
// Why a pre-load seed is the ONLY mechanism that works, rather than a preference.
// Upstream (`CanvasControls.tsx`, minified in the nightly bundle):
//
//   const [discovered] = useState(() => readAssistantDiscovered());
//   useEffect(() => {
//     if (discovered) return;
//     const t = setTimeout(() => setShowTooltip(true), ONBOARDING_TOOLTIP_DELAY_MS);
//     return () => clearTimeout(t);
//   }, [discovered]);
//
// `discovered` is a mount-time snapshot, so writing the flag AFTER the load cannot
// disarm the timer. Measured rather than inferred from the source: with the flag
// written 686 ms after the bar mounted, the tooltip still appeared at 10 766 ms —
// against 10 713 ms for the same run with no write at all. That is what rules out
// the obvious alternative of having `expandFocusedNode` suppress the tooltip
// itself, with no caller change: there is no post-load suppression to perform.
//
// What the hazard actually is, measured on dev15 rather than inherited from the
// #684 write-up: a 282×32 px opaque element at (378, 669) in a 1280×720 viewport,
// `z-index: 40`, `pointer-events: auto`. No body-wide blocking layer — but that
// rectangle sits over the canvas-controls bar, which is exactly what `zoomOut` and
// `adjustScreenView` click, so a test still running at mount + 10 s can lose a
// click there.

import type { Page } from "@playwright/test";

/**
 * The localStorage flag upstream reads to decide whether the assistant onboarding
 * affordances still need to surface (`assistant-discovery-storage.ts`). Pinned by
 * the unit lane, because a rename upstream would silently restore the overlay this
 * suppresses.
 */
export const ASSISTANT_DISCOVERED_STORAGE_KEY = "langflow-assistant-discovered";

/**
 * Pages already carrying the seed, so a spec that enters three times registers one
 * init script instead of three. `WeakSet`, so a closed page is collectable.
 */
const seededPages = new WeakSet<object>();

/** The `Page` surface the seed needs. Narrow, so the unit lane can drive it with a fake. */
export interface SeedablePage {
  addInitScript(script: (key: string) => void, arg: string): Promise<unknown>;
}

/**
 * Suppress the assistant onboarding affordances for every subsequent load.
 *
 * Call it BEFORE the first navigation of the test — `addInitScript` applies to the
 * loads that follow it, so a call after the `goto` leaves the one load the caller
 * cares about unseeded. A `test.beforeEach` is the reliable place: it cannot be
 * forgotten by the next `test()` added to the file.
 *
 * @returns whether this call registered the script (false when already seeded).
 */
export async function seedAssistantDiscovered(
  page: SeedablePage,
): Promise<boolean> {
  if (seededPages.has(page)) return false;
  // Marked AFTER the registration lands, never before: an `addInitScript` that
  // rejects would otherwise leave the page permanently flagged as seeded, so no
  // later entry would retry it and the overlay would be back with nothing saying
  // so.
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, "true");
    } catch {
      // Best-effort, exactly as upstream treats it (private browsing, quota): the
      // worst case is the affordance surfacing and the caller's own assertions
      // failing loudly, never a silent pass.
    }
  }, ASSISTANT_DISCOVERED_STORAGE_KEY);
  seededPages.add(page);
  return true;
}

/**
 * Fail loudly when the page driving a click-heavy helper was never seeded.
 *
 * This exists because of how the mechanism it replaces failed. A probe that runs
 * too early is indistinguishable from a probe that found nothing to do, so
 * `dismissOnboardingIfPresent` read as protection at four call sites for as long
 * as it existed and protected none of them. Deleting it without a guard would swap
 * that for a quieter version of the same thing: the next spec to call
 * `expandFocusedNode` without seeding gets no protection and no signal either.
 *
 * Deliberately not a probe: it reads the flag the seed writes, which is
 * deterministic and available the instant the document loads, so it needs no
 * waiting and cannot flake on timing.
 *
 * Fail-open on an unreadable `localStorage` (no document yet, storage denied): the
 * point is to catch a missing seed, and a verdict this cannot produce must not
 * redden a run on its own. That case is printed rather than swallowed (#1012).
 */
export async function assertAssistantOnboardingSeeded(
  page: Page,
  caller: string,
): Promise<void> {
  let flag: string | null | undefined;
  try {
    flag = await page.evaluate(
      (key) => localStorage.getItem(key),
      ASSISTANT_DISCOVERED_STORAGE_KEY,
    );
  } catch {
    console.log(
      `⚠️  ${caller}: could not read localStorage, so whether the assistant onboarding tooltip is suppressed for this test is UNKNOWN (issue #1220).`,
    );
    return;
  }
  if (flag === "true") return;
  throw new Error(
    `${caller} requires the assistant onboarding tooltip to be suppressed, and this page was never seeded ` +
      `(localStorage["${ASSISTANT_DISCOVERED_STORAGE_KEY}"] = ${JSON.stringify(flag)}).\n\n` +
      `Add this to the spec, BEFORE its first navigation:\n\n` +
      `  import { seedAssistantDiscovered } from "<...>/helpers/ui/assistant-onboarding";\n` +
      `  test.beforeEach(async ({ page }) => { await seedAssistantDiscovered(page); });\n\n` +
      `Dismissing the tooltip after the load is NOT an alternative: upstream snapshots the flag at mount, ` +
      `so a post-load write does not disarm the 10 s timer (measured — issue #1220).`,
  );
}
