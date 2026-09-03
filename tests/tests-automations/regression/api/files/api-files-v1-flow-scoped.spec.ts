import * as fs from "node:fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";

// The v1 files router: the FLOW-scoped file store every component that reads or
// writes a file goes through, plus the bundled profile-picture assets. Spec doc:
// docs/api/files/api-files-v1-flow-scoped.md
//
// Nothing drove these as a contract before #1692. The three specs that touch
// files today (knowledge-ingestion-management/{files-page,file-types-upload,
// upload-via-component}) drive the *v2* store through the browser and use the
// API only to clean up, so no status and no body shape was ever asserted.
//
// Every test declares the operations it covers through the `apiCoverage`
// fixture: a declared operation the test never issues FAILS it, which is what
// makes `npm run api:coverage` a measurement instead of a comment (#1692).
test.describe("Files API — v1, flow-scoped", () => {
  const TEXT_ASSET = "test-file.txt";
  const IMAGE_ASSET = "chain.png";

  // Id-scoped cleanup: the flow id comes from the creation 201 and afterEach
  // deletes exactly that id. Never a listing diff and never a global wipe —
  // under this suite's parallelism both delete flows other workers are driving
  // (#553/#518).
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  /** A flow of our own to scope the uploads to, tracked for cleanup. */
  async function createFlow(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
  ): Promise<string> {
    const res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: `api-files-v1 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: "created by api-files-v1-flow-scoped.spec.ts",
        data: { nodes: [], edges: [] },
      },
    });
    expect(res.status()).toBe(201);
    const flow = await res.json();
    createdFlowIds.push(flow.id);
    return flow.id as string;
  }

  test(
    "upload, list and download round-trip a flow-scoped file",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/files/upload/{flow_id}",
        "GET /api/v1/files/list/{flow_id}",
        "GET /api/v1/files/download/{flow_id}/{file_name}",
      ]);
      const authToken = await getAuthToken(request);
      const flowId = await createFlow(request, authToken);
      const assetPath = resolveAssetPath(TEXT_ASSET);
      const assetBytes = fs.readFileSync(assetPath);

      let uploadedName = "";

      await test.step("POST upload returns 201 with the stamped path", async () => {
        const res = await request.post(`/api/v1/files/upload/${flowId}`, {
          headers: { Authorization: authToken },
          multipart: {
            file: {
              name: TEXT_ASSET,
              mimeType: "text/plain",
              buffer: assetBytes,
            },
          },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.flowId).toBe(flowId);
        // `<flow_id>/<YYYY-MM-DD_HH-MM-SS>_<original name>` — the store stamps
        // the name, so the upload response is the only place the real filename
        // comes from.
        expect(body.file_path).toMatch(
          new RegExp(`^${flowId}/\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}_${TEXT_ASSET}$`),
        );
        uploadedName = String(body.file_path).split("/").pop() ?? "";
      });

      await test.step("GET list returns exactly that file", async () => {
        const res = await request.get(`/api/v1/files/list/${flowId}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ files: [uploadedName] });
      });

      await test.step("GET download returns the bytes that were uploaded", async () => {
        const res = await request.get(
          `/api/v1/files/download/${flowId}/${encodeURIComponent(uploadedName)}`,
          { headers: { Authorization: authToken } },
        );
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/octet-stream");
        // The bytes, not the length: a truncating proxy passes a length check.
        expect(Buffer.compare(await res.body(), assetBytes)).toBe(0);
      });
    },
  );

  test(
    "deletes a flow-scoped file and the listing reflects it",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/files/upload/{flow_id}",
        "DELETE /api/v1/files/delete/{flow_id}/{file_name}",
        "GET /api/v1/files/list/{flow_id}",
      ]);
      const authToken = await getAuthToken(request);
      const flowId = await createFlow(request, authToken);

      const upload = await request.post(`/api/v1/files/upload/${flowId}`, {
        headers: { Authorization: authToken },
        multipart: {
          file: {
            name: TEXT_ASSET,
            mimeType: "text/plain",
            buffer: fs.readFileSync(resolveAssetPath(TEXT_ASSET)),
          },
        },
      });
      expect(upload.status()).toBe(201);
      const uploadedName = String((await upload.json()).file_path)
        .split("/")
        .pop() as string;

      await test.step("DELETE confirms the file by name", async () => {
        const res = await request.delete(
          `/api/v1/files/delete/${flowId}/${encodeURIComponent(uploadedName)}`,
          { headers: { Authorization: authToken } },
        );
        expect(res.status()).toBe(200);
        expect((await res.json()).message).toContain(uploadedName);
      });

      await test.step("the listing is empty and the download no longer resolves", async () => {
        const list = await request.get(`/api/v1/files/list/${flowId}`, {
          headers: { Authorization: authToken },
        });
        expect(list.status()).toBe(200);
        expect(await list.json()).toEqual({ files: [] });

        // Asserted as "not 2xx" rather than a specific code: which code a
        // missing flow-scoped file gets is not part of this contract, and
        // pinning it would pin an implementation detail.
        const gone = await request.get(
          `/api/v1/files/download/${flowId}/${encodeURIComponent(uploadedName)}`,
          { headers: { Authorization: authToken } },
        );
        expect(gone.ok()).toBe(false);
      });
    },
  );

  test(
    "serves an image through images/ and refuses an unknown flow",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/files/upload/{flow_id}",
        "GET /api/v1/files/images/{flow_id}/{file_name}",
      ]);
      const authToken = await getAuthToken(request);
      const flowId = await createFlow(request, authToken);
      const imageBytes = fs.readFileSync(resolveAssetPath(IMAGE_ASSET));

      const upload = await request.post(`/api/v1/files/upload/${flowId}`, {
        headers: { Authorization: authToken },
        multipart: {
          file: {
            name: IMAGE_ASSET,
            mimeType: "image/png",
            buffer: imageBytes,
          },
        },
      });
      expect(upload.status()).toBe(201);
      const uploadedName = String((await upload.json()).file_path)
        .split("/")
        .pop() as string;

      await test.step("images/ serves it as image/png", async () => {
        const res = await request.get(
          `/api/v1/files/images/${flowId}/${encodeURIComponent(uploadedName)}`,
          { headers: { Authorization: authToken } },
        );
        expect(res.status()).toBe(200);
        // The content type is the assertion, not just the 200: this endpoint
        // exists to serve images to the chat preview, and a 200 carrying
        // octet-stream would break it while passing a status check.
        expect(res.headers()["content-type"]).toBe("image/png");
        expect(await res.body()).toHaveLength(imageBytes.length);
      });

      await test.step("uploading to a flow that does not exist is refused", async () => {
        // The premise assertion for the whole family: a store that accepted a
        // file for a nonexistent flow would make every scoping claim above
        // meaningless.
        const res = await request.post(
          "/api/v1/files/upload/11111111-2222-3333-4444-555555555555",
          {
            headers: { Authorization: authToken },
            multipart: {
              file: { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
            },
          },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Flow not found");
      });
    },
  );

  test(
    "serves the bundled profile pictures",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/files/profile_pictures/list",
        "GET /api/v1/files/profile_pictures/{folder_name}/{file_name}",
      ]);
      const authToken = await getAuthToken(request);

      const list = await request.get("/api/v1/files/profile_pictures/list", {
        headers: { Authorization: authToken },
      });
      expect(list.status()).toBe(200);
      const files = (await list.json()).files as string[];
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      // Every entry is `<folder>/<name>.svg` — the shape the next call splits on.
      for (const entry of files) expect(entry).toMatch(/^[^/]+\/.+\.svg$/);

      const [folder, ...rest] = files[0].split("/");
      const res = await request.get(
        `/api/v1/files/profile_pictures/${encodeURIComponent(folder)}/${encodeURIComponent(rest.join("/"))}`,
        { headers: { Authorization: authToken } },
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/svg+xml");
      expect((await res.text()).trimStart()).toMatch(/^<(\?xml|svg)/);
    },
  );
});
