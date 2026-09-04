// Unit tests for the settings-navigation verdicts (issue #1696).
// Run with: npm run test:units
//
// What rides on this file: `navigateSettingsPages` used to fire three blind
// clicks and verify none of them, so a hop the DOM ACCEPTED while the app
// DISCARDED it surfaced one hop LATER, at a locator that never had a chance.
// The measured cost of that was one cause reported under four different
// signatures across 30 days, every one of them shaped like
//
//   TimeoutError: locator.click: Timeout 20000ms exceeded.
//   Call log:
//     - waiting for getByText('Model Providers').first()
//
// with the failure-time screenshot and aria snapshot showing the HOME page and
// the string "Settings" appearing zero times — i.e. the report named the hop
// that had no chance, never the hop that broke (dailies 2026-09-01 run
// 33511210195 and 2026-09-03 run 33756085604).
//
// The classification is pure precisely so these branches are reachable here.
// On a live instance `menu-unopened` needs a click the app drops and
// `page-unreached` needs a route change that does not take — neither is
// something a spec may do on demand — which is the same argument
// `providerRowVerdict` (#1648), `censusForTarget` (#1464) and `decideEntryPoint`
// (#1465) settled for their own decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_NAV_TESTIDS,
  sectionHopState,
  settingsNavVerdict,
  trackTargetHeader,
  type SettingsNavSnapshot,
} from "./go-to-settings";

const HOME: SettingsNavSnapshot = {
  pathname: "/",
  menuPresent: false,
  menuItemPresent: false,
  navEntries: [],
  headerPresent: false,
  headerText: "",
  headerEverPresent: false,
  headerGraceElapsed: false,
  targetHref: "",
};

const SETTINGS_SHELL: SettingsNavSnapshot = {
  ...HOME,
  pathname: "/settings/general",
  navEntries: [
    "General",
    "MCP Servers",
    "Langflow API Keys",
    "Langflow MCP Client",
    "Global Variables",
    "Model Providers",
    "DB Providers",
    "Shortcuts",
    "Messages",
  ],
  headerPresent: true,
  headerText: "General",
  headerEverPresent: true,
};

// ---------- hop 1: the account menu ----------

test("hop 1 reports menu-unopened, naming the trigger and the page it stayed on", () => {
  const v = settingsNavVerdict("menu", HOME, "Model Providers", 20000);
  assert.equal(v.kind, "menu-unopened");
  assert.match(v.message, /^SETTINGS_MENU_UNOPENED:/);
  assert.match(v.message, /user-profile-settings/);
  assert.match(v.message, /menu_settings_button/);
  assert.match(v.message, /"\/"/); // the pathname it never left
  assert.match(v.message, /20000ms/);
});

test("hop 1 says the menu WAS open when a menu rendered without the item", () => {
  // The distinction matters: a menu that opened without the Settings entry is a
  // renamed testid (a product finding), not an app-shell stall.
  const v = settingsNavVerdict(
    "menu",
    { ...HOME, menuPresent: true },
    "Model Providers",
    20000,
  );
  assert.equal(v.kind, "menu-unopened");
  assert.match(v.message, /menu DID open/i);
});

// ---------- hop 2: the Settings route ----------

test("hop 2 reports page-unreached with the pathname the app is actually on", () => {
  const v = settingsNavVerdict("page", HOME, "Model Providers", 20000);
  assert.equal(v.kind, "page-unreached");
  assert.match(v.message, /^SETTINGS_PAGE_UNREACHED:/);
  assert.match(v.message, /"\/"/);
  // Must not be mistaken for a missing section.
  assert.doesNotMatch(v.message, /renamed or removed/);
});

test("hop 2 on /settings with ZERO nav entries is a shell that never mounted", () => {
  // Keyed on the URL plus the entry count, never on the `sidebar-nav-` prefix
  // alone: the flow sidebar uses the same prefix, so "an entry rendered" is not
  // evidence that the SETTINGS shell mounted.
  const v = settingsNavVerdict(
    "page",
    { ...HOME, pathname: "/settings" },
    "Model Providers",
    20000,
  );
  assert.equal(v.kind, "page-unreached");
  assert.match(v.message, /zero/i);
  assert.match(v.message, /"\/settings"/);
});

// ---------- hop 3: the section ----------

test("hop 3 reports section-absent as a PRODUCT finding, listing what did render", () => {
  const withoutTarget = {
    ...SETTINGS_SHELL,
    navEntries: SETTINGS_SHELL.navEntries.filter((n) => n !== "Model Providers"),
  };
  const v = settingsNavVerdict("section", withoutTarget, "Model Providers", 20000);
  assert.equal(v.kind, "section-absent");
  assert.match(v.message, /^SETTINGS_SECTION_ABSENT:/);
  assert.match(v.message, /PRODUCT/);
  // Naming the survivors is the whole point — a count alone leaves the reader
  // hand-diffing (the #1040 lesson).
  assert.match(v.message, /General/);
  assert.match(v.message, /Shortcuts/);
  assert.equal(v.message.includes("Model Providers,"), false);
});

test("hop 3 reports section-unconfirmed with the header text and the pathname", () => {
  const stuck = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/general",
  };
  const v = settingsNavVerdict("section", stuck, "Model Providers", 20000);
  assert.equal(v.kind, "section-unconfirmed");
  assert.match(v.message, /^SETTINGS_SECTION_UNCONFIRMED:/);
  assert.match(v.message, /\/settings\/model-providers/); // where it should be
  assert.match(v.message, /\/settings\/general/); // where it is
  assert.match(v.message, /General/); // the header it is showing
});

test("hop 3 distinguishes a wrong header from a wrong route", () => {
  // Pathname arrived, content did not: that is a mounted-wrong-content verdict,
  // and the message must not blame the route.
  const wrongContent = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/model-providers",
    headerText: "Global Variables",
  };
  const v = settingsNavVerdict("section", wrongContent, "Model Providers", 20000);
  assert.equal(v.kind, "section-unconfirmed");
  assert.match(v.message, /Global Variables/);
  assert.match(v.message, /route took/i);
});

// ---------- hop 3's success rule ----------

test("the section hop stays pending until the pathname matches the clicked anchor", () => {
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/general",
  };
  assert.equal(sectionHopState(s, "Model Providers"), "pending");
});

test("the section hop settles when the pathname matches and the header agrees", () => {
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/model-providers",
    headerText: "Model Providers",
  };
  assert.equal(sectionHopState(s, "Model Providers"), "settled");
});

test("a matching pathname with a DISAGREEING header is still pending", () => {
  // Never accepted, so the deadline turns it into `section-unconfirmed` rather
  // than a green hop on a page showing something else.
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/model-providers",
    headerText: "General",
  };
  assert.equal(sectionHopState(s, "Model Providers"), "pending");
});

test("a header that has not mounted yet is pending, not headerless", () => {
  // The trap this closes: right after the route change the header is legitimately
  // absent, and accepting there would green-light every section before its page
  // mounted. Only the elapsed grace can tell "not yet" from "never".
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/model-providers",
    headerPresent: false,
    headerText: "",
    headerEverPresent: false,
    headerGraceElapsed: false,
  };
  assert.equal(sectionHopState(s, "Model Providers"), "pending");
});

test("a section that renders NO header at all settles on the URL once the grace elapsed", () => {
  // `sidebar-nav-Langflow MCP Client` renders no `settings_menu_header` at all
  // (measured across all nine sections on 1.13.0.dev0). Requiring one would make
  // the helper unusable there, and hardcoding a list of headerless sections is
  // the name-to-path table this design refuses to keep (#1043/#1184).
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/mcp-client",
    pathname: "/settings/mcp-client",
    headerPresent: false,
    headerText: "",
    headerEverPresent: false,
    headerGraceElapsed: true,
  };
  assert.equal(sectionHopState(s, "Langflow MCP Client"), "settled-headerless");
});

test("a header that was seen and then vanished is pending, never headerless", () => {
  // A section that HAS a header is mid-render, not headerless — accepting it
  // would hand the caller a page whose content is still swapping.
  const s = {
    ...SETTINGS_SHELL,
    targetHref: "/settings/model-providers",
    pathname: "/settings/model-providers",
    headerPresent: false,
    headerText: "",
    headerEverPresent: true,
    headerGraceElapsed: true,
  };
  assert.equal(sectionHopState(s, "Model Providers"), "pending");
});

// ---------- the testid table ----------

test("the testid table carries the handles measured on the running build", () => {
  // Every one of these was read off 1.13.0.dev0 and confirmed in upstream
  // source: AccountMenu/index.tsx lines 57 and 98, sidebarComponent/index.tsx
  // line 53. A rename upstream must break this assertion, not a spec 20 s later.
  assert.equal(SETTINGS_NAV_TESTIDS.profileTrigger, "user-profile-settings");
  assert.equal(SETTINGS_NAV_TESTIDS.menuItem, "menu_settings_button");
  assert.equal(SETTINGS_NAV_TESTIDS.navPrefix, "sidebar-nav-");
  assert.equal(SETTINGS_NAV_TESTIDS.menuHeader, "settings_menu_header");
});

test("every verdict names the budget so no reader has to guess it", () => {
  const snapshots: Array<[Parameters<typeof settingsNavVerdict>[0], SettingsNavSnapshot]> = [
    ["menu", HOME],
    ["page", HOME],
    ["section", { ...SETTINGS_SHELL, navEntries: [] }],
    ["section", SETTINGS_SHELL],
  ];
  for (const [hop, snap] of snapshots) {
    assert.match(
      settingsNavVerdict(hop, snap, "Model Providers", 12345).message,
      /12345ms/,
      `${hop} verdict omitted the budget`,
    );
  }
});

test("no verdict invites raising the budget", () => {
  // The budgets are the ones the three blind clicks already had. Raising them
  // hides the stall the verdict exists to name (#1648's rule), so the messages
  // say so where a reader would otherwise reach for the timeout.
  for (const hop of ["menu", "page"] as const) {
    assert.match(settingsNavVerdict(hop, HOME, "Model Providers", 20000).message, /#1696/);
  }
});

// ---------- which header counts as "this section has one" ----------

test("a header on the page hop 3 is LEAVING does not count as the target's", () => {
  // The bug this closes, found by running the real helper rather than by
  // reading it: hop 3 starts on /settings/general, which HAS a
  // `settings_menu_header`. Counting that one makes `headerEverPresent` true
  // before the route even swaps, so the headerless branch can never fire and
  // `sidebar-nav-Langflow MCP Client` — the one section that renders no header
  // at all — failed as SETTINGS_SECTION_UNCONFIRMED after the full 20 s.
  const leaving = {
    pathname: "/settings/general",
    targetHref: "/settings/mcp-client",
    headerPresent: true,
  };
  assert.equal(trackTargetHeader(false, leaving), false);
});

test("a header on the page hop 3 ARRIVED at counts, and stays counted", () => {
  const arrived = {
    pathname: "/settings/model-providers",
    targetHref: "/settings/model-providers",
    headerPresent: true,
  };
  assert.equal(trackTargetHeader(false, arrived), true);
  // Sticky: a header that mounted and is mid-swap must not un-count and let the
  // headerless branch accept a page whose content is still moving.
  assert.equal(
    trackTargetHeader(true, { ...arrived, headerPresent: false }),
    true,
  );
});

test("no header present never flips the flag, whatever the pathname", () => {
  for (const pathname of ["/settings/general", "/settings/mcp-client"]) {
    assert.equal(
      trackTargetHeader(false, {
        pathname,
        targetHref: "/settings/mcp-client",
        headerPresent: false,
      }),
      false,
    );
  }
});
