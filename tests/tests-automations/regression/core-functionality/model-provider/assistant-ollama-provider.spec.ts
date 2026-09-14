import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
// Imported by path, not through `pages/index.ts`: the PR lane selects specs by import
// graph (#1054), and a new export there would pull every spec importing the index into
// this PR's E2E run for a change none of them can observe.
import { AssistantPanel } from "../../../../pages/AssistantPanel";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import {
  assistantSelectorModels,
  type CatalogProviderEntry,
  type EnabledModelsResponse,
} from "../../../../helpers/provider-setup/assistant-model-catalog";
import {
  boundOllamaModelList,
  declaredParameterCountB,
  readOllamaCapabilities,
  resolveAssistantTestModel,
  type OllamaCapabilityClasses,
} from "../../../../helpers/provider-setup/ollama-capabilities";
import { ollamaBaseUrl, ollamaTestModel } from "../../../../helpers/provider-setup/ollama-endpoint";
import { preconfigureRoutedProvider } from "../../../../helpers/provider-setup/preconfigure-routed-provider";

/**
 * Langflow Assistant × a local Ollama provider (#1810).
 *
 * The Assistant is the canvas panel whose whole entry condition is model-provider
 * configuration. This spec asserts that gate with the one keyless provider the lanes can
 * run, on its two independent surfaces:
 *
 *   Test 1 — the API contract. `GET /api/v1/agentic/check-config` lists an `Ollama`
 *            entry whose models are what the instance serves, checked against the
 *            Ollama API itself from the test host (never against another Langflow read).
 *   Test 2 — the UI gate. On a canvas, the panel renders its composer, the selector's
 *            `Ollama` group equals the enabled Ollama LLMs the panel's own two catalog
 *            reads imply, the local model arms Send once a draft exists, and a small
 *            local model carries the weak-model hint. Nothing is sent.
 *
 * The frontend never calls `check-config` (measured on 1.13.0.dev12), so neither test
 * vouches for the other's surface.
 *
 * Sibling coverage, not repeated here: `ollama-provider.spec.ts` configures Ollama
 * through the Settings UI and executes a flow on it. The Assistant's MOCKED branches
 * (unconfigured contract, no-models state, feature gate) are still open under #1810.
 *
 * Without a reachable Ollama both tests skip with the reason — the missing-dependency
 * contract `ollama-provider.spec.ts` follows. Spec doc:
 * docs/core-functionality/model-provider/assistant-ollama-provider.md
 */

const OLLAMA = "Ollama";

/**
 * How long `check-config` may take to list Ollama as configured. The wait exists for
 * one known concurrent writer: `ollama-provider.spec.ts` test 1 deletes the shared
 * `OLLAMA_BASE_URL` variable and re-saves it through the Settings UI within seconds.
 */
const CHECK_CONFIG_WAIT_MS = 30000;

/** `classifyModelStrength` flags a declared parameter count at or below this, in billions. */
const WEAK_HINT_MAX_B = 13;

interface CheckConfigProvider {
  name: string;
  configured: boolean;
  default_model: string | null;
  models: Array<{ name: string; display_name: string }>;
}

interface CheckConfig {
  enabled?: boolean;
  configured?: boolean;
  configured_providers?: string[];
  providers?: CheckConfigProvider[];
  default_provider?: string | null;
  default_model?: string | null;
}

interface OllamaSetup {
  model: string;
  classes: OllamaCapabilityClasses;
}

/**
 * Read the oracle and resolve the model. A missing or model-less Ollama is a skip; a
 * reachable Ollama whose capabilities cannot be read is a FAILURE, because the bounds
 * below would then be checked against an oracle that does not know what it serves.
 */
async function prepareOllama(
  request: APIRequestContext,
): Promise<OllamaSetup | { skipReason: string }> {
  const oracle = await readOllamaCapabilities(request, ollamaBaseUrl());
  if (!oracle.reachable) return { skipReason: oracle.reason };
  expect(
    oracle.classes.unreadable,
    `the local Ollama answered /api/tags but /api/show returned no capabilities for these tags`,
  ).toEqual([]);
  const resolution = resolveAssistantTestModel(oracle.classes, ollamaTestModel());
  if ("skipReason" in resolution) return resolution;
  return { model: resolution.model, classes: oracle.classes };
}

/**
 * Configure Ollama the way the routed any-completion tier's globalSetup does: the
 * base-URL `Global` variable (created, or patched when it holds another address — the
 * write is validated server-side) plus explicit enablement of the model, since only the
 * first five live tags are enabled by default. A rejection fails, naming the cause:
 * an Ollama the test host reaches but Langflow cannot is a lane misconfiguration.
 */
async function configureOllama(request: APIRequestContext, model: string): Promise<void> {
  const result = await preconfigureRoutedProvider(request, {
    ...process.env,
    ANY_COMPLETION_PROVIDER: "ollama",
    OLLAMA_TEST_MODEL: model,
  });
  expect(result.configured, `Langflow did not accept the local Ollama: ${result.detail}`).toBe(true);
}

/** Whether `OLLAMA_BASE_URL` exists right now — the attribution a missing Ollama needs. */
async function describeOllamaVariable(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<string> {
  const res = await request.get("/api/v1/variables/", { headers });
  if (!res.ok()) return `the variables read itself failed (HTTP ${res.status()})`;
  const rows = (await res.json()) as Array<{ name?: string; value?: string }>;
  const row = rows.find((v) => v.name === "OLLAMA_BASE_URL");
  return row
    ? `OLLAMA_BASE_URL is present (value "${row.value ?? "?"}")`
    : "OLLAMA_BASE_URL is ABSENT — a concurrent spec resets it (ollama-provider.spec.ts test 1)";
}

async function readCheckConfig(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<CheckConfig> {
  const res = await request.get("/api/v1/agentic/check-config", { headers });
  expect(res.status(), "GET /api/v1/agentic/check-config").toBe(200);
  return (await res.json()) as CheckConfig;
}

async function waitForOllamaInCheckConfig(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<CheckConfig> {
  let config: CheckConfig = {};
  try {
    // Every interval stays under 2 s on purpose. The backend closes an idle keep-alive
    // connection at ~2 s, and a request that reuses the socket at that instant dies with
    // `socket hang up` — measured on 1.13.0.dev12: alternate polls at exactly 2000 ms
    // failed, 1500 ms and 3000 ms never did. A thrown request is not retried by
    // `expect.poll`, so a 2 s cadence ended the 30 s window after one or two reads.
    await expect
      .poll(
        async () => {
          config = await readCheckConfig(request, headers);
          return config.configured_providers ?? [];
        },
        { timeout: CHECK_CONFIG_WAIT_MS, intervals: [250, 500, 1000] },
      )
      .toContain(OLLAMA);
  } catch (error) {
    const variable = await describeOllamaVariable(request, headers);
    throw new Error(
      `check-config did not list Ollama in configured_providers within ` +
        `${CHECK_CONFIG_WAIT_MS / 1000} s (last: ${JSON.stringify(config.configured_providers)}); ` +
        `${variable}. ${(error as Error).message.split("\n")[0]}`,
    );
  }
  return config;
}

/** The Ollama LLMs the panel's two flow-scoped catalog reads imply, read the way the panel reads them. */
async function readSelectorExpectation(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<string[]> {
  const query = `flow_id=${encodeURIComponent(flowId)}&purpose=use`;
  const [providersRes, enabledRes] = await Promise.all([
    request.get(`/api/v1/models?${query}`, { headers }),
    request.get(`/api/v1/models/enabled_models?${query}`, { headers }),
  ]);
  expect(providersRes.status(), "GET /api/v1/models (flow-scoped)").toBe(200);
  expect(enabledRes.status(), "GET /api/v1/models/enabled_models (flow-scoped)").toBe(200);
  return assistantSelectorModels(
    (await providersRes.json()) as CatalogProviderEntry[],
    (await enabledRes.json()) as EnabledModelsResponse,
    OLLAMA,
  );
}

test.describe("Langflow Assistant — local Ollama provider", () => {
  let flowId: string | undefined;

  test.afterEach(async ({ page, request }) => {
    if (!flowId) return;
    const id = flowId;
    flowId = undefined;
    // Leave the editor BEFORE deleting: an editor mounted over a deleted flow 404s its
    // own polls into the fixture's HTTP log.
    await unmountEditorForCleanup(page);
    await deleteFlow(request, id, { headers: { Authorization: await getAuthToken(request) } });
  });

  test("check-config lists exactly the completion models the local Ollama instance serves", { tag: ["@stable", "@api", "@model-provider"] }, async ({ request }) => {
    const setup = await test.step("read the Ollama oracle and resolve the test model", () =>
      prepareOllama(request),
    );

    test.skip("skipReason" in setup, "skipReason" in setup ? setup.skipReason : "");
    if ("skipReason" in setup) return;
    const { model, classes } = setup;

    await test.step("configure Ollama on the instance through the API", () =>
      configureOllama(request, model),
    );

    const headers = { Authorization: await getAuthToken(request) };

    const config = await test.step("read check-config until Ollama is a configured provider", () =>
      waitForOllamaInCheckConfig(request, headers),
    );

    await test.step("the Assistant is enabled and reports a configured provider", async () => {
      expect(
        config.enabled,
        "check-config reports the Assistant disabled — LANGFLOW_AGENTIC_EXPERIENCE is off on this instance, or its default flipped",
      ).toBe(true);
      expect(config.configured, "check-config.configured").toBe(true);
      expect(config.configured_providers).toContain(OLLAMA);
    });

    const entry = await test.step("providers[] holds exactly one configured Ollama entry", async () => {
      const entries = (config.providers ?? []).filter((p) => p.name === OLLAMA);
      expect(
        entries,
        `providers[] should hold one Ollama entry — got ${JSON.stringify((config.providers ?? []).map((p) => p.name))}`,
      ).toHaveLength(1);
      expect(entries[0].configured, "the Ollama entry's configured flag").toBe(true);
      return entries[0];
    });

    await test.step("the Ollama entry lists the instance's completion models and no embedding model", async () => {
      const listed = entry.models.map((m) => m.name);
      expect(
        boundOllamaModelList(listed, classes),
        `check-config lists ${JSON.stringify(listed)}; the instance serves completion ` +
          `${JSON.stringify(classes.completion)}, of which tool-capable ` +
          `${JSON.stringify(classes.completionWithTools)}, and embedding-only ` +
          `${JSON.stringify(classes.embeddingOnly)}`,
      ).toEqual({ missing: [], notCompletion: [], embeddingOnly: [] });
      for (const m of entry.models) {
        expect(m.display_name, `display_name of "${m.name}"`).toBe(m.name);
      }
      expect(listed, "the Ollama entry's default_model must be one of its models").toContain(
        entry.default_model,
      );
    });

    await test.step("default_provider and default_model agree with the provider entries", async () => {
      const providers = config.providers ?? [];
      const names = providers.map((p) => p.name);
      expect(names, "default_provider must name a provider entry").toContain(config.default_provider);
      const chosen = providers.find((p) => p.name === config.default_provider);
      expect(config.default_model, `default_model must be ${config.default_provider}'s default`).toBe(
        chosen?.default_model,
      );
      // Ollama is not a preferred provider, so it is the default only through the
      // `providers[0]` fallback — reachable when it is the only provider with models.
      if (names.length === 1) {
        expect(config.default_provider, "the only provider with models is the default").toBe(OLLAMA);
      }
    });
  });

  test("the Assistant composer offers the local Ollama model and arms Send for it", { tag: ["@stable", "@model-provider"] }, async ({ page, request }) => {
    const setup = await test.step("read the Ollama oracle and resolve the test model", () =>
      prepareOllama(request),
    );

    test.skip("skipReason" in setup, "skipReason" in setup ? setup.skipReason : "");
    if ("skipReason" in setup) return;
    const { model, classes } = setup;

    await test.step("configure Ollama on the instance through the API", () =>
      configureOllama(request, model),
    );

    const headers = { Authorization: await getAuthToken(request) };

    const id = await test.step("create an empty flow for the panel's flow-scoped catalog", async () => {
      flowId = await createFlow(
        request,
        {
          name: `assistant-ollama-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          description: "Empty flow for the Assistant × Ollama spec (#1810)",
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
        { headers },
      );
      return flowId;
    });

    const assistant = new AssistantPanel(page);

    await test.step("open the flow and the Assistant panel", async () => {
      await openFlowById(page, id);
      await assistant.open();
    });

    await test.step("the panel renders its composer, not the no-models or disabled state", async () => {
      expect(await assistant.waitForTerminalState(), "Assistant panel state").toBe("composer");
    });

    await test.step("the selector's Ollama group equals the enabled Ollama LLMs for this flow", async () => {
      const menu = await assistant.readModelMenu();
      const rendered = menu[OLLAMA] ?? [];
      const expected = await readSelectorExpectation(request, headers, id);
      expect(
        [...rendered].sort(),
        `the selector renders ${JSON.stringify(menu)}; the panel's catalog reads imply Ollama ${JSON.stringify(expected)}`,
      ).toEqual([...expected].sort());
      expect(rendered, "the local test model must be offered under Ollama").toContain(model);
      expect(
        rendered.filter((name) => !classes.completion.includes(name)),
        "every Ollama item must be a completion model the instance serves",
      ).toEqual([]);
    });

    await test.step("selecting the local model puts it on the selector", async () => {
      await assistant.selectModel(OLLAMA, model);
      await expect(assistant.modelSelector).toHaveText(model);
    });

    await test.step("Send is disabled without a draft and armed by one", async () => {
      await expect(assistant.textarea).toHaveValue("");
      await expect(assistant.sendButton).toBeDisabled();
      await assistant.textarea.fill("Which components does this flow use?");
      await expect(assistant.sendButton).toBeEnabled();
    });

    await test.step("a small local model carries the weak-model hint", async () => {
      const size = declaredParameterCountB(model);
      if (size !== undefined && size <= WEAK_HINT_MAX_B) {
        await expect(assistant.weakHint).toBeVisible();
        return;
      }
      test.info().annotations.push({
        type: "weak-model-hint",
        description:
          `not asserted: "${model}" declares ${size === undefined ? "no parameter count" : `${size}B`}; ` +
          `hint visible: ${await assistant.weakHint.isVisible()}`,
      });
    });
  });
});
