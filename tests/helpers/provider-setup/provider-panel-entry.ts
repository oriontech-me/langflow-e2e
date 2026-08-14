import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";

/**
 * How the Agent node lets a test reach the Model Providers panel.
 *
 * The node's Language Model field renders one of two controls, and which one is
 * present depends on state the test does not control:
 *
 *  - a provider IS configured → the `model_model` dropdown, whose menu carries
 *    "Manage Model Providers";
 *  - no provider is configured → a plain button reading **Setup Provider**,
 *    which opens the management modal directly.
 *
 * Reading that button by role+name stopped working on 1.12.0.dev26 (#1465). It
 * is still a real `<button>`, but it now carries
 * `aria-labelledby="node-Agent-<id>-field-model-label"`, so its accessible name
 * is the FIELD's label:
 *
 *   aria snapshot:  - button "Language Model required": Setup Provider
 *   getByRole("button", { name: "Setup Provider" })            → 0 matches
 *   locator("button").filter({ hasText: "Setup Provider" })    → 1 match
 *
 * so it is matched by its visible text, which is what a user reads and what the
 * label wiring cannot take away.
 */
export type EntryPointProbe = {
  /** `model_model` triggers found (provider already configured). */
  modelDropdown: number;
  /** Buttons whose visible text is "Setup Provider". */
  setupButton: number;
  /** Agent nodes on the canvas — the difference between "nothing to do" and "broken". */
  agentNodes: number;
};

export type EntryDecision =
  | { kind: "dropdown" }
  | { kind: "setup-button" }
  | { kind: "no-agent" }
  | { kind: "unreachable"; message: string };

/**
 * Decides how to open the panel from what the canvas actually shows.
 *
 * The branch that matters is the last one. Until #1465 all three keyed helpers
 * treated "neither control found" as "no Agent node on canvas" and returned,
 * silently, having configured nothing — a conclusion they never checked. The
 * cost was measured: with the Agent node present and its Setup Provider button
 * unreachable by role, `setupAnthropic` did nothing, the Agent ran with no model
 * bound, and `general-bugs-agent-sum-duplicate-message-playground.spec.ts` died
 * 30 s later on a completion observable that was healthy — while the backend had
 * already answered `ComponentBuildError: … No model selected.`
 *
 * So the silent return now stands only when there is genuinely no Agent node.
 * With a node present, an unreachable entry point is a suite defect and says so.
 */
export function decideEntryPoint(
  probe: EntryPointProbe,
  providerLabel: string,
): EntryDecision {
  if (probe.modelDropdown > 0) return { kind: "dropdown" };
  if (probe.setupButton > 0) return { kind: "setup-button" };
  if (probe.agentNodes === 0) return { kind: "no-agent" };

  return {
    kind: "unreachable",
    message:
      `PROVIDER_PANEL_UNREACHABLE: cannot open the Model Providers panel for ${providerLabel} — ` +
      `the canvas has ${probe.agentNodes} Agent node(s), but neither entry point resolved ` +
      `(model_model: ${probe.modelDropdown}, "Setup Provider" button: ${probe.setupButton}). ` +
      `Reported as a FAILURE, not a silent skip: configuring nothing leaves the Agent with no ` +
      `model, and the run then fails as "ComponentBuildError: No model selected" far from here ` +
      `(#1465).`,
  };
}

/** Buttons carrying the visible text of the not-configured entry point. */
export function setupProviderButton(page: Page) {
  return page.locator("button").filter({ hasText: "Setup Provider" });
}

/**
 * Opens the Model Providers panel from the Agent node, whichever control the
 * node is currently rendering. Returns `"no-agent"` when there is nothing to
 * configure; throws when the node is there but the panel cannot be reached.
 */
export async function openProviderPanel(
  page: Page,
  providerLabel: string,
  timeout = 20000,
): Promise<"opened" | "no-agent"> {
  const modelDropdown = page.getByTestId("model_model");
  const setupBtn = setupProviderButton(page);
  const agentNodes = page.locator('[data-testid^="rf__node-Agent"]');

  // Polled to a deadline, never sampled once. A template load navigates to
  // /flow/<id> BEFORE ReactFlow has mounted the nodes, so an immediate probe
  // sees zero of everything — including the Agent node — and a decision taken
  // there reports "nothing to configure" about a canvas that is still painting.
  // Measured on 1.12.0.dev26: probing right after the URL settles counts 0
  // Agent nodes, while the same page counts 1 a few seconds later (#1465).
  const deadline = Date.now() + timeout;
  let probe: EntryPointProbe;
  for (;;) {
    probe = {
      modelDropdown: await modelDropdown.count(),
      setupButton: await setupBtn.count(),
      agentNodes: await agentNodes.count(),
    };
    if (probe.modelDropdown > 0 || probe.setupButton > 0) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }
  const decision = decideEntryPoint(probe, providerLabel);

  if (decision.kind === "no-agent") {
    console.log(`No Agent node found on canvas — skipping ${providerLabel} setup.`);
    return "no-agent";
  }
  if (decision.kind === "unreachable") throw new Error(decision.message);

  if (decision.kind === "dropdown") {
    // A selected node opens a right-side Inspector Panel that overlaps the
    // model dropdown on 1.11.x+ — close it so the click is not intercepted.
    await hideInspectorPanel(page);
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupBtn.first().click();
  }
  return "opened";
}
