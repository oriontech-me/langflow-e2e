import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  SEARCH_ENTRY_TIMEOUT_MS,
  SEARCH_FILL_ATTEMPTS,
} from "../../../../helpers/flows/add-component-from-sidebar";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";
import {
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";
import {
  baselineMessage,
  baselineVerdict,
  type KnownViolation,
  scanSurface,
} from "../../../../helpers/ui/axe-baseline";
import { findRawKeys, isRawKey } from "../../../../helpers/ui/i18n-raw-keys";

// Accessibility and locale coverage of the Connections surfaces (upstream GA item
// connections-ui-a11y-i18n, surfaces B1-B5).
// Spec doc: docs/core-functionality/integrations/connections-a11y-i18n.md
//
// Siblings own the behaviour of these surfaces in English and are not repeated
// here: connections-page.spec.ts, connections-row-actions.spec.ts and
// connector-node-picker.spec.ts. This file only scans them and checks their
// language. i18n/language-selection.spec.ts and i18n/locale-resilience.spec.ts own
// the language selector and the fallback ladder.
//
// Every locator is keyed on a name this file generated: the page lists every
// connection of the shared superuser. Write budget: three seeds and three deletes
// (6 of the 30/minute per-user connection writes).
test.describe("Connections — accessibility and locale coverage", () => {
  const PAGE = "/settings/connections";
  /**
   * B1's scope: the element whose grandchild is the page header, bound to this page
   * by the connections table inside it. The Settings sidebar and the app header are
   * shared chrome and stay out.
   */
  const PAGE_BODY =
    ':has(> div > div > [data-testid="settings_menu_header"]):has([data-testid="connections-list"])';
  const ROW_MENU = '[role="menu"]';
  const ADD_DIALOG = '[role="dialog"]';
  /** The connection field of every connector node. */
  const FIELD = "connectionref_connection_ref_connection";
  const PICKER_FIELD = `[data-testid="rf__node-gmail"] [data-testid="parameter-permission-gate"]:has([data-testid="${FIELD}"])`;
  const PICKER_POPOVER = `[role="dialog"]:has([data-testid="refresh-connections-${FIELD}"])`;

  /**
   * The WCAG A/AA violations each surface ships today, verified both ways (#1084):
   * an undeclared one fails, and so does a declared one that stopped firing.
   * Measured on 1.14.0.dev32: every surface is clean, so every list is empty.
   */
  const BASELINE: Record<string, KnownViolation[]> = {
    "B1 page": [],
    "B1 row menu": [],
    "B2 Add dialog": [],
    "B2 Add dialog (Google Workspace)": [],
    "B5 connection field": [],
    "B5 picker popover": [],
  };

  /** The 8 shipped catalogs (`SUPPORTED_LANGUAGES` in src/frontend/src/i18n.ts). */
  const LOCALES = ["en", "de", "es", "fr", "ja", "ko", "pt", "zh-Hans"] as const;

  /**
   * Whether each catalog translates ANY connector component, verified both ways.
   * Measured on 1.14.0.dev32: 22 of the 86 in each of the six, none in Korean.
   * Korean is by design: upstream's `src/frontend/src/locales/KO_STYLE_GUIDE.md`
   * keeps every `display_name` in English (it translates 2 of 132 core component
   * names; its 130 are descriptions). The exact untranslated set is
   * recorded as an annotation instead, because it moves with every family upstream
   * translates.
   */
  const TRANSLATES_ANY_CONNECTOR: Record<Exclude<(typeof LOCALES)[number], "en">, boolean> = {
    de: true,
    es: true,
    fr: true,
    ja: true,
    ko: false,
    pt: true,
    "zh-Hans": true,
  };

  const connections: CreatedConnection[] = [];
  const flowIds: string[] = [];
  /**
   * The name of every flow this test asked for, so a flow whose create request timed
   * out on the client but landed on the server is still found and deleted. Measured
   * on a loaded machine: `POST /api/v1/flows/` passed the 20 s request timeout, the
   * test failed before it had an id, and the flow stayed behind.
   */
  const flowNames: string[] = [];
  const uniqueFlowName = (label: string) => {
    const name = `e2e-2304-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    flowNames.push(name);
    return name;
  };

  test.afterEach(async ({ page, request }) => {
    await unmountEditorForCleanup(page);
    const headers = { Authorization: await getAuthToken(request) };
    const failures: string[] = [];
    const names = new Set(flowNames.splice(0));
    const ids = new Set(flowIds.splice(0));
    if (names.size > ids.size) {
      const res = await request.get("/api/v1/flows/?remove_example_flows=true&header_flows=true", { headers });
      if (res.ok()) {
        for (const flow of (await res.json()) as Array<{ id: string; name: string }>) {
          if (names.has(flow.name)) ids.add(flow.id);
        }
      } else {
        failures.push(`listing flows to find one whose create timed out: ${res.status()}`);
      }
    }
    for (const id of ids) {
      await deleteFlow(request, id, { headers }).catch((error) => failures.push(`flow ${id}: ${error}`));
    }
    for (const connection of connections.splice(0)) {
      await connection.deleteConnection(request).catch((error) => failures.push(`connection ${connection.name}: ${error}`));
    }
    expect(failures, "everything this test created is deleted").toEqual([]);
  });

  async function seed(request: APIRequestContext, label: string): Promise<CreatedConnection> {
    const headers = { Authorization: await getAuthToken(request) };
    const connection = await createConnectionViaApi(request, headers, { label });
    connections.push(connection);
    return connection;
  }

  async function expectBaseline(page: Page, surface: string, include: string): Promise<void> {
    const scan = await scanSurface(page, include);
    expect(scan.rulesApplied, `${surface}: the scan applied no rule, so its scope matched nothing`).toBeGreaterThan(0);
    if (scan.needsReview.length > 0) {
      // Undecided results are recorded, never judged: the baseline covers definite
      // violations only (measured: color-contrast on 1 node in B1, 2 in the dialog, 1 in B5).
      test.info().annotations.push({
        type: "axe-needs-review",
        description: `${surface}: ${scan.needsReview.map((r) => `${r.rule} (${r.targets.length})`).join(", ")}`,
      });
    }
    expect(baselineMessage(surface, baselineVerdict(scan.violations, BASELINE[surface])), surface).toBe("");
  }

  /**
   * The locale test boots the app eight times, so a slow boot hits it eight times
   * as often as a sibling. Measured at a host load average of ~30 on 10 cores: the
   * page was still on its *Loading…* splash 30 s after `goto`.
   */
  const PAGE_BOOT_TIMEOUT_MS = 60_000;

  async function openPage(page: Page, name: string): Promise<void> {
    await page.goto(PAGE);
    await expect(page.getByTestId(`connection-row-${name}`), `the seeded row ${name}`).toBeVisible({
      timeout: PAGE_BOOT_TIMEOUT_MS,
    });
  }

  /**
   * The menu and the dialog open client-side, yet on a loaded machine (four workers,
   * a second Langflow and an unrelated container sharing the VM, every test 3-4x its
   * usual time) a click on the row's menu button was accepted and the menu never
   * opened: the trace shows the row on screen, the click resolved, and no
   * `role=menu` for the next 15 s. Why the click was lost was not isolated. The click
   * is repeated until the surface opens, and never while it is already open, so a
   * late-opening menu is not toggled shut. Whether the menu opens is
   * connections-row-actions.spec.ts's subject, not this file's.
   */
  const OPEN_TIMEOUT_MS = 30_000;

  async function openWithClick(page: Page, trigger: string, opened: string): Promise<void> {
    await expect(async () => {
      if (!(await page.locator(opened).isVisible())) await page.getByTestId(trigger).click();
      await expect(page.locator(opened)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: OPEN_TIMEOUT_MS });
  }

  async function openRowMenu(page: Page, name: string): Promise<void> {
    await openWithClick(page, `connection-menu-${name}`, ROW_MENU);
  }

  async function openAddDialog(page: Page): Promise<void> {
    await openWithClick(page, "add-connection", '[data-testid="connection-provider"]');
  }

  async function closeWithEscape(page: Page, selector: string): Promise<void> {
    await page.keyboard.press("Escape");
    await expect(page.locator(selector)).toHaveCount(0);
  }

  test(
    "the Connections page, its row menu and the Add dialog carry no WCAG A/AA violation beyond the declared baseline",
    { tag: ["@stable", "@ui-ux", "@integrations"] },
    async ({ page, request }) => {
      const connection = await seed(request, "a11ypage");

      await test.step("B1: the page body, with the seeded row", async () => {
        await openPage(page, connection.name);
        await expectBaseline(page, "B1 page", PAGE_BODY);
      });

      await test.step("B1: the seeded row's menu", async () => {
        await openRowMenu(page, connection.name);
        await expectBaseline(page, "B1 row menu", ROW_MENU);
        await closeWithEscape(page, ROW_MENU);
      });

      await test.step("B2: the Add dialog, with the default provider and then with Google Workspace", async () => {
        await openAddDialog(page);
        await expectBaseline(page, "B2 Add dialog", ADD_DIALOG);
        await page.getByTestId("connection-provider").click();
        await page.getByRole("option", { name: "Google Workspace" }).click();
        await expect(page.getByTestId("connection-provider")).toContainText("Google Workspace");
        await expectBaseline(page, "B2 Add dialog (Google Workspace)", ADD_DIALOG);
        await closeWithEscape(page, ADD_DIALOG);
      });
    },
  );

  test(
    "the node-level connection picker carries no WCAG A/AA violation beyond the declared baseline",
    { tag: ["@stable", "@ui-ux", "@integrations"] },
    async ({ page, request }) => {
      const connection = await seed(request, "a11ypicker");
      const handle = `google/${connection.name}`;
      const headers = { Authorization: await getAuthToken(request) };

      await test.step("a flow with one Gmail: Send Email node, bound to the seeded connection", async () => {
        const catalog = await fetchComponentCatalog(request, headers);
        const key = Object.values(catalog)
          .flatMap((entries) => (entries && typeof entries === "object" ? Object.keys(entries) : []))
          .find((k) => /^ext:google:GmailSendComponent@/.test(k));
        expect(key, "GmailSendComponent is in GET /api/v1/all").toBeTruthy();
        const flowId = await createCatalogFlow(
          request,
          catalog,
          { nodes: [{ id: "gmail", type: key!, values: { connection: handle } }], edges: [] },
          { name: uniqueFlowName("picker"), headers },
        );
        flowIds.push(flowId);
        await openFlowById(page, flowId);
        await expect(page.getByTestId("rf__node-gmail").getByTestId(`value-connection-${FIELD}`)).toHaveText(handle);
      });

      await test.step("B5: the connection field", async () => {
        await expectBaseline(page, "B5 connection field", PICKER_FIELD);
      });

      await test.step("B5: the open picker, listing the seeded connection", async () => {
        const node = page.getByTestId("rf__node-gmail");
        await node.getByTestId(FIELD).click();
        await expect(node.getByTestId(`connection-option-${handle}`)).toBeVisible({ timeout: 30000 });
        await expectBaseline(page, "B5 picker popover", PICKER_POPOVER);
        await closeWithEscape(page, PICKER_POPOVER);
      });
    },
  );

  test(
    "every shipped catalog renders the Connections page, its row menu and the Add dialog in its language, with no raw key",
    { tag: ["@stable", "@ui-ux", "@integrations"] },
    async ({ page, request }) => {
      test.setTimeout(240_000);
      const connection = await seed(request, "i18npage");
      let englishHeading = "";

      for (const locale of LOCALES) {
        await test.step(`${locale}: the language switches, and no raw key renders`, async () => {
          // The catalog chunk is `/assets/<code>-<hash>.js`, but icon chunks can share
          // the prefix (`pt-euro-<hash>.js` is served too), so a chunk counts only
          // when its body carries a Connections key.
          const prefix = new RegExp(`/assets/${locale.replace("-", "\\-")}-[A-Za-z0-9_-]+\\.js$`);
          const bodies: Array<Promise<string>> = [];
          const onResponse = (response: { url(): string; text(): Promise<string> }) => {
            if (prefix.test(new URL(response.url()).pathname)) bodies.push(response.text().catch(() => ""));
          };
          page.on("response", onResponse);
          try {
            // English comes first and needs no preference: a fresh context has none,
            // which is what makes the first load English. Every other locale is
            // written on the page's own origin and then loaded, because the
            // preference is read once, at module load.
            if (locale !== "en") {
              await page.evaluate((code) => localStorage.setItem("languagePreference", code), locale);
            }
            await openPage(page, connection.name);
            await expect(page.locator("html")).toHaveAttribute("lang", locale);
            const heading = page.getByTestId("settings_menu_header");
            await expect(heading).toBeVisible();
            if (locale === "en") {
              englishHeading = (await heading.textContent())?.trim() ?? "";
              expect(englishHeading).toBe("Connections");
            } else {
              await expect(heading, `${locale}: the heading left English`).not.toHaveText(englishHeading);
              const fetched = (await Promise.all(bodies)).some((body) => body.includes('"connections.title":'));
              expect(fetched, `${locale}: its catalog chunk was fetched`).toBe(true);
            }

            expect(await findRawKeys(page, PAGE_BODY), `${locale}: raw keys on the page`).toEqual([]);
            await openRowMenu(page, connection.name);
            expect(await findRawKeys(page, ROW_MENU), `${locale}: raw keys in the row menu`).toEqual([]);
            await closeWithEscape(page, ROW_MENU);
            await openAddDialog(page);
            expect(await findRawKeys(page, ADD_DIALOG), `${locale}: raw keys in the Add dialog`).toEqual([]);
            await closeWithEscape(page, ADD_DIALOG);
          } finally {
            page.off("response", onResponse);
          }
        });
      }
      await page.evaluate(() => localStorage.removeItem("languagePreference"));
    },
  );

  test(
    "connector components carry each catalog's own name, and which catalogs translate any of them holds",
    { tag: ["@stable", "@ui-ux", "@integrations"] },
    async ({ page, request }) => {
      const headers = { Authorization: await getAuthToken(request) };
      const names: Record<string, Map<string, string>> = {};

      await test.step("every catalog names every manifest connector, and none renders a raw key", async () => {
        const manifest = await request.get("/api/v1/integrations", { headers });
        expect(manifest.status(), await manifest.text()).toBe(200);
        const { providers } = (await manifest.json()) as {
          providers: Array<{ capabilities: Array<{ component_ref: string }> }>;
        };
        const refs = [...new Set(providers.flatMap((p) => p.capabilities.map((c) => c.component_ref)))];
        expect(refs.length, "the manifest names connector components").toBeGreaterThan(0);

        for (const locale of LOCALES) {
          // The full catalog, ~4 MB decompressed, eight times in a row: measured past the 20 s
          // request default on a loaded machine, so it gets a minute.
          const res = await request.get("/api/v1/all", {
            headers: { ...headers, "Accept-Language": locale },
            timeout: 60_000,
          });
          expect(res.status(), `${locale}: GET /api/v1/all`).toBe(200);
          const byRef = new Map<string, string>();
          for (const [category, entries] of Object.entries((await res.json()) as Record<string, unknown>)) {
            if (category === "component_display_names" || !entries || typeof entries !== "object") continue;
            for (const [key, entry] of Object.entries(entries as Record<string, { display_name?: unknown }>)) {
              const ref = key.match(/^ext:[^:]+:([^@]+)@/)?.[1] ?? key;
              byRef.set(ref, String(entry?.display_name ?? ""));
            }
          }
          const missing = refs.filter((ref) => !byRef.has(ref));
          expect(missing, `${locale}: manifest connectors absent from the catalog`).toEqual([]);
          const bad = refs.filter((ref) => !byRef.get(ref)?.trim() || isRawKey(byRef.get(ref)!));
          expect(bad, `${locale}: connectors with an empty or raw-key name`).toEqual([]);
          names[locale] = new Map(refs.map((ref) => [ref, byRef.get(ref)!]));
        }
      });

      await test.step("whether each catalog translates any connector holds, and the untranslated set is recorded", async () => {
        const english = names.en;
        for (const locale of Object.keys(TRANSLATES_ANY_CONNECTOR) as Array<keyof typeof TRANSLATES_ANY_CONNECTOR>) {
          const untranslated = [...english.keys()].filter((ref) => names[locale].get(ref) === english.get(ref));
          test.info().annotations.push({
            type: "untranslated-connectors",
            description: `${locale}: ${untranslated.length} of ${english.size} — ${untranslated.join(", ")}`,
          });
          expect(
            untranslated.length < english.size,
            `${locale} translates ${english.size - untranslated.length} of ${english.size} connector names; ` +
              `the declaration says it translates ${TRANSLATES_ANY_CONNECTOR[locale] ? "some" : "none"} — ` +
              `update TRANSLATES_ANY_CONNECTOR and the spec doc's table`,
          ).toBe(TRANSLATES_ANY_CONNECTOR[locale]);
        }
      });

      await test.step("under pt, the sidebar shows the catalog's pt name for Gmail: Send Email", async () => {
        const english = names.en.get("GmailSendComponent")!;
        const portuguese = names.pt.get("GmailSendComponent")!;
        expect(portuguese, "the pt catalog translates Gmail: Send Email").not.toBe(english);

        const catalogLanguages: string[] = [];
        page.on("request", (req) => {
          if (new URL(req.url()).pathname === "/api/v1/all") {
            catalogLanguages.push(req.headers()["accept-language"] ?? "<none>");
          }
        });
        await page.addInitScript(() => localStorage.setItem("languagePreference", "pt"));
        const flowId = await createFlow(
          request,
          {
            name: uniqueFlowName("sidebar"),
            data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
            is_component: false,
          },
          { headers },
        );
        flowIds.push(flowId);
        await openFlowById(page, flowId);
        await expect(page.locator("html")).toHaveAttribute("lang", "pt");

        const entry = page.getByTestId(`add-component-button-${portuguese.toLowerCase().replace(/ /g, "-")}`);
        const search = page.getByTestId("sidebar-search-input");
        // The fill can race the flow page mount, which clears the input (#1518), so
        // it is typed again while the entry has not appeared.
        for (let attempt = 1; attempt <= SEARCH_FILL_ATTEMPTS; attempt++) {
          await search.fill("gmail");
          const landed = await entry
            .waitFor({ state: "visible", timeout: SEARCH_ENTRY_TIMEOUT_MS })
            .then(() => true)
            .catch(() => false);
          if (landed) break;
        }
        await expect(entry, `the sidebar lists "${portuguese}"`).toBeVisible({ timeout: SEARCH_ENTRY_TIMEOUT_MS });
        expect(catalogLanguages, "the catalog request carried the interface language").toContain("pt");
        expect(catalogLanguages).not.toContain("en");
      });
    },
  );
});
