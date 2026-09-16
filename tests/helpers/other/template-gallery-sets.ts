/**
 * The expectation sets the templates gallery is asserted against (#1863, row G1
 * of the #1860 scoping pass). Spec doc:
 * `docs/core-functionality/templates/templates-gallery.md`.
 *
 * Everything here is PURE and derived from `GET /api/v1/flows/basic_examples/`,
 * the listing the gallery itself reads: no template name, tab membership or card
 * count is hardcoded, so an upstream template change moves the expectation
 * instead of reddening this spec. WHICH templates are registered is
 * `templates-registration.spec.ts`'s question (#1862), against a committed
 * baseline; this module only answers how that listing should be rendered.
 *
 * Covered by `npm run test:units`.
 */

/** One entry of the gallery listing, reduced to what rendering depends on. */
export interface GalleryTemplate {
  name: string;
  nameKey: string;
  tags: string[];
}

/**
 * The gallery's nav, as the shipped bundle builds it: the testid comes from the
 * tab's TITLE and the filter from its tag, and the two are not always the same
 * word — Prompting filters `chatbots`, Q&A filters `q-a`.
 *
 * `get-started` and `all-templates` are listed first because they are always
 * offered: the first renders the featured cards and the second every template.
 */
export const GET_STARTED_TAB = "side_nav_options_get-started";
export const ALL_TEMPLATES_TAB = "side_nav_options_all-templates";

/** Category tabs, in the order the nav renders them. */
export const CATEGORY_TABS: ReadonlyArray<{ navTestId: string; title: string; tag: string }> = [
  { navTestId: "side_nav_options_assistants", title: "Assistants", tag: "assistants" },
  { navTestId: "side_nav_options_classification", title: "Classification", tag: "classification" },
  { navTestId: "side_nav_options_coding", title: "Coding", tag: "coding" },
  {
    navTestId: "side_nav_options_content-generation",
    title: "Content Generation",
    tag: "content-generation",
  },
  { navTestId: "side_nav_options_q&a", title: "Q&A", tag: "q-a" },
  { navTestId: "side_nav_options_prompting", title: "Prompting", tag: "chatbots" },
  { navTestId: "side_nav_options_rag", title: "RAG", tag: "rag" },
  { navTestId: "side_nav_options_agents", title: "Agents", tag: "agents" },
];

/** The featured cards of the Get started tab, keyed by `name_key` upstream. */
export const FEATURED_TEMPLATES: ReadonlyArray<{ nameKey: string; name: string }> = [
  { nameKey: "basic_prompting", name: "Basic Prompting" },
  { nameKey: "vector_store_rag", name: "Vector Store RAG" },
  { nameKey: "simple_agent", name: "Simple Agent" },
];

/**
 * The card testid the gallery builds from a template's name — only spaces change
 * and punctuation stays, so *Document Q&A* is `document-q&a`. Taken from the
 * shipped bundle (`name.replace(/ /g, "-").toLowerCase()`), and the reason a
 * "sanitised" slug finds nothing.
 */
export const templateSlug = (name: string): string =>
  name.replace(/ /g, "-").toLowerCase();

/** The heading testid of a template's card. */
export const headingTestId = (name: string): string => `template_${templateSlug(name)}`;

/** The featured-card testid of a template. */
export const featuredCardTestId = (name: string): string =>
  `template-get-started-card-${templateSlug(name)}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * The templates `GET /api/v1/flows/basic_examples/` carries, or `null` for a body
 * that carries no signal.
 *
 * `null` rather than an empty list, for the reason the registration spec records:
 * an empty expectation PASSES against a gallery that renders nothing at all. Four
 * bodies produce it — a body that is not an array, an empty array (what a
 * still-starting instance answers), an entry with no `name_key`, and an entry
 * whose `tags` is not an array, which would silently empty every category tab.
 */
export function galleryTemplates(body: unknown): GalleryTemplate[] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const templates: GalleryTemplate[] = [];
  for (const entry of body) {
    if (!isRecord(entry)) return null;
    if (!isNonEmptyString(entry.name) || !isNonEmptyString(entry.name_key)) return null;
    if (!Array.isArray(entry.tags)) return null;
    if (!entry.tags.every((tag): tag is string => typeof tag === "string")) return null;
    templates.push({ name: entry.name, nameKey: entry.name_key, tags: [...entry.tags] });
  }
  return templates;
}

/**
 * The card headings a tab must render: every template when `tag` is omitted (All
 * templates), otherwise exactly the templates whose `tags` contain it. The match
 * is exact on purpose — `agent` (on *Social Media Agent*) is a different tag from
 * `agents`, and a `startsWith`/`includes` filter would merge them.
 */
export function expectedHeadings(templates: GalleryTemplate[], tag?: string): string[] {
  return templates
    .filter((t) => tag === undefined || t.tags.includes(tag))
    .map((t) => headingTestId(t.name))
    .sort();
}

/**
 * The nav entries the gallery offers: the two fixed tabs plus every category tab
 * at least one listed template is tagged with. A tag no tab carries (`agent`,
 * `openai`, `knowledge-base`, `hybrid`, `web-scraping`) adds nothing, and a
 * template with no tags at all is reachable only from All templates.
 */
export function expectedTabs(templates: GalleryTemplate[]): string[] {
  const tags = new Set(templates.flatMap((t) => t.tags));
  return [
    GET_STARTED_TAB,
    ALL_TEMPLATES_TAB,
    ...CATEGORY_TABS.filter((tab) => tags.has(tab.tag)).map((tab) => tab.navTestId),
  ];
}

/**
 * Why two card sets differ, or `""` when they do not.
 *
 * Named rather than left to `toEqual`'s array dump because the two causes need
 * different owners: a card the listing expects and the gallery does not render is
 * this spec's failure, while a template that disappeared from the listing is the
 * registration spec's. The `ENABLE_KNOWLEDGE_BASES` hint is the one build state a
 * URL-only suite cannot read (`isTemplateVisible` hides every template whose name
 * contains "Knowledge"), so it is named whenever it could explain the whole diff.
 */
export function describeHeadingDiff(
  expected: string[],
  actual: string[],
  context: string,
): string {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((testId) => !actualSet.has(testId));
  const unexpected = actual.filter((testId) => !expectedSet.has(testId));
  if (missing.length === 0 && unexpected.length === 0) return "";

  const parts = [
    `${context}: the gallery rendered ${actual.length} card(s) where the listing expects ${expected.length}.`,
  ];
  if (missing.length > 0) parts.push(`Listed but not rendered: ${missing.join(", ")}.`);
  if (unexpected.length > 0) parts.push(`Rendered but not listed: ${unexpected.join(", ")}.`);
  if (missing.length > 0 && missing.every((testId) => testId.includes("knowledge"))) {
    parts.push(
      "Every missing card is a Knowledge template, which is what a frontend built with " +
        "ENABLE_KNOWLEDGE_BASES off hides (isTemplateVisible) — check the build before reading " +
        "this as a template that vanished (that failure belongs to templates-registration.spec.ts).",
    );
  }
  return parts.join(" ");
}
