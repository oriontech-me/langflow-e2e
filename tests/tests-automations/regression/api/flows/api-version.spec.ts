import { expect, test } from "../../../../fixtures/fixtures";

// The version endpoint is at /api/v1/version and is public (no auth required).
// It returns: { "version": "1.11.0", "main_version": "1.11.0", "package": "Langflow" }
// Note: there is no /api/v1/health endpoint — the uptime probe lives at /health_check
// (covered by api-health-check.spec.ts). This spec covers the version contract.

test.describe("API Version", () => {
  test(
    "GET /api/v1/version returns 200 with a non-empty version string",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/api/v1/version");

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("version");
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
      // Sanity-check it looks like a semantic version (e.g. 1.11.0)
      expect(body.version).toMatch(/^\d+\.\d+/);
    },
  );

  test(
    "GET /api/v1/version reports the Langflow package and main_version",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/api/v1/version");

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("main_version");
      expect(typeof body.main_version).toBe("string");
      expect(body.main_version.length).toBeGreaterThan(0);

      expect(body).toHaveProperty("package");
      // Accept both distributions: "Langflow" (full) and "Langflow Base"
      expect(typeof body.package).toBe("string");
      expect(body.package.toLowerCase()).toContain("langflow");
    },
  );

  test(
    "GET /api/v1/version response has correct content-type",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/api/v1/version");

      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("application/json");
    },
  );

  test(
    "GET /api/v1/version responds within 5 seconds",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const start = Date.now();
      const response = await request.get("/api/v1/version");
      const elapsed = Date.now() - start;

      expect(response.status()).toBe(200);
      expect(elapsed).toBeLessThan(5000);
    },
  );

  test(
    "POST /api/v1/version returns 405 Method Not Allowed",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.post("/api/v1/version");

      expect(response.status()).toBe(405);
    },
  );
});
