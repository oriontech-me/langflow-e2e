import type { APIRequestContext } from "@playwright/test";
import { inflateRawSync } from "node:zlib";
import {
  expect,
  test,
  type PageWithErrorHooks,
} from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createThrowawayUser,
  deleteThrowawayUser,
  type ThrowawayUser,
} from "../../../../helpers/auth/throwaway-user";
import {
  buildCatalogFlow,
  type CatalogFlowSpec,
  fetchComponentCatalog,
  findCatalogComponent,
} from "../../../../helpers/flows/build-catalog-flow";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { DRIVE_LIST_TYPE } from "../../../../helpers/integrations/connection-probe";
import {
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";
import { providerOutageMessage } from "../../../../helpers/integrations/provider-outage";
import { PlaygroundPage } from "../../../../pages/PlaygroundPage";

// The saved-flow contract of Dedicated Integrations (#2298).
// Spec doc: docs/api/connections/api-connections-saved-flow-contract.md
//
// A saved flow names a connection by its handle (`<provider>/<name>`) and never
// carries a credential. These tests export a bound flow, import it again (as the
// same user and as another one), run a connector until the PROVIDER rejects its
// token, and sweep everything those steps leave behind for the planted tokens.
// Which callers may resolve a connection at all is
// `api-connections-resolution-entry-points.spec.ts`; every run there stops before a
// provider, which is the surface this file adds.
test.describe("Connections — the saved-flow contract", () => {
  const OUTLOOK_SEND_TYPE = "ext:microsoft:OutlookSendComponent@official";
  /** The scope Drive *List Files* requires (its `connection` input's `required_scopes`). */
  const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  /** What `_workspace_client.py` reports when Google refuses the token. */
  const AUTH_EXPIRED_TEXT =
    "The provider credential is expired or was rejected.";
  /** A real run stops at the provider in ~0.5 s, but the Google bundle loads on each build. */
  const RUN_TIMEOUT_MS = 60_000;

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let superHeaders: Record<string, string>;
  let catalog: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    superHeaders = { Authorization: await getAuthToken(request) };
    catalog = await fetchComponentCatalog(request, superHeaders);
  });

  /** Two sentinels per connection, unique per test and per run (#1967). */
  function newSentinels(label: string): { access: string; refresh: string } {
    const tag = `${label}-${run}`.toUpperCase();
    return {
      access: `E2E-ACCESS-SENTINEL-${tag}`,
      refresh: `E2E-REFRESH-SENTINEL-${tag}`,
    };
  }

  function expectNoSentinel(
    text: string,
    sentinels: Array<{ access: string; refresh: string }>,
    where: string,
  ) {
    for (const s of sentinels) {
      expect(
        text,
        `${where} must not carry the planted access token`,
      ).not.toContain(s.access);
      expect(
        text,
        `${where} must not carry the planted refresh token`,
      ).not.toContain(s.refresh);
    }
  }

  /** One Drive *List Files* node per handle. Drive only READS, so no run here can write anything. */
  function driveNodes(handles: Record<string, string>): CatalogFlowSpec {
    return {
      nodes: Object.entries(handles).map(([id, handle]) => ({
        id,
        type: DRIVE_LIST_TYPE,
        values: { connection: handle },
      })),
      edges: [],
    };
  }

  async function saveFlow(
    request: APIRequestContext,
    spec: CatalogFlowSpec,
    label: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    return createFlow(
      request,
      {
        name: `E2E saved-flow ${label} ${run} ${Math.random().toString(36).slice(2, 6)}`,
        data: buildCatalogFlow(catalog, spec),
        is_component: false,
        ...extra,
      },
      { headers: superHeaders },
    );
  }

  type FlowEnvelope = {
    id: string;
    data: {
      nodes: Array<{
        id: string;
        data: { type: string; node: Record<string, any> };
      }>;
    };
  };

  function nodeById(flow: FlowEnvelope, id: string) {
    const node = flow.data.nodes.find((n) => n.id === id);
    expect(node, `node ${id} is in the flow`).toBeTruthy();
    return node!.data;
  }

  function handleOf(flow: FlowEnvelope, id: string): unknown {
    return nodeById(flow, id).node.template.connection.value;
  }

  /** `POST /api/v1/flows/download/` for one flow: a single JSON envelope, as raw text. */
  async function downloadFlow(
    request: APIRequestContext,
    flowId: string,
  ): Promise<string> {
    const res = await request.post("/api/v1/flows/download/", {
      headers: superHeaders,
      data: [flowId],
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 300)).toBe(200);
    return text;
  }

  async function uploadFlow(
    request: APIRequestContext,
    headers: Record<string, string>,
    envelope: string,
  ): Promise<FlowEnvelope> {
    const res = await request.post("/api/v1/flows/upload/", {
      headers,
      multipart: {
        file: {
          name: "flow.json",
          mimeType: "application/json",
          buffer: Buffer.from(envelope),
        },
      },
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 300)).toBe(201);
    const flows = JSON.parse(text) as FlowEnvelope[];
    expect(flows, "the upload created exactly one flow").toHaveLength(1);
    return flows[0];
  }

  /** The Playground build, read whole: `event_delivery=direct` streams NDJSON and ends. */
  async function build(
    request: APIRequestContext,
    headers: Record<string, string>,
    flowId: string,
  ): Promise<string> {
    const res = await request.post(
      `/api/v1/build/${flowId}/flow?event_delivery=direct`,
      {
        headers,
        data: { inputs: { input_value: "saved-flow contract" } },
        timeout: RUN_TIMEOUT_MS,
      },
    );
    const text = await res.text();
    expect(res.status(), text.slice(0, 400)).toBe(200);
    return text;
  }

  /** Every `error` event of a build stream: its message text and its typed code. */
  function errorEvents(
    stream: string,
  ): Array<{ text: string; code: string | null }> {
    const out: Array<{ text: string; code: string | null }> = [];
    for (const line of stream.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { event: string; data: any };
      if (event.event !== "error") continue;
      const message = event.data?.data ?? {};
      const content = message.content_blocks?.[0]?.contents?.[0] ?? {};
      out.push({
        text: String(message.text ?? "").trim(),
        code: content.code ?? null,
      });
    }
    return out;
  }

  /** Every `end_vertex` error message of a build stream (a component that failed to BUILD). */
  function vertexErrors(stream: string): string[] {
    const out: string[] = [];
    for (const line of stream.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { event: string; data: any };
      if (
        event.event === "end_vertex" &&
        event.data?.build_data?.valid === false
      ) {
        out.push(String(event.data.build_data.params ?? ""));
      }
    }
    return out;
  }

  /** A connection's row as its owner lists it. */
  async function connectionRow(
    request: APIRequestContext,
    headers: Record<string, string>,
    id: string,
  ): Promise<{ status: string } & Record<string, unknown>> {
    const res = await request.get("/api/v1/connections", { headers });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as unknown;
    const rows = (
      Array.isArray(body) ? body : (body as { items: unknown[] }).items
    ) as Array<{ id: string; status: string } & Record<string, unknown>>;
    const row = rows.find((r) => r.id === id);
    expect(row, `connection ${id} is in its owner's list`).toBeTruthy();
    return row!;
  }

  /** Entries of a ZIP's central directory, stored or deflated (the project download). */
  function unzip(buffer: Buffer): Record<string, string> {
    const entries: Record<string, string> = {};
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd, "the project download is a ZIP").toBeGreaterThanOrEqual(0);
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      const method = buffer.readUInt16LE(offset + 10);
      const compressed = buffer.readUInt32LE(offset + 20);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const local = buffer.readUInt32LE(offset + 42);
      const name = buffer.toString(
        "utf8",
        offset + 46,
        offset + 46 + nameLength,
      );
      const dataStart =
        local +
        30 +
        buffer.readUInt16LE(local + 26) +
        buffer.readUInt16LE(local + 28);
      const raw = buffer.subarray(dataStart, dataStart + compressed);
      entries[name] = (method === 8 ? inflateRawSync(raw) : raw).toString(
        "utf8",
      );
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  test(
    "an export keeps the handle and carries no credential, as a flow and as a project",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/download/",
        "GET /api/v1/projects/download/{project_id}",
      ]);
      const sentinels = newSentinels("EXPORT");
      const connection = await createConnectionViaApi(request, superHeaders, {
        label: "saved_flow_export",
        credentials: {
          access_token: sentinels.access,
          refresh_token: sentinels.refresh,
        },
      });
      const project = await createProjectViaApi(request, superHeaders, {
        namePrefix: "e2esavedflow",
        description: "Saved-flow contract (#2298)",
      });
      let flowId: string | undefined;
      try {
        const handle = `google/${connection.name}`;
        flowId = await saveFlow(
          request,
          driveNodes({ "DriveList-export": handle }),
          "export",
          {
            folder_id: project.projectId,
          },
        );

        await test.step("the flow download carries the handle and neither sentinel", async () => {
          const text = await downloadFlow(request, flowId!);
          expectNoSentinel(text, [sentinels], "the flow export");
          expect(
            handleOf(JSON.parse(text) as FlowEnvelope, "DriveList-export"),
          ).toBe(handle);
        });

        await test.step("the project download carries the handle and neither sentinel", async () => {
          const res = await request.get(
            `/api/v1/projects/download/${project.projectId}`,
            { headers: superHeaders },
          );
          expect(res.status()).toBe(200);
          const entries = Object.values(unzip(await res.body()));
          expect(
            entries,
            "the project holds exactly the one flow",
          ).toHaveLength(1);
          expectNoSentinel(entries[0], [sentinels], "the project export");
          expect(
            handleOf(
              JSON.parse(entries[0]) as FlowEnvelope,
              "DriveList-export",
            ),
          ).toBe(handle);
        });
      } finally {
        if (flowId)
          await deleteFlow(request, flowId, { headers: superHeaders });
        await project.deleteProject(request);
        await connection.deleteConnection(request);
      }
    },
  );

  test(
    "a malformed handle is nulled on export, and kept on save and on import",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}",
        "POST /api/v1/flows/download/",
        "POST /api/v1/flows/upload/",
      ]);
      // Nothing resolves these: the test never runs the flow, so no connection is needed.
      const handles = {
        "DriveList-control": `google/saved_flow_${run}`,
        "DriveList-two-slashes": "google/a/b",
        "DriveList-bad-grammar": "Google/Bad Name",
        "DriveList-no-slash": "nohandle",
      };
      const malformed = [
        "DriveList-two-slashes",
        "DriveList-bad-grammar",
        "DriveList-no-slash",
      ];
      const sourceId = await saveFlow(
        request,
        driveNodes(handles),
        "malformed",
      );
      let sourceDeleted = false;
      let importedId: string | undefined;
      try {
        await test.step("save and read-back keep every value as sent", async () => {
          const res = await request.get(`/api/v1/flows/${sourceId}`, {
            headers: superHeaders,
          });
          expect(res.status()).toBe(200);
          const flow = (await res.json()) as FlowEnvelope;
          for (const [id, handle] of Object.entries(handles))
            expect(handleOf(flow, id), id).toBe(handle);
        });

        const exported =
          await test.step("the export nulls the malformed ones and keeps the control", async () => {
            const text = await downloadFlow(request, sourceId);
            const flow = JSON.parse(text) as FlowEnvelope;
            expect(handleOf(flow, "DriveList-control")).toBe(
              handles["DriveList-control"],
            );
            for (const id of malformed)
              expect(
                handleOf(flow, id),
                `${id} is nulled on export`,
              ).toBeNull();
            return flow;
          });

        await test.step("an import carrying a malformed handle keeps it", async () => {
          // The export already nulled it, so the envelope is the export with one
          // value put back: what a hand-edited or third-party file would carry.
          nodeById(
            exported,
            "DriveList-two-slashes",
          ).node.template.connection.value = "google/a/b";
          // An export keeps the flow id, and the upload refuses an id its user
          // already has (422) — so the source goes first.
          await deleteFlow(request, sourceId, { headers: superHeaders });
          sourceDeleted = true;
          const imported = await uploadFlow(
            request,
            superHeaders,
            JSON.stringify(exported),
          );
          importedId = imported.id;
          expect(
            handleOf(imported, "DriveList-two-slashes"),
            "the upload response",
          ).toBe("google/a/b");
          const res = await request.get(`/api/v1/flows/${imported.id}`, {
            headers: superHeaders,
          });
          expect(
            handleOf(
              (await res.json()) as FlowEnvelope,
              "DriveList-two-slashes",
            ),
            "the stored flow",
          ).toBe("google/a/b");
        });
      } finally {
        if (importedId)
          await deleteFlow(request, importedId, { headers: superHeaders });
        if (!sourceDeleted)
          await deleteFlow(request, sourceId, { headers: superHeaders });
      }
    },
  );

  test(
    "a round trip keys on the component class the manifest names, not on the component name",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/integrations",
        "POST /api/v1/flows/download/",
        "POST /api/v1/flows/upload/",
      ]);
      const res = await request.get("/api/v1/integrations", {
        headers: superHeaders,
      });
      expect(res.status()).toBe(200);
      const manifest = (await res.json()) as {
        providers: Array<{
          capabilities: Array<{ id: string; component_ref: string }>;
        }>;
      };
      const capability = manifest.providers
        .flatMap((p) => p.capabilities)
        .find((c) => c.id === "microsoft.outlook.send");
      expect(
        capability,
        "the manifest serves microsoft.outlook.send",
      ).toBeTruthy();
      expect(capability!.component_ref).toBe("OutlookSendComponent");

      const entry = findCatalogComponent(catalog, OUTLOOK_SEND_TYPE) as Record<
        string,
        any
      >;
      expect(
        entry.metadata.component_class_name,
        "the catalog entry is the class the manifest names",
      ).toBe(capability!.component_ref);
      // The premise that makes this test worth having: keying on `name` would miss it.
      expect(entry.name, "the component's name is not its class").not.toBe(
        capability!.component_ref,
      );

      const handle = `microsoft/saved_flow_${run}`;
      // Never run: Outlook *Send* writes, and no connection exists for this handle.
      const sourceId = await saveFlow(
        request,
        {
          nodes: [
            {
              id: "OutlookSend-roundtrip",
              type: OUTLOOK_SEND_TYPE,
              values: { connection: handle },
            },
          ],
          edges: [],
        },
        "outlook",
      );
      let sourceDeleted = false;
      let importedId: string | undefined;
      try {
        const exported = await downloadFlow(request, sourceId);
        await deleteFlow(request, sourceId, { headers: superHeaders });
        sourceDeleted = true;
        const imported = await uploadFlow(request, superHeaders, exported);
        importedId = imported.id;

        const node = nodeById(imported, "OutlookSend-roundtrip");
        expect(node.type, "the type key").toBe(OUTLOOK_SEND_TYPE);
        expect(node.node.metadata.component_class_name, "the class").toBe(
          capability!.component_ref,
        );
        expect(node.node.metadata.code_hash, "the code hash").toBe(
          entry.metadata.code_hash,
        );
        expect(
          node.node.template.code.value === entry.template.code.value,
          "the code is the catalog's",
        ).toBe(true);
        expect(node.node.template.connection.value, "the handle").toBe(handle);
      } finally {
        if (importedId)
          await deleteFlow(request, importedId, { headers: superHeaders });
        if (!sourceDeleted)
          await deleteFlow(request, sourceId, { headers: superHeaders });
      }
    },
  );

  test(
    "imported by another user, the handle binds to that user's connection, never the exporter's",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, playwright, apiCoverage }, testInfo) => {
      apiCoverage.declare(["POST /api/v1/flows/download/"]);
      const exporterSentinels = newSentinels("EXPORTER");
      const importerSentinels = newSentinels("IMPORTER");
      // The exporter's row HOLDS the scope, the importer's will not: resolving the
      // exporter's row would get past the scope check, so `scope-missing` can only
      // come from the importer's.
      const exporterConnection = await createConnectionViaApi(
        request,
        superHeaders,
        {
          label: "saved_flow_exporter",
          grantedScopes: [DRIVE_FILE_SCOPE],
          credentials: {
            access_token: exporterSentinels.access,
            refresh_token: exporterSentinels.refresh,
          },
        },
      );
      const handle = `google/${exporterConnection.name}`;
      let sourceId: string | undefined;
      let importer: ThrowawayUser | undefined;
      try {
        sourceId = await saveFlow(
          request,
          driveNodes({ "DriveList-moved": handle }),
          "moved",
        );
        const exported = await downloadFlow(request, sourceId);

        importer = await createThrowawayUser(request, {
          superHeaders,
          newContext: () =>
            playwright.request.newContext({
              baseURL: testInfo.project.use.baseURL,
            }),
          prefix: "savedflow",
          track: (user) => {
            importer = user;
          },
        });
        const imported = await uploadFlow(
          importer.request,
          importer.headers,
          exported,
        );
        expect(imported.id, "another user's import is a new flow").not.toBe(
          sourceId,
        );
        expect(
          handleOf(imported, "DriveList-moved"),
          "the handle travelled",
        ).toBe(handle);

        await test.step("with no connection of its own, the handle does not fall through", async () => {
          const stream = await build(
            importer!.request,
            importer!.headers,
            imported.id,
          );
          expectNoSentinel(
            stream,
            [exporterSentinels],
            "the importer's first build",
          );
          const errors = errorEvents(stream);
          expect(
            errors.map((e) => e.code),
            stream.slice(0, 600),
          ).toEqual(["connection-unresolved"]);
          expect(errors[0].text).toContain(
            `Connection '${handle}' could not be resolved`,
          );
        });

        await test.step("with its own connection under the same name, the handle binds to it", async () => {
          const ownConnection = await createConnectionViaApi(
            importer!.request,
            importer!.headers,
            {
              name: exporterConnection.name,
              credentials: {
                access_token: importerSentinels.access,
                refresh_token: importerSentinels.refresh,
              },
            },
          );
          expect(ownConnection.id).not.toBe(exporterConnection.id);
          const stream = await build(
            importer!.request,
            importer!.headers,
            imported.id,
          );
          expectNoSentinel(
            stream,
            [exporterSentinels, importerSentinels],
            "the importer's second build",
          );
          expect(
            errorEvents(stream).map((e) => e.code),
            stream.slice(0, 600),
          ).toEqual(["scope-missing"]);
        });

        // Read-only check of the exporter's row: nothing above may have used it.
        expect(
          (await connectionRow(request, superHeaders, exporterConnection.id))
            .status,
        ).toBe("ready");
      } finally {
        // The user's delete erases its flow and connection with it.
        if (importer)
          await deleteThrowawayUser(request, superHeaders, importer);
        if (sourceId)
          await deleteFlow(request, sourceId, { headers: superHeaders });
        await exporterConnection.deleteConnection(request);
      }
    },
  );

  /** A scoped connection that gets PAST resolution, so a run reaches the provider. */
  async function providerBoundConnection(
    request: APIRequestContext,
    label: string,
  ): Promise<{
    connection: CreatedConnection;
    sentinels: { access: string; refresh: string };
  }> {
    const sentinels = newSentinels(label);
    const connection = await createConnectionViaApi(request, superHeaders, {
      label: `saved_flow_${label.toLowerCase()}`,
      grantedScopes: [DRIVE_FILE_SCOPE],
      credentials: {
        access_token: sentinels.access,
        refresh_token: sentinels.refresh,
      },
    });
    return { connection, sentinels };
  }

  /** The traces of a flow, polled: the tracer writes them after the run returns. */
  async function tracesOf(
    request: APIRequestContext,
    flowId: string,
  ): Promise<Array<{ id: string }>> {
    let traces: Array<{ id: string }> = [];
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: superHeaders },
          );
          expect(res.status()).toBe(200);
          traces = ((await res.json()) as { traces: Array<{ id: string }> })
            .traces;
          return traces.length;
        },
        {
          message:
            "no trace was recorded for the run — an instance started with LANGFLOW_DEACTIVATE_TRACING=true " +
            "records none, and this test needs tracing on",
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0);
    return traces;
  }

  /** The typed integration codes the run's trace recorded (`error_code` in its logs). */
  async function traceErrorCodes(
    request: APIRequestContext,
    flowId: string,
  ): Promise<string[]> {
    const traces = await tracesOf(request, flowId);
    const res = await request.get(`/api/v1/monitor/traces/${traces[0].id}`, {
      headers: superHeaders,
    });
    expect(res.status()).toBe(200);
    // The root span repeats its child's output, so the codes are de-duplicated.
    const text = await res.text();
    return [...new Set([...text.matchAll(/"error_code":"([a-z-]+)"/g)].map((m) => m[1]))];
  }

  test(
    "a run the provider rejects surfaces no token in what it records",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/build/{flow_id}/flow",
        "GET /api/v1/connections",
        "GET /api/v1/monitor/messages",
        "GET /api/v1/monitor/builds",
        "GET /api/v1/monitor/transactions",
        "GET /api/v1/monitor/traces",
        "GET /api/v1/monitor/traces/{trace_id}",
      ]);
      const { connection, sentinels } = await providerBoundConnection(
        request,
        "PROVIDER",
      );
      let flowId: string | undefined;
      try {
        flowId = await saveFlow(
          request,
          driveNodes({ "DriveList-provider": `google/${connection.name}` }),
          "provider",
        );

        await test.step("the build stops at the provider: auth-expired", async () => {
          const stream = await build(request, superHeaders, flowId!);
          expectNoSentinel(stream, [sentinels], "the build stream");
          const errors = errorEvents(stream);
          // `scope-missing` or `connection-unresolved` here would mean the run never
          // reached Google. An outage code (Google down, no egress, rate-limited)
          // still fails, but names the outage so it classifies as infra (#1128).
          const codes = errors.map((e) => e.code);
          expect(
            codes,
            providerOutageMessage("google", codes) ?? stream.slice(0, 600),
          ).toEqual(["auth-expired"]);
          expect(errors[0].text).toBe(AUTH_EXPIRED_TEXT);
        });

        await test.step("the rejection was recorded on the connection", async () => {
          expect(
            (await connectionRow(request, superHeaders, connection.id)).status,
          ).toBe("expired");
        });

        for (const surface of ["messages", "builds", "transactions"] as const) {
          await test.step(`GET /api/v1/monitor/${surface} carries no token`, async () => {
            // Non-vacuous: each surface must have recorded this run (the transaction by
            // its handle input) before it is swept. Polled, because the vertex build
            // is written after the stream ends — measured empty on the first read.
            const marker =
              surface === "transactions"
                ? `google/${connection.name}`
                : AUTH_EXPIRED_TEXT;
            let text = "";
            await expect
              .poll(
                async () => {
                  const res = await request.get(
                    `/api/v1/monitor/${surface}?flow_id=${flowId}`,
                    { headers: superHeaders },
                  );
                  expect(res.status()).toBe(200);
                  text = await res.text();
                  return text.includes(marker);
                },
                { message: `monitor/${surface} recorded the run`, timeout: 15_000 },
              )
              .toBe(true);
            expectNoSentinel(text, [sentinels], `monitor/${surface}`);
          });
        }

        await test.step("the trace records the failure and carries no token", async () => {
          const traces = await tracesOf(request, flowId!);
          const list = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: superHeaders },
          );
          expectNoSentinel(await list.text(), [sentinels], "the trace list");
          const res = await request.get(
            `/api/v1/monitor/traces/${traces[0].id}`,
            { headers: superHeaders },
          );
          const text = await res.text();
          expect(res.status(), text.slice(0, 300)).toBe(200);
          expectNoSentinel(text, [sentinels], "the trace detail");
          expect(text, "the trace recorded the provider's verdict").toContain(
            '"error_code":"auth-expired"',
          );
        });
      } finally {
        if (flowId)
          await deleteFlow(request, flowId, { headers: superHeaders });
        await connection.deleteConnection(request);
      }
    },
  );

  test(
    "the Playground and the trace view show the provider's refusal, not the token",
    {
      tag: [
        "@stable",
        "@api",
        "@integrations",
        "@playground",
        "@observability",
      ],
    },
    async ({ page, request }) => {
      // The run fails at the provider on purpose; the gate would otherwise fail the test.
      (page as PageWithErrorHooks).allowFlowErrors();
      const { connection, sentinels } = await providerBoundConnection(
        request,
        "PLAYGROUND",
      );
      let flowId: string | undefined;
      try {
        flowId = await saveFlow(
          request,
          {
            nodes: [
              { id: "ChatInput-playground", type: "ChatInput" },
              {
                id: "DriveList-playground",
                type: DRIVE_LIST_TYPE,
                values: { connection: `google/${connection.name}` },
              },
            ],
            edges: [
              {
                source: "ChatInput-playground",
                output: "message",
                target: "DriveList-playground",
                field: "query",
              },
            ],
          },
          "playground",
        );

        await test.step("the Playground shows the refusal and no token", async () => {
          await page.goto(`/flow/${flowId}`);
          const playground = new PlaygroundPage(page);
          await playground.waitForLoad();
          await playground.open();
          await playground.sendMessage("list my files");
          const card = page.getByTestId("error-card").first();
          await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
          // The run's typed code, read where it was recorded, so an outage fails
          // naming the outage rather than as a text mismatch on the card (#1128).
          const codes = await traceErrorCodes(request, flowId!);
          expect(
            codes,
            providerOutageMessage("google", codes) ??
              "the run recorded the provider's verdict",
          ).toEqual(["auth-expired"]);
          await card.getByRole("button").first().click();
          await expect(card).toContainText(AUTH_EXPIRED_TEXT);
          expectNoSentinel(
            await page.content(),
            [sentinels],
            "the Playground page",
          );
          await playground.close();
        });

        await test.step("the trace view lists the Drive span with the provider's code and no token", async () => {
          await tracesOf(request, flowId!);
          await page.getByTestId("sidebar-nav-traces").click();
          await expect(page.getByTestId("flow-activity-header")).toBeVisible({
            timeout: 10_000,
          });
          // The Run cell is the wired click target (see traces-latency-tokens.spec.ts).
          await page.locator('.ag-cell[col-id="run"]').first().click();
          await expect(page.getByTestId("trace-detail-view")).toBeVisible({
            timeout: 10_000,
          });
          const driveSpan = page
            .locator('[data-testid^="span-node-"]')
            .filter({ hasText: "Drive: List Files" });
          await expect(driveSpan).toHaveCount(1);
          await driveSpan.click();
          await expect(page.getByTestId("span-detail")).toContainText(
            "auth-expired",
          );
          expectNoSentinel(await page.content(), [sentinels], "the trace view");
        });
      } finally {
        if (flowId)
          await deleteFlow(request, flowId, { headers: superHeaders });
        await connection.deleteConnection(request);
      }
    },
  );

  test(
    "a connection field is never a tool argument, and a handle naming another provider is refused",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/custom_component",
        "POST /api/v1/custom_component/update",
        "POST /api/v1/flows/download/",
        "POST /api/v1/build/{flow_id}/flow",
      ]);
      const guardComponent = (
        inputArgs: string,
      ) => `from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import ConnectionRefInput
from lfx.template.field.base import Output
from lfx.schema.message import Message


class SavedFlowGuardProbe(Component):
    display_name = "Saved-flow guard probe"
    name = "SavedFlowGuardProbe"
    inputs = [ConnectionRefInput(name="conn", display_name="Conn", provider="google"${inputArgs})]
    outputs = [Output(display_name="Out", name="out", method="run")]

    def run(self) -> Message:
        return Message(text="ok")
`;

      await test.step("control: the same component with a plain connection input validates", async () => {
        const res = await request.post("/api/v1/custom_component", {
          headers: superHeaders,
          data: { code: guardComponent("") },
        });
        expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
      });

      await test.step("a connection input declared as a tool-call input is refused", async () => {
        const res = await request.post("/api/v1/custom_component", {
          headers: superHeaders,
          data: { code: guardComponent(", tool_mode=True") },
        });
        const text = await res.text();
        expect(res.status(), text.slice(0, 300)).toBe(400);
        expect(text).toContain(
          "Connection references cannot be exposed as tool-call inputs",
        );
      });

      await test.step("a connection input defaulting to another provider's handle is refused", async () => {
        const res = await request.post("/api/v1/custom_component", {
          headers: superHeaders,
          data: { code: guardComponent(`, value="slack/saved_flow_${run}"`) },
        });
        const text = await res.text();
        expect(res.status(), text.slice(0, 300)).toBe(400);
        expect(text).toContain(
          "Connection reference provider 'slack' does not match declared provider 'google'",
        );
      });

      await test.step("in Tool Mode, no tool takes the connection as an argument", async () => {
        const drive = findCatalogComponent(catalog, DRIVE_LIST_TYPE) as Record<
          string,
          any
        >;
        for (const flagged of [false, true]) {
          const template = structuredClone(drive.template);
          // A saved template can carry the flag; the tool schema must not honour it.
          if (flagged) template.connection.tool_mode = true;
          const res = await request.post("/api/v1/custom_component/update", {
            headers: superHeaders,
            data: {
              code: template.code.value,
              template,
              field: "tool_mode",
              field_value: true,
              tool_mode: true,
            },
          });
          const text = await res.text();
          expect(res.status(), text.slice(0, 300)).toBe(200);
          const tools = JSON.parse(text).template.tools_metadata
            .value as Array<{ name: string; args: object }>;
          expect(
            tools.length,
            "Tool Mode exposed the connector's actions",
          ).toBeGreaterThan(0);
          for (const tool of tools) {
            expect(
              Object.keys(tool.args),
              `${tool.name} (field flagged: ${flagged})`,
            ).not.toContain("connection");
            // Non-vacuous: the action's own arguments are there.
            expect(Object.keys(tool.args)).toContain("query");
          }
        }
      });

      await test.step("a saved foreign-provider handle is kept, exported, and refused at run", async () => {
        const foreign = `slack/saved_flow_${run}`;
        const flowId = await saveFlow(
          request,
          driveNodes({ "DriveList-foreign": foreign }),
          "foreign",
        );
        try {
          const exported = JSON.parse(
            await downloadFlow(request, flowId),
          ) as FlowEnvelope;
          expect(
            handleOf(exported, "DriveList-foreign"),
            "well-formed, so the export keeps it",
          ).toBe(foreign);
          const stream = await build(request, superHeaders, flowId);
          const refusals = vertexErrors(stream);
          expect(refusals, stream.slice(0, 600)).toHaveLength(1);
          expect(refusals[0]).toContain(
            "Connection reference provider 'slack' does not match declared provider 'google'",
          );
          // Refused before any resolution: no resolver code was ever produced.
          for (const code of [
            "connection-unresolved",
            "scope-missing",
            "auth-expired",
          ]) {
            expect(stream, `no ${code}`).not.toContain(code);
          }
        } finally {
          await deleteFlow(request, flowId, { headers: superHeaders });
        }
      });
    },
  );
});
