import type { APIRequestContext } from "@playwright/test";
import { compareLangflowVersions, parseLangflowVersion } from "./validation-redaction-gate";

/**
 * Which side of a contract change the instance under test is on (#2336).
 *
 * Some contracts change inside one release line and not in the other one a lane
 * may run: 1.14.0.dev4 widened the integrations manifest and put the provider
 * triggers in the palette, while every 1.13.x build, the patch releases validated
 * on demand among them, keeps the old shape. A spec that pins one shape goes red
 * on the other line for a reason that is not a regression.
 *
 * The answer comes from the VERSION the instance declares, never from the
 * behaviour under test: asking "does it carry the new key?" would pass a build
 * that lost it by accident (the reasoning of `validation-redaction-gate.ts`, whose
 * parser this reuses). A version this cannot read or order throws instead of
 * guessing a side, so the spec fails on the precondition and says why.
 */
export function versionAtLeast(raw: unknown, floor: string): boolean {
  const parsed = parseLangflowVersion(raw);
  const parsedFloor = parseLangflowVersion(floor);
  if (!parsedFloor) {
    throw new Error(`served-version: the floor ${JSON.stringify(floor)} is not a Langflow version`);
  }
  if (!parsed) {
    throw new Error(
      `GET /api/v1/version answered a "version" that cannot be parsed: ${JSON.stringify(raw)}. ` +
        `Which side of ${floor} this instance is on is unknown, so the spec does not guess.`,
    );
  }
  const order = compareLangflowVersions(parsed, parsedFloor);
  if (order === null) {
    throw new Error(
      `Langflow ${String(raw)} is on the same release as ${floor} but carries a segment that ` +
        "cannot be ordered against it. Teach the segment to validation-redaction-gate.ts " +
        "rather than guessing.",
    );
  }
  return order >= 0;
}

/**
 * The raw `version` the instance declares on `GET /api/v1/version`, unparsed, for
 * the deciders above. A non-2xx throws: an unhealthy instance says nothing about
 * which build it is.
 */
export async function servedVersion(request: APIRequestContext): Promise<unknown> {
  const res = await request.get("/api/v1/version");
  if (!res.ok()) {
    throw new Error(
      `GET /api/v1/version answered HTTP ${res.status()}: the instance is unhealthy, which says ` +
        "nothing about which build it is.",
    );
  }
  return ((await res.json()) as { version?: unknown }).version;
}

/** `versionAtLeast` against the instance's own `GET /api/v1/version`. */
export async function servedVersionAtLeast(request: APIRequestContext, floor: string): Promise<boolean> {
  return versionAtLeast(await servedVersion(request), floor);
}
