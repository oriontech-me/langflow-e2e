import { request as pwRequest, type APIRequestContext, type Request } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { ECHO_OUTPUT, createEchoFlow } from "../../../../helpers/api/evals/evaluations";
import { fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Scoped API keys on OSS (#2573): Langflow 1.14 (upstream #16000) lets a key carry a
 * permission policy, enforced by an authorization service that is a pass-through on
 * OSS. The OSS contract is that the feature is unavailable: it says so, it refuses every
 * policy write, and keys keep full owner access.
 *
 * The refusal matters more than it looks. `_scoped_key_can_authenticate` denies ANY key
 * with a stored policy while authorization is off, so an OSS build that accepted a write
 * would silently lock the key out, not restrict it.
 *
 * The positive control runs on a cookie-less context: the auto-login cookie
 * authenticates on its own, and with it a BOGUS key created a flow (201, measured).
 *
 * Contract and measurements: docs/api/auth/api-key-permissions-oss.md.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PERMISSION_OPTIONS = "/api/v1/api_key/permission-options";
const API_KEYS = "/api/v1/api_key/";
const permissionsPath = (id: string) => `/api/v1/api_key/${id}/permissions`;

/** Well-formed (it passes the policy's own validation), so only authorization can refuse it. */
const READ_FLOWS_POLICY = { restrictions: [{ resource_type: "flow", actions: ["read"] }] };
const AUTHZ_REQUIRED = "Scoped API keys require enabled authorization";
const UNAVAILABLE_NOTICE =
  "Scoped key management requires enabled authorization support. Existing key limits have been preserved.";

interface ApiKeyRow {
  id: string;
  name: string;
  permissions: unknown;
  total_uses: number;
}

async function listKeys(request: APIRequestContext, headers: Record<string, string>): Promise<ApiKeyRow[]> {
  const res = await request.get(API_KEYS, { headers });
  expect(res.status(), `GET ${API_KEYS} — ${await res.text()}`).toBe(200);
  return (await res.json()).api_keys as ApiKeyRow[];
}

async function readKey(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<ApiKeyRow> {
  const key = (await listKeys(request, headers)).find((row) => row.id === id);
  if (!key) throw new Error(`API key ${id} is not in GET ${API_KEYS}`);
  return key;
}

test.describe("API keys — scoped permissions on OSS", () => {
  let headers: Record<string, string>;
  let skipReason: string | null = null;
  let keyIds: string[];
  let flowIds: string[];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const res = await request.get(PERMISSION_OPTIONS, { headers });
    if (res.status() === 404) {
      skipReason = `GET ${PERMISSION_OPTIONS} is 404: this build predates scoped API keys (Langflow 1.14)`;
      return;
    }
    expect(res.status(), `GET ${PERMISSION_OPTIONS} — ${await res.text()}`).toBe(200);
    const options = await res.json();
    if (options.supported !== false) {
      throw new Error(
        `scoped-keys premise: ${PERMISSION_OPTIONS} reports supported=${JSON.stringify(options.supported)}. ` +
          "An authorization plugin enforcing key scopes is active, which is the Enterprise contract, not the OSS one " +
          "this spec pins. Point PLAYWRIGHT_BASE_URL at an OSS instance.",
      );
    }
  });

  test.beforeEach(() => {
    keyIds = [];
    flowIds = [];
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test.afterEach(async ({ request }) => {
    const errors: string[] = [];
    for (const id of flowIds) await deleteFlow(request, id, { headers }).catch((e: Error) => errors.push(e.message));
    for (const id of keyIds) await deleteApiKey(request, id, headers).catch((e: Error) => errors.push(e.message));
    if (errors.length > 0) throw new Error(`cleanup left resources behind:\n${errors.join("\n")}`);
  });

  test("permission-options states that scoped keys are unsupported, with no options", { tag: ["@stable", "@api", "@auth"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([`GET ${PERMISSION_OPTIONS}`]);

    await test.step("the options answer supported:false with every option set empty", async () => {
      const res = await request.get(PERMISSION_OPTIONS, { headers });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ supported: false, roles: [], resource_actions: {}, scope_types: {} });
    });
  });

  test("a key's permissions cannot be set, and a refused write leaves the key unchanged", { tag: ["@stable", "@api", "@auth"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([`POST ${API_KEYS}`, `GET ${API_KEYS}`, "PATCH /api/v1/api_key/{api_key_id}/permissions"]);
    let keyId = "";

    await test.step("a plain key starts with no policy", async () => {
      keyId = (await createApiKey(request, headers, { namePrefix: "e2e-2573-patch" })).id;
      keyIds.push(keyId);
      expect((await readKey(request, headers, keyId)).permissions).toBeNull();
    });

    await test.step("a well-formed policy is refused with 403, and the key still has no policy", async () => {
      const res = await request.patch(permissionsPath(keyId), { headers, data: { permissions: READ_FLOWS_POLICY } });
      expect(res.status(), await res.text()).toBe(403);
      expect(await res.json()).toEqual({ detail: AUTHZ_REQUIRED });
      expect((await readKey(request, headers, keyId)).permissions).toBeNull();
    });

    await test.step("an empty policy is a 422 on body.permissions, before any authorization check", async () => {
      const res = await request.patch(permissionsPath(keyId), { headers, data: { permissions: {} } });
      expect(res.status(), await res.text()).toBe(422);
      const [error] = (await res.json()).detail;
      expect(error.loc).toEqual(["body", "permissions"]);
      expect(error.msg).toBe("Value error, Restricted keys require roles or explicit restrictions");
    });

    await test.step("removing the policy (null) is allowed and leaves the key unrestricted, secret masked", async () => {
      const res = await request.patch(permissionsPath(keyId), { headers, data: { permissions: null } });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toMatchObject({ id: keyId, permissions: null, api_key: "********" });
    });

    await test.step("an unknown key is 404", async () => {
      const res = await request.patch(permissionsPath("00000000-0000-4000-8000-000000000000"), {
        headers,
        data: { permissions: READ_FLOWS_POLICY },
      });
      expect(res.status(), await res.text()).toBe(404);
      expect(await res.json()).toEqual({ detail: "API Key not found" });
    });
  });

  test("a key cannot be created with permissions, and the refusal creates nothing", { tag: ["@stable", "@api", "@auth"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([`POST ${API_KEYS}`, `GET ${API_KEYS}`]);
    const name = `e2e-2573-scoped-${uid()}`;

    await test.step("creating a key with a well-formed policy is refused with 403", async () => {
      const res = await request.post(API_KEYS, { headers, data: { name, permissions: READ_FLOWS_POLICY } });
      // Tracked before asserting: a regression that created the key must not leak it.
      if (res.ok()) keyIds.push((await res.json()).id);
      expect(res.status(), await res.text()).toBe(403);
      expect(await res.json()).toEqual({ detail: AUTHZ_REQUIRED });
    });

    await test.step("no key carries the refused name", async () => {
      expect((await listKeys(request, headers)).filter((row) => row.name === name)).toEqual([]);
    });
  });

  test("after a refused restriction the key keeps full owner access: it creates and runs a flow", { tag: ["@stable", "@api", "@auth"] }, async ({ request, baseURL }) => {
    const key = await createApiKey(request, headers, { namePrefix: "e2e-2573-access" });
    keyIds.push(key.id);
    const keyHeaders = { "x-api-key": key.key };
    const catalog = await fetchComponentCatalog(request, headers);
    const bare = await pwRequest.newContext({ baseURL });

    try {
      await test.step("the restriction is refused and the key has not been used yet", async () => {
        const res = await request.patch(permissionsPath(key.id), { headers, data: { permissions: READ_FLOWS_POLICY } });
        expect(res.status(), await res.text()).toBe(403);
        expect(await readKey(request, headers, key.id)).toMatchObject({ permissions: null, total_uses: 0 });
      });

      await test.step("without a cookie, no header and a bogus key are both refused", async () => {
        const none = await bare.post("/api/v1/flows/", { data: { name: `e2e-2573-none-${uid()}`, data: null } });
        if (none.ok()) flowIds.push((await none.json()).id);
        expect(none.status(), await none.text()).toBe(403);

        const bogus = await bare.post("/api/v1/flows/", {
          headers: { "x-api-key": "sk-e2e-2573-not-a-real-key" },
          data: { name: `e2e-2573-bogus-${uid()}`, data: null },
        });
        if (bogus.ok()) flowIds.push((await bogus.json()).id);
        expect(bogus.status(), await bogus.text()).toBe(403);
        expect(await bogus.json()).toEqual({ detail: "Invalid API key" });
      });

      let flowId = "";

      await test.step("the key alone creates a flow, owned by the key's owner", async () => {
        flowId = await createEchoFlow(bare, keyHeaders, `e2e-2573-flow-${uid()}`, { catalog });
        flowIds.push(flowId);
        const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
        expect(res.status()).toBe(200);
        const whoami = await (await request.get("/api/v1/users/whoami", { headers })).json();
        expect((await res.json()).user_id).toBe(whoami.id);
      });

      await test.step("the key runs the flow on v1 and on v2, each run echoing its own sentinel", async () => {
        const v1Sentinel = `KEY-V1-${uid()}`;
        const v1 = await bare.post(`/api/v1/run/${flowId}?stream=false`, {
          headers: keyHeaders,
          data: { input_value: v1Sentinel, input_type: "chat", output_type: "chat" },
        });
        expect(v1.status(), await v1.text()).toBe(200);
        // The ChatOutput's message, not the whole body: v1 also echoes the input under outputs[0].inputs.
        expect((await v1.json()).outputs[0].outputs[0].results.message.text).toBe(v1Sentinel);

        const v2Sentinel = `KEY-V2-${uid()}`;
        const v2 = await bare.post("/api/v2/workflows", {
          headers: keyHeaders,
          data: { flow_id: flowId, input_value: v2Sentinel, mode: "sync" },
        });
        expect(v2.status(), await v2.text()).toBe(200);
        const v2Body = await v2.json();
        expect(v2Body.status).toBe("completed");
        expect(v2Body.outputs[ECHO_OUTPUT].content).toBe(v2Sentinel);
      });

      await test.step("the key authenticated exactly the three calls made with it, and is still unrestricted", async () => {
        expect(await readKey(request, headers, key.id)).toMatchObject({ permissions: null, total_uses: 3 });
      });
    } finally {
      await bare.dispose();
    }
  });

  test("Settings › API keys shows the permissions read-only: full owner access, an unavailable notice, Save disabled", { tag: ["@stable", "@auth", "@settings"] }, async ({ page, request }) => {
    keyIds.push((await createApiKey(request, headers, { namePrefix: "e2e-2573-ui" })).id);
    const permissionWrites: string[] = [];
    page.on("request", (req: Request) => {
      if (req.method() !== "GET" && new URL(req.url()).pathname.endsWith("/permissions")) {
        permissionWrites.push(`${req.method()} ${req.url()}`);
      }
    });
    const cells = page.locator('.ag-row [col-id="permissions"]');

    await test.step("the grid has a Permissions column, and every rendered key reads Full owner access", async () => {
      await page.goto("/settings/api-keys");
      await expect(page.locator('.ag-header-cell[col-id="permissions"]')).toHaveText("Permissions");
      await expect(cells.first()).toBeVisible();
      // The grid virtualizes and pages its rows (#2505), so the rendered ones are asserted, not a named one.
      const texts = await cells.allInnerTexts();
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.map((text) => text.trim())).toEqual(texts.map(() => "Full owner access"));
    });

    await test.step("a key's permissions open a notice instead of an editor, and Save stays disabled", async () => {
      const button = cells.first().getByRole("button");
      const label = await button.getAttribute("aria-label");
      const name = label?.replace(/^Edit permissions for /, "");
      expect(label, "the cell button is named after its key").toMatch(/^Edit permissions for .+/);

      const optionsRead = page.waitForResponse(
        (res) => new URL(res.url()).pathname === PERMISSION_OPTIONS && res.request().method() === "GET",
      );
      await button.click();
      expect((await optionsRead).status()).toBe(200);

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(`Permissions for ${name}`, { exact: true })).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(UNAVAILABLE_NOTICE);
      await expect(dialog.locator('input, select, textarea, [role="radio"], [role="combobox"], [role="checkbox"]')).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Save permissions" })).toBeDisabled();
    });

    await test.step("nothing was written, and Cancel closes the dialog", async () => {
      expect(permissionWrites).toEqual([]);
      await page.getByRole("dialog").getByTestId("btn-cancel-modal").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });

  test("the create-key modal has no scope step, and the key it creates is full-access", { tag: ["@stable", "@auth", "@settings"] }, async ({ page, request }) => {
    const name = `e2e-2573-modal-${uid()}`;

    await test.step("the create-key modal offers name and expiry only, with no permissions", async () => {
      const optionsRead = page.waitForResponse(
        (res) => new URL(res.url()).pathname === PERMISSION_OPTIONS && res.request().method() === "GET",
      );
      await page.goto("/settings/api-keys");
      expect((await optionsRead).status()).toBe(200);
      await page.getByTestId("api-key-button-store").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Create API Key", { exact: true })).toBeVisible();
      await expect(dialog.getByPlaceholder("My API Key")).toBeVisible();
      // Generate stays disabled while the options load: enabled means the modal has settled,
      // so the absence below is measured against the rendered options, not before them.
      await expect(dialog.getByTestId("secret_key_modal_submit_button")).toBeEnabled();
      await expect(dialog.getByText(/Permissions|Full owner access|Restricted/)).toHaveCount(0);
    });

    let body: Record<string, unknown> = {};

    await test.step("Generate sends a creation request with no permissions field", async () => {
      const dialog = page.getByRole("dialog");
      await dialog.getByPlaceholder("My API Key").fill(name);
      const creation = page.waitForRequest(
        (req) => req.method() === "POST" && new URL(req.url()).pathname === API_KEYS,
      );
      const created = page.waitForResponse(
        (res) => res.request().method() === "POST" && new URL(res.url()).pathname === API_KEYS,
      );
      await dialog.getByTestId("secret_key_modal_submit_button").click();
      body = (await creation).postDataJSON();
      const response = await created;
      if (response.ok()) keyIds.push((await response.json()).id);
      expect(response.status()).toBe(200);
      expect(body.name).toBe(name);
      expect(body).not.toHaveProperty("permissions");
    });

    await test.step("the created key is unrestricted", async () => {
      const rows = (await listKeys(request, headers)).filter((row) => row.name === name);
      expect(rows).toHaveLength(1);
      expect(rows[0].permissions).toBeNull();
    });
  });
});
