import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  ANTHROPIC_MODEL,
  OPENAI_MODEL,
  type ProviderModelUnderTest,
  createProviderModelFlowViaApi,
  fetchComponentCatalog,
} from "../../../helpers/flows/create-provider-model-flow-via-api";
import { privateEchoUrl } from "../../../helpers/other/private-echo-endpoint";

/**
 * The connector SSRF policy on model-provider base URLs — upstream
 * langflow-ai/langflow#14640 and its follow-up #14704, both on `release-1.12.0`.
 *
 * Spec doc: docs/security/model-provider-base-url-ssrf.md
 *
 * A provider component's base-URL field is tenant-editable AND credential-bearing:
 * the SDK performs a server-side request to whatever host it names, carrying the
 * operator's stored provider credential. `lfx/base/models/provider_ssrf.py` says so
 * itself — the field is "both an SSRF primitive and a credential-exfiltration
 * primitive". That module is the SINGLE SEAM where those components apply the
 * policy, "so a new provider bundle picks up the guard by importing one helper
 * rather than copy-pasting a call site"; #14704 followed two days later to close the
 * call sites the first pass missed. A seam whose whole value is that every provider
 * goes through it, and which already needed one follow-up, is what a spec is for —
 * and the regression is silent by construction: a component that stops consulting
 * the policy still builds, still runs, and still returns a plausible error. It just
 * sends the credential somewhere internal first.
 *
 * NOT `security/ssrf-url-validation.spec.ts` with a different component. That file
 * (#1391) covers the allow-list round trip on the API Request component — an
 * ordinary connector, a different code path, and a deliberately laxer policy.
 * Provider URLs are stricter, in the module's own words: "literal loopback is
 * blocked unless the operator explicitly trusts it through
 * LANGFLOW_SSRF_ALLOWED_HOSTS", while ordinary connectors ship
 * `connector_ssrf_allow_loopback=True` (read back from Settings() on dev38).
 *
 * No `page` fixture, and therefore no allowHttpErrors()/allowFlowErrors(): every
 * call here goes through the `request` fixture and the fixture's monitors are
 * `page.on("response")` listeners, which a request call never reaches. The honest
 * consequence is that checklist step 4 carries no information for this file — the
 * refusals are evidence only because they are asserted directly. (The sibling calls
 * both hatches, in the one test of its own that takes a page.)
 *
 * Serial, like the sibling and for the same reason: one catalog fetch and one minted
 * API key serve the whole file, and nothing here benefits from a second worker.
 */
test.describe.configure({ mode: "serial" });

/** The string every refusal carries, whatever its branch. */
const SSRF_MARKER = "SSRF Protection";

/** A blocked destination reached by NAME, so the guard resolves it. */
const LOOPBACK_BY_NAME = "http://localhost:8080/v1";

/** The canonical SSRF target, and the address no lane allow-lists. */
const CLOUD_METADATA = "http://169.254.169.254/v1";

/** A URL the guard rejects before it ever resolves a host. */
const NON_HTTP_SCHEME = "file:///etc/passwd";

test.describe("Model-provider base URLs go through the connector SSRF policy", () => {
  let bearer: Record<string, string>;
  let apiKey: string;
  let apiKeyId: string;
  let catalog: Record<string, unknown>;

  /** Ids pushed BEFORE any assertion that can throw, so a red test cannot leak. */
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request);
    bearer = { Authorization: token };

    // POST /api/v1/run/{id} authenticates with x-api-key, not a bearer token.
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `provider-ssrf-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const key = await keyRes.json();
    apiKey = key.api_key;
    apiKeyId = key.id;

    catalog = await fetchComponentCatalog(request, bearer);
  });

  test.afterAll(async ({ request }) => {
    try {
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, { headers: bearer }).catch(() => {});
      }
    } finally {
      if (apiKeyId) {
        await request.delete(`/api/v1/api_key/${apiKeyId}`, { headers: bearer });
      }
    }
  });

  /**
   * Wire `baseUrl` into `provider`, run the flow, and return the raw response body.
   *
   * The body is read as TEXT rather than JSON: the run's error arrives as a JSON
   * string nested inside `detail`, so every assertion in this file is about which
   * message came back, and text is the shape that cannot lose it to an escaping
   * change.
   */
  async function runWith(
    request: APIRequestContext,
    provider: ProviderModelUnderTest,
    baseUrl: string,
  ): Promise<{ status: number; text: string }> {
    const flow = await createProviderModelFlowViaApi(request, bearer, catalog, {
      provider,
      nodeId: `${provider.label}-ssrf-node`,
      baseUrl,
    });
    createdFlowIds.push(flow.flowId);

    const res = await request.post(`/api/v1/run/${flow.flowId}`, {
      headers: { "x-api-key": apiKey },
      data: { input_value: "ping", input_type: "text", output_type: "text" },
    });
    return { status: res.status(), text: await res.text() };
  }

  test(
    "a loopback base URL is refused, naming every address the name resolves to",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const { text } = await runWith(request, OPENAI_MODEL, LOOPBACK_BY_NAME);

      expect(text, "a provider base URL on loopback must be refused").toContain(SSRF_MARKER);
      // Both legs, because the guard resolves the name and reports every address
      // behind it. A message naming only one would mean the other went unchecked —
      // and `localhost` resolving to `::1` first is the common case.
      expect(text, "the IPv6 loopback leg must be reported too").toContain("::1");
      expect(text).toContain("127.0.0.1");
      // Provider URLs are STRICTER than ordinary connectors, which ship
      // connector_ssrf_allow_loopback=true. This refusal is that difference.
      expect(text, "the refusal must name the escape hatch an operator would use").toContain(
        "LANGFLOW_SSRF_ALLOWED_HOSTS",
      );
    },
  );

  test(
    "the cloud-metadata address is refused",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const { text } = await runWith(request, OPENAI_MODEL, CLOUD_METADATA);

      expect(text).toContain(SSRF_MARKER);
      expect(text, "the refusal must name the address it blocked").toContain("169.254.169.254");
    },
  );

  test(
    "a non-http(s) scheme is refused, naming the scheme",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // A different branch of the validator from the two above: this one never gets
      // as far as resolving a host, so a regression could plausibly close the
      // address checks and leave the scheme check open, or the reverse.
      const { text } = await runWith(request, OPENAI_MODEL, NON_HTTP_SCHEME);

      expect(text).toContain(SSRF_MARKER);
      expect(text, "the refusal must name the scheme it rejected").toContain("'file'");
      expect(text).toContain("Only http and https are allowed");
    },
  );

  test(
    "the same policy guards the Anthropic component through its differently-named field",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // OpenAI's field is `openai_api_base`; Anthropic's is `base_url`. #14704
      // exists because a per-component fix missed a call site, so a spec that
      // asserted one component would have passed the regression it was written for.
      for (const [label, url, fragment] of [
        ["loopback", LOOPBACK_BY_NAME, "127.0.0.1"],
        ["cloud metadata", CLOUD_METADATA, "169.254.169.254"],
        ["a non-http(s) scheme", NON_HTTP_SCHEME, "'file'"],
      ] as const) {
        await test.step(`${label} is refused through base_url`, async () => {
          const { text } = await runWith(request, ANTHROPIC_MODEL, url);
          expect(text).toContain(SSRF_MARKER);
          expect(text).toContain(fragment);
        });
      }
    },
  );

  test(
    "an allow-listed private base URL is admitted through the provider seam",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // The non-vacuity control for every refusal above: without it they are equally
      // consistent with "the policy blocks every non-default URL", which would be a
      // different and also broken product.
      const echo = privateEchoUrl();
      test.skip("skipReason" in echo, "skipReason" in echo ? echo.skipReason : "");
      const base = (echo as { url: string }).url;

      const { text } = await runWith(request, OPENAI_MODEL, `${base}/v1`);

      expect(
        text,
        `${base} is in a range Langflow blocks by default, so reaching it can only come from ` +
          "LANGFLOW_SSRF_ALLOWED_HOSTS — the policy was consulted and said yes",
      ).not.toContain(SSRF_MARKER);
      // A positive observable, so "the marker is absent" cannot pass on a run that
      // never happened: the echo service is not an OpenAI-compatible API, so it
      // answers 404 — which is a real HTTP response from a private host.
      expect(text, "the request must have reached the private endpoint").toContain("404");
    },
  );

  test(
    "the provider's own endpoint skips the policy on both components",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // `_is_provider_default` treats an empty value AND the provider's canonical
      // endpoint as nothing to constrain: no client minted, no DNS round trip.
      // Asserting only refusals would not notice that branch collapsing into
      // "validate everything" or widening into "validate nothing".
      //
      // This is also the control that survives an unset ECHO_BASE_URL, since the
      // test above skips without one and these refusals must not stand alone.
      for (const provider of [OPENAI_MODEL, ANTHROPIC_MODEL]) {
        for (const [label, baseUrl] of [
          ["an empty base URL", ""],
          ["the canonical endpoint", provider.canonicalBaseUrl],
        ] as const) {
          await test.step(`${provider.label}: ${label} reaches the provider`, async () => {
            const { text } = await runWith(request, provider, baseUrl);

            expect(text, "the skip path must not consult the SSRF policy").not.toContain(
              SSRF_MARKER,
            );
            // The provider's OWN words, not a bare 401: the claim is that the
            // request left the box and the provider decided, which is what makes
            // the absence above mean "skipped" rather than "died earlier".
            expect(
              text,
              `${provider.label} must have refused the deliberately invalid key itself`,
            ).toContain(provider.authRefusalFragment);
          });
        }
      }
    },
  );
});
