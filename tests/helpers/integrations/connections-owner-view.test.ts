import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OWNER_FILTER_SINCE, ownerFilterFor } from "./connections-owner-view";

describe("ownerFilterFor (#2409)", () => {
  it("reads every 1.13.x build as the tab shape", () => {
    for (const version of ["1.13.0", "1.13.1", "1.13.2rc1", "1.13.0.dev47"]) {
      assert.equal(ownerFilterFor(version), false, version);
    }
  });

  it("reads 1.14.0.dev22, the last build with ownership tabs, as the tab shape", () => {
    assert.equal(ownerFilterFor("1.14.0.dev22"), false);
  });

  it("reads 1.14.0.dev23 onwards as the Owner select", () => {
    assert.equal(OWNER_FILTER_SINCE, "1.14.0.dev23");
    for (const version of [
      "1.14.0.dev23",
      "1.14.0.dev30",
      "1.14.0",
      "1.15.0.dev1",
    ]) {
      assert.equal(ownerFilterFor(version), true, version);
    }
  });

  it("refuses a version it cannot read instead of guessing a side", () => {
    assert.throws(() => ownerFilterFor("nightly"), /cannot be parsed/);
    assert.throws(() => ownerFilterFor(undefined), /cannot be parsed/);
  });
});
