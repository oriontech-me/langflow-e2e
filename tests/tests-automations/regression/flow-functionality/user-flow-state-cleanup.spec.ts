import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

// Log in via the REST API and return a Bearer token. The login endpoint takes
// application/x-www-form-urlencoded (same shape as helpers/auth/auth-helpers.ts).
// Langflow rate-limits POST /api/v1/login (HTTP 429); tolerate that transient
// backpressure with a bounded backoff-retry — this is explicit infra rate
// limiting, not a product failure, and the isolation assertions stay hard.
async function loginApi(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const form = new URLSearchParams();
  form.append("username", username);
  form.append("password", password);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await request.post("/api/v1/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    });
    if (res.status() === 200) {
      return `Bearer ${(await res.json()).access_token}`;
    }
    if (res.status() === 429 && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    expect(res.status(), "login should succeed").toBe(200);
  }
  throw new Error("login did not succeed within retry budget");
}

async function flowNames(
  request: APIRequestContext,
  bearer: string,
): Promise<string[]> {
  const res = await request.get("/api/v1/flows/?get_all=true&header_flows=true", {
    headers: { Authorization: bearer },
  });
  expect(res.status(), "flow list should return 200").toBe(200);
  const flows: Array<{ name?: string }> = await res.json();
  return flows.map((f) => f.name ?? "");
}

test(
  "flow state should be properly cleaned up between user sessions",
  { tag: ["@stable", "@release", "@api", "@database"] },
  async ({ request }) => {
    const suffix = Math.random().toString(36).substring(2);
    const userAName = `user_a_${suffix}`;
    const userAPassword = `pass_a_${suffix}`;
    const userAFlowName = `flow_a_${suffix}`;

    let adminToken = "";
    let userAId = "";
    let userAToken = "";
    let userAFlowId = "";

    try {
      await test.step("superuser creates and activates User A", async () => {
        // Admin token via /api/v1/auto_login (the instance is auto-login mode,
        // so this returns the superuser token) — avoids a second POST /login and
        // its rate limit.
        adminToken = await getAuthToken(request);
        expect(adminToken, "admin token must be present").not.toBe("");

        const createRes = await request.post("/api/v1/users/", {
          headers: {
            Authorization: adminToken,
            "Content-Type": "application/json",
          },
          data: { username: userAName, password: userAPassword },
        });
        expect(createRes.status(), "user creation should return 201").toBe(201);
        userAId = (await createRes.json()).id;

        // New users are created inactive and cannot log in until activated.
        const activateRes = await request.patch(`/api/v1/users/${userAId}`, {
          headers: {
            Authorization: adminToken,
            "Content-Type": "application/json",
          },
          data: { is_active: true },
        });
        expect(activateRes.status(), "user activation should return 200").toBe(
          200,
        );
      });

      await test.step("User A logs in and creates a flow", async () => {
        userAToken = await loginApi(request, userAName, userAPassword);

        const flowRes = await request.post("/api/v1/flows/", {
          headers: {
            Authorization: userAToken,
            "Content-Type": "application/json",
          },
          data: {
            name: userAFlowName,
            description: "",
            data: { nodes: [], edges: [] },
          },
        });
        expect(flowRes.status(), "flow creation should return 201").toBe(201);
        userAFlowId = (await flowRes.json()).id;
      });

      await test.step("the superuser cannot see User A's flow", async () => {
        const adminFlows = await flowNames(request, adminToken);
        expect(
          adminFlows,
          "superuser flow list must NOT contain User A's flow",
        ).not.toContain(userAFlowName);
      });

      await test.step("User A can see their own flow", async () => {
        const userAFlows = await flowNames(request, userAToken);
        expect(
          userAFlows,
          "User A flow list must contain their own flow",
        ).toContain(userAFlowName);
      });
    } finally {
      // Cleanup: the flow is deleted with User A's token (the superuser cannot
      // see or delete another user's flow — a corollary of the isolation under
      // test), then User A is removed with the admin token.
      if (userAFlowId && userAToken) {
        await request
          .delete(`/api/v1/flows/${userAFlowId}`, {
            headers: { Authorization: userAToken },
          })
          .catch(() => {});
      }
      if (userAId && adminToken) {
        await request
          .delete(`/api/v1/users/${userAId}`, {
            headers: { Authorization: adminToken },
          })
          .catch(() => {});
      }
    }
  },
);
