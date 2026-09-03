import * as fs from "node:fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { resolveAssetPath } from "../../../../helpers/filesystem/resolve-asset-path";

// The v2 files router: the USER-scoped store behind the Files page and behind
// every component that picks an already-uploaded file. Spec doc:
// docs/api/files/api-files-v2-store.md
//
// Three UI specs touch this surface today (knowledge-ingestion-management/
// {files-page,file-types-upload,upload-via-component}) but drive it through the
// browser and use the API only to clean up — no status and no body shape is
// asserted anywhere, so by the definition in
// docs/api/api-surface-coverage-gauge.md the family is uncovered.
test.describe("Files API — v2, user-scoped store", () => {
  const TEXT_ASSET = "test-file.txt";
  const JSON_ASSET = "test-file.json";

  // Id-scoped cleanup: the store is shared by every worker running as the
  // superuser, so a listing-diff cleanup would delete another worker's uploads —
  // the same destructive class as `cleanAllFlows` (#553/#518).
  const uploadedIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of uploadedIds) {
      const res = await request.delete(`/api/v2/files/${id}`, {
        headers: { Authorization: authToken },
      });
      // 404 is fine: the test may have deleted it as part of its own assertions.
      if (!res.ok() && res.status() !== 404) {
        console.warn(`⚠️ Orphan file left behind (${id}): ${res.status()}`);
      }
    }
    uploadedIds.length = 0;
  });

  /** Upload one asset into the user store and track its id for cleanup. */
  async function upload(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
    asset: string,
    mimeType: string,
  ): Promise<{
    id: string;
    name: string;
    path: string;
    size: number;
    provider: unknown;
  }> {
    const bytes = fs.readFileSync(resolveAssetPath(asset));
    const res = await request.post("/api/v2/files", {
      headers: { Authorization: authToken },
      multipart: { file: { name: asset, mimeType, buffer: bytes } },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    uploadedIds.push(body.id);
    return body;
  }

  test(
    "uploads a file, the store reports it, and deleting it removes it",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v2/files",
        "GET /api/v2/files",
        "GET /api/v2/files/{file_id}",
        "DELETE /api/v2/files/{file_id}",
      ]);
      const authToken = await getAuthToken(request);
      const bytes = fs.readFileSync(resolveAssetPath(TEXT_ASSET));

      const uploaded = await upload(request, authToken, TEXT_ASSET, "text/plain");

      await test.step("the upload response carries the store's own naming", async () => {
        expect(uploaded.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        // The store strips the extension for the display name and keeps the
        // original filename in the path — asserting only the id would miss a
        // regression in either.
        expect(uploaded.name).toBe("test-file");
        expect(uploaded.path).toMatch(new RegExp(`/${TEXT_ASSET}$`));
        expect(uploaded.size).toBe(bytes.length);
        expect(uploaded.provider).toBeNull();
      });

      await test.step("the listing entry agrees with the upload response", async () => {
        const res = await request.get("/api/v2/files", {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        const entry = (await res.json()).find(
          (f: { id: string }) => f.id === uploaded.id,
        );
        expect(entry).toBeDefined();
        expect(entry.name).toBe(uploaded.name);
        expect(entry.path).toBe(uploaded.path);
        expect(entry.size).toBe(uploaded.size);
        expect(typeof entry.user_id).toBe("string");
        expect(typeof entry.created_at).toBe("string");
        expect(typeof entry.updated_at).toBe("string");
      });

      await test.step("GET by id returns the CONTENT, not metadata", async () => {
        const res = await request.get(`/api/v2/files/${uploaded.id}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/octet-stream");
        // Byte comparison, not length: a truncating proxy passes a length check.
        expect(Buffer.compare(await res.body(), bytes)).toBe(0);
      });

      await test.step("DELETE by id confirms under `detail` and the listing drops it", async () => {
        // Asserted here rather than left to the afterEach hook: cleanup resolves
        // on any status, so the single-delete contract would be exercised every
        // run and verified none. It is also what makes the `detail`-versus-
        // `message` asymmetry with the batch delete an assertion, not a note.
        const res = await request.delete(`/api/v2/files/${uploaded.id}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).detail).toContain(uploaded.name);

        const list = await request.get("/api/v2/files", {
          headers: { Authorization: authToken },
        });
        const remaining = (await list.json()).map((f: { id: string }) => f.id);
        expect(remaining).not.toContain(uploaded.id);
      });
    },
  );

  test(
    "renames a file without moving it",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v2/files",
        "PUT /api/v2/files/{file_id}",
        "GET /api/v2/files",
        "GET /api/v2/files/{file_id}",
      ]);
      const authToken = await getAuthToken(request);
      const bytes = fs.readFileSync(resolveAssetPath(TEXT_ASSET));
      const uploaded = await upload(request, authToken, TEXT_ASSET, "text/plain");
      const newName = `renamed-${Date.now()}`;

      const res = await request.put(
        `/api/v2/files/${uploaded.id}?name=${encodeURIComponent(newName)}`,
        { headers: { Authorization: authToken } },
      );
      expect(res.status()).toBe(200);
      const renamed = await res.json();
      expect(renamed.name).toBe(newName);
      // The rename is metadata-only: the stored path does NOT follow the name.
      // A client that resolved the file by path after renaming would break if
      // this ever changed, which is why both halves are asserted.
      expect(renamed.path).toBe(uploaded.path);

      const list = await request.get("/api/v2/files", {
        headers: { Authorization: authToken },
      });
      const entry = (await list.json()).find(
        (f: { id: string }) => f.id === uploaded.id,
      );
      expect(entry.name).toBe(newName);
      expect(entry.path).toBe(uploaded.path);

      const content = await request.get(`/api/v2/files/${uploaded.id}`, {
        headers: { Authorization: authToken },
      });
      expect(Buffer.compare(await content.body(), bytes)).toBe(0);
    },
  );

  test(
    "zips a batch and deletes a batch",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v2/files",
        "POST /api/v2/files/batch/",
        "DELETE /api/v2/files/batch/",
        "GET /api/v2/files",
      ]);
      const authToken = await getAuthToken(request);
      const first = await upload(request, authToken, TEXT_ASSET, "text/plain");
      const second = await upload(request, authToken, JSON_ASSET, "application/json");
      const ids = [first.id, second.id];

      await test.step("POST batch/ returns a zip holding both files", async () => {
        const res = await request.post("/api/v2/files/batch/", {
          headers: { Authorization: authToken },
          data: ids,
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/x-zip-compressed");
        const zip = await res.body();
        // The ZIP magic, then both member names: a 200 carrying an empty archive
        // would pass a status check and serve nothing.
        expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        const asText = zip.toString("latin1");
        // The members are named by the store's DISPLAY name plus the original
        // extension — not by the uploaded filename. Measured: uploading
        // test-file.txt and then test-file.json lands the second as
        // "test-file (1)", because the store enforces unique display names by
        // suffixing, so the zip member reads `test-file (1).json`. Asserting the
        // asset filenames instead of the reported names is state-dependent: the
        // suffix appears whenever a file of that name already exists, including
        // one another worker uploaded.
        expect(asText).toContain(`${first.name}.txt`);
        expect(asText).toContain(`${second.name}.json`);
      });

      await test.step("DELETE batch/ confirms the count and empties both", async () => {
        const res = await request.delete("/api/v2/files/batch/", {
          headers: { Authorization: authToken },
          data: ids,
        });
        expect(res.status()).toBe(200);
        // `message`, where the single delete answers `detail` — a client
        // normalising on one key silently loses the other's confirmation.
        expect((await res.json()).message).toBe("2 files deleted successfully");

        const list = await request.get("/api/v2/files", {
          headers: { Authorization: authToken },
        });
        const remaining = (await list.json()).map((f: { id: string }) => f.id);
        expect(remaining).not.toContain(first.id);
        expect(remaining).not.toContain(second.id);
      });
    },
  );

  test(
    "the batch path requires its trailing slash",
    { tag: ["@stable", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      // Only the upload is declared: the two calls below deliberately land on
      // `/api/v2/files/{file_id}` with "batch" as the id, so crediting them
      // would mark the single-file DELETE covered by a request that asserts the
      // opposite of its contract.
      apiCoverage.declare(["POST /api/v2/files", "GET /api/v2/files"]);
      const authToken = await getAuthToken(request);
      const uploaded = await upload(request, authToken, TEXT_ASSET, "text/plain");

      // The 405 and 422 below need no `allowHttpErrors()` hatch: the fixture's
      // HTTP monitor listens on `page.on("response")`, and this spec drives the
      // API through the `request` context, which the monitor never sees.
      await test.step("POST without the slash answers 405", async () => {
        const res = await request.post("/api/v2/files/batch", {
          headers: { Authorization: authToken },
          data: [uploaded.id],
        });
        expect(res.status()).toBe(405);
      });

      await test.step("DELETE without the slash is a uuid_parsing error on file_id", async () => {
        const res = await request.delete("/api/v2/files/batch", {
          headers: { Authorization: authToken },
          data: [uploaded.id],
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        // The body is the evidence that the request reached the SINGLE-file
        // route: it names `file_id` and echoes "batch" as the value it could not
        // parse. A bare 422 would not distinguish this from a rejected payload.
        expect(detail.type).toBe("uuid_parsing");
        expect(detail.loc).toEqual(["path", "file_id"]);
        expect(detail.input).toBe("batch");
      });

      await test.step("and the file is still there — the malformed calls deleted nothing", async () => {
        const list = await request.get("/api/v2/files", {
          headers: { Authorization: authToken },
        });
        const remaining = (await list.json()).map((f: { id: string }) => f.id);
        expect(remaining).toContain(uploaded.id);
      });
    },
  );

  test(
    "DELETE /api/v2/files empties the caller's store",
    { tag: ["@destructive", "@api", "@files"] },
    async ({ request, apiCoverage }) => {
      // @destructive and deliberately NOT @stable: the store is per-user and
      // every worker shares the superuser, so this wipes files other tests are
      // reading. `playwright.config.ts` grepInverts @destructive out of every
      // normal run and CI runs it alone with PW_DESTRUCTIVE=1 at workers: 1.
      // Combining it with @stable would put it in a lane with no destructive
      // pass, where it would silently never run (#1010).
      apiCoverage.declare([
        "POST /api/v2/files",
        "GET /api/v2/files",
        "DELETE /api/v2/files",
      ]);
      const authToken = await getAuthToken(request);
      const first = await upload(request, authToken, TEXT_ASSET, "text/plain");
      const second = await upload(request, authToken, JSON_ASSET, "application/json");

      const before = await request.get("/api/v2/files", {
        headers: { Authorization: authToken },
      });
      const beforeIds = (await before.json()).map((f: { id: string }) => f.id);
      expect(beforeIds).toContain(first.id);
      expect(beforeIds).toContain(second.id);

      const res = await request.delete("/api/v2/files", {
        headers: { Authorization: authToken },
      });
      expect(res.status()).toBe(200);

      const after = await request.get("/api/v2/files", {
        headers: { Authorization: authToken },
      });
      expect(after.status()).toBe(200);
      // The empty store is the assertion, not a delta: this endpoint's contract
      // is "everything", and a delta would pass against an endpoint that deleted
      // only the two files this test uploaded.
      expect(await after.json()).toEqual([]);
    },
  );
});
