import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

/**
 * Agent structured output (QA-CHECKLIST §6.5 "Agent returns output in
 * structured JSON format (output_schema)" + the JSON half of §7.7 "Output
 * formatting").
 *
 * The Agent's advanced output_schema TableInput drives its second output,
 * Structured Response (json_response -> Data). With NO tools attached the
 * orchestrator takes the native path (with_structured_output — provider-
 * validated JSON, agent loop bypassed); this spec pins that strongest form
 * of the contract by stripping the template's tool edges and disabling the
 * built-in tool toggles via API PATCH.
 *
 * Both tests assert STRUCTURE, never content quality: the model fills the
 * values (non-deterministic), the provider's structured-output mode enforces
 * the shape (deterministic). Asserts are JSON.parse + key presence + typeof,
 * tolerant of extra keys the orchestrator may add (e.g. default_value —
 * observed live on the 1.11 nightly).
 *
 *   Test 1 — schema {name: str, age: int}: parsed output has key `name` of
 *   type string and key `age` of type number.
 *   Test 2 — causal control on the schema knob: one row with multiple=true
 *   ({colors: str, As List}) comes back as an Array of strings — the shape
 *   follows the schema definition, not a fixed JSON habit of the model.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

interface ModelRecord {
  provider: string;
  model: string;
}

interface TestTarget {
  label: string;
  options: LoadSimpleAgentOptions;
  skipReason?: string;
}

function getProviderSkipReasons(): Map<string, string> {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/providers.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("providers.json not found — run collect-models.spec.ts first. Skipping provider pre-validation.");
    return new Map();
  }
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  const reasons = new Map<string, string>();
  for (const r of records) {
    if (r.status === "inactive") {
      reasons.set(r.provider, `Provider "${r.provider}" inactive — ${r.error}`);
    }
  }
  return reasons;
}

function getModelsFromJson(): ModelRecord[] {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("models.json not found — run collect-models.spec.ts first.");
    return [];
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const skipReasons = getProviderSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);
    if (!record) {
      console.warn(`MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred.`);
      return [{ label: `model:${model}`, options: { model } }];
    }
    const provider = record.provider as Provider;
    return [{
      label: `${provider} / ${model}`,
      options: { provider, model },
      skipReason: skipReasons.get(provider),
    }];
  }

  const allModels = getModelsFromJson();
  if (allModels.length === 0) {
    const fallbackProvider = Object.keys(providerConfigMap)[0] as Provider;
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [{
      label: `provider:${fallbackProvider} (fallback)`,
      options: { provider: fallbackProvider },
      skipReason: skipReasons.get(fallbackProvider),
    }];
  }

  let models = allModels;
  if (process.env.MODEL_TEST_PROVIDER) {
    models = models.filter((m) => m.provider === process.env.MODEL_TEST_PROVIDER);
  } else if (process.env.ALL_MODELS !== "true") {
    const seen = new Set<string>();
    models = models.filter((m) => {
      if (seen.has(m.provider)) return false;
      seen.add(m.provider);
      return true;
    });
  }

  return models.map((m) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

// Flows created by the template load are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and the
// app can fire more than one flows POST during template load (only one
// persists; deleting a transient id 404s harmlessly — deleteFlow treats 404
// as done).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// The collect-listener records transient ids too — the LIVE flow is the one
// the flows API still returns.
async function resolveLiveFlowId(
  request: APIRequestContext,
  bearer: string,
  ids: string[],
): Promise<string> {
  for (const id of [...ids].reverse()) {
    const res = await request.get(`/api/v1/flows/${id}`, {
      headers: { Authorization: bearer },
    });
    if (res.status() === 200) return id;
  }
  throw new Error(`none of the collected flow ids is live: ${JSON.stringify(ids)}`);
}

interface SchemaRow {
  name: string;
  description: string;
  type: "str" | "int" | "float" | "bool" | "dict";
  multiple: "True" | "False";
}

// Configure the Agent for the NATIVE structured-output path via API PATCH:
// set the output_schema rows, disable the built-in tool toggles, and strip
// the template's tool edges (URL / Web Search) — json_response only bypasses
// the agent loop when NO tools are attached.
//
// The GET polls until the Agent node's template carries the model the POM
// selected: the model choice lands via ASYNC autosave, and a GET+PATCH that
// races it writes the stale default model back (observed live: the agent
// then built with the inactive provider's default and the run hung — ~1/5
// failure rate before this guard).
//
// The poll MUST inspect the model field's selected `value`, not the whole
// serialized field: `template.model` embeds an `options` list of every
// enabled model (~59 on a multi-provider nightly), so a substring check over
// the stringified field matched `expectedModel` in `options` regardless of
// what was actually selected — returning "flow-ready" on the FIRST GET even
// when `value` was still the template default. That let a pre-autosave GET
// through, and the PATCH wrote the default (the leader/default provider's
// model, e.g. "claude-sonnet-5") back over the selection (#724).
async function patchStructuredOutputSetup(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  expectedModel: string | undefined,
  schema: SchemaRow[],
): Promise<void> {
  const headers = { Authorization: bearer };
  let flow: any;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
        if (res.status() !== 200) return `GET flow -> ${res.status()}`;
        flow = await res.json();
        const agentNode = (flow.data?.nodes ?? []).find(
          (n: any) => n.data?.type === "Agent",
        );
        if (!agentNode) return "no Agent node";
        if (expectedModel) {
          // The model field's `value` is the array of SELECTED model objects
          // ({ name, provider, ... }); `options` (all enabled models) is
          // deliberately excluded from this check — see the note above.
          // Exact-match on `name`: expectedModel comes from models.json (the
          // model id) and equals the option's `name`; a divergence there would
          // burn the full poll timeout rather than pass on a stale value.
          const selected = agentNode.data.node?.template?.model?.value;
          const selectedNames = Array.isArray(selected)
            ? selected.map((m: any) => m?.name)
            : [selected];
          if (!selectedNames.includes(expectedModel)) {
            return "model selection not autosaved yet";
          }
        }
        return "flow-ready";
      },
      { timeout: 20000 },
    )
    .toBe("flow-ready");

  let patched = 0;
  for (const node of flow.data?.nodes ?? []) {
    if (node.data?.type === "Agent") {
      const template = node.data.node?.template;
      expect(template?.output_schema, "Agent node has an output_schema field").toBeTruthy();
      template.output_schema.value = schema;
      template.add_current_date_tool.value = false;
      template.add_calculator_tool.value = false;
      patched++;
    }
  }
  expect(patched, "exactly one Agent node in the template").toBe(1);

  const beforeEdges = (flow.data?.edges ?? []).length;
  flow.data.edges = (flow.data?.edges ?? []).filter(
    (e: { target?: string; data?: { targetHandle?: unknown } }) =>
      !(e.target?.startsWith("Agent") && JSON.stringify(e.data?.targetHandle ?? "").includes("tools")),
  );
  expect(
    flow.data.edges.length,
    "the template's tool edges were found and removed",
  ).toBeLessThan(beforeEdges);

  const patchRes = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { data: flow.data },
  });
  expect(patchRes.status()).toBe(200);
}

// Set the task on the ChatInput node (the Agent's input_value resolves from
// it when the node runs).
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
}

// Switch the Agent node's visible output to Structured Response, run the
// node, open the output inspector, and return the payload parsed as JSON.
// The inspector renders the Data output as pretty-printed JSON — the parse
// slices the dialog text from the first "{" to the last "}".
//
// The node run builds from the FRONTEND's in-memory graph (the v2 workflows
// payload embeds data.nodes). #724 traced the "reverts to leader" flake to the
// test's own write-clobber (see patchStructuredOutputSetup) — NOT a product
// bug: selecting a non-leader model, autosaving, and reloading persists the
// selection correctly live. When the persisted model.value is empty/stale the
// product legitimately auto-picks the first enabled model (the leader). With
// the poll fixed the correct value is written back, so this gate below is now
// a defensive safety net: it re-reads the node's model widget right before
// running and reloads (bounded) until the selection is present. Setup
// stabilization only — the structured-output asserts are untouched.
async function runAgentAndParseStructuredOutput(
  page: Page,
  expectedModel: string | undefined,
): Promise<Record<string, unknown>> {
  if (expectedModel) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const widget = await page
        .getByTestId("model_model")
        .innerText()
        .catch(() => "");
      if (widget.includes(expectedModel)) break;
      expect(
        attempt,
        `Agent model widget lost the selection (shows "${widget}", expected "${expectedModel}") after 2 reloads`,
      ).toBeLessThan(3);
      await page.reload();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });
    }
  }

  await page.getByTestId("dropdown-output-undefined").click();
  await page.getByTestId("dropdown-item-output-undefined-structured response").click();
  await waitForFlowSaveSettled(page);

  await page.getByTestId("button_run_agent").click();
  try {
    await page.waitForSelector("text=built successfully", { timeout: 120000 });
  } catch (e) {
    // Fail with WHAT the build reported instead of a bare toast timeout.
    const toasts = await page
      .$$eval("[data-sonner-toast], .Toastify__toast", (els) =>
        els.map((el) => (el as HTMLElement).innerText.slice(0, 200)),
      )
      .catch(() => []);
    throw new Error(
      `Agent build did not report success; visible toasts: ${JSON.stringify(toasts)}`,
      { cause: e },
    );
  }

  const inspectButton = page.getByTestId("output-inspection-structured response-agent");
  await expect(inspectButton).toBeEnabled({ timeout: 20000 });
  await inspectButton.click();

  const dialog = page.locator('[role="dialog"]').last();
  await expect(dialog).toBeVisible({ timeout: 15000 });
  const raw = await dialog.innerText();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  expect(start, `inspector payload contains JSON (got: ${raw.slice(0, 200)})`).toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;

  await dialog.getByTestId("btn-close-modal").click();
  await expect(dialog).toBeHidden({ timeout: 10000 });
  return parsed;
}

const targets = getTestTargets();

// Loads the Simple Agent template — serial + --workers=1 per the agent-area
// rule. Cleanup is id-scoped; nothing here wipes flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Structured Output [${label}]`, () => {
    test(
      "output_schema fields come back as typed JSON keys on the structured response",
      { tag: ["@stable", "@regression", "@agents", "@components"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `so-${Date.now()}`;

        await loadAgent(page, options);
        const bearer = await getAuthToken(request);
        const flowId = await resolveLiveFlowId(request, bearer, createdFlowIds);

        await test.step("configure output_schema {name: str, age: int} and strip tools via API", async () => {
          await patchStructuredOutputSetup(request, bearer, flowId, options.model, [
            { name: "name", description: "the person's name", type: "str", multiple: "False" },
            { name: "age", description: "the person's age in years", type: "int", multiple: "False" },
          ]);
          await page.reload();
          await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });
        });

        await test.step("seed a trivially extractable task", async () => {
          await setChatInputText(page, `John is 25 years old. (${nonce})`);
          await waitForFlowSaveSettled(page);
        });

        const parsed = await test.step("run the Agent node and parse the Structured Response", () =>
          runAgentAndParseStructuredOutput(page, options.model));

        await test.step("schema keys are present with the schema's types", async () => {
          // Shape-only asserts — the model fills the values, the schema
          // drives the keys and types. Extra keys are tolerated.
          expect(typeof parsed.name, `key "name" is a string in ${JSON.stringify(parsed)}`).toBe("string");
          expect((parsed.name as string).length).toBeGreaterThan(0);
          expect(typeof parsed.age, `key "age" is a number in ${JSON.stringify(parsed)}`).toBe("number");
        });
      },
    );

    test(
      "a multiple (As List) schema row returns an array of the row's type",
      { tag: ["@stable", "@regression", "@agents", "@components"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `so-list-${Date.now()}`;

        await loadAgent(page, options);
        const bearer = await getAuthToken(request);
        const flowId = await resolveLiveFlowId(request, bearer, createdFlowIds);

        await test.step("configure output_schema {colors: str, As List} and strip tools via API", async () => {
          await patchStructuredOutputSetup(request, bearer, flowId, options.model, [
            { name: "colors", description: "every color mentioned in the text", type: "str", multiple: "True" },
          ]);
          await page.reload();
          await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });
        });

        await test.step("seed a task listing multiple values", async () => {
          await setChatInputText(page, `The flag is red, white and blue. (${nonce})`);
          await waitForFlowSaveSettled(page);
        });

        const parsed = await test.step("run the Agent node and parse the Structured Response", () =>
          runAgentAndParseStructuredOutput(page, options.model));

        await test.step("the As List key is an array of strings", async () => {
          // The causal control on the schema knob: same machinery as test 1,
          // only the row's `multiple` flag differs — the shape must follow.
          expect(Array.isArray(parsed.colors), `key "colors" is an array in ${JSON.stringify(parsed)}`).toBe(true);
          const colors = parsed.colors as unknown[];
          expect(colors.length).toBeGreaterThan(0);
          for (const c of colors) expect(typeof c).toBe("string");
        });
      },
    );
  });
}
