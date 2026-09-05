// Unit tests for cleanAllFlows' attribution opt-out (§2.2).
// Run with: npm run test:units
//
// Why this file exists at all, for a DEPRECATED helper with no live caller: the
// opt-out is the one place in this branch where getting it wrong writes a WRONG
// row rather than a missing one. This sweep deletes EVERY user flow on the shared
// instance, a neighbouring worker's included, so attributing them would name a
// spec that never ran them -- and a wrong number in `by_spec` carries no marker
// saying it is wrong, which is strictly worse than an absent one. The flag was
// shipped without anything pinning the CALLER passes it (`deleteFlow`'s own tests
// pin only that the flag works when passed), so a future edit could drop it here
// with every test still green.
//
// The assertions below are about an ABSENCE, which is the shape this branch keeps
// finding vacuous. Two things keep them honest: the `info` seam (without it
// `test.info()` throws under `node --test`, the sidecar makes no request no matter
// what this helper passes, and the test would hold for the wrong reason), and a
// positive control asserting the deletes DID happen -- so "no attribution request"
// can never be satisfied by "nothing ran".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { cleanAllFlows } from "./clean-all-flows";
import { resetAttributedFlows } from "./token-attribution";
import { makeTempDir } from "../../../scripts/lib/tmp-dir";

const AMBIENT = () => ({
  title: "a spec that swept the instance",
  file: "/repo/tests/tests-automations/regression/x.spec.ts",
  project: { testDir: "/repo/tests" },
});

interface FakePage {
  page: Page;
  gets: string[];
  deletes: string[];
}

/** A page whose flow list holds two flows, recording every request it serves. */
function fakePage(): FakePage {
  const gets: string[] = [];
  const deletes: string[] = [];
  const page = {
    request: {
      get: async (url: string) => {
        gets.push(url);
        if (url.includes("/auto_login")) {
          return { ok: () => true, status: () => 200, json: async () => ({ access_token: "tok" }) };
        }
        if (url.includes("/api/v1/flows/")) {
          return { ok: () => true, status: () => 200, json: async () => [{ id: "f1" }, { id: "f2" }] };
        }
        // The monitor endpoint: reached only if the opt-out stops working.
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 88 }] }) };
      },
      delete: async (url: string) => {
        deletes.push(url);
        return { ok: () => true, status: () => 200, text: async () => "" };
      },
    },
  } as unknown as Page;
  return { page, gets, deletes };
}

beforeEach(() => {
  resetAttributedFlows();
});

test("the sweep deletes every flow WITHOUT attributing any of them (§2.2)", async () => {
  const out = path.join(makeTempDir("sweep-"), "token-attrib.jsonl");
  process.env.TOKENS_ATTRIB = out;
  try {
    const { page, gets, deletes } = fakePage();

    await cleanAllFlows(page, { info: AMBIENT });

    // Positive control FIRST: without it, every assertion below is satisfied by a
    // helper that did nothing at all.
    assert.deepEqual(
      deletes,
      ["/api/v1/flows/f1", "/api/v1/flows/f2"],
      "the sweep must still delete both flows — this is what makes the absence below meaningful",
    );
    assert.deepEqual(
      gets.filter((u) => u.includes("/monitor/traces")),
      [],
      "a swept flow may belong to a neighbouring worker's test — naming it after the caller writes a WRONG by_spec row",
    );
    assert.equal(
      fs.existsSync(out),
      false,
      "no attribution means no line, so the sidecar must not have created its file either",
    );
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});
