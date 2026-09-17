import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  resolveRedactionVerdict,
  type RedactionVerdict,
} from "../../../../helpers/other/validation-redaction-gate";

// A 422 names the field that failed and never reflects the value that was sent.
// Spec doc: docs/api/instance/api-validation-redaction.md
//
// This is a contract of the WHOLE API, not of one route: upstream registers
// `langflow/api/validation_errors.py` on the app (LE-2462, langflow-ai/langflow#15038),
// replacing FastAPI's default handler, which echoed the caller's data back — and for a
// `missing` entry echoed the whole ENCLOSING OBJECT, which is how a valid access_token
// could return in an error body because a sibling field was absent.
//
// The suite noticed the change only by accident (#1841 went red on `input: "batch"`) and
// #1845 removed that assertion deliberately rather than inverting it. This file is the
// red a revert would produce.
//
// Every route below is a VEHICLE for an error shape, not a route under test — which is
// why nothing here declares apiCoverage (see the spec doc).
test.describe("422 validation errors do not echo submitted values", () => {
  let headers: Record<string, string> = {};
  let verdict: RedactionVerdict;

  /**
   * One value per run, carried by every request in the file.
   *
   * Long enough to be scrubbed (`MIN_REDACTED_LENGTH` is 8, measured), and the
   * leading uppercase also violates `^[a-z0-9][a-z0-9._-]*$`, which is what lets
   * Test 4 use the SAME string — so "the sentinel appears nowhere" stays one claim
   * across the file instead of four.
   */
  const SENTINEL = `Redaction-probe-${randomUUID()}`;

  /** The literal `validation_errors.REDACTED` writes over a submitted string. */
  const REDACTED = "[redacted]";

  /** Every key the handler is allowed to emit. A re-added `input` fails here first. */
  const ALLOWED_KEYS = ["ctx", "loc", "msg", "type"];

  /** `max_length` declared on the `X-Langflow-Operation-ID` header, Test 4's vehicle. */
  const OPERATION_ID_MAX = 128;

  interface ErrorEntry {
    type?: unknown;
    loc?: unknown;
    msg?: unknown;
    ctx?: unknown;
    input?: unknown;
  }

  /**
   * The assertions every shape shares, kept in one place so a new shape cannot
   * accidentally assert less than the others.
   *
   * `raw` is asserted, not `detail[i].input`: a field re-added under another name
   * would pass a key-by-key check while putting the value back on the wire.
   *
   * Only the STATUS message truncates, and only that one needs to: it is the one
   * message that can carry a route's real `200` body. The two below it are
   * reachable only after the `422` assertion passed, so what they interpolate is
   * always an error body.
   */
  async function expectRedacted(res: APIResponse): Promise<{ entries: ErrorEntry[]; raw: string }> {
    const raw = await res.text();
    // Truncated deliberately: when a request stops being refused, `raw` is that
    // route's real 200 body — an account listing, for `GET /api/v1/users/` — and a
    // security spec must not be the thing that copies one into a CI log. It
    // REDUCES rather than prevents (200 bytes of that listing still name a user),
    // which is the right trade against a failure message that says nothing.
    expect(res.status(), `body (truncated): ${raw.slice(0, 200)}`).toBe(422);
    expect(
      raw.includes(SENTINEL),
      `the submitted value came back in the 422 body: ${raw.slice(0, 400)}`,
    ).toBe(false);

    const entries = (JSON.parse(raw) as { detail?: ErrorEntry[] }).detail;
    expect(Array.isArray(entries) && entries.length > 0, `unexpected 422 shape: ${raw}`).toBe(
      true,
    );
    for (const entry of entries as ErrorEntry[]) {
      const extra = Object.keys(entry).filter((key) => !ALLOWED_KEYS.includes(key));
      expect(extra, `an entry carries keys the handler drops: ${raw}`).toEqual([]);
      expect(entry).not.toHaveProperty("input");
    }
    return { entries: entries as ErrorEntry[], raw };
  }

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    verdict = await resolveRedactionVerdict(request);
    // Unknown is not clean (#1012): an unreadable version fails here rather than
    // letting four tests decide the contract on a guess.
    if (verdict.available === "unknown") throw new Error(verdict.failReason);
  });

  test.beforeEach(() => {
    test.skip(verdict.available === false, (verdict as { skipReason?: string }).skipReason);
  });

  test(
    "a missing field does not echo the object it was missing from",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The credential-leak case the upstream PR cites: with FastAPI's default handler
      // a `missing` entry carried `input` = the WHOLE submitted body, so a request that
      // merely forgot a field answered with every value it did send.
      const body = { value: SENTINEL };

      const { entries, raw } = await test.step(
        "the 422 names the missing fields and carries no value",
        async () => {
          const res = await request.post("/api/v1/variables/", { headers, data: body });
          return expectRedacted(res);
        },
      );

      await test.step("the fixed pydantic template is untouched — the body WAS parsed", async () => {
        // The control for the absence: `loc` proves the sentinel-carrying body reached
        // the validator and was refused on its own fields, rather than rejected unread.
        const locs = entries.map((e) => JSON.stringify(e.loc));
        expect(locs).toContain(JSON.stringify(["body", "name"]));
        for (const entry of entries) {
          expect(entry.type).toBe("missing");
          // Not scrubbed: a fixed template quotes nothing, so it must survive verbatim.
          expect(entry.msg).toBe("Field required");
        }
      });

      await test.step("the response does not depend on what was submitted", async () => {
        const harmless = await request.post("/api/v1/variables/", {
          headers,
          data: { value: "an-ordinary-value" },
        });
        expect(harmless.status()).toBe(422);
        // Byte-identical raw bodies: the strongest form of "the response is independent
        // of what was submitted", and it fails the moment any entry starts reflecting
        // the value again — including through a field this file does not name.
        expect(await harmless.text()).toBe(raw);
      });

      await test.step("nothing was created", async () => {
        const list = await request.get("/api/v1/variables/", { headers });
        expect(list.status()).toBe(200);
        expect(JSON.stringify(await list.json())).not.toContain(SENTINEL);
      });
    },
  );

  test(
    "a validator that quotes its input answers [redacted]",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // `Flow.validate_icon_atr` raises f"Invalid emoji. {v} is not a valid emoji." for a
      // value that opens with a colon and does not close with one — the only validator
      // found on a REQUEST path that puts the submitted value in its own message (others
      // exist deeper, e.g. traces/model.py, but no request reaches them as a 422), which
      // is the branch the msg scrub exists for.
      const probeName = `redaction-probe-${randomUUID()}`;
      const newFlow = (icon: string) => ({
        name: probeName,
        data: { nodes: [], edges: [] },
        icon,
      });

      await test.step("the submitted value is replaced by the literal [redacted]", async () => {
        const res = await request.post("/api/v1/flows/", {
          headers,
          data: newFlow(`:${SENTINEL}`),
        });
        const { entries } = await expectRedacted(res);
        for (const entry of entries) {
          expect(entry.type).toBe("value_error");
          expect(entry.loc).toEqual(["body", "icon"]);
          // The POSITIVE control. "The sentinel is absent" alone would also pass on a
          // request that never carried it, or on a route that stopped validating; this
          // token can only appear because the scrub ran over a submitted string.
          expect(String(entry.msg)).toContain(REDACTED);
          // A custom error's ctx is the author's own, so the handler keeps none of it —
          // pydantic would have put the raised ValueError in `ctx.error`.
          expect(entry).not.toHaveProperty("ctx");
        }
      });

      await test.step("the 8-character boundary redacts", async () => {
        // MIN_REDACTED_LENGTH is 8, measured on the wire: ":abcdef" (7 submitted chars)
        // comes back verbatim, ":abcdefg" (8) comes back redacted. Pinning the 8 side
        // means a future RAISE of the threshold goes red while a lower one — strictly
        // better — never does.
        const res = await request.post("/api/v1/flows/", { headers, data: newFlow(":abcdefg") });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail as ErrorEntry[];
        expect(detail.length).toBeGreaterThan(0);
        for (const entry of detail) expect(String(entry.msg)).toContain(REDACTED);
      });

      await test.step("no flow was created", async () => {
        // `header_flows=true` drops each flow's `data`: the full listing is ~4.7 MB
        // on a starter-project account, and the name is all this step reads.
        const list = await request.get("/api/v1/flows/?header_flows=true", { headers });
        expect(list.status()).toBe(200);
        const names = ((await list.json()) as Array<{ name?: string }>).map((f) => f.name);
        expect(names).not.toContain(probeName);
      });
    },
  );

  test(
    "a non-uuid path parameter drops both the value and its input-derived ctx",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The direct successor of the assertion #1845 had to remove: that spec asserted
      // `input: "batch"` on exactly this error type and went red when the handler landed.
      const res = await request.get(`/api/v1/flows/${SENTINEL}`, { headers });
      const { entries } = await expectRedacted(res);

      for (const entry of entries) {
        // The control: `loc` is itself the evidence the sentinel reached the path parser,
        // so the absence above is not the absence of a request.
        expect(entry.type).toBe("uuid_parsing");
        expect(entry.loc).toEqual(["path", "flow_id"]);
        // pydantic fills `ctx.error` from the value it could not parse, so the whole ctx
        // goes. A handler that kept input-derived keys fails here and nowhere else.
        expect(entry).not.toHaveProperty("ctx");
      }
    },
  );

  test(
    "schema-derived ctx survives while the value does not",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The test that stops the contract being satisfied by "strip everything": a handler
      // that dropped ctx wholesale would pass every sentinel-absence assertion in this
      // file while removing the schema information a client needs to fix its request.
      await test.step("a too-long header keeps ctx.max_length", async () => {
        const res = await request.get("/api/v1/users/", {
          headers: {
            ...headers,
            // One over the declared limit, derived from it rather than written twice:
            // an upstream raise then fails on `ctx`, naming the cause, instead of on a
            // bare "expected 422, received 200".
            "X-Langflow-Operation-ID": SENTINEL.padEnd(OPERATION_ID_MAX + 1, "x"),
          },
        });
        const { entries } = await expectRedacted(res);
        for (const entry of entries) {
          expect(entry.type).toBe("string_too_long");
          expect(entry.loc).toEqual(["header", "X-Langflow-Operation-ID"]);
          expect(entry.ctx).toEqual({ max_length: OPERATION_ID_MAX });
        }
      });

      await test.step("a pattern mismatch keeps ctx.pattern", async () => {
        const res = await request.get(`/api/v1/connections?provider=${SENTINEL}`, { headers });
        const { entries } = await expectRedacted(res);
        for (const entry of entries) {
          expect(entry.type).toBe("string_pattern_mismatch");
          expect(entry.loc).toEqual(["query", "provider"]);
          const pattern = (entry.ctx as { pattern?: unknown } | undefined)?.pattern;
          expect(typeof pattern).toBe("string");
          // Asserted as a usable regular expression rather than as one literal, so an
          // upstream tightening of the pattern does not redden a contract about ctx.
          expect(() => new RegExp(pattern as string)).not.toThrow();
          expect(new RegExp(pattern as string).test(SENTINEL)).toBe(false);
        }
      });
    },
  );
});
