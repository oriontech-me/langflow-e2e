/**
 * Which API operations a spec covers, and whether it actually issued them
 * (#1692).
 *
 * **Covered** is a deliberate definition, not a measurement of traffic: an `@api`
 * spec drives the operation *on purpose* and asserts its status and body shape.
 * So credit is `declared ∩ recorded`:
 *
 * - a request the spec never declared earns **nothing** — that is what keeps
 *   incidental traffic out of the count, since a spec that merely passes through
 *   an endpoint has asserted no contract;
 * - a declaration the spec never issued **fails the test**, naming it — because a
 *   declaration whose justification expired silently is the failure #1084 was
 *   raised about, and a printed warning would be one more line nobody reads. The
 *   same reasoning makes `page.expectKnownHttpError()` verified in both
 *   directions.
 *
 * Pure by design: the fixture wiring lives in `api-coverage.ts`, and the
 * behaviour is pinned by `api-coverage-gate.spec.ts`.
 */

/** A request the spec issued, reduced to what a declaration can be matched on. */
export interface RecordedRequest {
  method: string;
  /** Path only — the query string is dropped (`PUT …/{id}?name=` is one op). */
  pathname: string;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** Split a `METHOD /path` declaration, or `null` when it is not one. */
function parseOpKey(op: string): { method: string; path: string } | null {
  if (typeof op !== "string") return null;
  const match = /^([A-Z]+) (\/\S*)$/.exec(op.trim());
  if (!match) return null;
  const [, method, path] = match;
  if (!HTTP_METHODS.has(method)) return null;
  return { method, path };
}

/**
 * A request, keyed for matching. `null` when the URL is not a request path.
 *
 * Accepts both an absolute URL (what `page` reports) and a bare path (what a
 * spec hands `APIRequestContext`, resolved against `baseURL`).
 */
export function recordFromUrl(
  method: string,
  url: string,
): RecordedRequest | null {
  if (typeof url !== "string" || url === "") return null;
  let pathname: string;
  if (url.startsWith("/")) {
    pathname = url.split("?")[0].split("#")[0];
  } else {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith("/")) return null;
  return { method: String(method).toUpperCase(), pathname };
}

/**
 * Whether a request satisfies a declaration.
 *
 * `{param}` fills exactly one path segment. The trailing slash is **significant
 * in one direction**, which is the whole reason this is a function and not a
 * string compare:
 *
 * - a declaration **without** a trailing slash accepts either spelling, because
 *   the router registers both and `normalizeRouteTable` collapses them onto the
 *   slash-less key;
 * - a declaration **with** one requires it, because a slash-only route is
 *   registered only that way. Measured: `POST /api/v2/files/batch` (no slash)
 *   falls through to `/api/v2/files/{file_id}` and answers `405`, and the DELETE
 *   answers `422 uuid_parsing` with `input: "batch"`. Crediting that call would
 *   mark the batch operation covered by a request that never reached it.
 */
export function matchesOperation(op: string, req: RecordedRequest): boolean {
  const parsed = parseOpKey(op);
  if (!parsed) return false;
  if (parsed.method !== String(req.method).toUpperCase()) return false;

  const declaredEndsInSlash = parsed.path.length > 1 && parsed.path.endsWith("/");
  const wanted = parsed.path.split("/");
  const actual = (
    declaredEndsInSlash || req.pathname === "/"
      ? req.pathname
      : req.pathname.replace(/\/+$/, "")
  ).split("/");
  if (wanted.length !== actual.length) return false;
  return wanted.every((segment, i) => {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      return actual[i].length > 0;
    }
    return segment === actual[i];
  });
}

/**
 * Why a declaration list cannot be used, or `null` when it can.
 *
 * A typo'd declaration would otherwise surface as "declared and never called",
 * pointing the reader at the spec body instead of at the string — so the string
 * is checked where it is written.
 */
export function describeDeclarationDefect(declared: unknown): string | null {
  if (!Array.isArray(declared)) {
    return `the declaration must be an array of "METHOD /path" strings (got ${typeof declared})`;
  }
  if (declared.length === 0) {
    return "the declaration is empty — declare the operations the test drives, or do not call declare()";
  }
  const seen = new Set<string>();
  for (const op of declared) {
    if (typeof op !== "string") {
      return `declaration entry is not a string: ${JSON.stringify(op)}`;
    }
    const trimmed = op.trim();
    if (!trimmed.includes(" ")) {
      return `"${op}" is not a "METHOD path" pair`;
    }
    const [method, ...rest] = trimmed.split(/\s+/);
    const path = rest.join(" ");
    if (!path.startsWith("/")) {
      return `"${op}" has no leading / on its path`;
    }
    if (!HTTP_METHODS.has(method)) {
      return `"${op}" does not start with an HTTP method (${[...HTTP_METHODS].join(", ")})`;
    }
    if (seen.has(trimmed)) {
      return `"${op}" is declared twice — a duplicate can never be the reason a test exists`;
    }
    seen.add(trimmed);
  }
  return null;
}

/** Declarations no recorded request satisfies, in declaration order. */
export function unfulfilledDeclarations(
  declared: string[],
  recorded: RecordedRequest[],
): string[] {
  return declared.filter((op) => !recorded.some((req) => matchesOperation(op, req)));
}
