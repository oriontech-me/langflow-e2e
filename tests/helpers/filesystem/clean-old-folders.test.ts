// Unit tests for cleanOldFolders (#1363).
// Run with: npm run test:units
//
// This helper is cleanup, so nothing asserts on it — which is exactly how it
// stopped working without anyone noticing. It drove the sidebar kebab through
// the project's NAME, upstream re-keyed that testid on the project id in
// `23f91d8587`, and from then on the helper deleted nothing and merely timed out
// on a click. The daily's own retries recorded the consequence — `New Project`
// through `New Project (5)` accumulating across six attempts of one test — and
// the run stayed green on that helper, because a cleanup that deletes nothing
// looks identical to a cleanup with nothing to do.
//
// Hence a unit test rather than a one-off measurement: the properties below are
// the ones a reader cannot confirm from a passing spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { cleanOldFolders } from "./clean-old-folders";

interface Call {
  method: string;
  url: string;
}

/**
 * A fake `page.request` over a project list. Deletions mutate the list, so a
 * test asserts on the END STATE of the account, not only on the calls made —
 * the distinction that separates "it issued a DELETE" from "the folder is gone".
 */
function fakePage(
  opts: {
    projects?: Array<{ id: string; name: string }>;
    listStatus?: number;
    listBodyIsWrapped?: boolean;
    deleteStatus?: number;
  } = {},
) {
  const {
    projects = [],
    listStatus = 200,
    listBodyIsWrapped = false,
    deleteStatus = 204,
  } = opts;

  const calls: Call[] = [];
  const live = [...projects];

  const res = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const request = {
    get: async (url: string) => {
      calls.push({ method: "GET", url });
      return res(listStatus, listBodyIsWrapped ? { folders: live } : live);
    },
    delete: async (url: string) => {
      calls.push({ method: "DELETE", url });
      if (deleteStatus < 300 || deleteStatus === 404) {
        const id = url.split("/").pop()!;
        const i = live.findIndex((p) => p.id === id);
        if (i >= 0) live.splice(i, 1);
      }
      return res(deleteStatus, {});
    },
  };

  return {
    page: { request } as unknown as Page,
    calls,
    liveProjects: () => live,
  };
}

test("deletes every leftover New Project* and leaves everything else alone", async () => {
  const fake = fakePage({
    projects: [
      { id: "p1", name: "New Project" },
      { id: "p2", name: "New Project (1)" },
      { id: "p3", name: "New Project (5)" },
      { id: "keep1", name: "Starter Project" },
      { id: "keep2", name: "bulk-actions-folder-1754" },
    ],
  });

  await cleanOldFolders(fake.page);

  assert.deepEqual(
    fake.liveProjects().map((p) => p.id),
    ["keep1", "keep2"],
    "the three New Project* leftovers must be gone, the other two untouched",
  );
});

test("deletes by ID, never through the sidebar", async () => {
  // The regression this file exists for: the helper used to hover the entry and
  // click `more-options-button_<slugified name>`. Cleanup runs before the test
  // it precedes has asserted anything, so it must not depend on the UI state
  // that test is about to read.
  const fake = fakePage({ projects: [{ id: "p1", name: "New Project" }] });

  await cleanOldFolders(fake.page);

  assert.deepEqual(
    fake.calls.filter((c) => c.method === "DELETE").map((c) => c.url),
    ["/api/v1/projects/p1"],
  );
});

test("reads the wrapped { folders: [...] } response shape too", async () => {
  // `/api/v1/projects/` answers a bare array on some builds and `{ folders }` on
  // others; reading only one shape makes the sweep silently a no-op on the other.
  const fake = fakePage({
    projects: [{ id: "p1", name: "New Project" }],
    listBodyIsWrapped: true,
  });

  await cleanOldFolders(fake.page);

  assert.equal(fake.liveProjects().length, 0);
});

test("a failed list is reported and does not throw", async () => {
  // Cleanup must never fail the test whose assertions have not run yet.
  const fake = fakePage({ projects: [{ id: "p1", name: "New Project" }], listStatus: 500 });

  await cleanOldFolders(fake.page);

  assert.equal(
    fake.calls.filter((c) => c.method === "DELETE").length,
    0,
    "nothing can be deleted from a list that never arrived",
  );
});

test("a project that survives every retry does not abort the sweep", async () => {
  // `deleteProject` retries the #965 contention 500 and then throws. One
  // undeletable leftover must not stop the others from being cleared.
  const fake = fakePage({
    projects: [
      { id: "p1", name: "New Project" },
      { id: "p2", name: "New Project (1)" },
    ],
    deleteStatus: 500,
  });

  await cleanOldFolders(fake.page);

  assert.deepEqual(
    fake.calls.filter((c) => c.method === "DELETE").map((c) => c.url),
    [
      // 3 attempts each, per deleteProject's retry contract — both projects tried.
      "/api/v1/projects/p1",
      "/api/v1/projects/p1",
      "/api/v1/projects/p1",
      "/api/v1/projects/p2",
      "/api/v1/projects/p2",
      "/api/v1/projects/p2",
    ],
  );
});

test("a name that merely CONTAINS 'New Project' is not swept", async () => {
  // The sweep owns the button's default name, not every project mentioning it —
  // a spec's own `keep-New Project-fixture` must survive its neighbours' cleanup.
  const fake = fakePage({
    projects: [{ id: "p1", name: "keep-New Project-fixture" }],
  });

  await cleanOldFolders(fake.page);

  assert.equal(fake.liveProjects().length, 1);
});
