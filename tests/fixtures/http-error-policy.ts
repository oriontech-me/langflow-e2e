/**
 * Decides which backend HTTP responses the base fixture reports as errors.
 *
 * Extracted from `fixtures.ts` (#1084) for two reasons:
 *
 * 1. **It was wrong and nobody could tell.** The filter matched four exact
 *    status codes — `400 || 404 || 422 || 500` — while `CLAUDE.md` advertised
 *    "4xx/5xx monitoring". Measured on 1.12.0.dev9: an in-page `405` and the
 *    `403 — No authentication credentials provided` that an unauthenticated
 *    `/api/v1/flows/` returns were both **invisible**, as were the `502`/`503`
 *    a wedged or restarting backend produces (#1030/#1048).
 * 2. **The fixture cannot be unit-tested.** It only runs inside a real browser
 *    session, so the classification was provable only by running the suite and
 *    reading a terminal. As a pure function it is covered by
 *    `npm run test:units` on every PR.
 *
 * ## This decides visibility, not pass/fail
 *
 * An `http_error` is **logged and never fails a test** — that is the fixture's
 * real, measured behaviour (see `fixtures.ts`, and `CLAUDE.md`'s validation
 * step). The load-bearing part of the mechanism is therefore a human reading
 * the log, which makes noise the actual defect: a log that always carries the
 * same three 500s is a log nobody reads carefully. That is what #1084 was
 * raised for — every entry in `IGNORED` below exists to keep a logged error
 * meaningful, and nothing is ignored merely because it is inconvenient.
 */

export interface HttpResponseFacts {
  url: string;
  status: number;
}

/**
 * One backend error a single test declares it **expects**, because a filed,
 * known defect fires it on a path the test has to walk.
 *
 * This is the narrow alternative to `page.allowHttpErrors()`, and the difference
 * is the whole reason it exists (#1008). `allowHttpErrors()` silences **every**
 * 4xx/5xx for the rest of the test, which is right for a spec that mocks one
 * response and asserts the UI around it. It is wrong for a spec that merely
 * *passes through* a state where a known product defect fires: the destructive
 * test in `folder-deletion-integrity.spec.ts` empties the account by deleting N
 * projects through the UI, and `DELETE /api/v1/projects/{id}` answering 500 while
 * the toast still reads "deleted successfully" is itself a filed defect
 * (#965/LE-2020) that this test is unusually well placed to observe. Blanket
 * silence would have traded one known error for blindness to the other.
 *
 * Three properties are deliberate:
 *
 * 1. **`pathname` is compared for equality, never as a pattern.** A regex is how
 *    a one-response exemption grows into a route-wide one without anybody
 *    re-reading it, which is the failure `IGNORED` is kept short to avoid.
 * 2. **The status is part of the match.** The declared 422 on
 *    `/api/v1/projects/undefined` must not hide a 500 on the same path.
 * 3. **A declaration is scoped to the test that makes it** and does not survive
 *    into the next one — unlike `IGNORED`, which is suite-wide and forever.
 *
 * The declaration is also a **claim about the product**, so the fixture verifies
 * it: a declared defect that does not fire fails the test rather than printing a
 * line nobody reads. See `fixtures.ts` for that half.
 */
export interface KnownHttpDefect {
  /** Exact `pathname` of the response, query string excluded. */
  pathname: string;
  /** Exact status. A different status on the same path is still reported. */
  status: number;
  /**
   * Why this response is expected — an issue reference and the mechanism, not a
   * restatement of the URL. This string is printed on every run, and it is what
   * tells the next reader whether the exemption is still earned.
   */
  reason: string;
}

export type HttpErrorVerdict =
  /** Report it: `🚨 Backend Error` in the log and one entry in the test's error list. */
  | { monitored: true }
  /**
   * A 4xx/5xx the running test declared it expects. Not reported as an error,
   * but recorded so the fixture can tell whether the declaration still holds.
   */
  | { monitored: false; ignoreReason: string; knownDefect: KnownHttpDefect }
  /** Stay quiet, and say why — an ignore without a reason is indistinguishable from a bug. */
  | { monitored: false; ignoreReason: string };

/**
 * Endpoints whose error responses carry no signal about the product under test.
 *
 * Deliberately short. Anything added here becomes invisible to every spec in the
 * suite, so an entry needs a reason that survives review — not "it is noisy".
 */
const IGNORED: Array<{ matches: (pathname: string) => boolean; reason: string }> =
  [
    {
      // Pre-existing behaviour, kept: the auth specs drive these endpoints into
      // 4xx/5xx on purpose (invalid credentials, expired session, mocked 500s),
      // and the SPA probes `/refresh` speculatively, so a 401 here is routine
      // rather than a finding.
      matches: (p) =>
        p.endsWith("/login") ||
        p.endsWith("/auto_login") ||
        p.endsWith("/refresh") ||
        p.endsWith("/logout"),
      reason: "auth endpoint — answers 4xx by design and is driven there deliberately",
    },
    {
      // The Langflow Store is an EXTERNAL service. A container without outbound
      // DNS answers `500 … [Errno -2] Name or service not known`, which is what
      // exposed this whole gap: in the #1052 review every test in a 20-test
      // slice logged three of these, and a log like that trains readers to skip
      // it. Environmental, not a Langflow defect (#1084 → "Not in scope").
      matches: (p) => p.startsWith("/api/v1/store/"),
      reason: "Langflow Store is external — unreachable in CI, environmental not a product defect",
    },
  ];

/**
 * Classifies one response.
 *
 * `status >= 400` rather than a code list: this is the "4xx/5xx" the docs always
 * claimed. Widening it cost **zero** extra noise when measured over 48 `@stable`
 * tests in `ui-ux` + `project-management` (the only two errors in that run were
 * `DELETE /api/v1/flows/` → 500, already matched by the old list).
 *
 * A URL this cannot parse is treated as unmonitored rather than throwing — the
 * caller runs inside a `page.on("response")` handler, where a throw would break
 * the test it is supposed to be observing.
 *
 * `declaredDefects` are the running test's `page.expectKnownHttpError()`
 * declarations (empty for the overwhelming majority of tests). They are consulted
 * **last**, after the `/api/` test and after `IGNORED`, so a declaration can only
 * ever quieten a response this policy would otherwise have reported — it can
 * never be used to widen monitoring onto a static asset or to un-ignore an
 * endpoint the suite exempts globally.
 */
export function classifyHttpError(
  { url, status }: HttpResponseFacts,
  declaredDefects: readonly KnownHttpDefect[] = [],
): HttpErrorVerdict {
  if (status < 400) {
    return { monitored: false, ignoreReason: "not an error status" };
  }

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { monitored: false, ignoreReason: `unparseable URL: ${url}` };
  }

  if (!pathname.includes("/api/")) {
    return {
      monitored: false,
      ignoreReason: "not a backend API call (static asset, page navigation, third party)",
    };
  }

  for (const { matches, reason } of IGNORED) {
    if (matches(pathname)) return { monitored: false, ignoreReason: reason };
  }

  const declared = declaredDefects.find(
    (defect) => defect.status === status && defect.pathname === pathname,
  );
  if (declared) {
    return {
      monitored: false,
      knownDefect: declared,
      ignoreReason: `declared by this test: ${declared.reason}`,
    };
  }

  return { monitored: true };
}
