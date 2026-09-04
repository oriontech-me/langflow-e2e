import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// The four WRITE operations of the models family, driven as a THROWAWAY USER.
// Spec doc: docs/api/models/api-models-selection.md
//
// Why a throwaway user and not @destructive: these endpoints do not write instance
// settings, they write the CALLING USER's global variables
// (variable_service.get_variable_object(user_id=current_user.id, …)). On the shared
// superuser that is contention — the core-functionality/model-provider and
// core-functionality/memory specs read this state — so this file creates its own
// principal, acts as it, and deletes it. The isolation is asserted in test 2 from
// both principals at once.
test.describe("Models API — the selection write surface", () => {
  let superHeaders: Record<string, string> = {};
  let userHeaders: Record<string, string> = {};
  let throwawayUserId = "";

  test.beforeAll(async ({ request }) => {
    superHeaders = { Authorization: await getAuthToken(request) };
    const username = `pmodels${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const password = "Throwaway!12345";

    const created = await request.post("/api/v1/users/", {
      headers: superHeaders,
      data: { username, password },
    });
    expect(created.status(), await created.text()).toBe(201);
    const body = await created.json();
    throwawayUserId = body.id;
    // Measured: a user created through the API arrives INACTIVE and cannot log in
    // until a superuser activates it.
    expect(body.is_active).toBe(false);
    expect(body.is_superuser).toBe(false);

    const activated = await request.patch(`/api/v1/users/${throwawayUserId}`, {
      headers: superHeaders,
      data: { is_active: true },
    });
    expect(activated.status(), await activated.text()).toBe(200);
    expect((await activated.json()).is_active).toBe(true);

    // Form-encoded, not JSON — and exactly ONE login per file, because OSS
    // rate-limits /api/v1/login at 5/min per IP on a fixed window.
    const login = await request.post("/api/v1/login", {
      headers: superHeaders,
      form: { username, password },
    });
    expect(login.status(), await login.text()).toBe(200);
    userHeaders = { Authorization: `Bearer ${(await login.json()).access_token}` };
  });

  test.afterAll(async ({ request }) => {
    if (!throwawayUserId) return;
    // Deleting the user takes its variables — and therefore every write this file
    // made — with it. Asserted, not ignored: a silent failure here would leave the
    // next run's assertions reading somebody else's state.
    const res = await request.delete(`/api/v1/users/${throwawayUserId}`, {
      headers: superHeaders,
    });
    if (res.status() !== 200) {
      console.warn(`⚠️ Orphan user left behind (${throwawayUserId}): ${await res.text()}`);
      return;
    }
    expect((await res.json()).detail).toBe("User deleted");
  });

  const defaultModel = async (
    request: APIRequestContext,
    headers: Record<string, string>,
    query = "",
  ) => {
    const res = await request.get(`/api/v1/models/default_model${query}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()).default_model;
  };

  test(
    "validating a provider answers 200 with the verdict in the body",
    { tag: ["@stable", "@api", "@model-provider"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/models/validate-provider"]);

      await test.step("a wrong key is a 200 whose body says it is invalid", async () => {
        const res = await request.post("/api/v1/models/validate-provider", {
          headers: userHeaders,
          data: { provider: "OpenAI", variables: { OPENAI_API_KEY: "sk-not-a-real-key" } },
        });
        // The trap this assertion exists for: the status is 200 for a DEAD
        // credential. A status-only check certifies a key that cannot work.
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.valid).toBe(false);
        expect(body.error).toContain("OpenAI");
      });

      await test.step("an unknown provider is a 404, not an invalid verdict", async () => {
        const res = await request.post("/api/v1/models/validate-provider", {
          headers: userHeaders,
          data: { provider: "NotAProvider", variables: { X: "y" } },
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Model provider not found");
      });

      await test.step("the body is validated on the field that is wrong", async () => {
        const empty = await request.post("/api/v1/models/validate-provider", {
          headers: userHeaders,
          data: { provider: "", variables: {} },
        });
        expect(empty.status()).toBe(422);
        const emptyDetail = (await empty.json()).detail[0];
        expect(emptyDetail.loc).toEqual(["body", "provider"]);
        expect(emptyDetail.msg).toContain("Provider cannot be empty");

        const noVars = await request.post("/api/v1/models/validate-provider", {
          headers: userHeaders,
          data: { provider: "OpenAI" },
        });
        expect(noVars.status()).toBe(422);
        const varsDetail = (await noVars.json()).detail[0];
        expect(varsDetail.loc).toEqual(["body", "variables"]);
        expect(varsDetail.type).toBe("missing");
      });
    },
  );

  test(
    "the default model is per user, scoped by model_type, and only its provider is validated",
    { tag: ["@stable", "@api", "@model-provider"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/models/default_model",
        "POST /api/v1/models/default_model",
        "DELETE /api/v1/models/default_model",
      ]);

      await test.step("a model name no provider serves is accepted and persisted", async () => {
        expect(await defaultModel(request, userHeaders)).toBeNull();
        const res = await request.post("/api/v1/models/default_model", {
          headers: userHeaders,
          data: {
            model_name: "definitely-not-a-model",
            provider: "OpenAI",
            model_type: "language",
          },
        });
        expect(res.status()).toBe(200);
        // Pinned as measured behaviour: only the PROVIDER is validated. A default
        // model can be set to a string no provider serves, and it reads back.
        expect((await res.json()).default_model).toEqual({
          model_name: "definitely-not-a-model",
          provider: "OpenAI",
          model_type: "language",
        });
        expect(await defaultModel(request, userHeaders)).toEqual({
          model_name: "definitely-not-a-model",
          provider: "OpenAI",
          model_type: "language",
        });
      });

      await test.step("the superuser reads null at the same moment — the state is per user", async () => {
        expect(
          await defaultModel(request, superHeaders),
          "the throwaway user's default leaked onto the shared superuser",
        ).toBeNull();
      });

      await test.step("the refusals land on the field that is wrong", async () => {
        const badType = await request.post("/api/v1/models/default_model", {
          headers: userHeaders,
          data: { model_name: "x", provider: "OpenAI", model_type: "nope" },
        });
        expect(badType.status()).toBe(422);
        expect((await badType.json()).detail[0].msg).toContain(
          "model_type must be 'language' or 'embedding'",
        );

        const emptyProvider = await request.post("/api/v1/models/default_model", {
          headers: userHeaders,
          data: { model_name: "x", provider: "", model_type: "language" },
        });
        expect(emptyProvider.status()).toBe(422);
        expect((await emptyProvider.json()).detail[0].loc).toEqual(["body", "provider"]);

        const unknownProvider = await request.post("/api/v1/models/default_model", {
          headers: userHeaders,
          data: { model_name: "x", provider: "NotAProvider", model_type: "language" },
        });
        expect(unknownProvider.status()).toBe(404);
        expect((await unknownProvider.json()).detail).toBe("Model provider not found");
      });

      await test.step("an unknown model_type silently reads the EMBEDDING slot", async () => {
        const res = await request.post("/api/v1/models/default_model", {
          headers: userHeaders,
          data: { model_name: "embed-default", provider: "OpenAI", model_type: "embedding" },
        });
        expect(res.status()).toBe(200);
        // The route branches `language` vs everything else, so a garbage model_type
        // is not a 422 — it answers with the embedding default. Proven by having a
        // DIFFERENT value in the language slot at the same time.
        const garbage = await defaultModel(request, userHeaders, "?model_type=zzz");
        expect(garbage.model_name).toBe("embed-default");
        expect(garbage.model_type).toBe("embedding");
        expect((await defaultModel(request, userHeaders, "?model_type=language")).model_name).toBe(
          "definitely-not-a-model",
        );
      });

      await test.step("DELETE answers 200 and clears only the type it names", async () => {
        const res = await request.delete("/api/v1/models/default_model?model_type=language", {
          headers: userHeaders,
        });
        // 200 with the cleared value, not 204.
        expect(res.status()).toBe(200);
        expect((await res.json()).default_model).toBeNull();
        expect(await defaultModel(request, userHeaders, "?model_type=language")).toBeNull();
        expect(
          (await defaultModel(request, userHeaders, "?model_type=embedding")).model_name,
          "the language delete also cleared the embedding slot",
        ).toBe("embed-default");

        const embedding = await request.delete("/api/v1/models/default_model?model_type=embedding", {
          headers: userHeaders,
        });
        expect(embedding.status()).toBe(200);
        expect(await defaultModel(request, userHeaders, "?model_type=embedding")).toBeNull();
      });
    },
  );

  test(
    "the enabled_models write stores a DISABLED set, and it is per user",
    { tag: ["@stable", "@api", "@model-provider"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/models/enabled_models",
        "GET /api/v1/models/enabled_models",
      ]);

      /**
       * The stored sets have no GET of their own — the write returns them, and an
       * EMPTY list is a pure read: measured on 1.13.0.dev0, a `POST []` leaves an
       * existing disable in place and echoes both sets back.
       */
      const storedSets = async (headers: Record<string, string>) => {
        const res = await request.post("/api/v1/models/enabled_models", {
          headers,
          data: [],
        });
        expect(res.status(), await res.text()).toBe(200);
        return (await res.json()) as { disabled_models: string[]; enabled_models: string[] };
      };
      const derivedFlag = async (headers: Record<string, string>, provider: string, model: string) => {
        const res = await request.get("/api/v1/models/enabled_models", { headers });
        expect(res.status()).toBe(200);
        return (await res.json()).enabled_models?.[provider]?.[model];
      };

      const provider = "OpenAI";
      const listing = await request.get("/api/v1/models/enabled_models", { headers: userHeaders });
      expect(listing.status()).toBe(200);
      const models = Object.keys((await listing.json()).enabled_models[provider] ?? {});
      expect(models.length, `no ${provider} models in enabled_models`).toBeGreaterThan(0);
      const modelId = models[0];

      await test.step("a single object is refused: the body is a list", async () => {
        const res = await request.post("/api/v1/models/enabled_models", {
          headers: userHeaders,
          data: { provider, model_id: modelId, enabled: true },
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        expect(detail.loc).toEqual(["body"]);
        expect(detail.type).toBe("list_type");
      });

      await test.step("a disable is stored, namespaced provider::model_id", async () => {
        expect((await storedSets(userHeaders)).disabled_models).toEqual([]);
        const res = await request.post("/api/v1/models/enabled_models", {
          headers: userHeaders,
          data: [{ provider, model_id: modelId, enabled: false }],
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(body.disabled_models).toEqual([`${provider}::${modelId}`]);
        expect(body.enabled_models).toEqual([]);
      });

      await test.step("the shared superuser's stored sets are untouched", async () => {
        // The isolation proof, read at the moment the throwaway user's set is
        // non-empty — this is why the file does not need @destructive.
        const theirs = await storedSets(superHeaders);
        expect(
          theirs.disabled_models,
          "the throwaway user's disable leaked onto the shared superuser",
        ).toEqual([]);
      });

      await test.step("enabling on an UNCONFIGURED provider records nothing, and the derived flag never moved", async () => {
        const res = await request.post("/api/v1/models/enabled_models", {
          headers: userHeaders,
          data: [{ provider, model_id: modelId, enabled: true }],
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // The disable is lifted; the enable itself is NOT stored — there is nothing
        // to enable while the provider has no credential.
        expect(body.disabled_models).toEqual([]);
        expect(body.enabled_models).toEqual([]);
        // And the derived flag in GET enabled_models is computed from the
        // provider's configured state, not from the stored sets: it reads false
        // through all of the above.
        expect(await derivedFlag(userHeaders, provider, modelId)).toBe(false);
      });
    },
  );
});
