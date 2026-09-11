// Unit tests for the account axis (#1800).
//
// Run: npm run test:scripts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  foldUsability,
  readUsability,
  readUsabilityDir,
  usabilityState,
} from "./provider-usability.mjs";

/** The shape `collect-models` writes, trimmed to the two fields this reads. */
const record = (provider, status, error = null) => ({
  provider,
  model: status === "active" ? "some-model" : null,
  status,
  error,
});

test("a provider recorded active makes the account alive", () => {
  const usability = foldUsability([
    [record("openai", "active"), record("google", "inactive", "spending cap")],
  ]);
  assert.deepEqual(usability, { known: true, active: ["openai"] });
  assert.equal(usabilityState(usability), "alive");
});

test("every provider inactive is a DRY account, not an unknown one", () => {
  // The distinction decides whether a lane fails: dry means a re-run cannot help.
  const usability = foldUsability([
    [record("openai", "inactive", "no credits"), record("google", "inactive", "cap")],
  ]);
  assert.deepEqual(usability, { known: true, active: [] });
  assert.equal(usabilityState(usability), "dry");
});

// The daily collects health per SHARD, and the four sweeps can legitimately disagree
// when a key recovers mid-run. One shard reaching a provider proves the ACCOUNT could,
// so the fold is a union — the intersection would let one shard's transient failure
// report the account as dead and fail a run the other three covered.
test("the shards union, they do not intersect", () => {
  const shard1 = [record("openai", "inactive", "no credits"), record("google", "active")];
  const shard2 = [record("openai", "active"), record("google", "inactive", "cap")];

  assert.deepEqual(foldUsability([shard1, shard2]), {
    known: true,
    active: ["google", "openai"],
  });
  assert.deepEqual(foldUsability([shard1]), { known: true, active: ["google"] });
});

test("no readable file is UNKNOWN, never dry", () => {
  // `providers.json` is gitignored and only exists after `collect-models`, which is
  // legitimately skipped and legitimately allowed to fail. Reading absence as "dry"
  // would fail a lane over a file that was never meant to be there.
  assert.deepEqual(foldUsability([]), { known: false, active: [] });
  assert.equal(usabilityState(foldUsability([])), "unknown");
  assert.equal(usabilityState({ known: false, active: [] }), "unknown");
  assert.equal(usabilityState(undefined), "unknown");
});

test("a shape it does not recognise degrades to UNKNOWN instead of to `dry`", () => {
  // This consumes a file written by another process on another machine, inside a
  // reporting step that must not be the thing that reddens a run. "Does not throw" was
  // the whole guarantee in the first round, and it is not enough: `known: true` came
  // from `payload.length > 0` alone, so a producer that renamed `status` handed over
  // two HEALTHY providers, matched no record, folded to `active: []` and read as
  // `dry` — which FAILS a lane and sends triage at the keys. The two producers
  // (`collect-models.ts`, `provider-health.ts`) keep this record in sync BY HAND.
  assert.deepEqual(foldUsability([null, "nope", 42, {}]), { known: false, active: [] });
  assert.deepEqual(
    foldUsability([
      [
        { provider: "openai", model: "gpt", state: "active" },
        { provider: "google", model: "g", state: "active" },
      ],
    ]),
    { known: false, active: [] },
    "a renamed status field must not read as an account with nothing usable",
  );
  // Half-formed records inside an otherwise recognisable file are simply ignored.
  assert.deepEqual(foldUsability([[null, "x", { status: "active" }, { provider: "  " }]]), {
    known: false,
    active: [],
  });
  assert.deepEqual(
    foldUsability([[{ status: "active" }, { provider: "openai", status: "active" }]]),
    { known: true, active: ["openai"] },
  );
  // `inactive` is recognisable too — that is what makes a genuinely dry account
  // distinguishable from a file this reader cannot interpret.
  assert.deepEqual(foldUsability([[{ provider: "openai", status: "inactive" }]]), {
    known: true,
    active: [],
  });
  // An empty array carries no information — see the dedicated test below.
  assert.deepEqual(foldUsability([[]]), { known: false, active: [] });
});

test("a parsed-but-unrecognised file is reported apart from an unread one", () => {
  const files = {
    "drift.json": JSON.stringify([{ provider: "openai", state: "active" }]),
    "empty.json": "[]",
    "ok.json": JSON.stringify([record("google", "active")]),
  };
  const usability = readUsability(["drift.json", "empty.json", "ok.json", "gone.json"], {
    readFile: (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
  });
  // Kept apart because the two send a reader somewhere else entirely: one file is not
  // there, the other IS and its producer's shape moved (#1012).
  assert.deepEqual(usability.unread, ["gone.json"]);
  assert.deepEqual(usability.unrecognised, ["drift.json"]);
  // An EMPTY array is not drift — the sweep legitimately recorded nothing.
  assert.deepEqual(usability.active, ["google"]);
  assert.equal(usability.read, 1, "only files that informed the fold are counted");
});

test("readUsability names what it could not read instead of dropping it", () => {
  const files = {
    "ok.json": JSON.stringify([record("openai", "active")]),
    "bad.json": "{",
    "object.json": JSON.stringify({ openai: "active" }),
  };
  const readFile = (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };

  const usability = readUsability(
    ["ok.json", "bad.json", "object.json", "gone.json"],
    { readFile },
  );
  assert.deepEqual(usability.active, ["openai"]);
  assert.equal(usability.known, true);
  // Unparseable, wrong-shaped and absent are all reported — a silently dropped file
  // is what would decide a verdict without saying so (#1012).
  assert.deepEqual(usability.unread, ["bad.json", "object.json", "gone.json"]);
});

test("readUsability with no paths is unknown and reports nothing unread", () => {
  const usability = readUsability([], { readFile: () => "[]" });
  assert.deepEqual(usability, {
    known: false,
    active: [],
    unread: [],
    unrecognised: [],
    read: 0,
  });
});

// --- reading a directory of shard files (#1800 review) ----------------------
// The daily's merge job hands over a DIRECTORY rather than an argument list built in
// YAML: a mutation that found the four files, counted them and then never passed them
// survived every guard available there, because the only one possible is a regex over
// the step text and its tokens all still matched (#1226). These are the assertions
// that mutation now has to get past.

test("readUsabilityDir unions every providers-*.json it finds", () => {
  const files = {
    "d/providers-1.json": JSON.stringify([record("openai", "inactive", "no credits")]),
    "d/providers-2.json": JSON.stringify([record("openai", "active")]),
    "d/providers-3.json": JSON.stringify([record("google", "active")]),
  };
  const io = {
    readdir: () => [
      "providers-3.json",
      "providers-1.json",
      "providers-2.json",
      // Everything else on the tokens artifact must be ignored.
      "token-provider-1.txt",
      "token-probes-1.jsonl",
      "providers.json.bak",
    ],
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };

  const usability = readUsabilityDir("d", io);
  assert.deepEqual(usability.active, ["google", "openai"]);
  assert.equal(usability.known, true);
  assert.equal(usability.read, 3, "only the providers-*.json files are read");
  assert.deepEqual(usability.unread, []);
});

test("one shard of four is enough, and the rest are reported unread", () => {
  const io = {
    readdir: () => ["providers-1.json", "providers-2.json"],
    readFile: (p) =>
      p.endsWith("providers-1.json")
        ? JSON.stringify([record("openai", "active")])
        : "{ truncated",
  };
  const usability = readUsabilityDir("d", io);
  assert.deepEqual(usability.active, ["openai"]);
  assert.equal(usability.read, 1);
  assert.deepEqual(usability.unread, ["d/providers-2.json"]);
});

test("an empty or absent directory is UNKNOWN, not dry", () => {
  // The artifact download is `continue-on-error`, so no directory is a real outcome —
  // and reading it as `dry` would fail the daily over a missing optional input.
  assert.deepEqual(readUsabilityDir("d", { readdir: () => [] }), {
    known: false,
    active: [],
    unread: [],
    unrecognised: [],
    read: 0,
  });
  assert.deepEqual(
    readUsabilityDir("gone", {
      readdir: () => {
        throw new Error("ENOENT");
      },
    }),
    { known: false, active: [], unread: [], unrecognised: [], read: 0 },
  );
});

test("a trailing slash on the directory does not double up in the paths", () => {
  const seen = [];
  readUsabilityDir("d/", {
    readdir: () => ["providers-1.json"],
    readFile: (p) => {
      seen.push(p);
      return "[]";
    },
  });
  assert.deepEqual(seen, ["d/providers-1.json"]);
});

test("an empty array carries no information, so it is not a dry account", () => {
  // `[]` means the sweep recorded no provider at all. Reading it as "nothing usable"
  // would make a file that says nothing indistinguishable from one that says every key
  // is dead — in the one direction that fails a lane.
  assert.deepEqual(foldUsability([[]]), { known: false, active: [] });
  assert.equal(usabilityState(foldUsability([[]])), "unknown");
  // But a file that lists providers and none active IS a measurement.
  assert.equal(
    usabilityState(foldUsability([[record("openai", "inactive", "no credits")]])),
    "dry",
  );
});
