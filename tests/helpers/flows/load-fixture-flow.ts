import { readFileSync } from "fs";
import path from "path";
import type { APIRequestContext } from "@playwright/test";
import { getComponentCodeIndex } from "./component-code-index";
import {
  formatHydrationReport,
  hydrateFixtureCode,
  type FlowData,
} from "./hydrate-fixture-code";

// Reads a fixture flow and hydrates its component source from the running image
// before any flow is created (#1478).
//
// Callers used to do `JSON.parse(readFileSync(FIXTURE_PATH))` and hand the
// payload straight to `createFlow`, which shipped a frozen copy of every
// component's Python source into the run. `createFlow` is deliberately NOT
// changed: most of its callers build payloads that are not fixtures at all.

export interface FixtureFlow {
  data: FlowData;
  description?: string;
  name?: string;
}

/**
 * A fixture whose component source is the IMAGE's, not the recording's.
 *
 * Throws — before creating anything — when a component type in the fixture is
 * absent from the image's catalog. That state has no honest outcome: the spec
 * cannot exercise a component this build does not ship, and letting it through
 * reproduces the #1478 failure (a 90s wait for a duration badge that cannot
 * render, because the graph was never built).
 */
export async function loadFixtureFlow(
  request: APIRequestContext,
  fixturePath: string,
  options?: { headers?: Record<string, string> },
): Promise<FixtureFlow> {
  let parsed: FixtureFlow;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, "utf-8")) as FixtureFlow;
  } catch (e) {
    throw new Error(`Cannot read fixture flow ${fixturePath}: ${String(e)}`);
  }

  const index = await getComponentCodeIndex(request, options);
  const report = hydrateFixtureCode(parsed.data, index);

  if (report.missing.length > 0) {
    throw new Error(
      `Fixture ${path.basename(fixturePath)} uses component type(s) absent ` +
        `from this image's catalog: ${report.missing.join(", ")}. ` +
        `The catalog exposes ${Object.keys(index).length} types. This is a ` +
        `packaging/renaming change in the image, not a fixture value problem — ` +
        `refusing to create a flow that cannot build.`,
    );
  }

  // Always emitted: a run where nothing changed says so, so the ABSENCE of this
  // line can only mean the hydration did not run (#1012).
  console.log(formatHydrationReport(path.basename(fixturePath), report));

  return { ...parsed, data: report.data };
}
