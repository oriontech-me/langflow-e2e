import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import {
  describeShapeDiff,
  graphShape,
  nameMatchesTemplate,
} from "../../../../helpers/flows/template-graph-shape";
import {
  describeBaselineDefect,
  type BaselineTemplate,
  type RegisteredTemplatesBaseline,
} from "../../../../helpers/other/registered-templates-drift";

/**
 * Every registered template instantiates as itself (#1864, row S1 of the #1860
 * scoping pass). Spec doc:
 * `docs/core-functionality/templates/templates-instantiate.md`.
 *
 * One test per registered template. Picking the card from *All templates* must
 * create a flow that IS that template: `GET /api/v1/flows/{id}` equal to the
 * template's entry in `GET /api/v1/flows/basic_examples/` on the component-type
 * multiset, the edge count, the note count and the name.
 *
 * **The expected side is read at run time.** If upstream edits a template, both
 * sides move together and nothing fails. What fails is an instantiation path that
 * changes the graph — a node type dropped or rewritten, an edge lost, a note
 * discarded. It finds no defect on `1.13.0.dev12` (26 of 26 exact), so it is a
 * regression detector and ships with force-fails proving the comparison bites.
 *
 * Sibling coverage, deliberately not duplicated here: the registered SET is
 * `templates-registration.spec.ts` (#1862), whose baseline this file consumes; the
 * gallery is #1863; running a template is §11.3–§11.5.
 */

const BASELINE_PATH = path.join(
  __dirname,
  "../../../../assets/templates/registered-templates-baseline.json",
);

/**
 * The templates to generate a test for, read at MODULE SCOPE so the list exists
 * when Playwright collects.
 *
 * It must not come from the live listing: a spec whose test list depends on
 * runtime state can drop out of the daily's shard listing and run nowhere while
 * the run stays green — #1764, which removed `provider-invalid-auth-error.spec.ts`
 * from the lane entirely. The committed baseline is static, reviewable, the same
 * set #1862 enforces, and skips declared absences by construction (*Research
 * Translation Loop* is not in `templates[]`, so no test is generated for a
 * template this image does not register).
 *
 * **Anything unusable THROWS here rather than yielding zero tests.** That is the
 * same #1764 hazard by a different door: zero tests means this file is ABSENT from
 * the shard listing, not red in it, and `--pass-with-no-tests` keeps the lane
 * green. A module-scope throw is a visible collection error; an empty loop is
 * silence.
 */
function templatesToCover(): BaselineTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch (e) {
    throw new Error(
      `templates-instantiate: could not read ${path.relative(process.cwd(), BASELINE_PATH)} ` +
        `(${(e as Error)?.message?.split("\n")[0] ?? String(e)}). ` +
        `Recreate it with: npm run templates:baseline`,
    );
  }
  // R1's validator, not a second one written here. It is exported, unit-tested,
  // and its sibling `describeListingDefect` already names S1 (#1864) as a
  // consumer of this module. The hand-rolled check it replaces was weaker in
  // three ways that all fail SILENTLY at this scope: it accepted a non-string or
  // whitespace `nameKey` (which then matches no `name_key` in the listing, so the
  // test fails claiming the image does not REGISTER the template — a defect in
  // the baseline reported as a defect in R1's area), it accepted a whitespace
  // `name` (an unusable card locator), and it did not notice a DUPLICATE
  // `nameKey`, which generates two tests with the same title.
  const defect = describeBaselineDefect(parsed);
  if (defect) {
    throw new Error(
      `templates-instantiate: ${path.relative(process.cwd(), BASELINE_PATH)} is unusable — ${defect}. ` +
        `Refusing to generate tests from it: zero or wrong tests here means this file is ABSENT from the ` +
        `shard listing rather than red in it, and \`--pass-with-no-tests\` keeps the lane green (#1764). ` +
        `Recreate it with: npm run templates:baseline`,
    );
  }
  return (parsed as RegisteredTemplatesBaseline).templates.map(({ nameKey, name }) => ({
    nameKey,
    name,
  }));
}

const TEMPLATES = templatesToCover();

test.describe("Templates — every registered template instantiates as itself", () => {
  /**
   * The flow the running test created, for `afterEach` to delete.
   *
   * Describe-scoped rather than in-body on purpose, for two gains of different
   * sizes. The load-bearing one: an in-body `finally` that throws REPLACES the
   * product failure (plain JS semantics — measured, the "edge count" message was
   * gone and only the cleanup's error was reported). The smaller one: Playwright
   * gives `afterEach` its own timeout budget and runs it after a test TIMES OUT,
   * whereas a `finally` inside the timed-out body is not guaranteed to complete.
   *
   * **That second gain is narrower than it reads, so do not lean on it.** The long
   * pole here is `loadTemplateByName` — two 30 s gates — and it runs BEFORE
   * `createdFlowId` is assigned, so a timeout in the window where a timeout is
   * actually likely leaves this hook with no id to delete. What covers that window
   * is the helper's own cleanup, which deletes what it created on every throw path
   * of its own.
   *
   * Safe under `fullyParallel` because each worker has its own module instance and
   * runs its tests serially; it is the same shape the merged
   * `create-flow-from-template.spec.ts` uses.
   */
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page, request }) => {
    const id = createdFlowId;
    createdFlowId = null;
    if (!id) return;

    // Take the page OFF the flow canvas before deleting anything, the shape the
    // folder and API specs already use (#1023/#1103,
    // `api/flows/api-component-regression.spec.ts`). An editor left mounted over
    // a flow that is being deleted keeps asking for it, and every such 404 is
    // logged as `🚨 Backend Error` — which fails no test (#1084) and is exactly
    // why it costs: that log is read by a human, and the deterministic pipeline's
    // VALIDATE gate greps the string.
    //
    // Measured on the lane, both sides: without this line the PR lane's run of
    // this file logged 57 of them over 17 flows (`/api/v1/models`,
    // `/custom_component/update`, `/flows/{id}/events`, `/variables/`,
    // `/note_translations` — all flow-scoped 404s for flows the run had created
    // and deleted); with it, the same job over the same 26 specs logged 0.
    //
    // **A LOCAL run cannot check this, which is the part to carry.** 26/26 green
    // against the same image (`1.13.0.dev12`) at `workers=2`, WITH and WITHOUT
    // this navigation, logged 0 of that class either way (3 unrelated 400s on a
    // shared dev instance, identical in both runs) — so a green local pair looks
    // exactly like a fix and proves nothing here. The plausible difference is
    // timing, a slower runner leaving more editor polls in flight when the delete
    // lands; it was not chased further.
    //
    // `about:blank` rather than `/` so the teardown adds no backend traffic of
    // its own, and unconditionally: Playwright captures the failure screenshot
    // BEFORE this hook runs (measured on 1.58.2), so navigating here does not
    // destroy the artifact of a red test.
    await page.goto("about:blank").catch(() => {});

    // Id-scoped, never a wipe (#553). A cleanup problem must NOT replace the
    // product failure — measured: with the comparison failing AND the delete
    // failing, the only error reported was the cleanup's, and the "edge count"
    // message was gone. That is the convention `load-template-by-name.ts` states
    // for its own cleanup, and the triage cost this repo keeps writing guards
    // about. So a cleanup failure is surfaced and re-thrown only when the test
    // had otherwise passed.
    //
    // The token read is INSIDE the try for the same reason: it retries a wedged
    // backend for ~30 s and then rethrows (#1086), and a throw out here would be
    // a cleanup failure replacing the product failure by the one path this hook
    // is written to close.
    try {
      const authToken = await getAuthToken(request);
      await deleteFlow(request, id, { headers: { Authorization: authToken } });
      const gone = await request.get(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
      expect(
        gone.status(),
        `flow ${id} survived its own cleanup — this file creates ${TEMPLATES.length} ` +
          `flows per run, so a leak here compounds`,
      ).toBe(404);
    } catch (error) {
      const reason = (error as Error)?.message?.split("\n")[0] ?? String(error);
      console.warn(`⚠️  templates-instantiate: could not clean up flow ${id} — ${reason}`);
      if (test.info().status === "passed") throw error;
    }
  });

  for (const template of TEMPLATES) {
    // The title is built from a variable, so the @stable listing detector reports
    // it under `unresolvedTitles` (#1812) — expected for this file, as for the
    // provider-parametrized specs, and stated in the spec doc.
    test(
      `${template.name} instantiates with the template's components, edges and notes`,
      { tag: ["@stable", "@workspace", "@regression", "@templates"] },
      async ({ page, request }) => {
        const authToken = await getAuthToken(request);

        const expectedShape = await test.step("read the template's entry from the live listing", async () => {
          const res = await request.get("/api/v1/flows/basic_examples/", {
            // Pinned for the same reason #1862 pins it: the endpoint localizes
            // `name`, and this spec picks the card BY its display name.
            headers: { Authorization: authToken, "Accept-Language": "en-US" },
          });
          expect(res.status()).toBe(200);
          const listing = (await res.json()) as Array<{ name_key?: string; data?: unknown }>;
          const entry = listing.find((e) => e?.name_key === template.nameKey);
          expect(
            entry,
            `${template.nameKey} is in the committed baseline but this image does not register it — ` +
              `that is a REGISTRATION problem, which templates-registration.spec.ts (#1862) owns. ` +
              `Refresh the baseline with: npm run templates:baseline`,
          ).toBeTruthy();

          const shape = graphShape(entry?.data);
          expect(
            shape,
            `the listing's graph for ${template.nameKey} could not be read — an unreadable expected ` +
              `side is unknown, never a match (#1012)`,
          ).not.toBeNull();
          return shape!;
        });

        createdFlowId = await test.step(`pick ${template.name} from All templates`, async () => {
          // The canonical journey, concurrency-hardened in #1002: it retries the
          // creation POST on the upstream same-name 500, recovers a lost
          // navigation, deletes the entry point's own `New Flow`, and resolves
          // once canvas_controls_dropdown is visible — so the editor being open
          // is part of this step, not a separate assertion.
          const id = await loadTemplateByName(page, template.name);
          expect(id).toBeTruthy();
          return id;
        });

        await test.step("the persisted flow is the template", async () => {
          const res = await request.get(`/api/v1/flows/${createdFlowId}`, {
            headers: { Authorization: authToken },
          });
          expect(res.status()).toBe(200);
          const flow = (await res.json()) as { name?: unknown; data?: unknown };

          const actualShape = graphShape(flow?.data);
          expect(
            actualShape,
            `the created flow's graph carried no signal: either it could not be read, or it ` +
              `holds NO component node at all — which on this side is not a parse failure but ` +
              `the severest instantiation defect there is, the template arriving as an empty ` +
              `canvas. Either way it is unknown, never a match (#1012). Body: ` +
              `${JSON.stringify(flow?.data)?.slice(0, 400) ?? "undefined"}`,
          ).not.toBeNull();

          const diff = describeShapeDiff(expectedShape, actualShape!);
          expect(
            diff,
            `${template.name} was instantiated with a graph that is not the template's:\n` +
              diff.map((l) => `  • ${l}`).join("\n"),
          ).toEqual([]);

          expect(
            nameMatchesTemplate(flow?.name, template.name),
            `the created flow is named ${JSON.stringify(flow?.name)}, which is neither ` +
              `"${template.name}" nor a "${template.name} (N)" duplicate of it. ` +
              `loadTemplateByName matches the card heading without \`exact\`, so a template ` +
              `name that became a substring of another would land here.`,
          ).toBe(true);
        });
      },
    );
  }
});
