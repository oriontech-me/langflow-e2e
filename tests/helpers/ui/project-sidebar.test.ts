// Unit tests for the project-sidebar selector builders (issue #1363).
// Run with: npm run test:units
//
// These builders decide whether SEVEN `@stable` tests across four specs can find
// a project at all, and they have to hold on two upstream spellings at once —
// the id-derived testid the nightly renders and the name-derived one `main` and
// the `1.11.x` release candidates still render. A string-equality test would
// pass every mutation that keeps the shape, so the assertions below run the
// compiled selector against elements instead: `selects()` answers the only
// question that matters — given an element carrying THIS `data-testid`, does the
// selector select it?
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectOptionsButtonSelector,
  projectSidebarEntrySelector,
} from "./project-sidebar";

/**
 * Does `selector` (a comma-separated list of `[data-testid="…"]` fragments)
 * select an element whose `data-testid` is exactly `testId`?
 *
 * Hand-parsed rather than regex-split on `", "`, because a project name may
 * legitimately contain a comma — splitting on it would silently mis-parse the
 * very input the escaping exists for.
 */
function selects(selector: string, testId: string): boolean {
  const values: string[] = [];
  let i = 0;
  while (i < selector.length) {
    const open = selector.indexOf('[data-testid="', i);
    if (open === -1) break;
    let j = open + '[data-testid="'.length;
    let value = "";
    while (j < selector.length) {
      const ch = selector[j];
      if (ch === "\\") {
        value += selector[j + 1];
        j += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      j += 1;
    }
    assert.equal(selector[j], '"', `unterminated attribute value in ${selector}`);
    assert.equal(selector[j + 1], "]", `malformed fragment in ${selector}`);
    values.push(value);
    i = j + 2;
  }
  assert.ok(values.length > 0, `no fragment parsed out of ${selector}`);
  return values.includes(testId);
}

const PROJECT = {
  id: "ced80faf-e13c-400d-872f-e207bd0f82f5",
  name: "New Project (3)",
};

test("the entry selector matches the id-derived testid the nightly renders", () => {
  // Measured live on 1.12.0.dev20 — `sidebar-nav-<uuid>`.
  assert.ok(
    selects(projectSidebarEntrySelector(PROJECT), `sidebar-nav-${PROJECT.id}`),
  );
});

test("the entry selector still matches the name-derived testid of main / 1.11.x", () => {
  // `manual.yml` runs the @stable set against 1.11.x release candidates before
  // sign-off; dropping this branch trades one lane's red for another's.
  assert.ok(
    selects(
      projectSidebarEntrySelector(PROJECT),
      `sidebar-nav-${PROJECT.name}`,
    ),
  );
});

test("the kebab selector matches the id on 1.12 and the SLUGIFIED name on 1.11", () => {
  const selector = projectOptionsButtonSelector(PROJECT);
  assert.ok(selects(selector, `more-options-button_${PROJECT.id}`));
  // 1.11 built this one through `convertTestName` — spaces to dashes, lowercased.
  assert.ok(selects(selector, "more-options-button_new-project-(3)"));
  // The raw name is NOT the 1.11 spelling; matching it would mean the slug was
  // dropped, which is how the kebab silently resolves to nothing on that line.
  assert.equal(
    selects(selector, `more-options-button_${PROJECT.name}`),
    false,
  );
});

test("a project is never matched by another project's id or name", () => {
  const other = { id: "7c7a4e0f-26e6-479e-b220-5d5035ede368", name: "Starter" };
  const selector = projectSidebarEntrySelector(PROJECT);
  assert.equal(selects(selector, `sidebar-nav-${other.id}`), false);
  assert.equal(selects(selector, `sidebar-nav-${other.name}`), false);
});

test("matching is exact, so a name that is a PREFIX of another does not match it", () => {
  // The state every failing daily attempt landed in: `New Project`,
  // `New Project (1)`, … accumulating because cleanup stopped deleting. A
  // prefix match here would delete or assert on the wrong folder.
  const prefix = { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "New Project" };
  assert.equal(
    selects(projectSidebarEntrySelector(prefix), "sidebar-nav-New Project (3)"),
    false,
  );
});

test("a name carrying a quote or a backslash still yields a well-formed selector", () => {
  const awkward = {
    id: "bbbbbbbb-0000-0000-0000-000000000000",
    name: 'we"ird\\name',
  };
  // `selects()` asserts the fragment is terminated and closed, so an unescaped
  // quote fails here rather than reaching Playwright as an unparsable selector.
  assert.ok(
    selects(projectSidebarEntrySelector(awkward), `sidebar-nav-${awkward.name}`),
  );
});
