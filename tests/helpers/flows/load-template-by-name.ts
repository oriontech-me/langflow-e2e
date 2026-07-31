import type { Page, Response } from "@playwright/test";
import { openNewFlowTemplatesModal } from "./open-new-flow-templates-modal";
import { getAuthToken } from "../auth/get-auth-token";
import { deleteFlow } from "./delete-flow";

/** How many times the template pick is retried when its creation POST fails. */
const MAX_PICK_ATTEMPTS = 3;
const CANVAS_GATE_TIMEOUT = 30000;
/** Backoff between pick attempts — the collision window is milliseconds wide. */
const PICK_RETRY_DELAY_MS = 1500;
/**
 * Cap on reading a recorded response body (see `readFlowBody`). Short: it only
 * gates cleanup and diagnostics, and a body the browser has not delivered by
 * then is one it will never deliver.
 */
const BODY_READ_TIMEOUT_MS = 5000;

interface FlowPost {
  status: number;
  id?: string;
  name?: string;
  body?: string;
}

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
 *
 * ## Concurrency hardening (#1002)
 *
 * This is the template-loading twin of the `setupPlayground` defect fixed in
 * #988, and it inherits the same upstream trigger: `POST /api/v1/flows/`
 * derives the flow name with a check-then-insert, so two creations that resolve
 * to the same name race and the loser gets a bare **500**
 * (`docs/upstream-bugs/UPSTREAM-BUG-concurrent-flow-create-500.md`; still
 * reproducible on 1.12.0.dev9 — 2 of 4 same-name POSTs fail, 6 of 8). Two
 * distinct names collide here, both shared across workers: the **`New Flow`**
 * the entry point creates on its own (see below) and the **template's own
 * name**, since many specs load the same template.
 *
 * When that 500 lands the SPA stays on the flows list, nothing navigates, and
 * the old implementation waited 30s for a `canvas_controls_dropdown` that could
 * never appear — surfacing as a bare `TimeoutError` on a *random* member of
 * whichever template-loading specs were running (#1002; 66 entries of this
 * timeout class in `reports/daily-history.jsonl`). So:
 *
 * - every `POST /api/v1/flows` this page makes is recorded, and the pick is
 *   **retried** when its creation POST fails instead of proceeding to a gate
 *   that cannot pass;
 * - a lost navigation is **recovered** by going straight to `/flow/<id>` — the
 *   flow exists, only the SPA's routing was lost;
 * - when neither works, the error names what actually happened (the creation
 *   status and body, the page the app stayed on), not a 30s selector timeout;
 * - anything created and then abandoned is **deleted** before throwing, so a
 *   failed setup stops leaking orphans (the id never reaches the caller's
 *   `afterEach`, so only this helper can clean it up).
 *
 * ### The entry point creates a flow of its own
 *
 * `openNewFlowTemplatesModal` clicks "New Flow", which since 1.10 **navigates to
 * a freshly-created flow** and shows the welcome overlay; the helper then
 * dismisses it via "Browse more templates" to reach the modal. That flow —
 * named `New Flow` — is never the template flow and never reached the caller, so
 * it leaked on **every** call: measured 14 leftover `New Flow (N)` flows from 16
 * runs of `create-flow-from-template.spec.ts`. Every id this helper sees other
 * than the one it returns is now deleted before returning.
 */
export interface LoadTemplateDeps {
  /**
   * Test seam. Opening the modal is a substantial helper of its own (retries,
   * the 1.10 welcome overlay, the #966 readiness gate), and faking that surface
   * to unit-test THIS helper's retry/recovery branches would mean faking all of
   * it. Production callers never pass this.
   */
  openModal: (page: Page) => Promise<void>;
}

export const loadTemplateByName = async (
  page: Page,
  templateName: string,
  { openModal = openNewFlowTemplatesModal }: Partial<LoadTemplateDeps> = {},
): Promise<string> => {
  const posts: FlowPost[] = [];
  /**
   * Body reads in flight. They are started off the response event (which cannot
   * await) but MUST be settled before the ids are used: the entry point's
   * creation happens seconds before cleanup, yet reading its id is still a race,
   * and a missing id silently means "nothing to clean up" — the exact leak this
   * is here to close.
   */
  const bodyReads: Promise<void>[] = [];

  const isFlowCreate = (resp: Response): boolean => {
    try {
      if (resp.request().method() !== "POST") return false;
      // Only the collection endpoint creates a flow. `includes("/api/v1/flows")`
      // would also match sub-resources (`/api/v1/flows/<id>/…`), whose responses
      // carry no flow id and would pollute both the diagnostics and the cleanup.
      const { pathname } = new URL(resp.url());
      return pathname === "/api/v1/flows" || pathname === "/api/v1/flows/";
    } catch {
      // A URL this cannot parse is not the create endpoint; never let a response
      // handler throw.
      return false;
    }
  };

  /**
   * Reads a response body under a hard cap.
   *
   * `resp.json()` can pend FOREVER: the entry point's creation is immediately
   * followed by the SPA navigating away, and the body of a discarded response is
   * never delivered. Awaiting those reads before cleanup (which is required — an
   * unread body means an id we cannot delete) then hung the whole helper past the
   * 5-minute test timeout. Measured while validating this fix: the serial control,
   * green for months, timed out at 300s.
   */
  const readFlowBody = (resp: Response, entry: FlowPost): Promise<void> => {
    let settle: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      entry.body ??= "<body not delivered>";
      settle();
    }, BODY_READ_TIMEOUT_MS);
    resp
      .json()
      .then((body: { id?: string; name?: string; detail?: string }) => {
        entry.id = body?.id;
        entry.name = body?.name;
        entry.body = body?.detail;
      })
      .catch(() => {
        entry.body = "<unreadable body>";
      })
      .finally(() => {
        clearTimeout(timer);
        settle();
      });
    return done;
  };

  const recordFlowPost = (resp: Response) => {
    if (!isFlowCreate(resp)) return;
    const entry: FlowPost = { status: resp.status() };
    posts.push(entry);
    bodyReads.push(readFlowBody(resp, entry));
  };

  page.on("response", recordFlowPost);

  /** Ids created during this call that are NOT `keepId` (entry-point flows, abandoned retries). */
  const strayIds = async (keepId?: string): Promise<string[]> => {
    await Promise.allSettled(bodyReads);
    return posts
      .filter((p) => p.status === 201 && p.id && p.id !== keepId)
      .map((p) => p.id as string);
  };

  const deleteIds = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    // A cleanup problem must never replace the real error, so failures here are
    // swallowed after being surfaced in the run output.
    try {
      const authorization = await getAuthToken(page.request);
      for (const id of ids) {
        await deleteFlow(page.request, id, {
          headers: authorization ? { Authorization: authorization } : undefined,
        });
      }
    } catch (error) {
      console.warn(
        `⚠️  loadTemplateByName: could not clean up ${ids.length} flow(s) it created (${(error as Error)?.message?.split("\n")[0] ?? error}).`,
      );
    }
  };

  const describePosts = () =>
    posts.length === 0
      ? "no POST /api/v1/flows was observed at all"
      : posts
          .map(
            (p) =>
              `${p.status}${p.name ? ` name=${JSON.stringify(p.name)}` : ""}${p.body ? ` detail=${JSON.stringify(p.body)}` : ""}`,
          )
          .join("; ");

  try {
    await page.goto("/");
    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    let flowId: string | undefined;
    let lastCreation: FlowPost | undefined;

    for (let attempt = 1; attempt <= MAX_PICK_ATTEMPTS; attempt++) {
      await openModal(page);
      await page.getByTestId("side_nav_options_all-templates").click();

      // Picking a template instantiates the flow via POST /api/v1/flows/.
      // Awaited on ANY status, not just 201: on the upstream name race it
      // answers 500, and matching 201 only turned that into a second silent
      // 30s timeout with no reason attached (#1002).
      const creationPromise = page.waitForResponse(isFlowCreate, {
        timeout: 30000,
      });
      await page.getByRole("heading", { name: templateName }).first().click();
      const creationResponse = await creationPromise;
      const created = (await creationResponse
        .json()
        .catch(() => ({}))) as { id?: string; detail?: string };
      lastCreation = {
        status: creationResponse.status(),
        id: created?.id,
        body: created?.detail,
      };

      if (creationResponse.ok() && created?.id && created.id.trim() !== "") {
        flowId = created.id;
        break;
      }

      if (attempt < MAX_PICK_ATTEMPTS) {
        console.warn(
          `⚠️  loadTemplateByName("${templateName}"): creation POST answered ${lastCreation.status} — retrying the pick (${attempt}/${MAX_PICK_ATTEMPTS - 1}). Concurrent same-name creation, see docs/upstream-bugs/UPSTREAM-BUG-concurrent-flow-create-500.md.`,
        );
        await page.waitForTimeout(PICK_RETRY_DELAY_MS);
        // The failed pick leaves the app on the flows list with a toast; start
        // the next attempt from a known state.
        await page.goto("/");
        await page.waitForSelector('[data-testid="mainpage_title"]', {
          timeout: 30000,
        });
      }
    }

    if (!flowId) {
      await deleteIds(await strayIds());
      throw new Error(
        `loadTemplateByName("${templateName}"): the template flow was never created after ${MAX_PICK_ATTEMPTS} attempts — ` +
          `last POST /api/v1/flows/ → ${lastCreation?.status ?? "no response"}` +
          `${lastCreation?.body ? ` ${JSON.stringify(lastCreation.body)}` : ""}. ` +
          `Observed: ${describePosts()}. The app is on ${page.url()}.`,
      );
    }

    // The flow exists. The canvas is a separate question: when the SPA loses the
    // navigation it stays on the flows list, which no amount of waiting fixes —
    // so go to the editor directly instead of timing out (#1002).
    try {
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: CANVAS_GATE_TIMEOUT,
      });
    } catch {
      console.warn(
        `⚠️  loadTemplateByName("${templateName}"): the editor did not open after creating ${flowId} (app on ${page.url()}) — navigating to /flow/${flowId} directly.`,
      );
      try {
        await page.goto(`/flow/${flowId}`);
        await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
          timeout: CANVAS_GATE_TIMEOUT,
        });
      } catch (error) {
        // keepId excludes flowId from the strays so it is not deleted twice.
        await deleteIds([...(await strayIds(flowId)), flowId]);
        throw new Error(
          `loadTemplateByName("${templateName}"): flow ${flowId} was created but its editor never opened, ` +
            `including after navigating to /flow/${flowId} directly (app on ${page.url()}). ` +
            `Observed: ${describePosts()}. Original: ${(error as Error)?.message?.split("\n")[0] ?? error}`,
        );
      }
    }

    // Whatever else got created along the way (the entry point's own `New Flow`,
    // an abandoned retry) is this helper's to clean: the caller only ever
    // receives — and can only ever delete — the returned id.
    await deleteIds(await strayIds(flowId));

    return flowId;
  } finally {
    page.off("response", recordFlowPost);
  }
};
