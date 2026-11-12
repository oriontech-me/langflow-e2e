// Unit tests for the MCP project-resource visibility switch (issue #2426).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectResourcesFollowMcpVisibility } from "./mcp-resource-visibility";

test("builds that carry langflow-ai/langflow#16127 hide the files of unexposed flows", () => {
  for (const version of [
    "1.13.2rc0",
    "1.13.2rc1",
    "1.13.2",
    "1.13.3",
    "1.14.0.dev23",
    "1.14.0.dev25",
    "1.14.0rc1",
    "1.14.0",
    "1.15.0.dev0",
  ]) {
    assert.equal(projectResourcesFollowMcpVisibility(version), true, version);
  }
});

// dev22 is the last 1.14 nightly whose tag does not contain the fix; on the 1.13
// line nothing below the first published 1.13.2 build is known to carry it.
test("builds before it list every flow's files, the 1.14 nightlies up to dev22 included", () => {
  for (const version of [
    "1.12.10",
    "1.13.1",
    "1.13.1rc2",
    "1.13.2.dev0",
    "1.13.2b1",
    "1.14.0.dev0",
    "1.14.0.dev16",
    "1.14.0.dev22",
  ]) {
    assert.equal(projectResourcesFollowMcpVisibility(version), false, version);
  }
});

test("an unreadable version throws instead of picking a side", () => {
  for (const raw of [undefined, null, "", "latest"]) {
    assert.throws(
      () => projectResourcesFollowMcpVisibility(raw),
      /cannot be parsed/,
      JSON.stringify(raw),
    );
  }
});
