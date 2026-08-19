import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  describePolicyState,
  isPolicyPristine,
  readPolicyBundle,
  restorePolicy,
  snapshotPolicy,
  type PolicySnapshot,
} from "../../../../helpers/governance/policy-state";

// Catalog policy — template blocklist enforcement (QA-CHECKLIST §21.2).
// Spec doc: docs/governance/catalog-policy/template-blocklist-enforcement.md
//
// @destructive for the same reason as its component sibling: the policy is
// instance-global. Serial — the tests share one policy write.
test.describe.configure({ mode: "serial" });

/** Referenced by no other spec, so blocking it cannot break another fixture. */
const TARGET_TEMPLATE = "SaaS Pricing";
/** A starter project (the shorter listing), used only inside step 4's window. */
const STARTER_TEMPLATE = "Basic Prompting";

interface TemplateListItem {
  name: string;
  name_key: string;
}

async function listBasicExamples(
  request: import("@playwright/test").APIRequestContext,
  token: string,
): Promise<TemplateListItem[]> {
  const response = await request.get("/api/v1/flows/basic_examples/", {
    headers: { Authorization: token },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as TemplateListItem[];
}

async function listStarterProjects(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  { includeBlocked = false } = {},
): Promise<TemplateListItem[]> {
  const response = await request.get(
    `/api/v1/starter-projects/${includeBlocked ? "?include_blocked=true" : ""}`,
    { headers: { Authorization: token } },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as TemplateListItem[];
}

test.describe("governance — catalog policy blocks a template", () => {
  let token: string;
  let snapshot: PolicySnapshot;
  let pristine = false;
  let skipReason = "";
  /** Resolved from the API, never hardcoded — see the spec doc. */
  let targetKey = "";
  let baselineExamples = 0;
  let baselineStarters = 0;

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
    const bundle = await readPolicyBundle(request, token);
    pristine = isPolicyPristine(bundle);
    skipReason = `instance already carries a catalog policy (${describePolicyState(bundle)}) — the "absent after blocking" assertions would be unfalsifiable`;
    if (pristine) {
      snapshot = await snapshotPolicy(request, token);
    }
  });

  test.afterAll(async ({ request }) => {
    if (pristine) {
      await restorePolicy(request, token, snapshot);
    }
  });

  test(
    "both template listings serve the target and expose its policy key",
    { tag: ["@destructive", "@api", "@templates"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      const examples = await listBasicExamples(request, token);
      const starters = await listStarterProjects(request, token);
      baselineExamples = examples.length;
      baselineStarters = starters.length;

      const target = examples.find((item) => item.name === TARGET_TEMPLATE);
      expect(
        target,
        `${TARGET_TEMPLATE} is not in this build's templates — pick another target`,
      ).toBeTruthy();
      // The key the policy is written with comes from the product, so a slug
      // convention change fails this test instead of silently disarming it.
      targetKey = target!.name_key;
      expect(targetKey).toBeTruthy();
      expect(targetKey).not.toBe(TARGET_TEMPLATE);
    },
  );

  test(
    "blocking by display name is accepted and enforces nothing",
    { tag: ["@destructive", "@api", "@templates"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      const put = await request.put("/api/v1/catalog-policy/templates", {
        headers: { Authorization: token },
        data: { blocked: [TARGET_TEMPLATE] },
      });
      expect(put.status()).toBe(200);
      expect((await put.json()).blocked).toContain(TARGET_TEMPLATE);

      // The trap this file exists for: the write succeeds, the bundle carries
      // the value, and the listings are untouched. An operator blocking a
      // template by the name they see in the UI gets no enforcement and no
      // error.
      const examples = await listBasicExamples(request, token);
      expect(examples.length).toBe(baselineExamples);
      expect(examples.map((item) => item.name)).toContain(TARGET_TEMPLATE);
    },
  );

  test(
    "blocking by name_key removes the template from the listing",
    { tag: ["@destructive", "@api", "@templates"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      const put = await request.put("/api/v1/catalog-policy/templates", {
        headers: { Authorization: token },
        data: { blocked: [targetKey] },
      });
      expect(put.status()).toBe(200);

      const examples = await listBasicExamples(request, token);
      expect(examples.map((item) => item.name)).not.toContain(TARGET_TEMPLATE);
      // Exactly one template left, not a listing that collapsed.
      expect(examples.length).toBe(baselineExamples - 1);
    },
  );

  test(
    "the starter-projects listing honours the block, and include_blocked reveals it",
    { tag: ["@destructive", "@api", "@templates"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      const starter = (await listStarterProjects(request, token)).find(
        (item) => item.name === STARTER_TEMPLATE,
      );
      expect(
        starter,
        `${STARTER_TEMPLATE} is not a starter project in this build`,
      ).toBeTruthy();

      const put = await request.put("/api/v1/catalog-policy/templates", {
        headers: { Authorization: token },
        data: { blocked: [starter!.name_key] },
      });
      expect(put.status()).toBe(200);

      await test.step("it leaves the starter listing", async () => {
        const starters = await listStarterProjects(request, token);
        expect(starters.map((item) => item.name)).not.toContain(STARTER_TEMPLATE);
        expect(starters.length).toBe(baselineStarters - 1);
      });

      await test.step("include_blocked returns it, proving it was filtered", async () => {
        // Absent-because-filtered vs absent-because-the-image-lacks-it are
        // indistinguishable without this read.
        const withBlocked = await listStarterProjects(request, token, {
          includeBlocked: true,
        });
        expect(withBlocked.map((item) => item.name)).toContain(STARTER_TEMPLATE);
        expect(withBlocked.length).toBe(baselineStarters);
      });
    },
  );

  test(
    "clearing the policy puts both listings back",
    { tag: ["@destructive", "@api", "@templates"] },
    async ({ request }) => {
      test.skip(!pristine, skipReason);

      await restorePolicy(request, token, snapshot);

      const examples = await listBasicExamples(request, token);
      const starters = await listStarterProjects(request, token);
      expect(examples.length).toBe(baselineExamples);
      expect(examples.map((item) => item.name)).toContain(TARGET_TEMPLATE);
      expect(starters.length).toBe(baselineStarters);
      expect(starters.map((item) => item.name)).toContain(STARTER_TEMPLATE);
    },
  );
});
