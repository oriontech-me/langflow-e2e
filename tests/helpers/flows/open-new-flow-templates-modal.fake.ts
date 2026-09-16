// A fake Playwright `Page` covering exactly the surface `openNewFlowTemplatesModal`
// touches, so its recovery from a blank editor (#1865) can be asserted without a
// browser.
//
// NOT a test file — it defines no `test()`. `npm run test:units` collects
// `*.test.ts` only and Playwright's `testMatch` is `*.spec.ts`, so this file is
// imported by tests and never executed as one.
//
// What it simulates is the path a live instance does not produce on demand:
// "New Flow" creates a flow and navigates to its editor, and the editor's types
// request (`GET /api/v1/all?force_refresh=true&flow_id=<id>`) answers 404 because
// the creation had not committed yet (LE-2598). The frontend never retries a 4xx,
// so that editor stays blank for good — no canvas, no welcome overlay, no modal.
// CI loses that race under shard load; ~3550 local POST→GET pairs never did.
//
// Time is simulated: `waitForTimeout(ms)` advances the clock and fires whatever
// the open editor scheduled by then, and the helper reads the same clock through
// its `now` seam. The waits under test are 8 s and 30 s long, so a real clock
// would cost every unhappy test 38 s.

export interface ScriptedResponse {
  /** Milliseconds after the New Flow click. */
  at: number;
  /** Path and query; `{id}` is replaced by the flow this entry created. */
  path: string;
  status: number;
}

/** What one New Flow click leads to. */
export interface EntryScript {
  /** Responses the new editor produces. */
  responses?: ScriptedResponse[];
  /** Milliseconds after the click at which the welcome overlay renders; omitted = never. */
  welcomeAt?: number;
  /**
   * Milliseconds after the click at which the templates modal renders DIRECTLY,
   * without the welcome overlay — what an older build does, and what the
   * welcome-panel entry has to refuse rather than silently accept.
   */
  modalAt?: number;
}

export interface FakeNewFlowPage {
  page: any;
  /** The simulated clock, for the helper's `now` seam. */
  now: () => number;
  /** How many New Flow clicks created a flow. */
  readonly entries: number;
  /** Flow ids passed to `DELETE /api/v1/flows/<id>`, in order. */
  readonly deleted: string[];
  /** Every URL passed to `page.goto`, in order. */
  readonly gotos: string[];
  readonly modalOpen: boolean;
  /** `response` listeners still attached to the page. */
  readonly responseListeners: number;
}

const ORIGIN = "http://localhost:7860";
const ENTRY_POINTS = ["new-project-btn", "new_project_btn_empty_page"];

export function fakeNewFlowPage(scripts: EntryScript[]): FakeNewFlowPage {
  const state = {
    clock: 0,
    url: `${ORIGIN}/`,
    /** The flow whose editor is open; `null` on the home page. */
    flow: null as string | null,
    entries: 0,
    welcome: false,
    modal: false,
    deleted: [] as string[],
    gotos: [] as string[],
    listeners: [] as ((resp: any) => void)[],
    scheduled: [] as { at: number; flow: string; fire: () => void }[],
  };

  const visible = (testId: string): boolean => {
    switch (testId) {
      case "mainpage_title":
      case "new-project-btn":
      case "cards-wrapper":
      case "list-card":
        return state.flow === null;
      case "flow-builder-welcome-panel":
      case "flow-builder-welcome-browse-more":
        return state.welcome;
      case "modal-title":
        return state.modal;
      default:
        // `new_project_btn_empty_page` included: the instance has flows, so the
        // header button is the entry point.
        return false;
    }
  };

  const emit = (path: string, status: number) => {
    const resp = {
      url: () => `${ORIGIN}${path}`,
      status: () => status,
      request: () => ({ method: () => "GET" }),
    };
    for (const listener of [...state.listeners]) listener(resp);
  };

  const newFlow = () => {
    const script = scripts[state.entries];
    if (!script) {
      throw new Error(`fake: unscripted New Flow click #${state.entries + 1}`);
    }
    state.entries += 1;
    const id = `flow-${state.entries}`;
    state.flow = id;
    state.url = `${ORIGIN}/flow/${id}`;
    for (const r of script.responses ?? []) {
      state.scheduled.push({
        at: state.clock + r.at,
        flow: id,
        fire: () => emit(r.path.replace("{id}", id), r.status),
      });
    }
    if (script.welcomeAt !== undefined) {
      state.scheduled.push({
        at: state.clock + script.welcomeAt,
        flow: id,
        fire: () => {
          state.welcome = true;
        },
      });
    }
    if (script.modalAt !== undefined) {
      state.scheduled.push({
        at: state.clock + script.modalAt,
        flow: id,
        fire: () => {
          state.modal = true;
        },
      });
    }
  };

  const advance = (ms: number) => {
    state.clock += ms;
    const due = state.scheduled
      .filter((e) => e.at <= state.clock)
      .sort((a, b) => a.at - b.at);
    state.scheduled = state.scheduled.filter((e) => e.at > state.clock);
    // An editor the page has already left fires nothing.
    for (const e of due) if (e.flow === state.flow) e.fire();
  };

  const locator = (testIds: string[]): any => ({
    testIds,
    isVisible: async () => testIds.some(visible),
    first: () => locator(testIds),
    or: (other: { testIds: string[] }) => locator([...testIds, ...other.testIds]),
    click: async () => {
      const target = testIds.find(visible);
      if (!target) {
        throw new Error(`locator.click: Timeout 15000ms exceeded — ${testIds.join(" | ")} is not on the page`);
      }
      if (ENTRY_POINTS.includes(target)) return newFlow();
      if (target === "flow-builder-welcome-browse-more") {
        state.welcome = false;
        state.modal = true;
        return;
      }
      throw new Error(`fake: clicking ${target} is not modelled`);
    },
  });

  const testIdOf = (selector: string): string =>
    /data-testid="([^"]+)"/.exec(selector)?.[1] ?? selector;

  const page = {
    on: (event: string, handler: (resp: any) => void) => {
      if (event === "response") state.listeners.push(handler);
    },
    off: (event: string, handler: (resp: any) => void) => {
      if (event === "response") {
        state.listeners = state.listeners.filter((h) => h !== handler);
      }
    },
    url: () => state.url,
    goto: async (url: string) => {
      state.gotos.push(url);
      if (url !== "/") throw new Error(`fake: navigating to ${url} is not modelled`);
      state.flow = null;
      state.url = `${ORIGIN}/`;
      state.welcome = false;
      state.modal = false;
    },
    waitForTimeout: async (ms: number) => advance(ms),
    waitForSelector: async (selector: string) => {
      if (visible(testIdOf(selector))) return;
      throw new Error(`TimeoutError: page.waitForSelector: waiting for ${selector}`);
    },
    getByTestId: (testId: string) => locator([testId]),
    locator: (selector: string) => locator([testIdOf(selector)]),
    request: {
      get: async (url: string) =>
        url.includes("auto_login")
          ? { ok: () => true, json: async () => ({ access_token: "fake" }) }
          : { ok: () => true, status: () => 200, json: async () => ({}) },
      delete: async (url: string) => {
        state.deleted.push(url.replace("/api/v1/flows/", ""));
        return { ok: () => true, status: () => 200 };
      },
    },
  };

  return {
    page,
    now: () => state.clock,
    get entries() {
      return state.entries;
    },
    get deleted() {
      return state.deleted;
    },
    get gotos() {
      return state.gotos;
    },
    get modalOpen() {
      return state.modal;
    },
    get responseListeners() {
      return state.listeners.length;
    },
  };
}
