import type { APIRequestContext } from "@playwright/test";

/**
 * Release gate for the `422` redaction contract (#1846, upstream LE-2462).
 *
 * `langflow/api/validation_errors.py` — the `RequestValidationError` handler that
 * stops a `422` echoing submitted values — first shipped in **`1.13.0.dev10`**
 * (probed inside the container on #1845; `1.13.0.dev9` was built before the merge
 * and `1.12.2` still carries `input`). A `manual.yml` dispatch pinned to an older
 * image must therefore **skip** rather than go red on a contract that image never
 * claimed.
 *
 * **The gate is on the VERSION, never on the behaviour.** A capability probe —
 * "does this instance redact?" — would skip exactly when the contract is broken,
 * which is the green all-skip #1010 exists to prevent. And a version string this
 * module cannot parse is reported as **unknown**, which the caller turns into a
 * failure: an unevaluated precondition is not a clean one (#1012).
 */

/** The first build carrying the handler. */
export const MIN_REDACTION_VERSION = "1.13.0.dev10";

/**
 * PEP 440 segment rank. Langflow ships `1.13.0.dev14`, `1.11.2rc3` and `1.12.2`
 * from the same scheme, and has published `1.5.0.post1`, `1.8.0qa1`, `1.7.0-pre`
 * and a run of `0.5.0b*` besides — they order dev < a < b < rc < final < post, so a numeric
 * tuple alone would sort `1.13.0` *below* `1.13.0.dev14` and `1.13.0.post1`
 * below `1.13.0`.
 */
const SEGMENT_RANK = { dev: 0, a: 1, b: 2, rc: 3, final: 4, post: 5 } as const;

/**
 * Every spelling PEP 440 normalises onto one of the ranks above.
 *
 * A `Map`, not an object literal, and that is a correctness decision rather than
 * a style one: an object index walks `Object.prototype`, where `constructor` is
 * the one all-lowercase property and therefore reachable through the `[a-z]+`
 * segment below. It would return the `Object` FUNCTION as a rank, slip past the
 * `undefined` guard, compare `NaN` against every real rank and resolve to
 * "newer than the floor" — a wrong `available: true` instead of the `unknown`
 * this module promises for anything it cannot read. TypeScript cannot see that
 * hole either: `Record<string, number>` types the lookup as a plain `number`.
 */
const SEGMENT_ALIASES = new Map<string, number>([
  ["dev", SEGMENT_RANK.dev],
  ["a", SEGMENT_RANK.a],
  ["alpha", SEGMENT_RANK.a],
  ["b", SEGMENT_RANK.b],
  ["beta", SEGMENT_RANK.b],
  ["c", SEGMENT_RANK.rc],
  ["rc", SEGMENT_RANK.rc],
  ["pre", SEGMENT_RANK.rc],
  ["preview", SEGMENT_RANK.rc],
  ["post", SEGMENT_RANK.post],
  ["r", SEGMENT_RANK.post],
  ["rev", SEGMENT_RANK.post],
]);

export interface ParsedVersion {
  /** `[major, minor, patch]`. */
  release: [number, number, number];
  /**
   * `SEGMENT_RANK` value, or `null` when the release triple parsed and its
   * suffix did not (`1.8.0qa1`). Null is not an error on its own: it only
   * matters when the triples tie — see `compareLangflowVersions`.
   */
  stage: number | null;
  /** The segment serial (`dev14` -> 14). `0` when there is no segment. */
  serial: number;
}

/**
 * Parse a Langflow version string, or `null` when even its `X.Y.Z` is not one.
 *
 * The release triple is required; the suffix is best-effort. That split is the
 * point: a version whose suffix this module does not know is still **orderable**
 * against a floor on another release (`1.8.0qa1 < 1.13.0.dev10` needs no suffix
 * at all), and only a tie on the triple makes the suffix load-bearing. Refusing
 * the whole string instead would turn every such image into a hard failure —
 * the opposite of the skip this gate exists to produce (Langflow has published
 * `1.1.4.post1`, `1.8.0qa1` and `1.7.0-pre`).
 */
export function parseLangflowVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  // A PEP 440 LOCAL identifier (`+g1234`, what a setuptools-scm build of the
  // release line emits) says where a build came from and never where it sits in
  // the ordering — and such a build does carry the handler, so refusing it would
  // hard-fail an image that should simply run.
  const match = /^(\d+)\.(\d+)\.(\d+)([^+]*)(?:\+.*)?$/.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, suffix] = match;
  const release: [number, number, number] = [Number(major), Number(minor), Number(patch)];
  if (suffix === "") return { release, stage: SEGMENT_RANK.final, serial: 0 };
  // The serial is optional: PEP 440 reads a bare `dev` as `dev0` and `post` as
  // `post0`, which `Number("")` already yields.
  const segment = /^[.\-_]?([a-z]+)[.\-_]?(\d*)$/.exec(suffix.toLowerCase());
  const rank = segment ? SEGMENT_ALIASES.get(segment[1]) : undefined;
  if (rank === undefined || !segment) return { release, stage: null, serial: 0 };
  return { release, stage: rank, serial: Number(segment[2]) };
}

/**
 * `-1`, `0`, `1` — `a` before, equal to, or after `b` — or `null` when the two
 * cannot be ordered because their triples tie and a suffix is unreadable.
 *
 * `null` is the only honest answer there, and the caller turns it into a
 * failure: guessing would either skip the nightly (silent loss of coverage) or
 * redden an image that does carry the handler.
 */
export function compareLangflowVersions(a: ParsedVersion, b: ParsedVersion): number | null {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (a.stage === null || b.stage === null) return null;
  if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
  if (a.serial !== b.serial) return a.serial < b.serial ? -1 : 1;
  return 0;
}

export type RedactionVerdict =
  | { available: true }
  | { available: false; skipReason: string }
  | { available: "unknown"; failReason: string };

/**
 * Decide, from a `GET /api/v1/version` body, whether this instance ships the
 * redaction handler.
 *
 * Reads `version` (the exact build) and not `main_version` (`1.13.0` for every
 * nightly of the line), because the boundary sits *inside* `1.13.0`.
 */
export function redactionVerdict(versionBody: unknown): RedactionVerdict {
  const raw = (versionBody as { version?: unknown } | null | undefined)?.version;
  const parsed = parseLangflowVersion(raw);
  if (!parsed) {
    return {
      available: "unknown",
      failReason:
        `GET /api/v1/version answered a "version" this gate cannot parse: ${JSON.stringify(raw)}. ` +
        "The redaction contract is gated on the build, so an unreadable version is unknown, " +
        "not clean — fix the gate (tests/helpers/other/validation-redaction-gate.ts) rather " +
        "than letting the spec decide on a guess.",
    };
  }
  const floor = parseLangflowVersion(MIN_REDACTION_VERSION) as ParsedVersion;
  const order = compareLangflowVersions(parsed, floor);
  if (order === null) {
    return {
      available: "unknown",
      failReason:
        `Langflow ${String(raw)} is on the same release as ${MIN_REDACTION_VERSION} but carries a ` +
        "pre/post segment this gate cannot order, so whether it ships " +
        "langflow/api/validation_errors.py is undecidable. Teach the segment to " +
        "tests/helpers/other/validation-redaction-gate.ts rather than guessing.",
    };
  }
  if (order < 0) {
    return {
      available: false,
      skipReason:
        `Langflow ${String(raw)} predates ${MIN_REDACTION_VERSION}, the first build carrying ` +
        "langflow/api/validation_errors.py (upstream langflow-ai/langflow#15038, LE-2462). " +
        "A 422 on this image still echoes the submitted value, by its own contract.",
    };
  }
  return { available: true };
}

/**
 * Fetch `GET /api/v1/version` and hand back the verdict.
 *
 * An unreachable or non-ok version endpoint is `unknown`, not a skip: it says the
 * instance is unhealthy, which is never a verdict about the handler.
 *
 * **The two unhealthy branches are not triaged the same way, and the difference is
 * worth knowing before reading a red daily.** The spec throws on `unknown` from
 * `beforeAll`, which takes all four tests with it — so whether that day costs the
 * file its `@stable` tag comes down to whether the message carries an infra
 * signature (`scripts/lib/infra-signature-patterns.json`, #1031/#1310). The THROW
 * branch below keeps the original error's first line, so `ECONNREFUSED` and
 * `apiRequestContext.get: Timeout` survive into the failure text and the exemption
 * applies. The **non-ok** branch cannot: those patterns are transport-level by
 * design, and a wedged backend answering `502`/`503` here produces prose that
 * matches none of them, so `remove-stable-from-failures.ts` would score it
 * attributable and strip the tag in an unreviewed commit. Deliberately not worked
 * around — widening the transport list to swallow a 5xx would blind it on every
 * spec — so the status is named in the message instead, for the human who triages
 * it.
 */
export async function resolveRedactionVerdict(
  request: APIRequestContext,
): Promise<RedactionVerdict> {
  let res;
  try {
    res = await request.get("/api/v1/version");
  } catch (error) {
    return {
      available: "unknown",
      failReason:
        `GET /api/v1/version did not answer (${(error as Error)?.message?.split("\n")[0] ?? String(error)}). ` +
        "The instance is unreachable — this is not a verdict on the redaction handler.",
    };
  }
  if (!res.ok()) {
    return {
      available: "unknown",
      failReason:
        `GET /api/v1/version answered HTTP ${res.status()}. The instance is unhealthy — ` +
        "this is not a verdict on the redaction handler.",
    };
  }
  return redactionVerdict(await res.json());
}
