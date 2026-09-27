// Unit tests for the folder-connector helpers (issue #2043).
// Run with: npm run test:units
//
// Why the allow-list is READ from the server instead of configured on the test side:
// the `folder` connector refuses to walk outside `LANGFLOW_KB_ALLOWED_FOLDER_ROOTS`,
// and the folder a spec can write into is the instance's config directory — which is
// `~/.cache/langflow` in the nightly image, `${STATE_DIR}/data` on the source starter
// (one per shard port on the VM lane) and `~/Library/Caches/langflow` on a macOS pip
// install. A test-side variable would have to be kept in step with each of those; the
// server's own 400 names the roots it enforces, resolved, on every one of them.
//
// Measured on 1.13.0.dev22: with the variable unset the connector answers
//   400 "FolderSource refuses to walk without an allow-list. Configure LANGFLOW_KB_ALLOWED_FOLDER_ROOTS."
// and with it set, a directory outside it answers
//   400 "Folder / is outside the configured allow-list (/app/data/.cache/langflow)."
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  folderUnderRoot,
  ingestFlowFolder,
  parseFolderAllowList,
  resolveAllowListRoots,
} from "./folder-source";

test("an unset allow-list is recognised, so the spec can name the variable", () => {
  assert.deepEqual(
    parseFolderAllowList(
      "FolderSource refuses to walk without an allow-list. Configure LANGFLOW_KB_ALLOWED_FOLDER_ROOTS.",
    ),
    { kind: "unset" },
  );
});

test("a single configured root is read out of the containment refusal", () => {
  assert.deepEqual(
    parseFolderAllowList(
      "Folder / is outside the configured allow-list (/app/data/.cache/langflow).",
    ),
    { kind: "roots", roots: ["/app/data/.cache/langflow"] },
  );
});

test("several roots are split on the server's own ', ' join", () => {
  assert.deepEqual(
    parseFolderAllowList(
      "Folder / is outside the configured allow-list (/home/u/.cache/langflow, /home/u/Library/Caches/langflow).",
    ),
    {
      kind: "roots",
      roots: ["/home/u/.cache/langflow", "/home/u/Library/Caches/langflow"],
    },
  );
});

test("a root that itself contains a parenthesis is not cut short", () => {
  assert.deepEqual(
    parseFolderAllowList(
      "Folder / is outside the configured allow-list (/srv/data (shared)).",
    ),
    { kind: "roots", roots: ["/srv/data (shared)"] },
  );
});

test("any other answer is unknown, never an empty allow-list", () => {
  for (const detail of [
    "Folder / does not exist.",
    "Path / is not a directory.",
    "",
    undefined,
    null,
    42,
    { detail: "nested" },
  ]) {
    const verdict = parseFolderAllowList(detail);
    assert.equal(verdict.kind, "unknown", `detail ${JSON.stringify(detail)}`);
  }
});

test("the unknown verdict carries what the server said, so a failure can quote it", () => {
  const verdict = parseFolderAllowList("Folder / does not exist.");
  assert.deepEqual(verdict, { kind: "unknown", detail: "Folder / does not exist." });
});

test("the flow folder is joined under a root without doubling the slash", () => {
  assert.equal(folderUnderRoot("/app/data/.cache/langflow", "abc"), "/app/data/.cache/langflow/abc");
  assert.equal(folderUnderRoot("/app/data/.cache/langflow/", "abc"), "/app/data/.cache/langflow/abc");
});

// resolveAllowListRoots / ingestFlowFolder take the HTTP calls as functions, so the
// branches that decide between "fail naming the variable", "try the next root" and
// "this is the run" are pinned without an instance.

test("an unset allow-list fails naming the variable and the start scripts", async () => {
  await assert.rejects(
    resolveAllowListRoots(async () => ({
      status: 400,
      detail:
        "FolderSource refuses to walk without an allow-list. Configure LANGFLOW_KB_ALLOWED_FOLDER_ROOTS.",
    })),
    /LANGFLOW_KB_ALLOWED_FOLDER_ROOTS[\s\S]*start-langflow/,
  );
});

test("a probe the server ACCEPTED fails, because the allow-list then admits '/'", async () => {
  await assert.rejects(
    resolveAllowListRoots(async () => ({ status: 200, detail: undefined })),
    /admits/,
  );
});

test("an unrecognised refusal fails quoting it, instead of guessing a root", async () => {
  await assert.rejects(
    resolveAllowListRoots(async () => ({ status: 400, detail: "something new" })),
    /something new/,
  );
});

test("the roots the server named are returned as it named them", async () => {
  assert.deepEqual(
    await resolveAllowListRoots(async () => ({
      status: 400,
      detail: "Folder / is outside the configured allow-list (/a, /b).",
    })),
    ["/a", "/b"],
  );
});

test("the flow folder is looked for under each root in turn until one is accepted", async () => {
  const tried: string[] = [];
  const result = await ingestFlowFolder(["/a", "/b"], "flow1", async (path) => {
    tried.push(path);
    return path === "/b/flow1"
      ? { status: 200, detail: undefined, runId: "run-1" }
      : { status: 400, detail: `Folder ${path} does not exist.` };
  });
  assert.deepEqual(tried, ["/a/flow1", "/b/flow1"]);
  assert.deepEqual(result, { folder: "/b/flow1", runId: "run-1" });
});

test("a root that holds no folder for the flow fails naming the roots it tried", async () => {
  await assert.rejects(
    ingestFlowFolder(["/a"], "flow1", async (path) => ({
      status: 400,
      detail: `Folder ${path} does not exist.`,
    })),
    /\/a\/flow1[\s\S]*config directory/,
  );
});

test("any refusal other than 'does not exist' stops the search and is quoted", async () => {
  const tried: string[] = [];
  await assert.rejects(
    ingestFlowFolder(["/a", "/b"], "flow1", async (path) => {
      tried.push(path);
      return { status: 409, detail: "already queued" };
    }),
    /409[\s\S]*already queued/,
  );
  assert.deepEqual(tried, ["/a/flow1"]);
});

test("a 200 without a run id is a malformed success, not a run", async () => {
  await assert.rejects(
    ingestFlowFolder(["/a"], "flow1", async () => ({ status: 200, detail: undefined })),
    /no run id/,
  );
});
