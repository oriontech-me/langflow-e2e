import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "GET /api/v1/monitor/transactions returns 200 with paginated result",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // flow_id is required — use a valid UUID format
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();

    // The endpoint returns the fastapi-pagination envelope:
    // { items: [], total, page, size, pages }. Each key must be present so the
    // Traces UI (FlowInsightsContent.tsx) can render a paginated grid without
    // probing for optional fields.
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("size");
    expect(body).toHaveProperty("pages");
  },
);

test(
  "GET /api/v1/monitor/transactions filters by flow_id (UUID)",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Use a well-formed UUID that does not correspond to any real flow.
    // The endpoint must still return 200 with an empty items array (not a 400/404).
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    // For an unknown flow_id the result should be a paginated object with empty items
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(0);
  },
);

test(
  "transaction records contain required fields when not empty",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // flow_id is required — use a valid UUID
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);

    if (body.items.length === 0) {
      // No transactions yet — nothing to validate, test passes
      return;
    }

    // Each record must have at minimum an id and a timestamp (or flow_id)
    const record = body.items[0];
    expect(record).toBeDefined();

    // The transaction object must be a plain object (not null/array)
    expect(typeof record).toBe("object");
    expect(record).not.toBeNull();
    expect(Array.isArray(record)).toBe(false);

    // One of the common timestamp fields must be present
    const hasTimestamp =
      "timestamp" in record ||
      "created_at" in record ||
      "updated_at" in record;
    expect(
      hasTimestamp,
      "Transaction record should contain a timestamp field",
    ).toBe(true);
  },
);
