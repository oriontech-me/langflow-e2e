// Blank the comments out of a TypeScript source, for the structural guards that
// scan the suite's own code (`open-flow-settings.test.ts`, `permissions-gate.test.ts`).
//
// ONE COPY, FOR THE SAME REASON THE BUDGET IS ONE CONSTANT
//
// This was two copies, and they had already drifted into carrying the same
// defect twice: the guard that #1222 added cloned it from the guard #1215 added.
// A leaf module importing nothing, so it couples nothing in
// `impacted-specs-by-import.mjs`'s transitive graph (#1054) — no spec imports it,
// only the two guards do.
//
// BLANKED, NOT DELETED
//
// Deleting a block comment shifts every line below it, so the caller's `lineOf`
// names a line the offender is not on — measured at 50 lines of skew on
// `setup-playground.ts`, where the real gate at line 198 was reported as 148.
// A wrong line number is worse than none, because it reads as precise. Blanking
// also stops a removal from JOINING the tokens either side of it
// (`foo/*c*\/bar` -> `foobar`), which could synthesise a match that is not in
// the source.
//
// WHY A SCANNER AND NOT TWO REGEXES
//
// Both copies used to be `/\/\*[\s\S]*?\*\//g` followed by a line-comment regex,
// and a context-free `/*` is wrong in the one way that matters to a guard: it
// goes QUIET. Any `/*` substring opened a comment that ran to the next `*/`
// anywhere in the file, and the suite is full of both halves:
//
//   - `'//*[@id="react-flow-id"]'`, the xpath idiom, 49 occurrences under `tests/`;
//   - `` `tests/fixtures/**` `` inside a line comment — which is
//     `open-flow-by-id.ts:20`, one of the two files the #1222 guard names as
//     canonical. It opened a span closing at the next JSDoc's `*/`, blanking 10
//     lines of real code including line 55, the `PERMISSIONS_GATE_TIMEOUT_MS`
//     import itself. A gate written anywhere in that window was invisible:
//     measured, injected at line 46, found 0.
//   - `run-flow.spec.ts` lost 37 lines of real code the same way.
//
// The line-comment half was mis-documented rather than merely narrow: it claimed
// to match `//` after start-of-line or whitespace, but `(^|[^:\w])` admits any
// non-colon non-word character, so `page.locator('//*[…]')` had its line tail
// blanked too — and `await page.goto("//x")` blanked the rest of that line
// outright.
//
// Scanning left to right fixes both halves at once, because it is the ORDER that
// was missing, not a bigger pattern: inside a string nothing opens a comment, and
// inside a line comment nothing opens a block.
//
// WHAT IT DOES NOT DO, AND WHY THAT IS SAFE HERE
//
// It does not track regex literals, which would need to distinguish `/` as a
// delimiter from `/` as division — the classic lexer ambiguity, and not worth a
// guard's complexity budget. It is safe for this suite because a regex literal
// cannot contain a bare `/*` (a quantifier with no atom is a syntax error) or a
// bare `//` (an empty regex), so the escaped forms the guards themselves use
// (`/\/\*[\s\S]*?\*\//`) never present either token contiguously. `${}`
// interpolation inside a template literal is treated as string content; a
// backtick nested inside one would end the literal early, which has no instance
// in the tree.
//
// Strings are PRESERVED, not blanked: the guards match on locator arguments, so
// `getByTestId("menu_bar_display")` has to survive.

/**
 * Replace every comment character with a space, leaving newlines, string
 * contents and every other offset exactly where they were.
 *
 * The returned text has the same length and the same line breaks as the input,
 * which is what lets a caller report `line` and column against the original.
 */
export function stripComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      let end = i;
      while (end < source.length && source[end] !== "\n") end++;
      blank(i, end);
      i = end;
      continue;
    }

    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === char) {
          end++;
          break;
        }
        // An unterminated quote on one line is a quote character in prose, not a
        // string — bail at the newline rather than swallowing the rest of the file.
        if (char !== "`" && source[end] === "\n") break;
        end++;
      }
      i = end;
      continue;
    }

    i++;
  }

  return out.join("");
}
