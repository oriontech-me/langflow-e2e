import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import {
  fetchComponentCatalog,
  findComponentTemplate,
} from "../../../helpers/flows/create-provider-model-flow-via-api";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { privateEchoUrl } from "../../../helpers/other/private-echo-endpoint";

/**
 * Which SSRF policy each Ollama and watsonx base-URL field applies.
 *
 * Spec doc: docs/security/ollama-watsonx-base-url-ssrf.md
 *
 * `security/model-provider-base-url-ssrf.spec.ts` covers OpenAI and Anthropic, the
 * two components behind the provider seam when it was created. On 1.12.0.dev38 the
 * Ollama and watsonx fields were recorded as outside it (§17.5, #2561). On the 1.14
 * line every one of them is guarded, but not all by the same policy:
 *
 *   - the CONNECTOR policy (Ollama, and the Language Model's watsonx field) refuses
 *     private and link-local addresses that are not allowlisted and admits loopback,
 *     because `connector_ssrf_allow_loopback` defaults to true;
 *   - the STRICT policy (the watsonx components, through `provider_ssrf`) also
 *     refuses loopback unless LANGFLOW_SSRF_ALLOWED_HOSTS names it.
 *
 * So this file pins the policy per field, and every admitted case asserts what
 * happened next (a connection attempt, the echo service's answer, the SDK's own
 * validation), because "no SSRF marker" alone also holds for a run that never got
 * as far as the guard.
 *
 * No `page` fixture, like the sibling: every call goes through `request`, which the
 * fixture's response monitors never see, so the assertions below are the evidence.
 * Serial for the same reason as the sibling: one catalog fetch and one API key
 * serve the whole file.
 */
test.describe.configure({ mode: "serial" });

/** The string every refusal carries, whatever its branch. */
const SSRF_MARKER = "SSRF Protection";

/**
 * Loopback by NAME, so the guard resolves it and reports both legs. Port 9
 * (discard) so the connection is refused at once on any lane, including the QA VM,
 * where Langflow runs natively and a common port may belong to another service.
 */
const LOOPBACK = "http://localhost:9";

/** The canonical SSRF target, and the one address no lane allowlists. */
const CLOUD_METADATA = "http://169.254.169.254";

/** A URL both policies reject before resolving any host. */
const FILE_SCHEME = "file:///etc/passwd";

/** The client's own failure to connect, reached only after the policy let the URL through. */
const CONNECTION_ATTEMPTED = "All connection attempts failed";

/** A project id the watsonx SDK accepts as a value; nothing here reaches IBM. */
const DUMMY_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

/** A deliberately invalid watsonx key; the runs never get far enough to use it. */
const DUMMY_WATSONX_KEY = "dummy-watsonx-key";

/** One base-URL field under test, and what its component needs to build. */
interface ModelUrlField {
  /** Component and field, for step titles and failure messages. */
  label: string;
  /** Catalog key in `GET /api/v1/all`. */
  componentType: string;
  /** The base-URL field under test. */
  field: string;
  /**
   * Field values the SDK needs to get as far as its own validation: a model, and
   * for watsonx a project id. Without them a run fails on a missing value before
   * the URL is ever looked at.
   */
  values: Record<string, unknown>;
  /**
   * The SDK's own refusal of a non-IBM URL without a username. It runs only after
   * the SSRF check has passed the URL, so it is the positive observable of an
   * admitted watsonx case. Absent for Ollama, whose observable is a connection.
   */
  sdkRefusal?: string;
}

const OLLAMA: ModelUrlField = {
  label: "Ollama · base_url",
  componentType: "ext:ollama:ChatOllamaComponent@official",
  field: "base_url",
  values: { model_name: "llama3.2:1b", api_key: "" },
};

const OLLAMA_EMBEDDINGS: ModelUrlField = {
  label: "Ollama Embeddings · base_url",
  componentType: "ext:ollama:OllamaEmbeddingsComponent@official",
  field: "base_url",
  values: { model_name: "all-minilm", api_key: "" },
};

const LANGUAGE_MODEL_OLLAMA: ModelUrlField = {
  label: "Language Model (Ollama) · ollama_base_url",
  componentType: "LanguageModelComponent",
  field: "ollama_base_url",
  values: { model: [{ name: "llama3.2:1b", provider: "Ollama" }], api_key: "" },
};

const WATSONX: ModelUrlField = {
  label: "IBM watsonx.ai · base_url",
  componentType: "ext:ibm:WatsonxAIComponent@official",
  field: "base_url",
  values: {
    model_name: "ibm/granite-3-8b-instruct",
    project_id: DUMMY_PROJECT_ID,
    api_key: DUMMY_WATSONX_KEY,
  },
  sdkRefusal: "validation error for ChatWatsonx",
};

const WATSONX_EMBEDDINGS: ModelUrlField = {
  label: "IBM watsonx.ai Embeddings · url",
  componentType: "ext:ibm:WatsonxEmbeddingsComponent@official",
  field: "url",
  values: {
    model_name: "ibm/slate-30m-english-rtrvr",
    project_id: DUMMY_PROJECT_ID,
    api_key: DUMMY_WATSONX_KEY,
  },
  sdkRefusal: "validation error for WatsonxEmbeddings",
};

const LANGUAGE_MODEL_WATSONX: ModelUrlField = {
  label: "Language Model (IBM watsonx) · base_url_ibm_watsonx",
  componentType: "LanguageModelComponent",
  field: "base_url_ibm_watsonx",
  values: {
    model: [{ name: "ibm/granite-3-8b-instruct", provider: "IBM WatsonX" }],
    project_id: DUMMY_PROJECT_ID,
    api_key: DUMMY_WATSONX_KEY,
  },
  sdkRefusal: "validation error for ChatWatsonx",
};

/**
 * A single-node flow with `url` in the field under test.
 *
 * Every field written is also SHOWN: a field the template ships hidden is not
 * passed to the component at build. Measured on the Language Model, whose
 * `project_id` ships hidden: left hidden, the run failed with "no project ID"
 * before the URL was looked at. Credentials are literal (`load_from_db: false`),
 * so no global variable is consulted.
 *
 * Throws naming the field when the template does not have it: a renamed field
 * would leave the component on its own default URL, and every verdict below would
 * be about an address this spec never set.
 */
function buildFlowData(catalog: Record<string, unknown>, target: ModelUrlField, url: string) {
  const node = findComponentTemplate(catalog, target.componentType);
  const values: Record<string, unknown> = { ...target.values, [target.field]: url };
  for (const [name, value] of Object.entries(values)) {
    if (!(name in node.template)) {
      throw new Error(
        `${target.label}: the ${target.componentType} template has no "${name}" field ` +
          `(fields: ${Object.keys(node.template).join(", ")}). It was renamed upstream.`,
      );
    }
    node.template[name] = {
      ...node.template[name],
      value,
      show: true,
      ...(name === "api_key" ? { load_from_db: false } : {}),
    };
  }
  if ("input_value" in node.template) {
    node.template.input_value = { ...node.template.input_value, value: "ping" };
  }
  const nodeId = `${target.componentType.replace(/[^A-Za-z]/g, "")}-ssrf`;
  return {
    nodes: [
      {
        id: nodeId,
        type: "genericNode",
        position: { x: 0, y: 0 },
        data: { id: nodeId, type: target.componentType, node },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test.describe("Ollama and watsonx base URLs apply the SSRF policy of their field", () => {
  let bearer: Record<string, string>;
  let apiKey: string;
  let apiKeyId: string;
  let catalog: Record<string, unknown>;

  /** Ids pushed BEFORE any assertion that can throw, so a red test cannot leak. */
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    bearer = { Authorization: await getAuthToken(request) };
    // POST /api/v1/run/{id} authenticates with x-api-key, not a bearer token.
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `ollama-watsonx-ssrf-${Date.now()}` },
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
   * Run `target` with `url` and return the response body as text: the run's error
   * arrives as a JSON string nested in `detail`, and every assertion here is about
   * which message came back.
   */
  async function runWith(
    request: APIRequestContext,
    target: ModelUrlField,
    url: string,
  ): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const flowId = await createFlow(
      request,
      {
        name: `Model URL SSRF ${target.field} ${suffix}`,
        description: "Single-node model flow for base-URL SSRF assertions",
        data: buildFlowData(catalog, target, url),
        is_component: false,
      },
      { headers: bearer },
    );
    createdFlowIds.push(flowId);
    const res = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: { input_value: "ping", input_type: "text", output_type: "text" },
    });
    return res.text();
  }

  test(
    "the watsonx components refuse loopback, the metadata address and a non-http scheme",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The strict provider policy: what sets these two apart from every connector
      // is the loopback refusal.
      for (const target of [WATSONX, WATSONX_EMBEDDINGS]) {
        await test.step(`${target.label}: loopback is refused, naming both addresses`, async () => {
          const text = await runWith(request, target, LOOPBACK);
          expect(text, `${target.label} must refuse a loopback URL`).toContain(SSRF_MARKER);
          // Both legs: a message naming only one would mean the other went unchecked.
          expect(text, "the IPv6 loopback leg must be reported").toContain("::1");
          expect(text).toContain("127.0.0.1");
          expect(text, "the refusal must name the operator's escape hatch").toContain(
            "LANGFLOW_SSRF_ALLOWED_HOSTS",
          );
        });

        await test.step(`${target.label}: the cloud-metadata address is refused`, async () => {
          const text = await runWith(request, target, CLOUD_METADATA);
          expect(text).toContain(SSRF_MARKER);
          expect(text, "the refusal must name the address it blocked").toContain(
            "169.254.169.254",
          );
        });

        await test.step(`${target.label}: a file: URL is refused, naming the scheme`, async () => {
          const text = await runWith(request, target, FILE_SCHEME);
          expect(text).toContain(SSRF_MARKER);
          expect(text).toContain("Invalid URL scheme 'file'");
        });
      }
    },
  );

  test(
    "the Ollama fields refuse the metadata address and a non-http scheme",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The half of the connector policy that makes admitting loopback (next test)
      // a decision rather than the absence of any policy.
      for (const target of [OLLAMA, OLLAMA_EMBEDDINGS, LANGUAGE_MODEL_OLLAMA]) {
        await test.step(`${target.label}: the cloud-metadata address is refused`, async () => {
          const text = await runWith(request, target, CLOUD_METADATA);
          expect(text, `${target.label} must refuse the metadata address`).toContain(
            SSRF_MARKER,
          );
          expect(text).toContain("169.254.169.254");
        });

        await test.step(`${target.label}: a file: URL is refused`, async () => {
          const text = await runWith(request, target, FILE_SCHEME);
          expect(text).toContain(SSRF_MARKER);
          // The connector validator quotes the whole URL rather than the scheme.
          expect(text).toContain(FILE_SCHEME);
        });
      }
    },
  );

  test(
    "the Ollama chat fields admit loopback, where Ollama runs by default",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // Ollama's default address IS loopback, so the strict policy would break every
      // local install. Ollama Embeddings is not here: its build does not connect,
      // so a loopback run answers 200 with nothing to observe.
      for (const target of [OLLAMA, LANGUAGE_MODEL_OLLAMA]) {
        await test.step(`${target.label}: loopback is admitted and connected to`, async () => {
          const text = await runWith(request, target, LOOPBACK);
          expect(text, `${target.label} must admit loopback (connector policy)`).not.toContain(
            SSRF_MARKER,
          );
          // The positive observable: the client tried to connect, which only happens
          // after the policy let the URL through.
          expect(text, "the client must have attempted the connection").toContain(
            CONNECTION_ATTEMPTED,
          );
        });
      }
    },
  );

  test(
    "the Language Model's watsonx field applies the connector policy, not the strict one",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The asymmetry this file pins: the watsonx components refuse loopback (first
      // test), this field admits it. Either side changing fails here and says which.
      const target = LANGUAGE_MODEL_WATSONX;

      await test.step("the cloud-metadata address is refused", async () => {
        const text = await runWith(request, target, CLOUD_METADATA);
        expect(text).toContain(SSRF_MARKER);
        expect(text).toContain("169.254.169.254");
      });

      await test.step("a file: URL is refused", async () => {
        const text = await runWith(request, target, FILE_SCHEME);
        expect(text).toContain(SSRF_MARKER);
        expect(text).toContain(FILE_SCHEME);
      });

      await test.step("loopback passes the SSRF check and reaches the SDK", async () => {
        const text = await runWith(request, target, LOOPBACK);
        expect(
          text,
          "the Language Model's watsonx field now refuses loopback: upstream moved it to the " +
            "strict policy. Update this test, its spec doc and QA-CHECKLIST §17.5",
        ).not.toContain(SSRF_MARKER);
        expect(text, "the SDK's own validation must have run").toContain(
          target.sdkRefusal as string,
        );
      });
    },
  );

  test(
    "an allow-listed private address is admitted on every field that connects",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The non-vacuity control: without it the refusals above are equally
      // consistent with "every non-default URL is refused".
      const echo = privateEchoUrl();
      test.skip("skipReason" in echo, "skipReason" in echo ? echo.skipReason : "");
      const base = (echo as { url: string }).url;

      for (const target of [OLLAMA, LANGUAGE_MODEL_OLLAMA]) {
        await test.step(`${target.label}: the private host answers`, async () => {
          const text = await runWith(request, target, base);
          expect(text, `${base} is private, so only the allowlist admits it`).not.toContain(
            SSRF_MARKER,
          );
          // A real HTTP answer from the private host: the echo service is not Ollama.
          expect(text, "the request must have reached the private host").toContain(
            "404 page not found",
          );
        });
      }

      for (const target of [WATSONX, WATSONX_EMBEDDINGS, LANGUAGE_MODEL_WATSONX]) {
        await test.step(`${target.label}: the URL reaches the SDK`, async () => {
          const text = await runWith(request, target, base);
          expect(text, `${base} is private, so only the allowlist admits it`).not.toContain(
            SSRF_MARKER,
          );
          expect(text, "the SDK's own validation must have run").toContain(
            target.sdkRefusal as string,
          );
        });
      }
    },
  );
});
