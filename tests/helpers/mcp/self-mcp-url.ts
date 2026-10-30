/**
 * The URL Langflow is given to reach its OWN project MCP transport.
 *
 * Two specs register the instance under test as an MCP server of itself, so the
 * URL is not fetched by Playwright but by Langflow, through its SSRF layer. From
 * 1.13.1 (upstream #16041) an MCP HTTP/SSE destination on loopback is refused
 * unless its host is listed in `LANGFLOW_SSRF_ALLOWED_HOSTS` — even with the
 * connector loopback exemption on — and the suite cannot list `localhost` or
 * `127.0.0.1`: three security specs use exactly those names as destinations the
 * layer must refuse.
 *
 * So a loopback base URL is rewritten to a dedicated name, `lf-self.localhost`,
 * which every lane and start script adds to the allowlist and nothing else uses.
 * `*.localhost` resolves to loopback without an `/etc/hosts` entry (RFC 6761;
 * measured on macOS and in the nightly image, whose nsswitch has `myhostname`).
 * Measured with the lanes' list plus that name: on 1.13.1rc1 it connects while
 * `localhost` and `127.0.0.1` stay refused, and on 1.13.1rc0, which predates the
 * policy, it connects too. A non-loopback base URL (a remote target, an RFC-1918
 * bind) is left alone — it is not what the policy refuses.
 */
export const DEFAULT_SELF_MCP_HOST = "lf-self.localhost";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function selfMcpUrl(
  projectId: string,
  baseUrl: string = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860/",
  selfHost: string = process.env.LANGFLOW_SELF_MCP_HOST || DEFAULT_SELF_MCP_HOST,
): string {
  const url = new URL(`/api/v1/mcp/project/${projectId}/streamable`, baseUrl);
  if (LOOPBACK_HOSTS.has(url.hostname)) url.hostname = selfHost;
  return url.toString();
}
