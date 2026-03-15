import { expect, test } from "../../../../fixtures/fixtures";

// The health check endpoint is at /health_check (not under /api/v1/)
// It returns: { "status": "ok", "chat": "ok", "db": "ok" }

test.describe("API Health Check", () => {
  test(
    "GET /health_check returns 200 with status ok",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/health_check");

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("status");
      expect(body.status).toBe("ok");
    },
  );

  test(
    "GET /health_check returns db ok",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/health_check");

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("db");
      expect(body.db).toBe("ok");
    },
  );

  test(
    "GET /health_check responds within 5 seconds",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const start = Date.now();
      const response = await request.get("/health_check");
      const elapsed = Date.now() - start;

      expect(response.status()).toBe(200);
      expect(elapsed).toBeLessThan(5000);
    },
  );

  test(
    "GET /health_check response has correct content-type",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.get("/health_check");

      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("application/json");
    },
  );
});
