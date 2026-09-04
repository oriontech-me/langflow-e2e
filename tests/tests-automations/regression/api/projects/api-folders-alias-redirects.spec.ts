import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteProject } from "../../../../helpers/flows/delete-project";

// /api/v1/folders is not a second implementation — it is a router of pure
// redirects onto /api/v1/projects, hidden from /openapi.json and asserted
// nowhere in this repo. Spec doc: docs/api/projects/api-folders-alias-redirects.md
//
// Every call here sets maxRedirects: 0. The default follows the redirect, which
// would assert the TARGET's answer — the one thing this file must not do.
test.describe("Folders API — the legacy alias", () => {
  const createdProjectIds: string[] = [];

  // Short names: a project's derived MCP server name is
  // `lf-${sanitize_mcp_name(name)[:26]}` and must be unique per user (#1409).
  const uniqueName = (label: string) =>
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    for (const id of createdProjectIds) {
      await deleteProject(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
      });
    }
    createdProjectIds.length = 0;
  });

  test(
    "every folders route is a 307 onto its projects twin, and the alias has no PUT",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/folders/",
        "POST /api/v1/folders/",
        "GET /api/v1/folders/{folder_id}",
        "PATCH /api/v1/folders/{folder_id}",
        "DELETE /api/v1/folders/{folder_id}",
        "GET /api/v1/folders/download/{folder_id}",
        "POST /api/v1/folders/upload/",
      ]);
      const headers = { Authorization: await getAuthToken(request) };

      const seed = await request.post("/api/v1/projects/", {
        headers,
        data: { name: uniqueName("pali") },
      });
      expect(seed.status(), await seed.text()).toBe(201);
      const projectId = (await seed.json()).id as string;
      createdProjectIds.push(projectId);

      const options = { headers, maxRedirects: 0 };

      await test.step("the six read/write aliases redirect onto the exact twin path", async () => {
        const cases: Array<[string, Promise<{ status(): number; headers(): Record<string, string> }>]> = [
          ["GET /api/v1/folders/", request.get("/api/v1/folders/", options)],
          [
            "GET /api/v1/folders/{id}",
            request.get(`/api/v1/folders/${projectId}`, options),
          ],
          [
            "PATCH /api/v1/folders/{id}",
            request.patch(`/api/v1/folders/${projectId}`, {
              ...options,
              data: { name: uniqueName("pnop") },
            }),
          ],
          [
            "DELETE /api/v1/folders/{id}",
            request.delete(`/api/v1/folders/${projectId}`, options),
          ],
          [
            "GET /api/v1/folders/download/{id}",
            request.get(`/api/v1/folders/download/${projectId}`, options),
          ],
          ["POST /api/v1/folders/upload/", request.post("/api/v1/folders/upload/", options)],
        ];
        const expected = [
          "/api/v1/projects/",
          `/api/v1/projects/${projectId}`,
          `/api/v1/projects/${projectId}`,
          `/api/v1/projects/${projectId}`,
          `/api/v1/projects/download/${projectId}`,
          "/api/v1/projects/upload/",
        ];

        for (const [index, [label, pending]] of cases.entries()) {
          const res = await pending;
          expect(res.status(), `${label} must not answer for itself`).toBe(307);
          // Exact, never a substring: a redirect onto the wrong id would pass a
          // `toContain("/api/v1/projects/")` check.
          expect(res.headers().location, `${label} location`).toBe(expected[index]);
        }
      });

      await test.step("the DELETE alias redirected without deleting anything", async () => {
        // Proof the step above asserted the alias and not its target: the
        // project the DELETE named is still there.
        const still = await request.get(`/api/v1/projects/${projectId}`, { headers });
        expect(still.status()).toBe(200);
      });

      await test.step("the read alias forwards its query string, hand-built and all", async () => {
        const res = await request.get(
          `/api/v1/folders/${projectId}?is_component=true&is_flow=true&search=probe&page=2&size=5`,
          options,
        );
        expect(res.status()).toBe(307);
        // The route rebuilds the target URL by hand, so the parameters are
        // re-serialized from Python values — `True`, not `true`.
        expect(res.headers().location).toBe(
          `/api/v1/projects/${projectId}?is_component=True&is_flow=True&search=probe&page=2&size=5`,
        );
      });

      await test.step("the verb the alias does not have answers 405", async () => {
        const res = await request.put(`/api/v1/folders/${projectId}`, {
          ...options,
          data: { name: uniqueName("pnop") },
        });
        expect(res.status()).toBe(405);
        expect(res.headers().allow).toContain("GET");
      });

      await test.step("following one for real proves the 307 kept the method and the body", async () => {
        const name = uniqueName("pfol");
        const res = await request.post("/api/v1/folders/", { headers, data: { name } });
        // Default maxRedirects: the client follows, and a 307 — unlike a 302 —
        // must arrive at the target as the same POST carrying the same body.
        expect(res.status(), await res.text()).toBe(201);
        const created = await res.json();
        createdProjectIds.push(created.id);
        expect(created.name).toBe(name);
      });
    },
  );
});
