import type { Page } from "@playwright/test";
import { openNewFlowTemplatesModal } from "./open-new-flow-templates-modal";

/**
 * Canonical "load a starter template by name" flow, shared by every spec that
 * needs a template on the canvas.
 *
 * Steps: open the templates modal via whichever New Flow entry point exists →
 * switch to the All Templates tab → pick the template whose heading matches
 * `templateName`. Returns the created flow's id (from the
 * template-instantiation `POST /api/v1/flows/` response — the canvas URL id
 * is transient on 1.11, so this is the only reliable handle) once the canvas
 * controls are visible; callers run their own post-load steps (provider
 * setup, component migration, assertions) and delete the flow by this id in
 * their own cleanup.
 *
 * Deliberately NO pre-cleanup of existing flows: this helper used to call
 * `cleanAllFlows` first, which deletes flows other parallel workers are
 * actively using and killed neighbor tests mid-flight in the fully-parallel
 * CI suite (#553 — the victim's page starts 404ing "Flow not found").
 * Duplicate names don't need it either: the backend auto-suffixes new copies
 * ("Memory Chatbot (1)"), and callers hold the id, not the name.
 */
export const loadTemplateByName = async (
  page: Page,
  templateName: string,
): Promise<string> => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });

  await openNewFlowTemplatesModal(page);

  await page.getByTestId("side_nav_options_all-templates").click();

  // Picking a template instantiates the flow via POST /api/v1/flows/ —
  // capture the response to return the authoritative flow id.
  const flowCreationPromise = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByRole("heading", { name: templateName }).first().click();
  const creationResponse = await flowCreationPromise;
  const flowId = (await creationResponse.json()).id as string | undefined;
  if (!flowId || flowId.trim() === "") {
    throw new Error(
      "Template flow creation response did not include a valid non-empty id.",
    );
  }

  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 30000,
  });

  return flowId;
};
