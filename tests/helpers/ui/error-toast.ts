import { type Locator, type Page } from "@playwright/test";

// Single anchor for the error toast rendered by `ErrorAlert`
// (src/frontend/src/alerts/error/index.tsx). The upstream component exposes no
// `data-testid`, so the `.error-build-message` CSS class is the only stable
// hook. Centralizing it here means an upstream CSS rename — or the arrival of a
// `data-testid` (issue #224) — is a one-line change instead of a sweep across
// every spec that waits on an error toast.
export function errorToastLocator(page: Page): Locator {
  return page.locator(".error-build-message");
}
