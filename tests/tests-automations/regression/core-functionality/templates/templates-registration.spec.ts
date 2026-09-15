import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  describeExtra,
  describeMissing,
  describeRenamed,
  describeStaleDeclarations,
  listedTemplates,
  registrationVerdict,
  type ListedTemplate,
  type RegisteredTemplatesBaseline,
} from "../../../../helpers/other/registered-templates-drift";

/**
 * The registered starter-template set (#1862, row R1 of the #1860 scoping pass).
 * Spec doc: `docs/core-functionality/templates/templates-registration.md`.
 *
 * `GET /api/v1/flows/basic_examples/` is the listing the New Flow gallery reads,
 * and this file owns WHICH templates are in it. `api/flows/api-flows-public-and-metadata.spec.ts`
 * owns the endpoint's SHAPE and deliberately asserts nothing about membership, so
 * when the image stops registering a template nothing goes red — #1234 surfaced
 * only because a Loop component spec happened to use it as a fixture.
 *
 * Three branches, three severities:
 *   1. an undeclared absence FAILS, naming it;
 *   2. a declared absence that came back FAILS, naming the declaration to delete
 *      and the issue to close (#1084: an exemption must not expire silently);
 *   3. an extra template is REPORTED and stays green (#980's trade) — accepting
 *      it is a reviewed `npm run templates:baseline` diff.
 *
 * Everything that decides lives in `helpers/other/registered-templates-drift.ts`
 * and is pure; this file is I/O and assertions only.
 *
 * `Accept-Language: en-US` is pinned on every request here, and the pin is the
 * fragile part rather than the safe part. The endpoint localizes `name` (#1400) —
 * under `pt-BR` *Basic Prompting* answers as *Sugestões básicas* while `name_key`
 * is unchanged — and nothing in the harness supplies that header for an
 * `APIRequestContext`: `PW_LOCALE` sets the browser context's `locale`, which is
 * not an `APIRequestContext` option at all, so it cannot reach this request
 * (`tests/fixtures/locale.ts` point 3 says the same). English is therefore a
 * property of the line below, not of the environment. Hence the split: the SET is
 * compared on `name_key`, which no header can move, while the `name` is compared
 * separately so that losing the pin goes red HERE — instead of surfacing in S1
 * (`templates-instantiate`, #1864), which picks a card by its display name and
 * would report it as an unexplained click timeout.
 */

const BASELINE_PATH = path.join(
  __dirname,
  "../../../../assets/templates/registered-templates-baseline.json",
);

/**
 * The committed baseline, or the reason it could not be read.
 *
 * A raw `SyntaxError`/`ENOENT` out of `JSON.parse`/`readFileSync` is fail-closed
 * but anonymous, and `registrationVerdict` cannot recover the cause either — it
 * would only report "the baseline is not a JSON object". Naming it here keeps the
 * promise this whole file makes: the failure says what happened.
 */
const readBaseline = (): { baseline: unknown; readError?: string } => {
  try {
    return { baseline: JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) };
  } catch (e) {
    return {
      baseline: null,
      readError:
        `${path.relative(process.cwd(), BASELINE_PATH)} could not be read: ` +
        `${(e as Error)?.message?.split("\n")[0] ?? String(e)}. ` +
        `Recreate it with: npm run templates:baseline`,
    };
  }
};

const baselineVersion = (baseline: unknown): string =>
  (baseline as RegisteredTemplatesBaseline)?.version ?? "(version unknown)";

test.describe("Templates — the registered set", () => {
  test(
    "the registered template set matches the committed baseline",
    { tag: ["@stable", "@release", "@api", "@templates"] },
    async ({ request, apiCoverage }, testInfo) => {
      apiCoverage.declare(["GET /api/v1/flows/basic_examples/"]);
      const authToken = await getAuthToken(request);
      const { baseline, readError } = readBaseline();
      expect(readError, readError).toBeUndefined();

      const listed = await test.step("GET /api/v1/flows/basic_examples/ answers 200 with a readable listing", async () => {
        const res = await request.get("/api/v1/flows/basic_examples/", {
          headers: { Authorization: authToken, "Accept-Language": "en-US" },
        });
        expect(res.status()).toBe(200);
        return listedTemplates(await res.json());
      });

      const verdict = registrationVerdict(baseline, listed);

      // An unreadable listing or an unusable baseline is UNKNOWN, never clean
      // (#1012): assert it here so the two below cannot pass vacuously.
      expect(
        verdict.kind,
        `no comparison was possible against ${path.relative(process.cwd(), BASELINE_PATH)}: ${verdict.reason}`,
      ).not.toBe("unknown");

      await test.step("every baseline template is registered", async () => {
        // The probe runs only when the assertion is already lost, so it costs a
        // green run nothing. It distinguishes a registration loss from a
        // catalog-policy block, which removes entries from this same listing by
        // name_key (`_filter_basic_examples_by_catalog_policy`): the @destructive
        // governance specs set one and restore it, so no scheduled lane sees a
        // block — a local run sharing an instance with them would. Only the
        // MESSAGE is conditional; the assertion below is not, so there is exactly
        // one gate here and no chance of reading the wrong one as the gate.
        const message =
          verdict.missing.length === 0
            ? ""
            : `${verdict.missing.length} template(s) the baseline expects are not registered by this image ` +
              `(baseline captured from ${baselineVersion(baseline)}):\n${describeMissing(verdict.missing)}\n` +
              `${describeBlockProbe(
                await probeIncludingBlocked(request, authToken),
                verdict.missing.map((t) => t.nameKey),
              )}\n` +
              `  If upstream legitimately removed it, accept the drift with: npm run templates:baseline`;
        expect(verdict.missing, message).toEqual([]);
      });

      await test.step("every registered template answers its recorded English name", async () => {
        expect(
          verdict.renamed,
          `${verdict.renamed.length} registered template(s) answer a name the baseline does not record:\n` +
            describeRenamed(verdict.renamed),
        ).toEqual([]);
      });

      await test.step("a template the baseline does not know is reported, not failed", async () => {
        if (verdict.extra.length > 0) {
          const report = describeExtra(verdict.extra);
          console.log(report);
          testInfo.annotations.push({ type: "templates-extra", description: report });
        }
        // The assertion is on what was ACTUALLY reported, read back out of
        // testInfo, against what the verdict says should have been. Asserting
        // `comparedCount === baseline.templates.length` instead — as the first
        // version did — is `x === x`: the helper sets it from that same field.
        // Measured: with that assertion, deleting the whole report block above
        // left the test green and silent, so "an extra is reported" was pinned
        // nowhere in the spec this checklist bullet claims coverage from. That is
        // #1862's "with the report asserted", and #1012 one level down.
        expect(
          testInfo.annotations
            .filter((a) => a.type === "templates-extra")
            .map((a) => a.description),
          "the extras report did not reach the test's annotations",
        ).toEqual(verdict.extra.length === 0 ? [] : [describeExtra(verdict.extra)]);
      });
    },
  );

  test(
    "every declared absence is still absent",
    { tag: ["@stable", "@release", "@api", "@templates"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/flows/basic_examples/"]);
      const authToken = await getAuthToken(request);
      const { baseline, readError } = readBaseline();
      expect(readError, readError).toBeUndefined();

      const listed = await test.step("GET /api/v1/flows/basic_examples/ answers 200 with a readable listing", async () => {
        const res = await request.get("/api/v1/flows/basic_examples/", {
          headers: { Authorization: authToken, "Accept-Language": "en-US" },
        });
        expect(res.status()).toBe(200);
        return listedTemplates(await res.json());
      });

      const verdict = registrationVerdict(baseline, listed);
      // Ordered before every read of the baseline's own fields: the verdict is
      // the only thing that validates its shape, so checking `declaredAbsences`
      // first — as the first version did — turned a baseline with that key
      // missing into a bare `TypeError: Cannot read properties of undefined`,
      // losing the named reason in the one file whose whole thesis is that the
      // cause is named. Fail-closed either way; the difference is the message.
      expect(
        verdict.kind,
        `no comparison was possible: ${verdict.reason}`,
      ).not.toBe("unknown");

      // A run with nothing declared asserts nothing, and would go green forever
      // the day the declaration is deleted without this spec noticing.
      expect(
        (baseline as RegisteredTemplatesBaseline).declaredAbsences.length,
        "the baseline declares no absence, so this test would assert nothing — " +
          "if that is intentional, delete this test along with the declarations",
      ).toBeGreaterThan(0);

      expect(
        verdict.staleDeclarations,
        `${verdict.staleDeclarations.length} declared absence(s) have expired — an exemption whose ` +
          `justification is gone must not pass silently (#1084):\n` +
          describeStaleDeclarations(verdict.staleDeclarations),
      ).toEqual([]);
    },
  );
});

/**
 * Re-reads the listing with the blocked templates included.
 *
 * `include_blocked=true` is superuser-only (measured: `403` without a
 * credential), so a `null` result means "could not probe" and is reported as
 * such rather than being read as evidence either way (#1012).
 */
async function probeIncludingBlocked(
  request: Parameters<typeof getAuthToken>[0],
  authToken: string,
): Promise<ListedTemplate[] | null> {
  try {
    const res = await request.get("/api/v1/flows/basic_examples/?include_blocked=true", {
      headers: { Authorization: authToken, "Accept-Language": "en-US" },
    });
    if (!res.ok()) return null;
    return listedTemplates(await res.json());
  } catch {
    return null;
  }
}

/** Turns the probe into the one sentence a reader needs to pick a remedy. */
function describeBlockProbe(
  probe: ListedTemplate[] | null,
  missingKeys: string[],
): string {
  if (probe === null) {
    return (
      "  Could not probe ?include_blocked=true (superuser only), so a catalog-policy block could not be\n" +
      "  ruled out as the cause."
    );
  }
  const withBlocked = new Set(probe.map((t) => t.nameKey));
  const blocked = missingKeys.filter((k) => withBlocked.has(k));
  if (blocked.length === 0) {
    return (
      "  ?include_blocked=true does not list them either, so this is a REGISTRATION loss, not a catalog\n" +
      "  policy block: the image stopped shipping a component the template needs (see the startup log for\n" +
      "  \"Skipping starter project …; unavailable components: …\")."
    );
  }
  return (
    `  ?include_blocked=true DOES list ${blocked.join(", ")}, so a catalog-policy template block is active\n` +
    "  on this instance — not a registration loss. The @destructive governance specs set one and restore it;\n" +
    "  a local run sharing an instance with them sees this. Re-run against a clean instance."
  );
}
