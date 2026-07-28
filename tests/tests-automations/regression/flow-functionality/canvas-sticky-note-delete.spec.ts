import { expect, test } from "../../../fixtures/fixtures";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.8 — Delete a sticky note, through both affordances.
 *
 * The persisted flow is the final witness: a note removed from the canvas but
 * left in the flow would reappear on reload.
 *
 * The inherited version of this file was red on 1.12.0.dev8 — all three tests
 * clicked **`sidebar-nav-add_note`**, a testid that no longer exists (the
 * affordance is now the canvas control `canvas-add-note-button`) — and it
 * created a flow per test without deleting any.
 *
 * Adding/colouring/resizing notes is `ui-ux/sticky-notes.spec.ts`; editing
 * their text is `ui-ux/edit-sticky-note-text.spec.ts`; deleting *components*
 * through the same two affordances is `core-components/componentDelete.spec.ts`.
 */

test.describe("Canvas — deleting sticky notes", () => {
  let createdFlowId: string | null = null;

  /** Note nodes as the backend currently has them. */
  async function fetchNoteNodes(
    request: import("@playwright/test").APIRequestContext,
    flowId: string,
  ) {
    const bearer = await getAuthToken(request);
    const response = await request.get(`/api/v1/flows/${flowId}`, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    const nodes = (body?.data?.nodes ?? []) as Array<{ type?: string }>;
    return nodes.filter((n) => n.type === "noteNode");
  }

  /** Adds one sticky note and waits for the canvas to render it. */
  async function addStickyNote(
    page: import("@playwright/test").Page,
    expectedCount: number,
  ) {
    await page.getByTestId("canvas-add-note-button").click();
    await expect(page.getByTestId("note_node")).toHaveCount(expectedCount, {
      timeout: 15000,
    });
  }

  test.beforeEach(async ({ page }) => {
    createdFlowId = await setupBlankFlow(page);
    await expect(page.getByTestId("note_node")).toHaveCount(0);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("deleting a sticky note from its options menu removes it everywhere",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const notes = page.getByTestId("note_node");

      await test.step("Add a note and wait for it to persist", async () => {
        await addStickyNote(page, 1);
        // Polled: the canvas autosave is debounced, so the delete assertion
        // below would otherwise pass against a flow that never held the note.
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            { timeout: 30000, message: "the note should be persisted first" },
          )
          .toBe(1);
      });

      await test.step("Delete it through the node options menu", async () => {
        await notes.first().click();
        await page.getByTestId("icon-MoreHorizontal").click();
        await page
          .locator('[data-radix-popper-content-wrapper] [role="option"]')
          .filter({ hasText: /Delete/ })
          .first()
          .click();
        await expect(notes).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("The note is gone from the flow too", async () => {
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the deleted note should be gone from the flow",
            },
          )
          .toBe(0);
      });
    },
  );

  test("deleting a sticky note with Backspace removes it everywhere",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const notes = page.getByTestId("note_node");

      await test.step("Add a note and wait for it to persist", async () => {
        await addStickyNote(page, 1);
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            { timeout: 30000, message: "the note should be persisted first" },
          )
          .toBe(1);
      });

      await test.step("Select it and press Backspace", async () => {
        await notes.first().click();
        await page.keyboard.press("Backspace");
        await expect(notes).toHaveCount(0, { timeout: 10000 });
      });

      await test.step("The note is gone from the flow too", async () => {
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the deleted note should be gone from the flow",
            },
          )
          .toBe(0);
      });
    },
  );

  test("deleting one of two sticky notes leaves the other in place",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const notes = page.getByTestId("note_node");

      await test.step("Add two notes and wait for both to persist", async () => {
        await addStickyNote(page, 1);
        await addStickyNote(page, 2);
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            { timeout: 30000, message: "both notes should be persisted first" },
          )
          .toBe(2);
      });

      await test.step("Drag the second note clear of the first", async () => {
        // Two notes added in a row land stacked; the top one would intercept
        // the click meant for the bottom one.
        const topNote = page.locator(".react-flow__node-noteNode").nth(1);
        const box = await topNote.boundingBox();
        expect(box, "the second note must be on screen").not.toBeNull();
        const startX = box!.x + box!.width / 2;
        const startY = box!.y + 8;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 60, startY + 260, { steps: 15 });
        await page.mouse.up();

        await expect
          .poll(
            async () => {
              const boxes = await page
                .locator(".react-flow__node-noteNode")
                .evaluateAll((nodes) =>
                  nodes.map((n) => {
                    const r = n.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                  }),
                );
              return (
                boxes[0].bottom < boxes[1].top || boxes[1].bottom < boxes[0].top
              );
            },
            {
              timeout: 15000,
              message: "the two notes must not overlap before deleting one",
            },
          )
          .toBe(true);
      });

      await test.step("Delete only the first one", async () => {
        await notes.first().click();
        await page.keyboard.press("Backspace");
        // Exactly one survivor — this is what makes the test about deleting a
        // note rather than about clearing the canvas.
        await expect(notes).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Exactly one note remains in the flow", async () => {
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "one note should survive in the persisted flow",
            },
          )
          .toBe(1);
      });
    },
  );
});
