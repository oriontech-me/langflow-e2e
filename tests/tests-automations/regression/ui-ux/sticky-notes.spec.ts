import { expect, test } from "../../../fixtures/fixtures";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.8 — Add a sticky note, change its colour, resize it.
 *
 * Every behaviour is asserted in the DOM AND in the persisted flow: a note that
 * renders correctly but never reaches the autosave `PATCH` would come back
 * wrong on reload, which is the regression worth catching.
 *
 * This file consolidates three inherited specs. All of them were red on
 * 1.12.0.dev8 for one reason: they clicked **`sidebar-nav-add_note`**, a testid
 * that no longer exists — the affordance moved to the canvas control
 * `canvas-add-note-button` (the shape the already-@stable
 * `edit-sticky-note-text.spec.ts` uses). `sticky-notes-dimensions.spec.ts` and
 * `note-color-picker.spec.ts` were removed in the same change; what survived
 * from them is folded in here, and the CSS-only assertions they carried
 * (`font-size`, `overflow`) were dropped — see `docs/ui-ux/sticky-notes.md` for
 * the per-test disposition.
 *
 * Text editing is `ui-ux/edit-sticky-note-text.spec.ts`; deletion is
 * `flow-functionality/canvas-sticky-note-delete.spec.ts`.
 */

/** Default size of a freshly added note on 1.12.0.dev8. */
const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 140;

/** Every colour the note picker must offer. */
const COLOR_OPTIONS = [
  "amber",
  "neutral",
  "rose",
  "blue",
  "lime",
  "transparent",
  "custom",
];

test.describe("Canvas — sticky notes", () => {
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
    const nodes = (body?.data?.nodes ?? []) as Array<{
      type?: string;
      width?: number;
      height?: number;
      data: { node?: { template?: { backgroundColor?: string } } };
    }>;
    return nodes.filter((n) => n.type === "noteNode");
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

  test("adding a sticky note places it on the canvas and in the flow",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const note = page.getByTestId("note_node");

      await test.step("Add a note from the canvas controls", async () => {
        await page.getByTestId("canvas-add-note-button").click();
        await expect(note).toBeVisible({ timeout: 15000 });
      });

      await test.step("The note renders at its default size", async () => {
        const box = await note.boundingBox();
        expect(box, "the note must be on screen").not.toBeNull();
        expect(Math.round(box!.width)).toBe(DEFAULT_WIDTH);
        expect(Math.round(box!.height)).toBe(DEFAULT_HEIGHT);
      });

      await test.step("The note reached the backend as a noteNode", async () => {
        // Polled, not read once: the canvas autosave is debounced, so an
        // immediate GET still reports an empty node list.
        await expect
          .poll(
            async () => (await fetchNoteNodes(request, createdFlowId!)).length,
            {
              timeout: 30000,
              message: "the added note should be persisted to the flow",
            },
          )
          .toBe(1);
      });
    },
  );

  test("changing a sticky note colour repaints it and persists the choice",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const note = page.getByTestId("note_node");

      await test.step("Add a note and select it", async () => {
        await page.getByTestId("canvas-add-note-button").click();
        await expect(note).toBeVisible({ timeout: 15000 });
        await note.click();
      });

      await test.step("The picker offers every colour", async () => {
        await page.getByTestId("color_picker").click();
        for (const color of COLOR_OPTIONS) {
          await expect(
            page.getByTestId(`color_picker_button_${color}`),
          ).toBeVisible({ timeout: 10000 });
        }
      });

      await test.step("Picking rose repaints the note", async () => {
        await page.getByTestId("color_picker_button_rose").click();
        // The colour lives on the note's inline style, not on a class.
        await expect(note).toHaveAttribute("style", /--note-rose/, {
          timeout: 10000,
        });
      });

      await test.step("The colour reached the backend", async () => {
        await expect
          .poll(
            async () => {
              const notes = await fetchNoteNodes(request, createdFlowId!);
              return notes[0]?.data?.node?.template?.backgroundColor;
            },
            {
              timeout: 30000,
              message: "the chosen colour should be persisted to the flow",
            },
          )
          .toBe("rose");
      });
    },
  );

  test("resizing a sticky note grows it and persists the new size",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const note = page.getByTestId("note_node");

      await test.step("Add a note and select it", async () => {
        await page.getByTestId("canvas-add-note-button").click();
        await expect(note).toBeVisible({ timeout: 15000 });
        await note.click();
      });

      await test.step("Drag the bottom-right resize handle", async () => {
        // Selecting the note mounts ReactFlow's NodeResizer controls.
        const handle = page.locator(
          ".react-flow__resize-control.bottom.right.handle",
        );
        const box = await handle.boundingBox();
        expect(box, "the resize handle must be on screen").not.toBeNull();

        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + 120, box!.y + 90, { steps: 12 });
        await page.mouse.up();
      });

      let resized = { width: 0, height: 0 };

      await test.step("The note grew in both axes", async () => {
        await expect
          .poll(
            async () => {
              const box = await note.boundingBox();
              return (
                !!box &&
                box.width > DEFAULT_WIDTH &&
                box.height > DEFAULT_HEIGHT
              );
            },
            {
              timeout: 15000,
              message: "the note should be larger than its default size",
            },
          )
          .toBe(true);

        const box = await note.boundingBox();
        resized = {
          width: Math.round(box!.width),
          height: Math.round(box!.height),
        };
      });

      await test.step("The new size reached the backend", async () => {
        await expect
          .poll(
            async () => {
              const notes = await fetchNoteNodes(request, createdFlowId!);
              const persisted = notes[0];
              if (!persisted) return null;
              return `${Math.round(persisted.width ?? 0)}x${Math.round(
                persisted.height ?? 0,
              )}`;
            },
            {
              timeout: 30000,
              message: "the resized dimensions should be persisted to the flow",
            },
          )
          .toBe(`${resized.width}x${resized.height}`);
      });
    },
  );
});
