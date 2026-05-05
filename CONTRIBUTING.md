# Contributing to Langflow E2E

This guide is for anyone creating, validating or maintaining tests in this repository.

---

## How to create a new test

**1. Choose the correct folder**

Find the folder inside `tests/tests-automations/regression/` that matches the functional area of the test:

| What you are testing | Folder |
|---|---|
| Login, logout, user management | `core-functionality/auth/` |
| Flow execution, JSON import | `flow-functionality/` |
| Model provider configuration | `core-functionality/model-provider/` |
| Canvas, sidebar, sticky notes | `ui-ux/` |
| REST endpoints | `api/flows/` |
| File upload, RAG | `core-functionality/knowledge-ingestion-management/` |
| LLM agents, reasoning, tool calling | `core-functionality/llm-agents/` |
| MCP server or client | `mcp/server/` or `mcp/client/` |

> Folders with a `CLAUDE.md` contain specific instructions on how to create tests in that area. Read it before you start.

**2. Name the file**

The file must end in `.spec.ts` and have a descriptive kebab-case name that identifies the behavior under test:

```
login-invalid-credentials.spec.ts
agent-model-provider-selection.spec.ts
canvas-add-custom-component.spec.ts
flow-import-json.spec.ts
```

**3. Basic file structure**

```typescript
import { test, expect } from "../../../fixtures";

test.describe("Area or feature name", () => {
  test("should [expected behavior] when [condition]", async ({ page }) => {
    await test.step("Step 1 description", async () => {
      // action
    });

    await test.step("Step 2 description", async () => {
      // assertion
    });
  });
});
```

> Always import from `fixtures` — never directly from Playwright. The base fixture adds automatic backend error monitoring.

**4. Use existing helpers and pages**

Before writing actions from scratch, check if a helper or page object already exists for what you need:

```typescript
// navigate to settings
import { SettingsPage } from "../../pages";

// load Simple Agent with configurable provider and model
import { SimpleAgentTemplatePage } from "../../pages";
await new SimpleAgentTemplatePage(page).load({ provider: "openai", model: "gpt-4o-mini" });
```

**5. Add at least one tag**

Every test must have a tag so it can be filtered by suite:

```typescript
test("should configure the model provider", { tag: ["@model-provider"] }, async ({ page }) => {
```

See the available tags table in the [README](./README.md#available-tags).

**6. Update `QA-CHECKLIST.md`**

After creating the test, find the corresponding item in `QA-CHECKLIST.md` and mark it as `[-]` (automated, needs validation). Only change to `[x]` after following the validation process below.

**7. Create the spec documentation file**

For each spec, create a corresponding `.md` file in `docs/`, mirroring the relative path from `regression/`. For example:

```
tests/tests-automations/regression/core-functionality/playground/playground-session-id.spec.ts
→ docs/core-functionality/playground/playground-session-id.md
```

Use `docs/TEST-SPEC-TEMPLATE.md` as a base. The mandatory sections are: **What this test validates**, **Tags**, **Validation criterion** and **External dependencies**.

In the **Last validated** field, record the Langflow release cycle in which the test was developed or last reviewed (e.g.: `Langflow 1.10.x`). Validate preferably against the `langflowai/langflow-nightly:latest` image, which tracks the release branch under development. If the nightly is unstable, use the corresponding release branch (`release-1.x.x`) directly. In both cases, the field should reflect the cycle, not the exact build.

> The **External dependencies** section lists files from the upstream Langflow repository that, if changed, could break the test. It is read by `file-watcher.yml` to determine which tests need review when Langflow changes. Fill it in carefully.

---

## Creating tests with LLM (agents, providers, MCP)

Tests that execute an agent with an LLM require a specific setup. **Do not hardcode provider, API key or model** — use the project infrastructure.

### Before creating the test: generate the data

```bash
npx playwright test tests/collect-models.spec.ts
```

This validates the API keys for each provider and collects the available models in the UI, generating:
- `tests/helpers/provider-setup/data/providers.json`
- `tests/helpers/provider-setup/data/models.json`

### Model parameterization pattern

The project uses a pattern where each model from `models.json` generates a separate `test.describe.serial`. See `agent-component-regression.spec.ts` as a complete reference.

Basic structure:

```typescript
import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { test, expect } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { hasProviderEnvKeys, type Provider } from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Read inactive providers to display as skipped in output
function getProviderSkipReasons(): Map<string, string> {
  const jsonPath = path.resolve(__dirname, "../../../../helpers/provider-setup/data/providers.json");
  if (!fs.existsSync(jsonPath)) return new Map();
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  return new Map(
    records.filter((r) => r.status === "inactive").map((r) => [r.provider, `Provider "${r.provider}" inactive — ${r.error}`])
  );
}

// Read models and apply the .env strategy
function getTestTargets() {
  const jsonPath = path.resolve(__dirname, "../../../../helpers/provider-setup/data/models.json");
  if (!fs.existsSync(jsonPath)) return [];
  const allModels = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const skipReasons = getProviderSkipReasons();
  // apply strategy filter (see agent-component-regression.spec.ts for full implementation)
  return allModels.map((m: any) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

const targets = getTestTargets();

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? "openai";

  test.describe.serial(`My Test [${label}]`, () => {
    test("should ...", { tag: ["@agents"] }, async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      test.skip(!hasProviderEnvKeys(provider), `Missing env vars for "${provider}"`);

      try {
        await new SimpleAgentTemplatePage(page).load(options);
      } catch (e: any) {
        if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
        throw e;
      }

      // your test here
    });
  });
}
```

### Running agent tests

This is the most important step — and the most overlooked.

Intentionally break the behavior the test should detect and confirm the test **fails**. If it keeps passing, the assertion is not validating anything real.

```bash
# Run all models for a provider
MODEL_TEST_PROVIDER=openai \
  npx playwright test path/to/test.spec.ts --workers=1

# Run only a specific model
MODEL_TEST_ID=gpt-4o-mini \
  npx playwright test path/to/test.spec.ts --workers=1

# Run all models from JSON (default)
npx playwright test path/to/test.spec.ts --workers=1
```

For agent tests, how to force a failure depends on the behavior being validated:

| What the test validates | How to force failure |
|---|---|
| Response contains specific content | Change the prompt to one that won't produce that content |
| Parameter affects behavior (e.g.: `max_tokens`) | Comment out the line that sets the parameter in the test |
| `system_prompt` is respected | Leave the instructions field empty |
| Memory is retained between messages | Disconnect the Memory component from the flow |
| Tool result appears in reasoning panel | Remove the tool from the agent before executing |
| New Chat clears the session | Do not click New Chat before asking |
| Streaming is progressive | Mock the response as non-streaming via `page.route()` |

> If the test passes in all these failure scenarios, it is a **false positive** and must not be merged.

**4. Run in debug mode to walk through step by step**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test path/to/test.spec.ts --reporter=html --trace=on
npx playwright show-report
```

**2. Confirm that the test steps are documented**

Every test must have `test.step()` describing what each block does.

**3. Force a failure to confirm it is not a false positive**

Comment out or invert the main assertion. The test **must fail**. If it passes even with the broken assertion, the scenario is not being truly validated.

**4. Run in debug mode to walk through step by step**

```bash
npx playwright test path/to/test.spec.ts --debug
```

**5. Check the terminal logs**

The base fixture prints backend errors automatically. Look for:

- `🚨 Backend Error:` — unexpected HTTP error
- `🚨 Flow Error Detected` — silent failure in flow execution

**6. Update the checklist**

Only mark `[x]` after confirming all 5 steps above. If coverage is partial, use `[~]`.

---

## False positive anti-patterns

The patterns below produce tests that **never fail** — regardless of the application state. These are the most common mistakes when creating E2E tests and the hardest to detect in code review.

### `|| true` — mathematically impossible assertion to fail

```typescript
// ❌ WRONG — always passes, validates nothing
expect(hasResponse || hasSteps || true).toBe(true);
expect(claudeVisible || manageBtnVisible || true).toBe(true);
```

A test with `|| true` in the assertion is a disguised placeholder. If you find this pattern in the codebase, rewrite the assertion or remove the test.

### `catch(() => false)` without justification — silent soft check

```typescript
// ❌ PROBLEMATIC without context — passes even if the element never appears
const isVisible = await element.isVisible({ timeout: 3000 }).catch(() => false);
if (isVisible) {
  await expect(anotherElement).toBeVisible();
}
```

The `catch(() => false)` pattern is **acceptable only when the behavior is genuinely optional**. In that case, document the intent with a comment explaining why the check is soft:

```typescript
// ✅ CORRECT — intentional and documented soft check
// header-icon only appears when the agent uses tools.
// Models that respond directly without tools do not generate this icon — expected behavior.
const usedTools = await page.getByTestId("header-icon").last()
  .isVisible({ timeout: 3000 }).catch(() => false);
if (usedTools) {
  await expect(page.getByTestId("duration-display").last()).toBeVisible();
}
```

If the behavior is **not** optional, use a direct assertion:

```typescript
// ✅ CORRECT — direct assertion for mandatory behavior
await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
const responseText = await page.getByTestId("div-chat-message").last().innerText();
expect(responseText.trim().length).toBeGreaterThan(1);
```

### Presence assertion without content validation

```typescript
// ❌ WEAK — confirms the element exists, but not that it contains the correct data
await expect(page.getByTestId("div-chat-message").last()).toBeVisible();

// ✅ BETTER — validates that the content is what is expected
const response = await page.getByTestId("div-chat-message").last().innerText();
expect(response).toContain("Paris"); // for "what is the capital of France?"
```

### Hardcoded provider in agent tests

```typescript
// ❌ WRONG — tests only Anthropic, ignores OpenAI, Google, WatsonX, Ollama
await page.getByText("Anthropic").click();
await page.getByTestId("popover-anchor-input-api_key").fill(process.env.ANTHROPIC_API_KEY);

// ✅ CORRECT — parameterized by the project's provider infrastructure
for (const { label, options, skipReason } of getTestTargets()) {
  test.describe.serial(`My Test [${label}]`, () => {
    test("should ...", async ({ page }) => {
      await new SimpleAgentTemplatePage(page).load(options);
    });
  });
}
```

See `agent-component-regression.spec.ts` and the `CLAUDE.md` in the `llm-agents/` folder for the complete pattern.

---

## Branches

Use the `<type>/<short-description>` pattern in kebab-case:

| Type | When to use | Example |
|---|---|---|
| `feat/` | New test, new helper or page object | `feat/agent-regression-multi-provider` |
| `fix/` | Fix for a broken or flaky test | `fix/model-provider-selector-flaky` |
| `chore/` | CI, checklist, dependencies, internal refactoring | `chore/update-nightly-workflow` |
| `docs/` | Documentation update | `docs/update-contributing` |

---

## Commits

Use the same prefix as the branch followed by a description in the imperative:

```
feat: add agent regression tests parametrized by model
fix: replace flaky selector in model provider test
chore: update file-watcher monitored paths
```

- Maximum 72 characters on the first line
- English preferred
- No trailing period

---

## Pull Requests

All work enters via PR — no direct push to `main`.

**Process:**
1. Open the PR with the branch ready and the test validated
2. **Request review from another organization member** before merging
3. Use **squash merge** to keep the `main` history clean and linear
4. **After the merge**, delete the local and remote branch:
   ```bash
   git checkout main && git pull
   git branch -d <branch>
   git push origin --delete <branch>
   ```

**What the PR must communicate:**
- What it adds or fixes
- How the test was validated (the 5 steps from the guide)
- Related issue, if it comes from a file-watcher alert

### Describing a new test PR

The description of a test PR has a different responsibility than a feature or fix PR: it must communicate not only *what was done*, but *what is being guaranteed*. The reviewer must be able, without opening any file, to assess whether the test covers the correct behavior, whether the approach is sound and what the limits of the added coverage are.

> **For the reviewer:** consult `QA-SCENARIOS-GUIDE.md` and locate the corresponding scenario. Verify that the implemented test covers the specified behavior — objective, preconditions and validation criterion. Divergences between the specification and the implementation must be flagged as blocking.

**1. Covered tests table**

List each test with a description of the **system behavior** it validates — not the execution steps, but the property that would break in case of a regression:

| # | Test | What it validates |
|---|---|---|
| 1 | `test name` | Description of the system behavior that would be detected if it regressed |
| 2 | `test name` | Description of the system behavior that would be detected if it regressed |

**2. How each test was built**

Describe non-obvious implementation decisions. If the test uses response interception, API injection, a pre-built flow file or any indirect mechanism instead of direct UI interaction, justify the choice — what makes the direct approach infeasible or inappropriate for the scenario:

> Ex: field X has no editable UI under normal usage conditions; the test injects the value via API response interception to exercise the behavior without depending on external side effects.

**3. Dependencies**

Explicitly declare what the test needs to run correctly:

- PRs or helpers that must be merged first
- If it requires LLM: provider, model and environment variables needed in `.env`
- Execution mode: `serial` or parallel, and why
- Presence of cleanup `afterEach` and what it discards

**4. What this test does not cover**

Declare the negative scope — related behaviors the reviewer might reasonably expect to be covered, but that are out of scope for this PR and why:

> Ex: does not cover the component's behavior when the API returns a 5xx error; does not validate integration with field Y, which belongs to another functional area.

**5. Known limitations** *(if any)*

Record workarounds, empirical timeouts, accepted race conditions or any decision that a future maintainer would need to understand to avoid introducing regressions when modifying the test:

> Ex: the test waits N ms to ensure autosave before navigating; this value is empirical and may be insufficient in high-latency environments. The correct solution would depend on an explicit backend signal that is not available in the current version.

**6. Update `QA-SCENARIOS-GUIDE.md`**

For each new scenario covered, add an entry in `QA-SCENARIOS-GUIDE.md` with:

- **Objective** — what the scenario validates in terms of system behavior
- **Preconditions** — what needs to be configured or running
- **Step by step** — the sequence of actions the test executes
- **Validation** — the criterion that determines success or failure

The guide is the human-language specification of the automated tests. Keeping it up to date allows the reviewer to compare the implemented test with the specified behavior and assess whether the coverage is correct — without having to read the code.

---

## Test maintenance

### How the team learns that a test needs review

`file-watcher.yml` runs every day at 05:00 BRT and checks whether there were commits in the official Langflow repository in the last 24h in critical paths. When changes are detected, it automatically opens an issue in this repository.

**The issue reports:**
- Which functional area changed
- The exact command to run the affected tests
- Which section of `QA_CHECKLIST.md` to review

### Monitored areas

| Area | Monitored paths | Affected tags |
|---|---|---|
| Routes & Feature Flags | `routes.tsx`, `feature-flags.ts` | all |
| Authentication | `api/v1/login.py`, `services/auth/` | `@auth` |
| Flow CRUD & Canvas | `api/v1/flows.py`, `FlowPage/` | `@project-management` |
| Flow Execution | `api/v1/endpoints.py`, `processing/` | `@api` |
| Model Providers & LLM | `ModelProvidersPage/`, `providerConstants.ts` | `@model-provider @agents` |
| Agents & Agentic Flows | `agentic/`, `base/agents/` | `@agents` |
| Playground & Chat | `pages/Playground/`, `api/v1/chat.py` | `@playground` |
| Settings & Global Variables | `SettingsPage/`, `api/v1/variable.py` | `@settings` |
| MCP Server | `MCPServersPage/`, `api/v1/mcp.py` | `@mcp` |
| Tracing & Monitoring | `api/v1/traces.py`, `services/tracing/` | `@observability` |
| Database Models | `services/database/models/`, `alembic/` | `@api` |
| Component Input Types | `parameterRenderComponent/`, `inputs/` | `@ui-ux` |

### What to do when a file-watcher issue arrives

1. Read the commits listed in the issue
2. Run the tests indicated in the issue table
3. For each test that fails or seems outdated, follow the validation guide above
4. Update the necessary tests and mark `QA_CHECKLIST.md`
5. Close the issue

---

## Tag @stable — validated tests

### What it is

`@stable` identifies tests that have been reviewed by the team and confirmed as correct and reliable. Only these tests run in the weekly workflow (`weekly-stable.yml`). A failure in this workflow automatically opens an issue for triage.

### Standard: every new test enters with @stable

`@stable` is the default for any new test. The test **enters with the tag in the PR itself**, together with the documentation file in `docs/` (see step 7 of the guide above). The reviewer, upon approving the merge, is confirming that:

1. The test passed all 5 steps of the validation guide (trace, forced failure, debug, no backend errors, checklist)
2. The validated behavior is real and relevant for weekly monitoring
3. The documentation file in `docs/` is present with the mandatory sections filled in

If any of these points is absent or incomplete, the reviewer must **request changes** before approving.

```typescript
test("should create a flow and run successfully", { tag: ["@workspace", "@stable"] }, async ({ page }) => {
```

> The `@stable` tag coexists with other functional and cross-cutting tags — it does not replace them.

### Exceptions — when the test will not have @stable

Three cases where the tag is intentionally absent:

1. **Inherited tests not yet reviewed** — they exist in the repository but have not yet gone through the validation and documentation process.
2. **Tests temporarily removed while failing** — the tag was removed while the test awaits correction (see lifecycle below).
3. **Utility specs** — scripts that collect data or configure infrastructure rather than asserting product behavior (e.g. `collect-models.spec.ts`). These are not regression tests and must never enter the weekly workflow.

**When `@stable` is permanently absent** (case 3): state the reason in the spec doc's **Tags** section so it is visible without reading PR history.

**When `@stable` is temporarily absent** (cases 1 and 2): no spec doc update is required — the absence is tracked via the GitHub issue and the PR that removed the tag.

### @stable lifecycle when a weekly failure occurs

```
@stable present
      │
      │  weekly-stable.yml opens a failure issue
      ▼
Evaluate: did the product break, or is the test wrong?
      │
      ├─► Product broke (test is correct)
      │       Flag the issue to the product team.
      │       Monitor upstream. The tag remains.
      │
      └─► Test is wrong or behavior changed
              │
              ▼
          @stable removed  ◄── PR references the issue; tag removed; test exits weekly workflow
              │
              │  Test is corrected and re-validated (5-step guide)
              ▼
          @stable restored  ◄── Same correction PR restores the tag; issue is closed
```

**Criteria for deciding "product broke" vs "test wrong":**

| Observation | Classification |
|---|---|
| Assertion fails because the UI element moved or was renamed | Test wrong — update selector |
| Assertion fails because the feature no longer exists or changed flow | Behavior change — update test and spec doc |
| Assertion fails but the UI works correctly in manual testing | Test wrong — fix assertion logic |
| Assertion fails and manual testing confirms the same failure | Product broke — flag upstream |

**Step 1 — Analyst (upon receiving the workflow issue):**
1. Identify the failing test and classify the failure using the table above
2. Open a PR removing the `@stable` tag from the test; reference the issue in the PR body
3. After merge, the test immediately stops running in the weekly workflow
4. Update the issue with the classification and the name of the test that needs correction

**Step 2 — Dev (upon fixing the test):**
1. Fix the test following the validation guide (all 5 steps)
2. Restore the `@stable` tag in the same correction PR
3. Reference the issue in the PR body; close the issue upon merge

The spec doc is **not updated** during this cycle — the issue and the two PRs are the traceability record.
