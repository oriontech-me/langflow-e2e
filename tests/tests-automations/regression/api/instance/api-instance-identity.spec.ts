import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Nine operations that are each their own route group — the single-operation tail of
// the API surface. Spec doc: docs/api/instance/api-instance-identity.md
test.describe("Instance API — identity, configuration and health", () => {
  let headers: Record<string, string> = {};
  let anonymous: APIRequestContext;

  test.beforeAll(async ({ request, playwright }) => {
    headers = { Authorization: await getAuthToken(request) };
    // A context with NO Authorization header: the shared fixture context carries
    // storage state, so "unauthenticated" has to be an explicit second context or
    // the 403 assertions would be testing the wrong thing.
    anonymous = await playwright.request.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860",
      extraHTTPHeaders: {},
    });
  });

  test.afterAll(async () => {
    await anonymous.dispose();
  });

  test(
    "the three health routes are not synonyms of each other",
    { tag: ["@stable", "@api", "@settings"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /health", "GET /health_check", "GET /healthz"]);

      const shallow = await request.get("/health", { headers });
      expect(shallow.status()).toBe(200);
      expect(Object.keys(await shallow.json())).toEqual(["status"]);

      const check = await request.get("/health_check", { headers });
      expect(check.status()).toBe(200);
      const checkBody = await check.json();
      expect(Object.keys(checkBody).sort()).toEqual(["chat", "db", "status"]);

      const healthz = await request.get("/healthz", { headers });
      expect(healthz.status()).toBe(200);
      // Deep equality, not just a 200: /healthz and /health_check are the SAME probe,
      // and a change that made either shallower would weaken every gate polling it
      // while still answering 200.
      expect(await healthz.json()).toEqual(checkBody);
    },
  );

  test(
    "version and config answer unauthenticated, the catalog and starter projects do not",
    { tag: ["@stable", "@api", "@settings"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/version",
        "GET /api/v1/config",
        "GET /api/v1/all",
        "GET /api/v1/starter-projects/",
      ]);

      await test.step("version needs no credential, and a credential changes nothing", async () => {
        const res = await anonymous.get("/api/v1/version");
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["main_version", "package", "version"]);
        expect(typeof body.package).toBe("string");
        expect(body.package.length).toBeGreaterThan(0);
        expect(typeof body.version).toBe("string");

        // The same call WITH a credential — asserted because it is the contrast that
        // makes the config step below mean something: version is credential-blind,
        // config is not.
        const authed = await request.get("/api/v1/version", { headers });
        expect(authed.status()).toBe(200);
        expect(await authed.json()).toEqual(body);
      });

      await test.step("config answers TWO different bodies, and says which one you got", async () => {
        // Measured on 1.13.0.dev2: anonymous gets `type: "public"` with 12 keys,
        // a credential gets `type: "full"` with 35. The variant — not the flag
        // values, which differ per lane by design (#668, #1240) — is the contract:
        // a regression that served the full body to an anonymous caller would leak
        // operational settings (blocked_component_types, webhook_auth_enable,
        // mcp_base_url, the hide_* flags).
        const publicRes = await anonymous.get("/api/v1/config");
        expect(publicRes.status()).toBe(200);
        const publicBody = await publicRes.json();
        expect(publicBody.type).toBe("public");

        const fullRes = await request.get("/api/v1/config", { headers });
        expect(fullRes.status()).toBe(200);
        const fullBody = await fullRes.json();
        expect(fullBody.type).toBe("full");

        const publicKeys = Object.keys(publicBody);
        const fullKeys = new Set(Object.keys(fullBody));
        // A strict subset: everything public is also in the full body, and the full
        // body carries strictly more.
        for (const key of publicKeys) expect(fullKeys.has(key)).toBe(true);
        expect(fullKeys.size).toBeGreaterThan(publicKeys.length);

        // The withheld half, named rather than counted — a count would pass the day
        // one sensitive key leaked and another was dropped.
        for (const withheld of [
          "blocked_component_types",
          "custom_component_admin_only",
          "webhook_auth_enable",
          "hide_logout_button",
          "auto_saving",
        ]) {
          expect(fullKeys.has(withheld), `${withheld} missing from the full body`).toBe(true);
          expect(
            publicKeys,
            `${withheld} is exposed to an anonymous caller`,
          ).not.toContain(withheld);
        }
        expect(typeof publicBody.allow_custom_components).toBe("boolean");
      });

      await test.step("the catalog is refused without a credential and answers with one", async () => {
        const denied = await anonymous.get("/api/v1/all");
        expect(denied.status()).toBe(403);

        const res = await request.get("/api/v1/all", { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // This asserts the OPERATION, never the catalog's content: globalSetup's
        // drift guard owns that (#1040). Two traps are pinned all the same —
        // component_display_names is a metadata MAP and not a category, and the
        // categories are keyed by display name.
        expect(typeof body).toBe("object");
        expect(Object.keys(body).length).toBeGreaterThan(1);
        expect(typeof body.component_display_names).toBe("object");
        expect(Array.isArray(body.component_display_names)).toBe(false);
        expect(body.models_and_agents, "the models_and_agents category").toBeTruthy();
      });

      await test.step("starter projects are refused without a credential and are flows with one", async () => {
        const denied = await anonymous.get("/api/v1/starter-projects/");
        expect(denied.status()).toBe(403);

        const res = await request.get("/api/v1/starter-projects/", { headers });
        expect(res.status()).toBe(200);
        const rows = await res.json();
        expect(Array.isArray(rows)).toBe(true);
        // Not a count: how many starters ship is a property of the image.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].data, "a starter project carries a flow graph").toBeTruthy();
        expect(Array.isArray(rows[0].data.nodes)).toBe(true);
      });
    },
  );

  test(
    "log retrieval is disabled by default, and is not public either",
    { tag: ["@stable", "@api", "@settings"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /logs", "GET /logs-stream"]);

      for (const path of ["/logs", "/logs-stream"]) {
        await test.step(`${path} without a credential is refused`, async () => {
          const denied = await anonymous.get(path);
          expect(denied.status()).toBe(403);
        });

        await test.step(`${path} with a credential answers 501 while the buffer is off`, async () => {
          const res = await request.get(path, { headers });
          // 501, not 200 and not an open SSE stream: the retrieval buffer is sized
          // by LANGFLOW_LOG_RETRIEVER_BUFFER_SIZE, which defaults to 0, and
          // `enabled()` is `max > 0`. An instance that DOES enable it fails here,
          // which is the intent — the second branch gets written and read.
          expect(
            res.status(),
            `${path} answered ${res.status()}: this instance may have ` +
              "LANGFLOW_LOG_RETRIEVER_BUFFER_SIZE set, which needs the enabled-buffer " +
              "branch of this contract written",
          ).toBe(501);
          expect((await res.json()).detail).toBe("Log retrieval is disabled");
        });
      }
    },
  );
});
