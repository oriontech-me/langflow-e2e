// Unit tests for the token attribution sidecar (issue #1197).
// Run with: npm run test:units
//
// What rides on this helper: it is the only thing that can name WHICH spec spent
// the tokens, because a trace 404s the moment its flow is deleted (design §2, S4).
// It runs inside `cleanup()`, so its hard requirement is the inverse of a test
// helper's: it must never throw, never slow the teardown, and never be the reason a
// green test goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { recordTokenAttribution } from "./token-attribution";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "attrib-")), "token-attrib.jsonl");
}

function fakeRequest(
  traces: Record<string, unknown[]>,
  opts: { fail?: boolean } = {},
): APIRequestContext {
  return {
    get: async (url: string) => {
      if (opts.fail) throw new Error("backend wedged");
      const flowId = new URL(url, "http://x").searchParams.get("flow_id") ?? "";
      return {
        ok: () => true,
        status: () => 200,
        json: async () => ({ traces: traces[flowId] ?? [] }),
      };
    },
  } as unknown as APIRequestContext;
}

test("writes one line per trace of the flows the spec created", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1" }, { id: "t2" }] });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "agent suite",
    file: "x.spec.ts",
    out,
  });
  assert.equal(result.recorded, 2);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { trace_id: "t1", flow_id: "f1", test: "agent suite", file: "x.spec.ts" });
  assert.equal(lines[1].trace_id, "t2");
});

test("does nothing at all when the out path is unset — no request, no file", async () => {
  let called = false;
  const request = {
    get: async () => {
      called = true;
      throw new Error("should not be called");
    },
  } as unknown as APIRequestContext;
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out: undefined,
  });
  assert.deepEqual(result, { recorded: 0, skipped: [] });
  assert.equal(called, false);
});

test("a failing backend is reported on the result, never thrown", async () => {
  const out = tmpFile();
  const request = fakeRequest({}, { fail: true });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out,
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /f1/);
});

test("an unwritable out path is reported, never thrown", async () => {
  const request = fakeRequest({ f1: [{ id: "t1" }] });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out: "/proc/definitely/not/writable/x.jsonl",
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1);
});

test("a flow with no trace yet is simply not recorded — no polling", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [] });
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f", out });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 0);
});

test("appends rather than truncating, so parallel workers coexist", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1" }], f2: [{ id: "t2" }] });
  await recordTokenAttribution({ request, flowIds: ["f1"], test: "a", file: "a.spec.ts", out });
  await recordTokenAttribution({ request, flowIds: ["f2"], test: "b", file: "b.spec.ts", out });
  assert.equal(fs.readFileSync(out, "utf8").trim().split("\n").length, 2);
});
