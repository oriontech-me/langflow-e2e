import { request as pwRequest } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import {
  DATASET_KEYS,
  DATASETS,
  DatasetTracker,
  addItems,
  createDataset,
  csvUpload,
  listAllItems,
  readDataset,
  readEvalsSurface,
  type DatasetItemRead,
  type DatasetRead,
} from "../../../../helpers/api/evals/datasets";

/**
 * Evals datasets API (#2563) — the 16 operations under `/api/v1/datasets`, the input of
 * every evaluation (Langflow 1.14, upstream #15999; on by default since #16591).
 *
 * First spec of the evals family. Nothing else in the suite drives this surface:
 * #2564 covers evaluations and #2565 the UI, both on top of the helper this spec uses.
 * API-only, so the fixture's HTTP monitor (page responses) never sees the deliberate
 * 404/409/422s and no `allowHttpErrors()` hatch is needed.
 *
 * Contract and measurements: docs/api/evals/api-datasets.md.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BOM = "﻿";

/** Input/expected pairs in order — what an item list is compared on. */
const pairs = (items: DatasetItemRead[]) => items.map((item) => [item.input, item.expected_output]);

test.describe("Evals API — datasets", () => {
  let headers: Record<string, string>;
  let skipReason: string | null = null;
  let tracker: DatasetTracker;

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const verdict = await readEvalsSurface(request, headers);
    if (verdict.state === "absent") skipReason = verdict.reason;
    else if (verdict.state !== "enabled") throw new Error(`evals premise: ${verdict.reason}`);
  });

  test.beforeEach(() => {
    tracker = new DatasetTracker();
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test.afterEach(async ({ request }) => {
    await tracker.cleanup(request, headers);
  });

  test("creates, reads, lists, renames and deletes a dataset", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "POST /api/v1/datasets/",
      "GET /api/v1/datasets/{dataset_id}",
      "GET /api/v1/datasets/",
      "PATCH /api/v1/datasets/{dataset_id}",
      "DELETE /api/v1/datasets/{dataset_id}",
    ]);
    const name = `ds-crud-${uid()}`;
    let created: DatasetRead;

    await test.step("create answers 201 with the seven keys, revision 1 and no items", async () => {
      created = await createDataset(request, headers, { name, description: "first" }, tracker);
      expect(Object.keys(created).sort()).toEqual(DATASET_KEYS);
      expect(created).toMatchObject({ name, description: "first", revision: 1, item_count: 0 });
    });

    await test.step("a taken name is 409 and an empty name is 422 on body.name", async () => {
      const taken = await request.post(`${DATASETS}/`, { headers, data: { name } });
      expect(taken.status()).toBe(409);
      expect((await taken.json()).detail).toBe(`A dataset named '${name}' already exists`);

      const empty = await request.post(`${DATASETS}/`, { headers, data: { name: "" } });
      expect(empty.status()).toBe(422);
      const [entry] = (await empty.json()).detail;
      expect(entry).toMatchObject({ type: "string_too_short", loc: ["body", "name"] });
    });

    await test.step("read returns the create response and the search lists exactly it", async () => {
      expect(await readDataset(request, headers, created.id)).toEqual(created);
      const list = await request.get(`${DATASETS}/`, { headers, params: { search: name } });
      expect(list.status()).toBe(200);
      const page = await list.json();
      expect(page.total).toBe(1);
      expect(page.items.map((d: DatasetRead) => d.id)).toEqual([created.id]);
    });

    await test.step("a rename applies both fields and leaves revision alone", async () => {
      const renamed = `${name}-renamed`;
      const patch = await request.patch(`${DATASETS}/${created.id}`, {
        headers,
        data: { name: renamed, description: null },
      });
      expect(patch.status()).toBe(200);
      // Metadata, not content: an evaluation records the revision it ran on (#2564), and
      // a rename must not make it look as if the rows changed.
      expect(await patch.json()).toMatchObject({ id: created.id, name: renamed, description: null, revision: 1 });
    });

    await test.step("delete is 204, then the id is 404 and a malformed id is 422 on path.dataset_id", async () => {
      const del = await request.delete(`${DATASETS}/${created.id}`, { headers });
      expect(del.status()).toBe(204);
      const gone = await request.get(`${DATASETS}/${created.id}`, { headers });
      expect(gone.status()).toBe(404);
      expect((await gone.json()).detail).toBe("Dataset not found");

      const malformed = await request.get(`${DATASETS}/not-a-uuid`, { headers });
      expect(malformed.status()).toBe(422);
      expect((await malformed.json()).detail[0]).toMatchObject({ type: "uuid_parsing", loc: ["path", "dataset_id"] });
    });
  });

  test("items keep their order, edits and deletions, and the dataset counts them", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v1/datasets/{dataset_id}/items",
      "GET /api/v1/datasets/{dataset_id}/items",
      "PATCH /api/v1/datasets/{dataset_id}/items/{item_id}",
      "POST /api/v1/datasets/{dataset_id}/items/delete",
    ]);
    const dataset = await createDataset(request, headers, { name: `ds-items-${uid()}` }, tracker);
    let rows: DatasetItemRead[] = [];
    let revision = dataset.revision;
    const expectRevisionMoved = async () => {
      const now = (await readDataset(request, headers, dataset.id)).revision;
      expect(now, "every content write moves the revision forward").toBeGreaterThan(revision);
      revision = now;
    };

    await test.step("five rows come back in order, manual, with an omitted expected as null", async () => {
      rows = await addItems(request, headers, dataset.id, [
        { input: "in-1", expected_output: "out-1" },
        { input: "in-2", expected_output: "out-2" },
        { input: "in-3", expected_output: "out-3" },
        { input: "in-4", expected_output: "out-4" },
        { input: "in-5" },
      ]);
      expect(pairs(rows)).toEqual([
        ["in-1", "out-1"],
        ["in-2", "out-2"],
        ["in-3", "out-3"],
        ["in-4", "out-4"],
        ["in-5", null],
      ]);
      expect(rows.every((row) => row.source === "manual")).toBe(true);
      const positions = rows.map((row) => row.position);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(positions).size).toBe(5);
    });

    await test.step("the list holds the same ids in order and the dataset counts five", async () => {
      expect((await listAllItems(request, headers, dataset.id)).map((row) => row.id)).toEqual(rows.map((r) => r.id));
      expect((await readDataset(request, headers, dataset.id)).item_count).toBe(5);
      await expectRevisionMoved();
    });

    await test.step("an input edit keeps the expected output, and clear_expected_output nulls it", async () => {
      const edit = await request.patch(`${DATASETS}/${dataset.id}/items/${rows[1].id}`, {
        headers,
        data: { input: "in-2-edited" },
      });
      expect(edit.status()).toBe(200);
      expect(await edit.json()).toMatchObject({ id: rows[1].id, input: "in-2-edited", expected_output: "out-2" });
      await expectRevisionMoved();

      const clear = await request.patch(`${DATASETS}/${dataset.id}/items/${rows[2].id}`, {
        headers,
        data: { clear_expected_output: true },
      });
      expect(clear.status()).toBe(200);
      expect(await clear.json()).toMatchObject({ id: rows[2].id, input: "in-3", expected_output: null });
      await expectRevisionMoved();
    });

    await test.step("deleting rows 1 and 4 leaves exactly rows 2, 3 and 5 with their edits", async () => {
      const del = await request.post(`${DATASETS}/${dataset.id}/items/delete`, {
        headers,
        data: { ids: [rows[0].id, rows[3].id] },
      });
      expect(del.status()).toBe(200);
      expect(await del.json()).toEqual({ deleted: 2 });
      const left = await listAllItems(request, headers, dataset.id);
      expect(left.map((row) => row.id)).toEqual([rows[1].id, rows[2].id, rows[4].id]);
      expect(pairs(left)).toEqual([
        ["in-2-edited", "out-2"],
        ["in-3", null],
        ["in-5", null],
      ]);
      expect((await readDataset(request, headers, dataset.id)).item_count).toBe(3);
      await expectRevisionMoved();
    });

    await test.step("an unknown item, an unknown delete id and an empty input change nothing", async () => {
      const unknown = await request.patch(`${DATASETS}/${dataset.id}/items/00000000-0000-4000-8000-000000000000`, {
        headers,
        data: { input: "x" },
      });
      expect(unknown.status()).toBe(404);
      expect((await unknown.json()).detail).toBe("Dataset item not found");

      const noop = await request.post(`${DATASETS}/${dataset.id}/items/delete`, {
        headers,
        data: { ids: ["00000000-0000-4000-8000-000000000000"] },
      });
      expect(noop.status()).toBe(200);
      expect(await noop.json()).toEqual({ deleted: 0 });

      const empty = await request.post(`${DATASETS}/${dataset.id}/items`, { headers, data: { items: [{ input: "" }] } });
      expect(empty.status()).toBe(422);
      expect((await empty.json()).detail[0]).toMatchObject({
        type: "string_too_short",
        loc: ["body", "items", 0, "input"],
      });

      const after = await readDataset(request, headers, dataset.id);
      expect(after.item_count).toBe(3);
      expect(after.revision).toBe(revision);
    });
  });

  test("CSV import previews without writing, imports trimmed rows and skips empty inputs", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v1/datasets/{dataset_id}/import/preview",
      "POST /api/v1/datasets/{dataset_id}/import",
    ]);
    const dataset = await createDataset(request, headers, { name: `ds-csv-${uid()}` }, tracker);
    await addItems(request, headers, dataset.id, [{ input: "manual row", expected_output: "manual" }]);
    const before = await readDataset(request, headers, dataset.id);
    // Line 4 of the file (the header is line 1) has an empty input.
    const csv = "question,answer,extra\n  what is 1+1  ,2,a\nsay hi,  ,b\n,blank,c\n";
    const preview = (multipart: ReturnType<typeof csvUpload>) =>
      request.post(`${DATASETS}/${dataset.id}/import/preview`, { headers, multipart });
    const importCsv = (multipart: ReturnType<typeof csvUpload>) =>
      request.post(`${DATASETS}/${dataset.id}/import`, { headers, multipart });

    await test.step("the preview returns the cells verbatim and writes nothing", async () => {
      const res = await preview(csvUpload("rows.csv", csv));
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({
        headers: ["question", "answer", "extra"],
        rows: [
          ["  what is 1+1  ", "2", "a"],
          ["say hi", "  ", "b"],
          ["", "blank", "c"],
        ],
        total_rows: 3,
      });
      const after = await readDataset(request, headers, dataset.id);
      expect(after.item_count).toBe(before.item_count);
      expect(after.revision).toBe(before.revision);
    });

    await test.step("a 30-row preview samples 5 rows and counts all 30", async () => {
      const many = `input\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join("\n")}\n`;
      const res = await preview(csvUpload("many.csv", many));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.rows).toEqual([["row-0"], ["row-1"], ["row-2"], ["row-3"], ["row-4"]]);
      expect(body.total_rows).toBe(30);
    });

    await test.step("the import appends two trimmed csv rows and skips line 4 with its reason", async () => {
      const res = await importCsv(csvUpload("rows.csv", csv, { input_column: "question", expected_column: "answer" }));
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ imported: 2, skipped: [{ row: 4, reason: "Input is empty" }] });
      const items = await listAllItems(request, headers, dataset.id);
      expect(pairs(items)).toEqual([
        ["manual row", "manual"],
        ["what is 1+1", "2"],
        ["say hi", null],
      ]);
      expect(items.map((item) => item.source)).toEqual(["manual", "csv", "csv"]);
    });

    await test.step("a wrong column, a non-UTF-8 file and an empty file are refused and write nothing", async () => {
      const wrong = await importCsv(csvUpload("rows.csv", csv, { input_column: "nope" }));
      expect(wrong.status()).toBe(422);
      expect((await wrong.json()).detail).toBe("Column 'nope' is not in the file. Columns: question, answer, extra");

      const latin = await preview(csvUpload("latin.csv", Buffer.from([0xff, 0xfe, 0x00, 0x67, 0x00])));
      expect(latin.status()).toBe(422);
      expect((await latin.json()).detail).toBe("The file is not UTF-8 encoded. Save it as CSV UTF-8 and try again.");

      const empty = await preview(csvUpload("empty.csv", ""));
      expect(empty.status()).toBe(422);
      expect((await empty.json()).detail).toBe("The file has no header row.");

      expect((await readDataset(request, headers, dataset.id)).item_count).toBe(3);
    });
  });

  test("bundled examples create a dataset and append to one", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "GET /api/v1/datasets/examples",
      "POST /api/v1/datasets/examples/{key}",
      "POST /api/v1/datasets/{dataset_id}/examples/{key}",
    ]);
    let example: { key: string; name: string; description: string; item_count: number };

    await test.step("the examples list is non-empty and every entry is well formed", async () => {
      const res = await request.get(`${DATASETS}/examples`, { headers });
      expect(res.status()).toBe(200);
      const list = await res.json();
      expect(list.length).toBeGreaterThan(0);
      for (const entry of list) {
        expect(Object.keys(entry).sort()).toEqual(["description", "item_count", "key", "name"]);
        expect(entry.item_count).toBeGreaterThan(0);
      }
      // The first entry, not a hardcoded key: a renamed example must not fail this test.
      example = list[0];
    });

    await test.step("creating from an example yields a dataset named after it with all its rows", async () => {
      const res = await request.post(`${DATASETS}/examples/${example.key}`, { headers, data: {} });
      expect(res.status()).toBe(201);
      const created = (await res.json()) as DatasetRead;
      tracker.track(created.id);
      // Suffixed (" 2", " 3"…) when another dataset of the caller already holds the name.
      expect(created.name.startsWith(example.name)).toBe(true);
      expect(created.item_count).toBe(example.item_count);
      expect(await listAllItems(request, headers, created.id)).toHaveLength(example.item_count);
    });

    await test.step("appending keeps a dataset's own description", async () => {
      const own = await createDataset(request, headers, { name: `ds-ex-own-${uid()}`, description: "mine" }, tracker);
      const res = await request.post(`${DATASETS}/${own.id}/examples/${example.key}`, { headers, data: {} });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ id: own.id, description: "mine", item_count: example.item_count });
    });

    await test.step("appending to a dataset with no description fills it from the example", async () => {
      const bare = await createDataset(request, headers, { name: `ds-ex-bare-${uid()}` }, tracker);
      const res = await request.post(`${DATASETS}/${bare.id}/examples/${example.key}`, { headers, data: {} });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ id: bare.id, description: example.description });
    });

    await test.step("an unknown example key is 404 naming it", async () => {
      const key = `nope-${uid()}`;
      const res = await request.post(`${DATASETS}/examples/${key}`, { headers, data: {} });
      expect(res.status()).toBe(404);
      expect((await res.json()).detail).toBe(`No example dataset named '${key}'`);
    });
  });

  test("duplicates a dataset into an independent copy", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({ request, apiCoverage }) => {
    apiCoverage.declare(["POST /api/v1/datasets/{dataset_id}/duplicate"]);
    const name = `ds-dup-${uid()}`;
    const source = await createDataset(request, headers, { name }, tracker);
    const sourceRows = await addItems(request, headers, source.id, [
      { input: "a", expected_output: "1" },
      { input: "b" },
      { input: "c", expected_output: "3" },
    ]);
    const duplicate = async () => {
      const res = await request.post(`${DATASETS}/${source.id}/duplicate`, { headers });
      expect(res.status()).toBe(201);
      const copy = (await res.json()) as DatasetRead;
      tracker.track(copy.id);
      return copy;
    };
    let copy: DatasetRead;

    await test.step("the copy is a new dataset named '(copy)' with the same rows under new ids", async () => {
      copy = await duplicate();
      expect(copy.id).not.toBe(source.id);
      expect(copy).toMatchObject({ name: `${name} (copy)`, revision: 1, item_count: 3 });
      const copyRows = await listAllItems(request, headers, copy.id);
      expect(pairs(copyRows)).toEqual(pairs(sourceRows));
      const sourceIds = new Set(sourceRows.map((row) => row.id));
      expect(copyRows.some((row) => sourceIds.has(row.id))).toBe(false);
    });

    await test.step("a second copy is suffixed '(copy) 2'", async () => {
      expect((await duplicate()).name).toBe(`${name} (copy) 2`);
    });

    await test.step("deleting a row in the copy leaves the source whole", async () => {
      const [first] = await listAllItems(request, headers, copy.id);
      const del = await request.post(`${DATASETS}/${copy.id}/items/delete`, { headers, data: { ids: [first.id] } });
      expect(await del.json()).toEqual({ deleted: 1 });
      expect(pairs(await listAllItems(request, headers, source.id))).toEqual(pairs(sourceRows));
    });
  });

  test("exports a spreadsheet-safe CSV that round-trips everything else", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "GET /api/v1/datasets/{dataset_id}/export",
      "POST /api/v1/datasets/{dataset_id}/import",
    ]);
    const name = `ds-export-${uid()}`;
    const dataset = await createDataset(request, headers, { name }, tracker);
    const safeRows = [
      { input: "has, comma", expected_output: 'has "quotes"' },
      { input: "multi\nline", expected_output: "ünïcødé ✓" },
      { input: "no expected", expected_output: null },
    ];
    await addItems(request, headers, dataset.id, [...safeRows, { input: "=1+1", expected_output: "+cmd" }]);
    let body = "";

    await test.step("the export is a UTF-8 CSV attachment with a BOM, CRLF lines and formula cells neutralised", async () => {
      const res = await request.get(`${DATASETS}/${dataset.id}/export`, { headers });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers()["content-disposition"]).toContain(`attachment; filename="${name}.csv"`);
      body = (await res.body()).toString("utf8");
      expect(body.startsWith(BOM)).toBe(true);
      expect(body.slice(1).split("\r\n")[0]).toBe("input,expected_output");
      // csv_safe_cell (utils/csv_safety.py): a cell starting with = + - @ is prefixed
      // with ' so a spreadsheet does not run it. Losing this is a CSV-injection hole.
      expect(body).toContain("'=1+1,'+cmd\r\n");
    });

    await test.step("re-importing it reproduces every row, the formula row with its apostrophe", async () => {
      const target = await createDataset(request, headers, { name: `${name}-reimport` }, tracker);
      const res = await request.post(`${DATASETS}/${target.id}/import`, {
        headers,
        multipart: csvUpload(`${name}.csv`, body, { input_column: "input", expected_column: "expected_output" }),
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ imported: 4, skipped: [] });
      // Lossy by design for the formula row only: the import does not strip the
      // prefix back, since a genuine leading apostrophe would be indistinguishable.
      expect(pairs(await listAllItems(request, headers, target.id))).toEqual([
        ...safeRows.map((row) => [row.input, row.expected_output]),
        ["'=1+1", "'+cmd"],
      ]);
    });
  });

  // No apiCoverage.declare() here: the fixture records the test's own `request`
  // context, and the refusals this test is about are issued from the other user's.
  // Tests 1–6 cover all 16 operations between them.
  test("another user can neither see nor change the dataset", { tag: ["@stable", "@api", "@database", "@evals"] }, async ({ request, baseURL }) => {
    const name = `ds-owner-${uid()}`;
    const dataset = await createDataset(request, headers, { name }, tracker);
    await addItems(request, headers, dataset.id, [{ input: "owned", expected_output: "row" }]);
    const before = await readDataset(request, headers, dataset.id);
    // A holder, not a `let`: the user is assigned inside the helper's `track` callback,
    // which TypeScript's narrowing cannot see.
    const owned: { user?: ThrowawayUser } = {};

    try {
      const them = await test.step("create a throwaway user", () =>
        createThrowawayUser(request, {
          superHeaders: headers,
          newContext: () => pwRequest.newContext({ baseURL }),
          prefix: "dsowner",
          track: (user) => {
            owned.user = user;
          },
        }),
      );

      await test.step("every per-id operation answers 404 'Dataset not found' to the other user", async () => {
        const id = dataset.id;
        const attempts: Array<[string, () => Promise<{ status(): number; json(): Promise<{ detail: unknown }> }>]> = [
          ["GET", () => them.request.get(`${DATASETS}/${id}`, { headers: them.headers })],
          ["GET items", () => them.request.get(`${DATASETS}/${id}/items`, { headers: them.headers })],
          ["PATCH", () => them.request.patch(`${DATASETS}/${id}`, { headers: them.headers, data: { name: "hijack" } })],
          [
            "POST items",
            () => them.request.post(`${DATASETS}/${id}/items`, { headers: them.headers, data: { items: [{ input: "x" }] } }),
          ],
          ["GET export", () => them.request.get(`${DATASETS}/${id}/export`, { headers: them.headers })],
          ["POST duplicate", () => them.request.post(`${DATASETS}/${id}/duplicate`, { headers: them.headers })],
          [
            "POST examples",
            () => them.request.post(`${DATASETS}/${id}/examples/support-triage`, { headers: them.headers, data: {} }),
          ],
          ["DELETE", () => them.request.delete(`${DATASETS}/${id}`, { headers: them.headers })],
        ];
        for (const [label, attempt] of attempts) {
          const res = await attempt();
          expect(res.status(), `${label} as another user`).toBe(404);
          expect((await res.json()).detail, `${label} as another user`).toBe("Dataset not found");
        }
        const list = await them.request.get(`${DATASETS}/`, { headers: them.headers, params: { search: name } });
        expect(list.status()).toBe(200);
        expect((await list.json()).total).toBe(0);
      });

      await test.step("the owner's dataset is unchanged", async () => {
        const after = await readDataset(request, headers, dataset.id);
        expect(after).toMatchObject({ name: before.name, item_count: before.item_count, revision: before.revision });
      });

      await test.step("the other user may use the same name — names are unique per user", async () => {
        const res = await them.request.post(`${DATASETS}/`, { headers: them.headers, data: { name } });
        expect(res.status()).toBe(201);
        const theirs = (await res.json()) as DatasetRead;
        expect(theirs.id).not.toBe(dataset.id);
        const del = await them.request.delete(`${DATASETS}/${theirs.id}`, { headers: them.headers });
        expect(del.status()).toBe(204);
      });
    } finally {
      if (owned.user) await deleteThrowawayUser(request, headers, owned.user);
    }
  });
});
