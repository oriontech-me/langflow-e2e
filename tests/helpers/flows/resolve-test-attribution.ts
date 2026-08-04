// Derives the two fields the token attribution sidecar needs from Playwright's
// ambient test context (§1.1).
//
// Why this is a separate module rather than three lines inlined at each call
// site: `deleteFlow` and `trackCreatedFlows().cleanup()` both need it, and the
// hard part is not the derivation — it is that `test.info()` throws outside a
// running test and `deleteFlow` is reachable from module scope, from setup
// helpers, and from unit tests. Isolating it means that failure mode gets its own
// tests instead of being duplicated into two hosts that must not throw.
import path from "node:path";
import { test } from "@playwright/test";

export interface TestAttribution {
  /** The test's leaf title — `testInfo.title`, not the full describe chain. */
  test: string;
  /** The spec file, relative to the project's testDir: `tests-automations/…`. */
  file: string;
}

/** The shape this module reads off Playwright's `TestInfo`. Structural on purpose:
 *  it names only what is used, so a unit test can supply it without constructing a
 *  real TestInfo. */
interface AmbientInfo {
  title: string;
  file: string;
  project: { testDir: string };
}

/**
 * Resolve `{test, file}` from the running test, or `null`.
 *
 * Never throws. `test.info()` raises outside a test, a partial info object makes
 * `path.relative` raise, and neither may reach a caller whose own contract is
 * "cannot fail a teardown over telemetry" (§2.3).
 *
 * @param info Override the source of test metadata. **Unit tests only** — a spec
 *   must not pass it. Follows the same convention as `token-attribution.ts`'s
 *   `loadBuildProbe` override: forcing a real `test.info()` failure from a test is
 *   impractical, so the seam is explicit.
 */
export function resolveTestAttribution(
  info: () => AmbientInfo = () => test.info() as unknown as AmbientInfo,
): TestAttribution | null {
  try {
    const ambient = info();
    // Checked rather than trusted: an empty title would key a by_spec row on
    // `file::""`, which renders as a real measurement of a test nobody can find.
    if (!ambient?.title || !ambient?.file || !ambient?.project?.testDir) return null;
    return {
      test: ambient.title,
      file: path.relative(ambient.project.testDir, ambient.file),
    };
  } catch {
    return null;
  }
}
