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
 * has 3), so a zero reading is a parse failure, not a measurement.
 */

/** A graph reduced to what instantiation must preserve. */
export interface GraphShape {
  /** Component types, **sorted**, one entry per node — a multiset, not a set. */
  componentTypes: string[];
  edgeCount: number;
  /** Every node that is not a `genericNode`. */
  noteCount: number;
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
 *  - zero component nodes, which no registered template has.
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

  // Sorted so the comparison is order-independent while staying count-sensitive:
  // node order in the persisted flow is not a contract, the multiset is.
  componentTypes.sort();
  return { componentTypes, edgeCount: edges.length, noteCount };
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
