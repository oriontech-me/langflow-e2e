import { type Locator, type Page } from "@playwright/test";

/**
 * Reaching the Settings page without discarding what the app already said
 * (#1696).
 *
 * This helper used to fire three blind clicks and verify NONE of them:
 *
 *   await page.getByTestId("user-profile-settings").click();
 *   await page.getByText(`${pageName}`).first().click();
 *   await page.getByText(`${settingsMenuName}`).first().click();
 *
 * A hop the DOM ACCEPTS while the app DISCARDS it therefore surfaced one hop
 * LATER, at a locator that never had a chance, and the run recorded
 *
 *   TimeoutError: locator.click: Timeout 20000ms exceeded.
 *   Call log:
 *     - waiting for getByText('Model Providers').first()
 *
 * — a call log that names the hop with no chance, never the hop that broke. One
 * cause was reported under four different signatures across 30 days because of
 * it. On daily 2026-09-03 (run `33756085604`) the failure-time screenshot and
 * aria snapshot are the HOME page — dropdown closed, account button carrying a
 * focus ring, the string "Settings" appearing ZERO times — while Playwright had
 * reported hops 1 and 2 as successful; daily 2026-09-01 (run `33511210195`)
 * failed on the same line, the same locator and the same budget.
 *
 * The mechanism is a re-render, and it is measured rather than assumed. In the
 * 09-03 run's own passing retry the hop-1 click took **1532 ms** of actionability
 * wait right after `page.goto("/")` against **121 ms** for the identical click
 * earlier in the same test, with `agent credential settled slowly: 6.2s` in its
 * stderr (the #751 guard); locally a `MutationObserver` on `1.13.0.dev0` shows
 * the header's DOM node being REPLACED ~616 ms after `goto("/")`, which discards
 * a Radix menu whose trigger was clicked just before it.
 *
 * Upstream Langflow reached the same conclusion from the same symptom first, and
 * that is why this is a fix rather than an invention: `release-1.9.7` still
 * carries the blind-click version byte-identically (`waitForTimeout(500)`
 * included), and upstream rewrote its own copy — `src/frontend/tests/utils/
 * go-to-settings.ts` — on 2026-08-25 in `76fb85da` ("test: stabilize release
 * Playwright navigation") onto exactly the testids used below plus a
 * `waitForURL`. Both of our remaining occurrences post-date that fix.
 *
 * Three things this adds on top of upstream's shape:
 *
 *   1. Each hop VERIFIES its own effect before the next click is made, so the
 *      failure is reported at the hop that broke.
 *   2. `settingsNavVerdict()` — pure, unit-tested — names which hop broke and
 *      what the page was showing, instead of a bare locator timeout.
 *   3. A hop whose effect does not land is re-attempted ONCE inside the same
 *      deadline, announced on stdout. That repairs a dropped click the way #1518
 *      repairs the sidebar's dropped `fill`, while keeping a SYSTEMATIC breakage
 *      visible instead of hidden behind the repair.
 *
 * The budgets are deliberately NOT raised. One hop's click and its effect wait
 * share a single `HOP_BUDGET_MS` deadline, so the worst case equals the three
 * `actionTimeout` clicks this replaces — and the unconditional
 * `waitForTimeout(500)` is gone. Upstream's own budgets (`TIMEOUTS.standard`,
 * 30 s) are NOT adopted: 30 s on the last hop would sit above the 20 s
 * `actionTimeout` it has today and hide the stall (#1648's rule).
 */

/** The handles each hop uses, all measured on `1.13.0.dev0`. */
export const SETTINGS_NAV_TESTIDS = {
  /** Hop 1's trigger — `AccountMenu/index.tsx` line 57 upstream. */
  profileTrigger: "user-profile-settings",
  /** Hop 2's menu item — `AccountMenu/index.tsx` line 98 upstream. */
  menuItem: "menu_settings_button",
  /** Hop 3's entry prefix — `sidebarComponent/index.tsx` line 53 upstream. */
  navPrefix: "sidebar-nav-",
  /** Hop 3's content confirmation, rendered per settings page. */
  menuHeader: "settings_menu_header",
} as const;

/** The URL every settings section lives under. */
const SETTINGS_URL_RE = /\/settings(?:\/|$)/;

/**
 * One hop's total budget — its click AND its effect wait share this deadline,
 * which is why replacing three `actionTimeout` clicks does not widen the worst
 * case. Matches `playwright.config.ts`'s `actionTimeout`.
 */
const HOP_BUDGET_MS = 20_000;

/** How long a single effect wait may take before the hop re-attempts. */
const MENU_SLICE_MS = 5_000;
const ROUTE_SLICE_MS = 8_000;
const ENTRY_SLICE_MS = 10_000;
const SECTION_SLICE_MS = 10_000;

/**
 * How long a section's `settings_menu_header` gets to mount before its absence
 * is read as "this section renders none". Only the elapsed grace can tell "not
 * yet" from "never", and getting that wrong in either direction is a real
 * failure: accept too early and every section greens before its page mounted;
 * require a header always and `sidebar-nav-Langflow MCP Client`, which renders
 * none at all, becomes unreachable.
 */
const HEADER_GRACE_MS = 2_000;

/** Poll interval while a hop waits for its effect. */
const POLL_MS = 200;

/** Which hop a verdict is about. */
export type SettingsNavHop = "menu" | "page" | "section";

/** What the settings navigation was showing at one instant. */
export type SettingsNavSnapshot = {
  /** `location.pathname` at the moment of the read. */
  pathname: string;
  /** A menu is on the page (`[role="menu"]`) — the Radix content mounted. */
  menuPresent: boolean;
  /** `menu_settings_button` is in the DOM. */
  menuItemPresent: boolean;
  /** Section names rendered as `sidebar-nav-<name>`, prefix stripped. */
  navEntries: string[];
  /** `settings_menu_header` is in the DOM right now. */
  headerPresent: boolean;
  /** Its trimmed text (`""` when absent). */
  headerText: string;
  /** Whether a header was present in ANY poll of this hop. */
  headerEverPresent: boolean;
  /** Whether `HEADER_GRACE_MS` has elapsed since this hop's click. */
  headerGraceElapsed: boolean;
  /** The clicked entry's OWN `href` (`""` before hop 3 resolved one). */
  targetHref: string;
};

export type SettingsNavVerdictKind =
  | "menu-unopened"
  | "page-unreached"
  | "section-absent"
  | "section-unconfirmed";

export type SettingsNavVerdict = {
  kind: SettingsNavVerdictKind;
  message: string;
};

/** Where hop 3 stands, so the accept-on-URL-alone rule is testable. */
export type SectionHopState = "settled" | "settled-headerless" | "pending";

const quote = (value: string) => `"${value}"`;

const renderedEntries = (entries: string[]) =>
  entries.length ? `[${entries.join(", ")}]` : "[] (none)";

/**
 * Decides whether hop 3 has landed. PURE.
 *
 * The target path comes from the clicked anchor's own `href`, never from a
 * name-to-path table — the anchor is the single source, so a section Langflow
 * renames cannot desync a map (the `langflowProviderName` argument,
 * #1043/#1184). The header is the CONTENT half and is optional for a measured
 * reason: of the nine sections on `1.13.0.dev0`, eight render exactly one
 * `settings_menu_header` whose text equals the sidebar title and
 * `Langflow MCP Client` renders none.
 */
export function sectionHopState(
  snapshot: SettingsNavSnapshot,
  wanted: string,
): SectionHopState {
  if (snapshot.pathname !== snapshot.targetHref) return "pending";
  if (snapshot.headerPresent) {
    return snapshot.headerText.includes(wanted) ? "settled" : "pending";
  }
  // No header on screen. A section that HAS one is mid-render, not headerless —
  // accepting there hands the caller a page whose content is still swapping.
  if (snapshot.headerEverPresent) return "pending";
  return snapshot.headerGraceElapsed ? "settled-headerless" : "pending";
}

/**
 * Whether the TARGET section has ever rendered a `settings_menu_header`. PURE.
 *
 * The scoping is load-bearing and was found by running the helper, not by
 * reading it: hop 3 starts on `/settings/general`, which HAS a header, so
 * counting any header on screen makes the flag true before the route even
 * swaps — and `sectionHopState` can then never reach `settled-headerless`.
 * `sidebar-nav-Langflow MCP Client` renders no header at all, so it failed as
 * `SETTINGS_SECTION_UNCONFIRMED` after the full 20 s. Only a header seen while
 * the pathname already matches the anchor's href belongs to the target page.
 *
 * Sticky once set: a header that mounted and is mid-swap must not un-count and
 * let the headerless branch accept a page whose content is still moving.
 */
export function trackTargetHeader(
  seenSoFar: boolean,
  snapshot: Pick<
    SettingsNavSnapshot,
    "pathname" | "targetHref" | "headerPresent"
  >,
): boolean {
  if (seenSoFar) return true;
  return snapshot.headerPresent && snapshot.pathname === snapshot.targetHref;
}

/**
 * Classifies a hop that did not land. PURE — no page, no clock — so every
 * branch is reachable from a unit test. On a live instance `menu-unopened`
 * needs a click the app drops and `page-unreached` a route change that does not
 * take, neither of which a spec may do on demand: the same argument
 * `providerRowVerdict` (#1648) settled for the provider list.
 */
export function settingsNavVerdict(
  hop: SettingsNavHop,
  snapshot: SettingsNavSnapshot,
  wanted: string,
  timeoutMs: number,
): SettingsNavVerdict {
  const budget = `${timeoutMs}ms`;
  const where = quote(snapshot.pathname);

  if (hop === "menu") {
    const opened = snapshot.menuPresent
      ? `The menu DID open — a "[role=\\"menu\\"]" is on the page — and ` +
        `"${SETTINGS_NAV_TESTIDS.menuItem}" is not in it, so this is a RENAMED ` +
        `testid rather than an app-shell stall. `
      : `No "[role=\\"menu\\"]" ever mounted, so the trigger's click was ` +
        `accepted and DISCARDED — the app-shell re-render that follows ` +
        `page.goto() drops it. `;
    return {
      kind: "menu-unopened",
      message:
        `SETTINGS_MENU_UNOPENED: "${SETTINGS_NAV_TESTIDS.profileTrigger}" was clicked ` +
        `twice and "${SETTINGS_NAV_TESTIDS.menuItem}" never became visible within ` +
        `${budget}. ${opened}The page is still on ${where}. Do not raise this timeout ` +
        `to make it pass (#1696).`,
    };
  }

  if (hop === "page" || snapshot.navEntries.length === 0) {
    const onSettings = SETTINGS_URL_RE.test(snapshot.pathname);
    const detail = onSettings
      ? `The URL IS a settings route (${where}) but the sidebar rendered zero ` +
        `"${SETTINGS_NAV_TESTIDS.navPrefix}*" entries, so the Settings shell never ` +
        `mounted — the route changed and the page did not. `
      : `The URL never became a settings route: it is ${where}, so ` +
        `"${SETTINGS_NAV_TESTIDS.menuItem}" was clicked, the menu closed, and the ` +
        `route change was DISCARDED. `;
    return {
      kind: "page-unreached",
      message:
        `SETTINGS_PAGE_UNREACHED: Settings was not reached within ${budget} while ` +
        `navigating to "${wanted}". ${detail}Keyed on the URL rather than on the ` +
        `"${SETTINGS_NAV_TESTIDS.navPrefix}" prefix alone, which the flow sidebar also ` +
        `uses. Do not raise this timeout to make it pass (#1696).`,
    };
  }

  if (!snapshot.navEntries.includes(wanted)) {
    return {
      kind: "section-absent",
      message:
        `SETTINGS_SECTION_ABSENT: the Settings sidebar SETTLED and rendered ` +
        `${snapshot.navEntries.length} section(s) ${renderedEntries(snapshot.navEntries)} ` +
        `within ${budget}, and ${quote(wanted)} is not among them. The sidebar answered, ` +
        `so this is a PRODUCT finding — the section was renamed or removed — and not a ` +
        `navigation stall.`,
    };
  }

  const arrived = snapshot.pathname === snapshot.targetHref;
  const detail = arrived
    ? `The section route took (${where}), but "${SETTINGS_NAV_TESTIDS.menuHeader}" ` +
      `reads ${quote(snapshot.headerText)} instead of ${quote(wanted)} — the route ` +
      `changed and the page mounted the wrong content. `
    : `The pathname never became the entry's own href ` +
      `${quote(snapshot.targetHref)} — it is ${where}, with ` +
      `"${SETTINGS_NAV_TESTIDS.menuHeader}" reading ${quote(snapshot.headerText)}. `;
  return {
    kind: "section-unconfirmed",
    message:
      `SETTINGS_SECTION_UNCONFIRMED: ${quote(wanted)} is in the sidebar but opening it ` +
      `was not confirmed within ${budget}. ${detail}`,
  };
}

/** Reads every part of the navigation state in one pass. */
export async function readSettingsNavState(
  page: Page,
): Promise<SettingsNavSnapshot> {
  const raw = await page.evaluate((ids) => {
    const header = document.querySelector(`[data-testid="${ids.menuHeader}"]`);
    return {
      pathname: window.location.pathname,
      menuPresent: document.querySelector('[role="menu"]') !== null,
      menuItemPresent:
        document.querySelector(`[data-testid="${ids.menuItem}"]`) !== null,
      navEntries: Array.from(
        document.querySelectorAll(`[data-testid^="${ids.navPrefix}"]`),
      )
        .map((el) => el.getAttribute("data-testid") ?? "")
        .filter((id) => id !== "")
        .map((id) => id.slice(ids.navPrefix.length)),
      headerPresent: header !== null,
      headerText: (header?.textContent ?? "").trim(),
    };
  }, SETTINGS_NAV_TESTIDS as unknown as Record<string, string>);

  return {
    ...raw,
    headerEverPresent: raw.headerPresent,
    headerGraceElapsed: false,
    targetHref: "",
  };
}

const firstLine = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0] : String(error);

const remaining = (deadline: number, cap?: number) => {
  const left = Math.max(1_000, deadline - Date.now());
  return cap === undefined ? left : Math.min(left, cap);
};

/**
 * Announced, never silent. A dropped click is worth repairing; a SYSTEMATIC
 * breakage repaired on every single navigation is a regression nobody would
 * see, which is the `mode=count` lesson.
 */
const announceReattempt = (hop: string, wanted: string, cause: string) => {
  console.log(
    `⚠️  settings navigation: ${hop} did not land on the first attempt while ` +
      `opening "${wanted}" — re-attempting once (#1696). Cause: ${cause}`,
  );
};

/**
 * Throws the verdict for a hop that did not land, falling back to the raw cause
 * if the state itself cannot be read. Losing the real failure to a secondary
 * error would replace one unattributed failure with a worse one — the guard
 * `waitForProviderRow` needed for the same reason.
 */
async function failHop(
  page: Page,
  hop: SettingsNavHop,
  wanted: string,
  lastCause: string,
  extra: Partial<SettingsNavSnapshot> = {},
): Promise<never> {
  let snapshot: SettingsNavSnapshot;
  try {
    snapshot = { ...(await readSettingsNavState(page)), ...extra };
  } catch (readError) {
    throw new Error(
      `SETTINGS_NAV_UNREADABLE: the "${hop}" hop toward "${wanted}" did not land, and ` +
        `the page state could not be read to say why (${firstLine(readError)}). The ` +
        `hop's own failure was: ${lastCause}`,
    );
  }
  const verdict = settingsNavVerdict(hop, snapshot, wanted, HOP_BUDGET_MS);
  throw new Error(`${verdict.message} Last hop failure: ${lastCause}`);
}

/** Hop 1 — open the account menu and confirm the Settings item is there. */
async function openAccountMenu(
  page: Page,
  wanted: string,
  deadline: number,
): Promise<void> {
  const item = page.getByTestId(SETTINGS_NAV_TESTIDS.menuItem);
  let lastCause = "the item never became visible";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const snapshot = await readSettingsNavState(page);
      if (!snapshot.menuItemPresent) {
        // A Radix trigger TOGGLES: re-clicking it while the content is mounted
        // would close the menu instead of opening it, so an open-but-itemless
        // menu is dismissed first.
        if (snapshot.menuPresent) {
          await page.keyboard.press("Escape").catch(() => {});
        }
        await page
          .getByTestId(SETTINGS_NAV_TESTIDS.profileTrigger)
          .click({ timeout: remaining(deadline) });
      }
      await item.waitFor({
        state: "visible",
        timeout: remaining(deadline, MENU_SLICE_MS),
      });
      return;
    } catch (error) {
      lastCause = firstLine(error);
      if (attempt === 1) {
        announceReattempt("hop 1 (open the account menu)", wanted, lastCause);
      }
    }
  }
  await failHop(page, "menu", wanted, lastCause);
}

/**
 * Hop 2 — click the Settings item and confirm the route took.
 *
 * The repair is to REOPEN the menu and click again, not to click again: a
 * dropped selection leaves the menu closed, so the item is gone. Measured —
 * a prototype that only re-clicked timed out on a locator that no longer
 * existed.
 */
async function enterSettings(
  page: Page,
  wanted: string,
  deadline: number,
): Promise<void> {
  let lastCause = "the URL never became a settings route";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt === 2) {
        await openAccountMenu(page, wanted, Date.now() + MENU_SLICE_MS);
      }
      await page
        .getByTestId(SETTINGS_NAV_TESTIDS.menuItem)
        .click({ timeout: remaining(deadline) });
      await page.waitForURL(SETTINGS_URL_RE, {
        timeout: remaining(deadline, ROUTE_SLICE_MS),
      });
      return;
    } catch (error) {
      lastCause = firstLine(error);
      if (attempt === 1) {
        announceReattempt("hop 2 (enter Settings)", wanted, lastCause);
      }
    }
  }
  await failHop(page, "page", wanted, lastCause);
}

/** Hop 3 — open one section and confirm both its route and its content. */
async function openSection(
  page: Page,
  section: string,
  deadline: number,
): Promise<void> {
  const entry = page.getByTestId(`${SETTINGS_NAV_TESTIDS.navPrefix}${section}`);
  let lastCause = "the section was never confirmed";

  await entry
    .waitFor({ state: "visible", timeout: remaining(deadline, ENTRY_SLICE_MS) })
    .catch((error) => {
      lastCause = firstLine(error);
    });

  const shell = await readSettingsNavState(page);
  if (!shell.navEntries.includes(section)) {
    await failHop(page, "section", section, lastCause, shell);
  }

  // The target path is the anchor's OWN href — never a name-to-path table.
  const targetHref = (await entry.getAttribute("href")) ?? "";
  let headerEverPresent = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const slice = Math.min(
      deadline,
      Date.now() + (attempt === 1 ? SECTION_SLICE_MS : remaining(deadline)),
    );
    try {
      await entry.click({ timeout: remaining(slice) });
    } catch (error) {
      lastCause = firstLine(error);
    }
    const clickedAt = Date.now();

    while (Date.now() < slice) {
      const raw = await readSettingsNavState(page);
      headerEverPresent = trackTargetHeader(headerEverPresent, {
        ...raw,
        targetHref,
      });
      const snapshot: SettingsNavSnapshot = {
        ...raw,
        targetHref,
        headerEverPresent,
        headerGraceElapsed: Date.now() - clickedAt >= HEADER_GRACE_MS,
      };
      const state = sectionHopState(snapshot, section);
      if (state === "settled") return;
      if (state === "settled-headerless") {
        console.log(
          `ℹ️  settings navigation: "${section}" renders no ` +
            `"${SETTINGS_NAV_TESTIDS.menuHeader}", so the hop is confirmed by its own ` +
            `href (${targetHref}) alone (#1696).`,
        );
        return;
      }
      lastCause =
        `pathname ${quote(raw.pathname)} vs href ${quote(targetHref)}, ` +
        `header ${quote(raw.headerText)}`;
      await page.waitForTimeout(POLL_MS);
    }
    if (attempt === 1) {
      announceReattempt(`hop 3 (open "${section}")`, section, lastCause);
    }
  }
  await failHop(page, "section", section, lastCause, {
    targetHref,
    headerEverPresent,
    headerGraceElapsed: true,
  });
}

/**
 * Navigates to `Settings -> <settingsMenuName>` through three VERIFIED hops.
 *
 * The signature is unchanged from the blind-click version it replaces, so all
 * of its call sites are untouched. `pageName` is kept for that reason and is
 * only tested for emptiness — the Settings route is identified by URL, not by
 * the label a menu happens to render.
 */
export const navigateSettingsPages = async (
  page: Page,
  pageName: string,
  settingsMenuName: string,
): Promise<void> => {
  if (!pageName) {
    return;
  }
  const target = settingsMenuName || pageName;
  await openAccountMenu(page, target, Date.now() + HOP_BUDGET_MS);
  await enterSettings(page, target, Date.now() + HOP_BUDGET_MS);

  if (settingsMenuName) {
    await openSection(page, settingsMenuName, Date.now() + HOP_BUDGET_MS);
  }
};

/**
 * The `sidebar-nav-<section>` locator, exported so a spec can assert on the
 * entry itself without rebuilding the prefix.
 */
export const settingsNavEntry = (page: Page, section: string): Locator =>
  page.getByTestId(`${SETTINGS_NAV_TESTIDS.navPrefix}${section}`);
