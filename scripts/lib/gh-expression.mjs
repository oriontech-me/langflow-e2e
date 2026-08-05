// Evaluate a GitHub Actions `${{ … }}` expression against a supplied context.
//
// WHY THIS EXISTS. #1226 established the rule this repo now works by: a regex over
// workflow text pins a SPELLING, not a behaviour, and such a guard reliably passes
// the mutation it was written to catch. #1300's first attempt at a tracing guard
// proved it again — it asserted that the workflow's LANGFLOW_DEACTIVATE_TRACING
// value "includes needs_models", and every one of these genuinely broken edits
// passed it:
//
//   needs_models == 'false'          → tracing OFF on exactly the LLM runs
//   … && 'true' || 'false'           → the same inversion, branches swapped
//
// Both mention `needs_models`. Only evaluating the expression can tell them apart,
// so that is what this does: the caller states what the run looks like
// (`needs_models` is 'true', the impacted set is empty) and asks what the workflow
// would actually set.
//
// SCOPE, deliberately small. This understands the operators these workflows use —
// `!`, `==`, `!=`, `&&`, `||`, parentheses, string/number/boolean literals,
// `contains()`, `startsWith()`, `endsWith()` — and nothing else. Anything outside
// that grammar, and any context path the caller did not supply, THROWS rather than
// evaluating to a default. A guard that silently treats an unknown reference as
// empty is how the class of bug above comes back: the expression would still
// evaluate, to a number nobody chose. Same fail-closed rule the rest of the repo's
// verdict scripts follow (#1035).
//
// Not a general Actions engine: no `github.*`/`env.*` semantics, no object
// filters, no `format()`/`join()`/`fromJSON()`, no `hashFiles()`. Add an operator
// here when a workflow needs one, with a test.

const LITERALS = { true: true, false: false, null: null };

// GitHub's truthiness, which is not JavaScript's: it coerces to a number where it
// can, so '' and 0 are false and any non-empty string that is not a number is
// true. Only the cases this grammar can produce are modelled.
function truthy(value) {
  if (typeof value === "string") return value !== "" && value !== "0";
  return Boolean(value);
}

// `==` in Actions is loose across types (it casts to number when the operands
// differ), but every comparison in these workflows is string-to-string literal, so
// this stays strict on same-typed operands and refuses a mixed one instead of
// guessing which cast the author meant.
function looseEquals(a, b) {
  if (typeof a === typeof b) return a === b;
  if (a === null || b === null) return a === b;
  throw new Error(
    `gh-expression: refusing to compare ${typeof a} with ${typeof b} — ` +
      "Actions would cast these, and this evaluator does not model the cast",
  );
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      // Actions escapes a quote by doubling it.
      let value = "";
      i += 1;
      for (;;) {
        if (i >= source.length) throw new Error(`gh-expression: unterminated string in \`${source}\``);
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += source[i];
        i += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === "!") {
      tokens.push({ type: ch === "!" ? "op" : ch, value: ch });
      i += 1;
      continue;
    }
    const word = /^[A-Za-z0-9_.\-*]+/.exec(source.slice(i));
    if (!word) throw new Error(`gh-expression: unexpected character \`${ch}\` in \`${source}\``);
    tokens.push({ type: "word", value: word[0] });
    i += word[0].length;
    continue;
  }
  return tokens;
}

const FUNCTIONS = {
  contains: (haystack, needle) => String(haystack).includes(String(needle)),
  startsWith: (value, prefix) => String(value).startsWith(String(prefix)),
  endsWith: (value, suffix) => String(value).endsWith(String(suffix)),
};

function parse(tokens, source, context) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const token = next();
    if (!token) throw new Error(`gh-expression: unexpected end of \`${source}\``);
    if (token.type === "string") return token.value;
    if (token.type === "(") {
      const value = or();
      const close = next();
      if (!close || close.type !== ")") throw new Error(`gh-expression: unbalanced parentheses in \`${source}\``);
      return value;
    }
    if (token.type === "op" && token.value === "!") return !truthy(primary());
    if (token.type === "word") {
      if (peek()?.type === "(") {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error(`gh-expression: unsupported function \`${token.value}()\` in \`${source}\``);
        next();
        const args = [];
        if (peek()?.type !== ")") {
          for (;;) {
            args.push(or());
            if (peek()?.type === ",") {
              next();
              continue;
            }
            break;
          }
        }
        const close = next();
        if (!close || close.type !== ")") throw new Error(`gh-expression: unbalanced call in \`${source}\``);
        if (args.length !== fn.length) {
          throw new Error(`gh-expression: \`${token.value}()\` takes ${fn.length} argument(s) in \`${source}\``);
        }
        return fn(...args);
      }
      if (token.value in LITERALS) return LITERALS[token.value];
      if (/^-?\d+(\.\d+)?$/.test(token.value)) return Number(token.value);
      if (!(token.value in context)) {
        throw new Error(
          `gh-expression: no value supplied for \`${token.value}\` — ` +
            "supply it in the context rather than letting it default",
        );
      }
      return context[token.value];
    }
    throw new Error(`gh-expression: unexpected token \`${token.value}\` in \`${source}\``);
  }

  function comparison() {
    let left = primary();
    while (peek()?.type === "op" && (peek().value === "==" || peek().value === "!=")) {
      const op = next().value;
      const right = primary();
      left = op === "==" ? looseEquals(left, right) : !looseEquals(left, right);
    }
    return left;
  }

  // `&&` and `||` yield an OPERAND, not a boolean — that is what makes
  // `cond && 'false' || 'true'` the Actions idiom for a ternary, and modelling it
  // as a boolean would make every such expression evaluate to `true`.
  function and() {
    let left = comparison();
    while (peek()?.type === "op" && peek().value === "&&") {
      next();
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function or() {
    let left = and();
    while (peek()?.type === "op" && peek().value === "||") {
      next();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const value = or();
  if (pos !== tokens.length) throw new Error(`gh-expression: trailing input in \`${source}\``);
  return value;
}

// Evaluate the body of a `${{ … }}` (without the delimiters).
export function evaluateExpression(source, context = {}) {
  return parse(tokenize(source), source, context);
}

// Evaluate a workflow VALUE as written in the YAML — either a whole-value
// `${{ … }}`, or a plain scalar (optionally quoted), which is returned as the
// string it is. A value that merely CONTAINS an interpolation among other text is
// refused: reading it would need YAML-level string concatenation this does not
// model, and the alternative — returning it half-evaluated — is the silent
// almost-right answer the whole module exists to avoid.
export function evaluateWorkflowValue(raw, context = {}) {
  const value = String(raw).trim();
  const whole = /^\$\{\{(.*)\}\}$/s.exec(value);
  if (whole) {
    if (whole[1].includes("${{")) throw new Error(`gh-expression: nested interpolation in \`${value}\``);
    return evaluateExpression(whole[1], context);
  }
  if (value.includes("${{")) {
    throw new Error(`gh-expression: \`${value}\` mixes an interpolation with literal text — not modelled`);
  }
  const quoted = /^(['"])(.*)\1$/s.exec(value);
  return quoted ? quoted[2] : value;
}
