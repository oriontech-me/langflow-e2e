import type { Page } from "@playwright/test";

/**
 * What a missing translation looks like on screen: the i18n key itself.
 *
 * The frontend configures i18next with `fallbackLng: "en"`, so a key missing
 * from one catalog renders in English. Only a key missing from EVERY catalog,
 * the English one included, renders raw — `connections.add.title` in place of a
 * label. That is the failure this detector looks for.
 *
 * Matched on the namespaces the Connections surfaces read, not on any dotted
 * word. Measured on `release-1.14.0`: the ConnectionsPage tree and the
 * connection picker call `t()` with `connections.` (194 sites), `settings.` (3),
 * `common.` (1) and `loading.` (1). A generic `word.word` pattern would also
 * match a scope short name such as `drive.file`, which the product shows on
 * purpose.
 */
export const RAW_KEY_NAMESPACES = ["connections", "settings", "common", "loading"] as const;

const RAW_KEY = new RegExp(`^(?:${RAW_KEY_NAMESPACES.join("|")})(?:\\.[A-Za-z0-9_-]+)+$`);

export function isRawKey(text: string): boolean {
  return RAW_KEY.test(text.trim());
}

/** The attributes a screen reader or a tooltip reads, besides the text itself. */
export const READ_ATTRIBUTES = ["aria-label", "placeholder", "title", "alt", "aria-description"] as const;

/**
 * Every raw key rendered inside the elements matching `root`, as text or as one
 * of `READ_ATTRIBUTES`. Hidden nodes count too: a closed menu's label is still
 * announced when it opens.
 */
export async function findRawKeys(page: Page, root: string): Promise<string[]> {
  return page.evaluate(
    ({ root, source, attributes }) => {
      const pattern = new RegExp(source);
      const hits: string[] = [];
      for (const scope of Array.from(document.querySelectorAll(root))) {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent ?? "").trim();
          if (pattern.test(text)) hits.push(`text: ${text}`);
        }
        for (const el of [scope, ...Array.from(scope.querySelectorAll("*"))]) {
          for (const attr of attributes) {
            const value = el.getAttribute(attr)?.trim();
            if (value && pattern.test(value)) hits.push(`${attr}: ${value}`);
          }
        }
      }
      return hits;
    },
    { root, source: RAW_KEY.source, attributes: [...READ_ATTRIBUTES] },
  );
}
