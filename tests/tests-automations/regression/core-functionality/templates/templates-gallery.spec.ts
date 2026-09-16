import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { openNewFlowTemplatesModal, openNewFlowWelcomePanel } from "../../../../helpers/flows/open-new-flow-templates-modal";
import { trackCreatedFlows, type FlowTracker } from "../../../../helpers/flows/track-created-flows";
import { waitForPageEntry } from "../../../../helpers/other/page-entry-barrier";
import {
  ALL_TEMPLATES_TAB,
  CATEGORY_TABS,
  FEATURED_TEMPLATES,
  GET_STARTED_TAB,
  describeHeadingDiff,
  expectedHeadings,
  expectedTabs,
  featuredCardTestId,
  galleryTemplates,
  headingTestId,
  templateSlug,
  type GalleryTemplate,
} from "../../../../helpers/other/template-gallery-sets";

/**
 * The templates gallery (#1863, row G1 of the #1860 scoping pass).
 * Spec doc: `docs/core-functionality/templates/templates-gallery.md`.
 *
 * Every expected set is derived at run time from `GET /api/v1/flows/basic_examples/`
 * — the listing the gallery itself reads — so an upstream template change moves the
 * expectation instead of reddening this file. That is the layering with #1862:
 * `templates-registration.spec.ts` owns WHICH templates are registered, against a
 * committed baseline; this file owns how that listing is RENDERED, which is the
 * failure no membership check can see (a card that stops mounting, a tab filter that
 * stops matching).
 *
 * It replaces `starter-projects.spec.ts`, which waited for cards this gallery no
 * longer renders and asserted `category_title_<title>` — a nav label visible in every
 * tab.
 *
 * Three entry-point behaviours, measured by id on `1.13.0.dev12`, decide the
 * assertions here:
 *   - a gallery pick CREATES a flow (`POST /api/v1/flows/` 201) and the product
 *     deletes the New Flow placeholder;
 *   - a welcome quick pick creates NOTHING: it `PATCH`es the placeholder in place,
 *     so this file asserts that request and the persisted flow, never a 201;
 *   - closing the gallery without picking leaves the placeholder behind, which is why
 *     every test here runs on the shared flow tracker.
 */

/** The listing, fetched once per worker: it carries every template's full graph (~4.6 MB). */
let listingCache: { raw: unknown[]; templates: GalleryTemplate[] } | undefined;

const readListing = async (request: APIRequestContext) => {
  if (listingCache) return listingCache;
  const authorization = await getAuthToken(request);
  const res = await request.get("/api/v1/flows/basic_examples/", {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
  expect(
    res.status(),
    "the gallery listing must answer 200 — every expectation in this file is derived from it",
  ).toBe(200);
  const raw = (await res.json()) as unknown[];
  const templates = galleryTemplates(raw);
  expect(
    templates,
    "GET /api/v1/flows/basic_examples/ carried no usable template (an empty array is what a " +
      "still-starting instance answers) — an empty expectation would pass against a gallery " +
      "rendering nothing at all",
  ).not.toBeNull();
  listingCache = { raw, templates: templates as GalleryTemplate[] };
  return listingCache;
};

/** The template the listing registers under `nameKey`, or a failure naming it. */
const templateByKey = (templates: GalleryTemplate[], nameKey: string): GalleryTemplate => {
  const template = templates.find((t) => t.nameKey === nameKey);
  expect(
    template,
    `the listing carries no template with name_key "${nameKey}", so the gallery cannot render its card`,
  ).toBeDefined();
  return template as GalleryTemplate;
};

/** Component types of a flow or listing entry, sorted — the graph observable used here. */
const nodeTypes = (flow: unknown): string[] => {
  const nodes = (flow as { data?: { nodes?: Array<{ data?: { type?: string } }> } })?.data?.nodes;
  return (nodes ?? [])
    .map((node) => node?.data?.type)
    .filter((type): type is string => typeof type === "string")
    .sort();
};

/** A flow named after `name`, allowing the backend's ` (N)` suffix for a taken name. */
const nameOfTemplate = (name: string): RegExp =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(\\d+\\))?$`);

const renderedTestIds = async (page: Page, cssPrefix: string): Promise<string[]> =>
  (
    await page
      .locator(`[data-testid^="${cssPrefix}"]`)
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""))
  ).sort();

const renderedHeadings = (page: Page) => renderedTestIds(page, "template_");

/**
 * Poll until the rendered headings match, then hand the last set back for the
 * assertion. Not `expect.poll`: the assertion below names WHICH cards differ, and a
 * caught poll timeout would replace that with an array dump (plus a spurious red ✗
 * step in the trace, #599).
 */
const settledHeadings = async (page: Page, expected: string[]): Promise<string[]> => {
  const deadline = Date.now() + 15000;
  let actual = await renderedHeadings(page);
  while (describeHeadingDiff(expected, actual, "poll") !== "" && Date.now() < deadline) {
    await page.waitForTimeout(200);
    actual = await renderedHeadings(page);
  }
  return actual;
};

const goHome = async (page: Page) => {
  await page.goto("/");
  await waitForPageEntry(page, '[data-testid="mainpage_title"]', 30000);
};

const flowIdFromUrl = (url: string): string | undefined =>
  /\/flow\/([^/?#]+)/.exec(url)?.[1];

test.describe("Templates — the gallery", () => {
  let flows: FlowTracker;

  test.beforeEach(async ({ page }) => {
    flows = trackCreatedFlows(page);
  });

  test.afterEach(async ({ request }) => {
    // Every path here creates the New Flow placeholder, and a gallery pick creates a
    // second flow; ids the product already deleted answer 404, which the tracker
    // treats as done.
    await flows.cleanup(request);
    flows.dispose();
  });

  test(
    "All templates renders one card per registered template",
    { tag: ["@stable", "@release", "@workspace", "@templates"] },
    async ({ page, request }) => {
      const { templates } = await readListing(request);
      const expected = expectedHeadings(templates);

      await test.step("open the gallery on All templates", async () => {
        await goHome(page);
        await openNewFlowTemplatesModal(page);
        await page.getByTestId(ALL_TEMPLATES_TAB).click();
      });

      const actual = await settledHeadings(page, expected);
      expect(actual, describeHeadingDiff(expected, actual, "All templates")).toEqual(expected);
    },
  );

  test(
    "each category tab lists exactly the templates carrying its tag",
    { tag: ["@stable", "@release", "@workspace", "@templates"] },
    async ({ page, request }) => {
      const { templates } = await readListing(request);

      await test.step("open the gallery", async () => {
        await goHome(page);
        await openNewFlowTemplatesModal(page);
      });

      const offered = await renderedTestIds(page, "side_nav_options_");
      expect(
        offered,
        "the gallery offers the two fixed tabs plus every category tab a listed template is " +
          "tagged with — a tag no tab carries (agent, openai, knowledge-base, hybrid, " +
          "web-scraping) must add none, and a tab nothing is tagged with must not be offered",
      ).toEqual([...expectedTabs(templates)].sort());

      for (const tab of CATEGORY_TABS) {
        const expected = expectedHeadings(templates, tab.tag);
        if (expected.length === 0) continue;
        await test.step(`${tab.title} lists the templates tagged ${tab.tag}`, async () => {
          await page.getByTestId(tab.navTestId).click();
          const actual = await settledHeadings(page, expected);
          expect(actual, describeHeadingDiff(expected, actual, tab.title)).toEqual(expected);
        });
      }
    },
  );

  test(
    "Get started shows exactly the three featured cards and opens by default",
    { tag: ["@stable", "@release", "@workspace", "@templates"] },
    async ({ page, request }) => {
      const { templates } = await readListing(request);
      const expectedCards = FEATURED_TEMPLATES.map((featured) =>
        featuredCardTestId(templateByKey(templates, featured.nameKey).name),
      ).sort();

      await test.step("open the gallery and touch no tab", async () => {
        await goHome(page);
        await openNewFlowTemplatesModal(page);
      });

      expect(
        await renderedTestIds(page, "template-get-started-card-"),
        "Get started carries exactly the three featured templates — a fourth card, or one " +
          "pointing at a template the listing no longer registers, changes what a first-time " +
          "user is offered",
      ).toEqual(expectedCards);
      expect(
        await renderedHeadings(page),
        "no `template_<slug>` heading renders on Get started — which is also what proves it is " +
          "the tab the modal opens on, since the nav marks the active tab with no attribute",
      ).toEqual([]);
    },
  );

  for (const featured of FEATURED_TEMPLATES) {
    test(
      `the featured card for ${featured.name} creates its template`,
      { tag: ["@stable", "@release", "@workspace", "@templates"] },
      async ({ page, request }) => {
        const { templates } = await readListing(request);
        const template = templateByKey(templates, featured.nameKey);

        await test.step("open the gallery on Get started", async () => {
          await goHome(page);
          await openNewFlowTemplatesModal(page);
        });

        await flows.settle();
        const beforePick = flows.ids();

        const creation = page.waitForResponse(
          (res) =>
            res.request().method() === "POST" &&
            new URL(res.url()).pathname === "/api/v1/flows/",
          { timeout: 30000 },
        );
        await page.getByTestId(featuredCardTestId(template.name)).click();
        const response = await creation;
        const created = (await response.json()) as { id?: string; name?: string };

        expect(response.status(), "picking a featured card creates a flow").toBe(201);
        expect(created.name, `the created flow is named after ${template.name}`).toMatch(
          nameOfTemplate(template.name),
        );
        expect(
          beforePick,
          "the gallery pick creates a NEW flow — it does not convert the New Flow placeholder " +
            "(that is what the welcome quick picks do)",
        ).not.toContain(created.id);
        await expect(
          page.getByTestId("canvas_controls_dropdown"),
          "the editor opens on the created template",
        ).toBeVisible({ timeout: 30000 });
        expect(page.url()).toContain(created.id as string);
      },
    );
  }

  test(
    "search keeps a template's own card and empties on a string that matches nothing",
    { tag: ["@stable", "@release", "@workspace", "@templates"] },
    async ({ page, request }) => {
      const { templates } = await readListing(request);
      const subject = templateByKey(templates, "memory_chatbot");

      await test.step("open the gallery on All templates", async () => {
        await goHome(page);
        await openNewFlowTemplatesModal(page);
        await page.getByTestId(ALL_TEMPLATES_TAB).click();
        await settledHeadings(page, expectedHeadings(templates));
      });

      await test.step(`searching "${subject.name}" keeps its card`, async () => {
        await page.getByTestId("search-input-template").fill(subject.name);
        // Inclusion, never an exact set: the search is a fuzzy match over name AND
        // description, so siblings legitimately come along.
        await expect(page.getByTestId(headingTestId(subject.name))).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("a string matching no name or description leaves no card", async () => {
        await page.getByTestId("search-input-template").fill("zzzqqq-not-a-template");
        const actual = await settledHeadings(page, []);
        expect(
          actual,
          "a query that matches nothing must empty the gallery, not fall back to every card",
        ).toEqual([]);
      });
    },
  );

  for (const quickPick of [
    { nameKey: "simple_agent" },
    { nameKey: "vector_store_rag" },
  ]) {
    test(
      `the welcome quick pick for ${quickPick.nameKey} converts the placeholder in place`,
      { tag: ["@stable", "@release", "@workspace", "@templates"] },
      async ({ page, request }) => {
        const { raw, templates } = await readListing(request);
        const template = templateByKey(templates, quickPick.nameKey);
        const listedEntry = (raw as Array<{ name_key?: string }>).find(
          (entry) => entry?.name_key === quickPick.nameKey,
        );

        await test.step("New Flow, stopping at the welcome panel", async () => {
          await goHome(page);
          await openNewFlowWelcomePanel(page);
        });

        const placeholderId = flowIdFromUrl(page.url());
        expect(
          placeholderId,
          "the welcome panel opens over the flow the New Flow click just created",
        ).toBeTruthy();

        let creationsDuringPick = 0;
        const countCreations = (res: { request(): { method(): string }; url(): string }) => {
          if (
            res.request().method() === "POST" &&
            new URL(res.url()).pathname === "/api/v1/flows/"
          ) {
            creationsDuringPick += 1;
          }
        };
        page.on("response", countCreations);

        const conversion = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" &&
            new URL(res.url()).pathname === `/api/v1/flows/${placeholderId}`,
          { timeout: 30000 },
        );
        await page.getByTestId(`flow-builder-welcome-template-${templateSlug(template.name)}`).click();
        const patched = await conversion;
        await expect(
          page.getByTestId("canvas_controls_dropdown"),
          "the placeholder's own editor mounts the template",
        ).toBeVisible({ timeout: 30000 });
        page.off("response", countCreations);

        expect(
          patched.status(),
          `the quick pick converts flow ${placeholderId} in place`,
        ).toBe(200);
        expect(
          creationsDuringPick,
          "a quick pick creates NO flow — the 201 already happened at the New Flow click, and a " +
            "second one would mean the placeholder was abandoned",
        ).toBe(0);
        expect(page.url(), "the editor stays on the placeholder's id").toContain(
          placeholderId as string,
        );

        const authorization = await getAuthToken(request);
        const persisted = await request.get(`/api/v1/flows/${placeholderId}`, {
          headers: authorization ? { Authorization: authorization } : undefined,
        });
        expect(persisted.status(), "the converted flow is readable by its own id").toBe(200);
        const flow = await persisted.json();
        expect(flow.name, `the placeholder is renamed to ${template.name}`).toMatch(
          nameOfTemplate(template.name),
        );
        expect(
          nodeTypes(flow),
          "the persisted graph is the template's — the conversion is the whole flow, not just a name",
        ).toEqual(nodeTypes(listedEntry));
      },
    );
  }

  test(
    "Browse more templates opens the gallery from the welcome panel",
    { tag: ["@stable", "@release", "@workspace", "@templates"] },
    async ({ page }) => {
      await test.step("New Flow, stopping at the welcome panel", async () => {
        await goHome(page);
        await openNewFlowWelcomePanel(page);
      });

      await page.getByTestId("flow-builder-welcome-browse-more").click();

      // Visibility, never text: `modal-title` reads "Templates" through innerText and
      // "Toggle SidebarTemplates" through textContent, because the sidebar toggle's
      // screen-reader label lives inside the same node.
      await expect(
        page.getByTestId(GET_STARTED_TAB),
        "the gallery opened on its default tab",
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId("modal-title")).toBeVisible();
    },
  );
});
