// A fake Playwright `Page` covering exactly the surface `loadTemplateByName`
// touches, so its #1002 branches (retry on a failed creation POST, recovery of a
// lost navigation, cleanup of what it created) can be asserted without a
// browser. Opening the templates modal is injected instead of faked — see
// `LoadTemplateDeps` for why.
//
// The script drives one thing: what the template-instantiation
// `POST /api/v1/flows/` answers on each attempt, and whether the editor renders.

export interface AttemptScript {
  /** Status the creation POST answers with on this attempt. */
  status: number;
  /** Id returned on a 201. Defaults to `flow-<n>`. */
  id?: string;
  /** `detail` returned on an error. */
  detail?: string;
  /**
   * Whether the canvas gate resolves after this attempt's creation. `false`
   * simulates the SPA losing the navigation and staying on the flows list.
   */
  editorOpens?: boolean;
}

export interface FakePageOptions {
  attempts: AttemptScript[];
  /**
   * Whether `page.goto('/flow/<id>')` recovery makes the editor render.
   * Defaults to true.
   */
  recoveryWorks?: boolean;
  /** Ids the entry point creates on its own (the `New Flow` of #1002). */
  entryPointIds?: string[];
  /**
   * Simulate a response whose body the browser never delivers — what actually
   * happens to the entry point's creation once the SPA navigates away. `json()`
   * then pends forever, which is how the first version of the fix hung past the
   * 5-minute test timeout.
   */
  entryPointBodyNeverDelivered?: boolean;
}

export interface FakePage {
  page: any;
  /** Every URL passed to `page.goto`, in order. */
  gotos: string[];
  /** Flow ids passed to `DELETE /api/v1/flows/<id>`, in order. */
  deleted: string[];
  /** How many times the template heading was clicked. */
  picks: number;
  /** How many times the injected modal-opener ran. */
  modalOpens: number;
  openModal: (page: any) => Promise<void>;
}

export function fakePage(options: FakePageOptions): FakePage {
  const {
    attempts,
    recoveryWorks = true,
    entryPointIds = [],
    entryPointBodyNeverDelivered = false,
  } = options;
  const state = {
    gotos: [] as string[],
    deleted: [] as string[],
    picks: 0,
    modalOpens: 0,
    url: "http://localhost:7860/flows",
    editorOpen: false,
    responseHandlers: [] as ((resp: any) => void)[],
  };

  const flowResponse = (
    status: number,
    body: Record<string, unknown>,
    bodyNeverDelivered = false,
  ) => ({
    url: () => "http://localhost:7860/api/v1/flows/",
    request: () => ({ method: () => "POST" }),
    status: () => status,
    ok: () => status >= 200 && status < 300,
    json: bodyNeverDelivered
      ? () => new Promise<Record<string, unknown>>(() => {})
      : async () => body,
  });

  /** Emit a POST /api/v1/flows response to whatever the helper registered. */
  const emit = (
    status: number,
    body: Record<string, unknown>,
    bodyNeverDelivered = false,
  ) => {
    const resp = flowResponse(status, body, bodyNeverDelivered);
    // Iterate a copy: a `waitForResponse` handler removes itself when it fires.
    for (const h of [...state.responseHandlers]) h(resp);
    return resp;
  };

  const page = {
    on: (event: string, handler: (resp: any) => void) => {
      if (event === "response") state.responseHandlers.push(handler);
    },
    off: (event: string, handler: (resp: any) => void) => {
      if (event === "response") {
        state.responseHandlers = state.responseHandlers.filter((h) => h !== handler);
      }
    },
    url: () => state.url,
    goto: async (url: string) => {
      state.gotos.push(url);
      if (url.startsWith("/flow/")) {
        state.url = `http://localhost:7860${url}`;
        state.editorOpen = recoveryWorks;
      } else {
        state.url = "http://localhost:7860/flows";
        state.editorOpen = false;
      }
    },
    waitForTimeout: async () => {},
    waitForSelector: async (selector: string) => {
      if (selector.includes("mainpage_title")) return;
      if (selector.includes("canvas_controls_dropdown")) {
        if (state.editorOpen) return;
        throw new Error(`TimeoutError: waiting for ${selector}`);
      }
    },
    getByTestId: () => ({ click: async () => {} }),
    getByRole: () => ({
      first: () => ({
        click: async () => {
          const script = attempts[Math.min(state.picks, attempts.length - 1)];
          state.picks += 1;
          const id = script.id ?? `flow-${state.picks}`;
          if (script.status >= 200 && script.status < 300) {
            emit(script.status, { id, name: "Basic Prompting" });
            state.editorOpen = script.editorOpens ?? true;
            if (state.editorOpen) state.url = `http://localhost:7860/flow/${id}`;
          } else {
            emit(script.status, {
              detail: script.detail ?? "An internal error occurred while creating the flow.",
            });
          }
        },
      }),
    }),
    // Resolves on the first emitted response the predicate accepts — the same
    // contract as Playwright's, and the reason the helper can await it before
    // clicking.
    waitForResponse: (predicate: (resp: any) => boolean) =>
      new Promise((resolve) => {
        const collect = (resp: any) => {
          if (!predicate(resp)) return;
          state.responseHandlers = state.responseHandlers.filter((h) => h !== collect);
          resolve(resp);
        };
        state.responseHandlers.push(collect);
      }),
    request: {
      get: async (url: string) => {
        if (url.includes("auto_login")) {
          return { ok: () => true, json: async () => ({ access_token: "fake" }) };
        }
        return { ok: () => true, json: async () => ({}) };
      },
      delete: async (url: string) => {
        state.deleted.push(url.replace("/api/v1/flows/", ""));
        return { ok: () => true, status: () => 200 };
      },
    },
  };

  return {
    page,
    get gotos() {
      return state.gotos;
    },
    get deleted() {
      return state.deleted;
    },
    get picks() {
      return state.picks;
    },
    get modalOpens() {
      return state.modalOpens;
    },
    openModal: async () => {
      state.modalOpens += 1;
      // The entry point creates a flow of its own before the modal opens — the
      // #1002 leak. One per configured id, consumed in order.
      const id = entryPointIds[state.modalOpens - 1];
      if (id) emit(201, { id, name: "New Flow" }, entryPointBodyNeverDelivered);
    },
  };
}
