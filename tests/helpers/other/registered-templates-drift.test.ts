// Unit tests for the registered-template drift detector (#1862).
// Run with: npm run test:units
//
// Every fixture below is shaped after the real listing measured on Langflow
// Nightly `1.13.0.dev12`: 26 registered templates out of the 27 JSONs upstream
// ships, the one absence being *Research Translation Loop* (ArXivComponent).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  describeBaselineDefect,
  describeBlockProbe,
  describeExtra,
  describeStaleDeclarations,
  listedTemplates,
  registrationVerdict,
  type RegisteredTemplatesBaseline,
} from "./registered-templates-drift";

const BASELINE_PATH = path.join(
  __dirname,
  "../../assets/templates/registered-templates-baseline.json",
);

const baseline: RegisteredTemplatesBaseline = {
  version: "1.13.0.dev12",
  templates: [
    { nameKey: "basic_prompting", name: "Basic Prompting" },
    { nameKey: "simple_agent", name: "Simple Agent" },
  ],
  declaredAbsences: [
    {
      nameKey: "research_translation_loop",
      name: "Research Translation Loop",
      reason: "ArXivComponent is not shipped by this image.",
      issue: "#1744",
      unavailableComponents: ["ArXivComponent"],
    },
  ],
};

const live = [
  { name: "Basic Prompting", name_key: "basic_prompting" },
  { name: "Simple Agent", name_key: "simple_agent" },
];

test("the committed baseline is well-formed and is the one the spec compares against", () => {
  const committed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  assert.equal(describeBaselineDefect(committed), null);
  // Measured on 1.13.0.dev12: 26 registered of the 27 JSONs upstream ships.
  assert.equal(committed.templates.length, 26);
  assert.deepEqual(
    committed.declaredAbsences.map((d: { nameKey: string }) => d.nameKey),
    ["research_translation_loop"],
  );
});

test("a listing matching the baseline is clean, with nothing missing and nothing extra", () => {
  const v = registrationVerdict(baseline, listedTemplates(live));
  assert.equal(v.kind, "clean");
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.extra, []);
  assert.deepEqual(v.staleDeclarations, []);
  assert.deepEqual(v.renamed, []);
  assert.equal(v.comparedCount, 2);
});

test("an undeclared absence is drift, and names the template", () => {
  const v = registrationVerdict(baseline, listedTemplates([live[0]]));
  assert.equal(v.kind, "drift");
  assert.deepEqual(v.missing, [{ nameKey: "simple_agent", name: "Simple Agent" }]);
  assert.deepEqual(v.extra, []);
});

test("a declared absence that came back is drift, not a silent pass (#1084)", () => {
  const v = registrationVerdict(
    baseline,
    listedTemplates([
      ...live,
      { name: "Research Translation Loop", name_key: "research_translation_loop" },
    ]),
  );
  assert.equal(v.kind, "drift");
  assert.equal(v.staleDeclarations.length, 1);
  assert.equal(v.staleDeclarations[0].issue, "#1744");
  // It must NOT be reported as an extra: it is a known template, and reporting
  // it as unknown would let the run stay green.
  assert.deepEqual(v.extra, []);
  const message = describeStaleDeclarations(v.staleDeclarations);
  assert.match(message, /#1744/);
  assert.match(message, /ArXivComponent/);
  assert.match(message, /templates:baseline/);
});

test("an unknown template is reported as extra and does NOT make the verdict drift (#980)", () => {
  const v = registrationVerdict(
    baseline,
    listedTemplates([...live, { name: "Brand New Template", name_key: "brand_new_template" }]),
  );
  assert.equal(v.kind, "clean");
  assert.deepEqual(v.extra, [{ nameKey: "brand_new_template", name: "Brand New Template" }]);
  assert.match(describeExtra(v.extra), /brand_new_template/);
  assert.match(describeExtra(v.extra), /templates:baseline/);
});

test("a template whose English name changed under an UNCHANGED key is drift", () => {
  const v = registrationVerdict(
    baseline,
    listedTemplates([{ name: "Sugestões básicas", name_key: "basic_prompting" }, live[1]]),
  );
  assert.equal(v.kind, "drift");
  assert.deepEqual(v.renamed, [
    { nameKey: "basic_prompting", expected: "Basic Prompting", actual: "Sugestões básicas" },
  ]);
  // The set itself is intact: keying on name_key is what keeps a localized
  // listing from reading as 2 missing plus 2 extra.
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.extra, []);
});

test("listedTemplates returns no signal for the three bodies that would diff as a total wipe", () => {
  assert.equal(listedTemplates({ detail: "Not authenticated" }), null);
  assert.equal(listedTemplates([]), null);
  assert.equal(listedTemplates([{ name: "Basic Prompting" }]), null);
  assert.equal(listedTemplates([{ name: "x", name_key: "  " }]), null);
  assert.equal(listedTemplates(null), null);
});

test("an unreadable listing is UNKNOWN with a reason, never clean (#1012)", () => {
  const v = registrationVerdict(baseline, null);
  assert.equal(v.kind, "unknown");
  assert.equal(v.comparedCount, 0);
  assert.match(String(v.reason), /never clean/);
  assert.deepEqual(v.missing, []);
});

test("a malformed baseline is UNKNOWN rather than a throw — the verdict is total", () => {
  for (const bad of [
    null,
    [],
    {},
    { templates: [], declaredAbsences: [] },
    { templates: [{ nameKey: "a" }], declaredAbsences: [] },
    { templates: [{ nameKey: "a", name: "A" }] },
  ]) {
    const v = registrationVerdict(bad, listedTemplates(live));
    assert.equal(v.kind, "unknown", `expected UNKNOWN for ${JSON.stringify(bad)}`);
    assert.ok(v.reason, "UNKNOWN must carry a reason");
  }
});

test("the listing side is validated too — `cannot throw` is a property, not a claim about one call site", () => {
  // Measured before the guard existed: `registrationVerdict(baseline, [null])` threw
  // `TypeError: Cannot read properties of null (reading 'nameKey')`. Not reachable
  // from the spec, where `listed` always comes from `listedTemplates` — but the
  // JSDoc states the guarantee unconditionally and S1 (#1864) parametrizes over
  // this module, so the guarantee has to hold for any caller.
  for (const bad of [
    [null],
    [undefined],
    ["Basic Prompting"],
    [{ name: "Basic Prompting" }],
    [{ nameKey: "", name: "x" }],
    "not an array",
  ]) {
    const v = registrationVerdict(baseline, bad as never);
    assert.equal(v.kind, "unknown", `expected UNKNOWN for ${JSON.stringify(bad)}`);
    assert.ok(v.reason, "UNKNOWN must carry a reason");
  }
});

test("a declaration with no reason or no issue is refused — that is the silent exemption #1084 forbids", () => {
  const defect = describeBaselineDefect({
    templates: [{ nameKey: "a", name: "A" }],
    declaredAbsences: [{ nameKey: "b", name: "B", reason: "", issue: "#1" }],
  });
  assert.match(String(defect), /no reason or no issue/);
});

test("an unavailableComponents that is not an array of strings is refused", () => {
  // Left unvalidated, the plausible hand-edit of a string where an array belongs
  // passed the validator and then threw `TypeError: …join is not a function` out
  // of describeStaleDeclarations — losing the "close #N and delete the
  // declaration" message on the exact failure it exists to report.
  for (const bad of ["ArXivComponent", [""], [null], 3]) {
    const defect = describeBaselineDefect({
      templates: [{ nameKey: "a", name: "A" }],
      declaredAbsences: [
        { nameKey: "b", name: "B", reason: "r", issue: "#1", unavailableComponents: bad },
      ],
    });
    assert.match(String(defect), /unavailableComponents/, `must be refused: ${JSON.stringify(bad)}`);
  }
  // Absent and well-formed both stay legal.
  for (const ok of [undefined, [], ["ArXivComponent"]]) {
    assert.equal(
      describeBaselineDefect({
        templates: [{ nameKey: "a", name: "A" }],
        declaredAbsences: [
          { nameKey: "b", name: "B", reason: "r", issue: "#1", unavailableComponents: ok },
        ],
      }),
      null,
    );
  }
});

test("a baseline that both expects and declares absent the same template is refused", () => {
  const defect = describeBaselineDefect({
    templates: [{ nameKey: "a", name: "A" }],
    declaredAbsences: [{ nameKey: "a", name: "A", reason: "r", issue: "#1" }],
  });
  assert.match(String(defect), /both expects and declares absent/);
});

test("describeBlockProbe tells a catalog-policy block apart from a registration loss", () => {
  const probe = [
    { nameKey: "basic_prompting", name: "Basic Prompting" },
    { nameKey: "saas_pricing", name: "SaaS Pricing" },
  ];

  // The branch the whole probe exists for. It is unreachable from any spec run on
  // a clean instance — which is precisely why it is pinned here and nowhere else.
  const blocked = describeBlockProbe(probe, ["saas_pricing"]);
  assert.match(blocked, /DOES list saas_pricing/);
  assert.match(blocked, /catalog-policy template block is active/);
  assert.doesNotMatch(blocked, /REGISTRATION loss/);

  const lost = describeBlockProbe(probe, ["ghost_template"]);
  assert.match(lost, /REGISTRATION loss/);
  assert.doesNotMatch(lost, /DOES list/);

  // null is "could not rule it out", never "nothing is blocked" (#1012).
  const unknown = describeBlockProbe(null, ["ghost_template"]);
  assert.match(unknown, /could not be\n  ruled out/);
  assert.doesNotMatch(unknown, /REGISTRATION loss/);
});
