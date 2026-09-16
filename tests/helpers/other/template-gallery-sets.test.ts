// Unit tests for the template-gallery expectation sets (#1863, row G1).
// Run with: npm run test:units
//
// Why this is unit-tested rather than left inline in the spec: every expectation
// the gallery spec asserts is DERIVED from `GET /api/v1/flows/basic_examples/`,
// so a derivation that quietly returns an empty set turns a red test green — the
// vacuous-pass shape #1012 is about. The branches here are also the ones a browser
// cannot produce on demand: a listing whose shape changed, a tag no tab carries,
// a template with no tags at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeHeadingDiff,
  expectedHeadings,
  expectedTabs,
  galleryTemplates,
  templateSlug,
  type GalleryTemplate,
} from "./template-gallery-sets";

const listing = (
  entries: Array<{ name: string; name_key?: string; tags?: unknown }>,
): unknown[] =>
  entries.map((e) => ({
    name: e.name,
    name_key: e.name_key ?? e.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    tags: e.tags ?? [],
  }));

const parsed = (entries: Parameters<typeof listing>[0]): GalleryTemplate[] => {
  const templates = galleryTemplates(listing(entries));
  assert.ok(templates, "the fixture listing must parse");
  return templates;
};

test("the slug turns spaces into dashes, lowercases, and keeps punctuation", () => {
  // The shipped bundle builds it as `name.replace(/ /g, "-").toLowerCase()`, so
  // `template_document-q&a` is the real testid — dropping the `&` finds nothing.
  assert.equal(templateSlug("Document Q&A"), "document-q&a");
  assert.equal(templateSlug("Simple Agent"), "simple-agent");
  assert.equal(templateSlug("SEO Keyword Generator"), "seo-keyword-generator");
});

test("the listing is parsed with its tags, and an empty tag array survives", () => {
  const templates = parsed([
    { name: "Simple Agent", name_key: "simple_agent", tags: ["assistants", "agents"] },
    { name: "Knowledge Retrieval", name_key: "knowledge_retrieval", tags: [] },
  ]);

  assert.deepEqual(templates, [
    { name: "Simple Agent", nameKey: "simple_agent", tags: ["assistants", "agents"] },
    { name: "Knowledge Retrieval", nameKey: "knowledge_retrieval", tags: [] },
  ]);
});

test("a listing that carries no signal is null, never an empty expectation", () => {
  // Same rule as the registration spec's reader: an expectation of zero cards
  // would pass against a gallery rendering nothing at all.
  assert.equal(galleryTemplates([]), null, "an empty array is a still-starting instance");
  assert.equal(galleryTemplates({ detail: "Not authenticated" }), null, "an error envelope");
  assert.equal(galleryTemplates([{ name: "No key" }]), null, "an entry without name_key");
  assert.equal(
    galleryTemplates([{ name: "Bad tags", name_key: "bad_tags", tags: "agents" }]),
    null,
    "tags that are not an array — the category tabs would silently empty",
  );
});

test("the headings are the slugs of every template, sorted and prefixed", () => {
  const templates = parsed([
    { name: "Simple Agent", tags: ["agents"] },
    { name: "Basic Prompting", tags: ["chatbots"] },
  ]);

  assert.deepEqual(expectedHeadings(templates), [
    "template_basic-prompting",
    "template_simple-agent",
  ]);
});

test("a tab's headings are exactly the templates carrying its tag", () => {
  const templates = parsed([
    { name: "Simple Agent", tags: ["assistants", "agents"] },
    { name: "Social Media Agent", tags: ["agent", "assistants"] },
    { name: "Knowledge Retrieval", tags: [] },
  ]);

  assert.deepEqual(
    expectedHeadings(templates, "agents"),
    ["template_simple-agent"],
    "`agent` is a different tag from `agents` — the filter is an exact match",
  );
  assert.deepEqual(expectedHeadings(templates, "assistants"), [
    "template_simple-agent",
    "template_social-media-agent",
  ]);
  assert.deepEqual(expectedHeadings(templates, "rag"), [], "a tag nothing carries lists nothing");
});

test("only the tabs a listed template is tagged with are offered", () => {
  const templates = parsed([
    { name: "Basic Prompting", tags: ["chatbots"] },
    { name: "Social Media Agent", tags: ["agent", "openai"] },
    { name: "Knowledge Retrieval", tags: [] },
  ]);

  assert.deepEqual(
    expectedTabs(templates),
    [
      "side_nav_options_get-started",
      "side_nav_options_all-templates",
      "side_nav_options_prompting",
    ],
    "Prompting filters `chatbots`; `agent`, `openai` and an untagged template carry no tab",
  );
});

test("a diff names what is missing and what is extra, and is empty when they match", () => {
  assert.equal(describeHeadingDiff(["template_a"], ["template_a"], "All templates"), "");

  const missing = describeHeadingDiff(
    ["template_a", "template_b"],
    ["template_a"],
    "All templates",
  );
  assert.match(missing, /All templates/);
  assert.match(missing, /template_b/);

  const extra = describeHeadingDiff(["template_a"], ["template_a", "template_z"], "Agents");
  assert.match(extra, /Agents/);
  assert.match(extra, /template_z/);
});

test("a diff whose every missing card is a Knowledge template names the build flag", () => {
  // `isTemplateVisible` hides every template whose name contains "Knowledge" when
  // the frontend is built with ENABLE_KNOWLEDGE_BASES off. A spec cannot read that
  // flag, so the failure has to say it out loud or the red reads as a template
  // that vanished — which is the registration spec's failure, not this one's.
  const message = describeHeadingDiff(
    ["template_knowledge-retrieval", "template_simple-agent"],
    ["template_simple-agent"],
    "All templates",
  );

  assert.match(message, /ENABLE_KNOWLEDGE_BASES/);
  assert.doesNotMatch(
    describeHeadingDiff(["template_simple-agent"], [], "All templates"),
    /ENABLE_KNOWLEDGE_BASES/,
    "a missing card that is not a Knowledge template must not blame the flag",
  );
});
