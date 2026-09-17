/**
 * The shape of a template's graph, and the diff `templates-instantiate.spec.ts`
 * asserts on (#1864).
 *
 * The question that spec answers is whether picking a template's card creates a
 * flow that IS that template. Both sides of the comparison are graphs — the
 * template's entry in `GET /api/v1/flows/basic_examples/` and the persisted flow
 * from `GET /api/v1/flows/{id}` — so the comparison is over a reduction of each:
 * the multiset of component types, the edge count, and the note count.
 *
 * ## What is compared, and why in this spelling
 *
 * Measured on `1.13.0.dev12` across all 26 registered templates: **138 nodes with
 * `type === "genericNode"` and 29 without**. A component node carries its type at
 * `data.type` (`ChatInput`, `Prompt`, `LanguageModelComponent`, …); every other
 * node is a note.
 *
 * Notes are counted as "not a genericNode" rather than as `type === "noteNode"`
 * because the note nodes are not uniformly shaped: of *Basic Prompting*'s two,
 * one carries `data.type: "note"` and the other carries no `data.type` at all. A
 * rule keyed on the note's own shape is the fragile spelling; the component rule
 * is the sharp one, and notes are its complement.
 *
 * The component types are a **multiset, not a set**. Several templates repeat a
 * type — *Multi Agent Flow* has three Agents, *Deep Research Agent* has three —
 * so a set comparison would pass with two of the three silently dropped, which is
 * exactly the instantiation defect this spec exists to catch.
 *
 * ## Why the wiring is compared and not just the edge COUNT
 *
 * A count is blind to an edge that moved. The instantiation path is `updateIds`
 * (`src/frontend/src/utils/reactflowUtils.ts`), which rewrites every node id and
 * then repoints every edge through the id map — so "the edge landed on the wrong
 * node" is a live regression shape, and 7 of the 26 templates repeat a component
 * type, which is where it hides.
 *
 * `wiring` is therefore a one-round neighbourhood signature: per component node,
 * its type plus the sorted multiset of its incoming and outgoing neighbour TYPES.
 * Measured on `1.13.0.dev12` across all 26 templates, expected == actual **26 of
 * 26** — so it is assertable today with no divergence to tolerate.
 *
 * What it buys, measured rather than asserted: of the 7 templates where an edge
 * can be repointed onto a different node of the SAME type, this catches **6**; a
 * type-level topology (the multiset of `sourceType → targetType` pairs) catches
 * **0 of 7**, because moving an `Agent → Agent` edge between two Agents leaves
 * that multiset identical. The 1 it misses is *Deep Research Agent*, where the
 * constructed rewire lands between two nodes whose 1-hop neighbourhoods coincide;
 * distinguishing those needs a second refinement round, which is not taken —
 * 6 of 7 for one round is the trade, and the residual is named rather than hidden.
 *
 * ## Layering
 *
 * Everything here is pure and cannot throw; the spec holds the requests and the
 * assertions. Same split as `registered-templates-drift.ts` (#1862), and for the
 * reason its review established: decision logic living in a spec is logic no unit
 * test covers, and its rarely-taken branches are then pinned nowhere at all.
 *
 * There is no "empty" verdict: a graph that cannot be read is `null` — UNKNOWN,
 * never "a graph with zero components" (#1012). A template with zero component
 * nodes does not exist on this image (the smallest, *Image Sentiment Analysis*,
 * has 3).
 *
 * **What a zero reading MEANS differs by side, and the caller says so.** On the
 * expected side (the listing) it is a parse failure, because no registered
 * template is empty. On the ACTUAL side it can also be the product's own answer —
 * the template instantiated as an empty canvas, which is the severest defect this
 * spec exists to catch. Both are `null` here, both are red, and the spec's message
 * names both readings rather than calling the second one unparseable.
 */

/** A graph reduced to what instantiation must preserve. */
export interface GraphShape {
  /** Component types, **sorted**, one entry per node — a multiset, not a set. */
  componentTypes: string[];
  edgeCount: number;
  /** Every node that is not a `genericNode`. */
  noteCount: number;
  /**
   * One canonical line per component node — its type and the sorted neighbour
   * types on each side — **sorted**, and a multiset like `componentTypes`. This
   * is what notices an edge that moved rather than vanished.
   */
  wiring: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * Reduces a flow's `data` to its comparable shape.
 *
 * `null` means **no signal**, which the spec turns into a named failure rather
 * than into a comparison. Four bodies produce it, and each would otherwise diff
 * as a real difference:
 *
 *  - `data` that is not an object, or carries no `nodes`/`edges` arrays;
 *  - a node that is not an object;
 *  - a `genericNode` with no readable `data.type` — the component type IS the
 *    observation, so an unreadable one is not "a component called undefined";
 *  - zero component nodes, which no registered template has — and which, read
 *    from a CREATED flow, is the empty-canvas defect rather than a parse failure
 *    (see the module header).
 */
export function graphShape(data: unknown): GraphShape | null {
  if (!isRecord(data)) return null;
  const { nodes, edges } = data;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;

  const componentTypes: string[] = [];
  let noteCount = 0;
  for (const node of nodes) {
    if (!isRecord(node)) return null;
    if (node.type !== "genericNode") {
      noteCount += 1;
      continue;
    }
    const inner = node.data;
    if (!isRecord(inner) || !isNonEmptyString(inner.type)) return null;
    componentTypes.push(inner.type);
  }
  if (componentTypes.length === 0) return null;

  // Node ids are rewritten by `updateIds` on instantiation, so they are never
  // compared; what IS comparable is each node's neighbourhood expressed in types.
  const typeById = new Map<string, string>();
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    if (n.type !== "genericNode") continue;
    const id = n.id;
    const inner = n.data as Record<string, unknown>;
    if (isNonEmptyString(id)) typeById.set(id, inner.type as string);
  }
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isRecord(edge)) return null;
    const { source, target } = edge;
    if (!isNonEmptyString(source) || !isNonEmptyString(target)) continue;
    const sourceType = typeById.get(source);
    const targetType = typeById.get(target);
    // An edge touching a non-component node contributes to `edgeCount` but has no
    // type to name, so it is left out of the signature rather than guessed at.
    if (sourceType === undefined || targetType === undefined) continue;
    (outgoing.get(source) ?? outgoing.set(source, []).get(source)!).push(targetType);
    (incoming.get(target) ?? incoming.set(target, []).get(target)!).push(sourceType);
  }
  const wiring: string[] = [];
  for (const [id, type] of typeById) {
    const inTypes = [...(incoming.get(id) ?? [])].sort();
    const outTypes = [...(outgoing.get(id) ?? [])].sort();
    wiring.push(`${type} ←(${inTypes.join(", ")}) →(${outTypes.join(", ")})`);
  }

  // Sorted so the comparison is order-independent while staying count-sensitive:
  // node order in the persisted flow is not a contract, the multiset is.
  componentTypes.sort();
  wiring.sort();
  return { componentTypes, edgeCount: edges.length, noteCount, wiring };
}

/**
 * How two shapes differ, one human line per difference. Empty when they are equal.
 *
 * The component line names the types that moved rather than printing both full
 * multisets: on an 8-node template the two lists are what a reader has to diff by
 * eye, and the whole point of this spec is that the failure says what changed.
 */
export function describeShapeDiff(expected: GraphShape, actual: GraphShape): string[] {
  const lines: string[] = [];

  const counts = (types: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const t of types) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const want = counts(expected.componentTypes);
  const got = counts(actual.componentTypes);
  for (const type of [...new Set([...want.keys(), ...got.keys()])].sort()) {
    const w = want.get(type) ?? 0;
    const g = got.get(type) ?? 0;
    if (w === g) continue;
    lines.push(
      g === 0
        ? `component type ${type} is missing from the created flow (the template has ${w})`
        : w === 0
          ? `component type ${type} appears ${g}× in the created flow and not at all in the template`
          : `component type ${type}: the template has ${w}, the created flow has ${g}`,
    );
  }

  if (expected.edgeCount !== actual.edgeCount) {
    lines.push(
      `edge count: the template has ${expected.edgeCount}, the created flow has ${actual.edgeCount}`,
    );
  }
  if (expected.noteCount !== actual.noteCount) {
    lines.push(
      `note count: the template has ${expected.noteCount}, the created flow has ${actual.noteCount}`,
    );
  }

  // Wiring last: when an edge MOVED, the counts above are all equal and this is
  // the only thing that differs, so it reads as the finding rather than as a
  // footnote to three lines that said nothing.
  const wantWiring = counts(expected.wiring);
  const gotWiring = counts(actual.wiring);
  for (const entry of [...new Set([...wantWiring.keys(), ...gotWiring.keys()])].sort()) {
    const w = wantWiring.get(entry) ?? 0;
    const g = gotWiring.get(entry) ?? 0;
    if (w === g) continue;
    lines.push(
      g === 0
        ? `wiring: the template has a node "${entry}" and the created flow has none`
        : w === 0
          ? `wiring: the created flow has a node "${entry}" that the template does not`
          : `wiring "${entry}": the template has ${w}, the created flow has ${g}`,
    );
  }
  return lines;
}

/**
 * Whether a persisted flow name is the template's.
 *
 * The backend de-duplicates a name that already exists by appending ` (N)`, and
 * many templates are loaded by several specs, so under parallel workers the
 * suffix is EXPECTED rather than a defect — but the stem must still be the
 * template's. That is what stops a future name collision from passing with the
 * wrong template: `loadTemplateByName` matches the card heading without `exact`,
 * so on an image where one template name became a substring of another, this is
 * the assertion that notices.
 */
export function nameMatchesTemplate(persisted: unknown, templateName: string): boolean {
  if (typeof persisted !== "string") return false;
  if (persisted === templateName) return true;
  // The stem is compared literally, never as a regex source: template names carry
  // regex metacharacters (`Document Q&A`, and `(`/`)` would be the dangerous one).
  if (!persisted.startsWith(`${templateName} (`) || !persisted.endsWith(")")) return false;
  const suffix = persisted.slice(templateName.length + 2, -1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}
