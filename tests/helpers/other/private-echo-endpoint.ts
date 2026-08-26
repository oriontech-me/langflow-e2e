/**
 * The private echo endpoint an SSRF spec needs for its ADMITTED case.
 *
 * An SSRF spec that only asserts refusals is indistinguishable from one running
 * against an instance that blocks every non-default URL — a different, and also
 * broken, product. The admitted case is what separates them, and it only works
 * against an address Langflow blocks **by default** and reaches only because
 * `LANGFLOW_SSRF_ALLOWED_HOSTS` admits it. Reaching a *public* host proves
 * nothing.
 *
 * Every CI lane resolves such an address through
 * `.github/actions/resolve-echo-endpoint` (a `ghcr.io/mccutchen/go-httpbin`
 * service container, addressed by raw container IP because Langflow's
 * `validators.url()` rejects a single-label host). Locally there may be none, so
 * the caller `test.skip`s with the reason this module returns.
 *
 * **Canonical home, and the only copy** (#1599). The functions were written in
 * `security/ssrf-url-validation.spec.ts` (#1391) and extracted here by #1595,
 * which left that spec's inline copy in place rather than dragging its four tests
 * into its own force-fail scope; #1599 migrated it. Both consumers now import
 * from here — that spec's admitted case, and
 * `security/model-provider-base-url-ssrf.spec.ts`'s non-vacuity control on the
 * provider seam. Keep it that way: the load-bearing branch is that a PUBLIC host
 * is *skipped* rather than accepted, and a second copy is the shape where a
 * tightening reaches one caller and not the other (#1108's 51 hand-copied
 * cleanup blocks are the precedent).
 */

/**
 * Whether an IPv4 literal falls in a range `lfx/utils/ssrf_protection.py` blocks
 * by default — and which a lane may therefore have to allow-list explicitly.
 *
 * A hostname answers **false**: this cannot know what a name resolves to, and
 * guessing is how a public endpoint would slip in as the admitted case.
 *
 * Deliberately wider than `isPrivateIpv4` in `scripts/resolve-echo-endpoint.mjs`,
 * which answers a different question (may this endpoint need the allow-list?) and
 * covers RFC-1918 only. Here the question is whether a 200 is attributable to the
 * allow-list, which is true for every range the guard blocks by default.
 */
export function isBlockedRangeIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host ?? "");
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 (loopback)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — the docker bridge
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local / cloud metadata)
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 (CGNAT)
  );
}

/** Either a usable base URL, or the reason a caller must skip instead. */
export type PrivateEchoEndpoint = { url: string } | { skipReason: string };

/**
 * Resolve the echo endpoint's base URL, refusing anything that would make an
 * admitted-case assertion vacuous.
 *
 * `env` is injected rather than read from `process.env` so the two refusals — no
 * variable, and a public host — are testable without mutating the environment.
 * The returned URL has no trailing slash, so a caller can append a path.
 */
export function privateEchoEndpoint(env: Record<string, string | undefined>): PrivateEchoEndpoint {
  const base = (env.ECHO_BASE_URL ?? env.HTTPBIN_BASE_URL ?? "").replace(/\/$/, "");

  if (!base) {
    return {
      skipReason:
        "ECHO_BASE_URL/HTTPBIN_BASE_URL is unset, so there is no private endpoint whose " +
        "reachability could only come from LANGFLOW_SSRF_ALLOWED_HOSTS. Every CI lane sets it " +
        "via .github/actions/resolve-echo-endpoint; locally, run " +
        "`docker run -d -p 8099:8080 ghcr.io/mccutchen/go-httpbin:latest` and pass the " +
        "container's IP (not `localhost` — Langflow blocks loopback and the container " +
        "cannot reach the host's loopback anyway).",
    };
  }

  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return { skipReason: `ECHO_BASE_URL is not a URL: ${base}` };
  }

  if (!isBlockedRangeIpv4(host)) {
    return {
      skipReason:
        `the echo endpoint resolved to ${base}, whose host is not an address Langflow blocks ` +
        "by default (a public host, or a name rather than an IP). Reaching it proves nothing " +
        "about the allow-list, so the assertion would be vacuous rather than green.",
    };
  }

  return { url: base };
}

/** `privateEchoEndpoint` over the real environment. */
export function privateEchoUrl(
  env: Record<string, string | undefined> = process.env,
): PrivateEchoEndpoint {
  return privateEchoEndpoint(env);
}
