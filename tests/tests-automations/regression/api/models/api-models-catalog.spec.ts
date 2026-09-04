import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// The nine READ operations of the models family — the surface this suite's own
// infrastructure consumes (scripts/collect-models.*, every provider resolver) and
// which nothing asserts. All nine are hidden from /openapi.json.
// Spec doc: docs/api/models/api-models-catalog.md
test.describe("Models API — the catalog read surface", () => {
  let headers: Record<string, string> = {};

  type ProviderRow = {
    provider_id: string;
    provider: string;
    icon: string;
    is_configured: boolean;
    is_enabled: boolean;
    num_models: number;
    models: Array<{ model_name: string; metadata: Record<string, unknown> }>;
  };
  type Descriptor = { provider_id: string; display_name: string; provider: string };

  // Measured on 1.13.0.dev0. Asserted as the keys every row MUST carry — the
  // resolvers read `is_configured`, `models` and `num_models` by name — and
  // deliberately not as an exact set: the rows are NOT uniform. Provider-specific
  // extras exist (`aliases` on ibm-watsonx, `display_name` on openai-compatible and
  // vllm, `base_url` on openrouter), so an exact-equality assertion fails on a
  // healthy catalog while a superset one still catches a removed field.
  const CATALOG_ROW_KEYS = [
    "api_docs_url",
    "icon",
    "is_configured",
    "is_enabled",
    "live_discovery",
    "mapping",
    "max_tokens_field_name",
    "models",
    "num_models",
    "provider",
    "provider_id",
    "variables",
  ];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
  });

  const getJson = async (request: APIRequestContext, path: string) => {
    const res = await request.get(path, { headers });
    expect(res.status(), `${path} — ${await res.text()}`).toBe(200);
    return res.json();
  };

  test(
    "the three provider lists are a strict hierarchy, not three views of one list",
    { tag: ["@stable", "@api", "@model-provider"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/models",
        "GET /api/v1/models/providers",
        "GET /api/v1/models/provider-descriptors",
        "GET /api/v1/models/provider-variable-mapping",
      ]);

      const catalog = (await getJson(request, "/api/v1/models")) as ProviderRow[];
      const names = (await getJson(request, "/api/v1/models/providers")) as string[];
      const descriptors = (await getJson(
        request,
        "/api/v1/models/provider-descriptors",
      )) as Descriptor[];

      await test.step("each list has its own shape", async () => {
        expect(Array.isArray(catalog)).toBe(true);
        expect(catalog.length).toBeGreaterThan(0);
        for (const row of catalog) {
          expect(
            Object.keys(row).sort(),
            `GET /api/v1/models row "${row.provider_id}" is missing a required field`,
          ).toEqual(expect.arrayContaining(CATALOG_ROW_KEYS));
        }

        expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);

        for (const row of descriptors) {
          expect(Object.keys(row).sort()).toEqual(["display_name", "provider", "provider_id"]);
        }
      });

      await test.step("models ⊆ providers ⊆ descriptors — which is why the three counts differ", async () => {
        // Asserted as a SUBSET relation, never as counts: 9/11/14 on this image is a
        // packaging fact per image (#1040) and a hardcoded number would redden the day
        // one more distribution ships. The relation is the contract.
        const idByDisplayName = new Map(descriptors.map((d) => [d.display_name, d.provider_id]));
        const descriptorIds = new Set(descriptors.map((d) => d.provider_id));

        const namedIds = names.map((name) => {
          const id = idByDisplayName.get(name);
          expect(id, `GET /models/providers returned "${name}", absent from provider-descriptors`).
            toBeTruthy();
          return id as string;
        });
        const namedIdSet = new Set(namedIds);

        for (const id of namedIds) expect(descriptorIds.has(id)).toBe(true);
        for (const row of catalog) {
          expect(
            namedIdSet.has(row.provider_id),
            `GET /models lists "${row.provider_id}", absent from GET /models/providers`,
          ).toBe(true);
        }
        // A strict hierarchy: the descriptor list is the widest of the three.
        expect(descriptorIds.size).toBeGreaterThanOrEqual(namedIdSet.size);
        expect(namedIdSet.size).toBeGreaterThanOrEqual(catalog.length);
      });

      await test.step("the provider this suite depends on is in all three", async () => {
        const openai = catalog.find((row) => row.provider_id === "openai");
        expect(openai, "openai missing from GET /api/v1/models").toBeTruthy();
        expect(openai!.models.length).toBeGreaterThan(0);
        expect(openai!.num_models).toBe(openai!.models.length);
        expect(typeof openai!.models[0].model_name).toBe("string");
        expect(names).toContain("OpenAI");
        expect(descriptors.some((d) => d.provider_id === "openai")).toBe(true);
      });

      await test.step("the variable mapping names the key each provider is stored under", async () => {
        const mapping = (await getJson(
          request,
          "/api/v1/models/provider-variable-mapping",
        )) as Record<string, Array<{ variable_key: string; required: boolean; is_secret: boolean }>>;
        // Keyed by DISPLAY NAME, not provider_id — the trap for anyone reading it as
        // the catalog's twin.
        expect(Object.keys(mapping)).toContain("OpenAI");
        const openaiVars = mapping.OpenAI;
        expect(Array.isArray(openaiVars)).toBe(true);
        const apiKey = openaiVars.find((v) => v.variable_key === "OPENAI_API_KEY");
        expect(apiKey, "OPENAI_API_KEY missing from the OpenAI mapping").toBeTruthy();
        expect(apiKey!.required).toBe(true);
        expect(apiKey!.is_secret).toBe(true);
      });
    },
  );

  test(
    "the enabled and default reads hold their shape whether or not a provider is configured",
    { tag: ["@stable", "@api", "@model-provider"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/models/enabled_providers",
        "GET /api/v1/models/enabled_models",
        "GET /api/v1/models/default_model",
        "GET /api/v1/model_options/language",
        "GET /api/v1/model_options/embedding",
      ]);

      await test.step("enabled_providers reports one status per named provider", async () => {
        const body = (await getJson(request, "/api/v1/models/enabled_providers")) as {
          enabled_providers: string[];
          provider_status: Record<string, boolean>;
        };
        expect(Object.keys(body).sort()).toEqual(["enabled_providers", "provider_status"]);
        expect(Array.isArray(body.enabled_providers)).toBe(true);
        // The status map is keyed by the same display names GET /models/providers
        // returns — asserted as a set relation, not a count.
        const names = (await getJson(request, "/api/v1/models/providers")) as string[];
        expect(Object.keys(body.provider_status).sort()).toEqual([...names].sort());
        for (const value of Object.values(body.provider_status)) {
          expect(typeof value).toBe("boolean");
        }
        // Every enabled provider must be one the status map knows about.
        for (const name of body.enabled_providers) {
          expect(Object.keys(body.provider_status)).toContain(name);
        }
      });

      await test.step("enabled_models is a per-provider map of booleans", async () => {
        const body = (await getJson(request, "/api/v1/models/enabled_models")) as {
          enabled_models: Record<string, Record<string, boolean>>;
          enabled_models_by_type: Record<string, unknown>;
        };
        expect(Object.keys(body).sort()).toEqual(["enabled_models", "enabled_models_by_type"]);
        const providers = Object.keys(body.enabled_models);
        expect(providers.length).toBeGreaterThan(0);
        for (const models of Object.values(body.enabled_models)) {
          for (const flag of Object.values(models)) expect(typeof flag).toBe("boolean");
        }
      });

      await test.step("the default model read answers one envelope per model_type", async () => {
        for (const query of ["", "?model_type=language", "?model_type=embedding"]) {
          const body = await getJson(request, `/api/v1/models/default_model${query}`);
          expect(Object.keys(body)).toEqual(["default_model"]);
          // null when unset, a {model_name, provider, model_type} triple when set —
          // and NOT asserted as null: a lane that ran the provider sweep may have
          // one. The round-trip is asserted properly, on a principal the test owns,
          // in api-models-selection.spec.ts.
          if (body.default_model !== null) {
            expect(Object.keys(body.default_model).sort()).toEqual([
              "model_name",
              "model_type",
              "provider",
            ]);
          }
        }
      });

      await test.step("model_options answers option rows, and is empty only when nothing is configured", async () => {
        for (const kind of ["language", "embedding"]) {
          const body = (await getJson(request, `/api/v1/model_options/${kind}`)) as Array<
            Record<string, unknown>
          >;
          expect(Array.isArray(body)).toBe(true);
          // The CONTENT is a property of the instance and must not be asserted:
          // keyless it is `[]`; on a lane that ran the provider sweep it is one row
          // per selectable model. The first version of this step asserted `[]` and
          // reddened the PR lane, which configures credentials — the shape is the
          // contract, the emptiness is not.
          for (const row of body) {
            // A required SUPERSET, for the same reason the catalog rows are: the
            // /models rows already vary by provider, so an exact key set is the
            // wrong shape of assertion on this API.
            expect(Object.keys(row).sort(), `model_options/${kind} row`).toEqual(
              expect.arrayContaining([
                "category",
                "icon",
                "metadata",
                "name",
                "provider",
                "provider_id",
              ]),
            );
            expect(typeof row.name).toBe("string");
            expect(typeof row.provider_id).toBe("string");
          }
        }
      });
    },
  );
});
