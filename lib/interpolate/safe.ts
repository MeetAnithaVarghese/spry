// Safe Interpolator
//
// Safe, configurable text interpolation with:
//  - Arbitrary delimiters (prefix + open + close), each with an ID
//  - Mini expression language: literals, paths, function calls, backtick templates
//  - Function registry for safe, predefined operations (aware of bracketID)
//  - Hook to post-process resolved paths (`resolvedPath`)
//  - Recursive interpolation for backtick template strings (depth limited)
//  - Pluggable escaping (HTML, text, etc.)
//  - No eval / Function / arbitrary JS execution

// -----------------------------------------------------------------------------
// SafeString & escaping utilities
// -----------------------------------------------------------------------------

/**
 * Marker type for values that have already been safely escaped for the
 * target context (e.g. HTML).
 */
export interface SafeString {
  readonly __safe: true;
  readonly value: string;
}

export const SafeString = {
  from(value: string): SafeString {
    return { __safe: true as const, value };
  },
  isSafe(value: unknown): value is SafeString {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as SafeString).__safe === true &&
      typeof (value as SafeString).value === "string"
    );
  },
};

/**
 * Basic HTML escaping for untrusted values.
 * Escapes &, <, >, ", and '.
 */
export function escapeHtml(value: unknown): string {
  const s = String(
    value === null || typeof value === "undefined" ? "" : value,
  );
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Default escaping strategy: if you pass a SafeString, use as-is; otherwise
 * HTML-escape the value.
 */
export function defaultEscape(value: unknown): string {
  if (SafeString.isSafe(value)) return value.value;
  return escapeHtml(value);
}

// -----------------------------------------------------------------------------
// Core interpolation types
// -----------------------------------------------------------------------------

/**
 * Context type for Safe Interpolator.
 * You can narrow this in your own code via intersection or casting.
 */
// deno-lint-ignore no-explicit-any
export type SafeInterpolationContext = any;
export type SIC = SafeInterpolationContext;

/**
 * A delimiter configuration: optional prefix + open + close.
 *
 * Examples:
 *   { id: "dollar",  prefix: "$", open: "{",  close: "}"  } //  ${ expr }
 *   { id: "curly2",  open: "{{",  close: "}}" }             //  {{ expr }}
 *   { id: "percent", prefix: "%", open: "{",  close: "}"  } //  %{ expr }
 *   { id: "angle",   open: "<<",  close: ">>" }             //  << expr >>
 *
 * `id` is required and is passed into functions, hooks, etc.
 * Order matters if you have overlapping patterns: the first match wins.
 */
export interface SafeBracketSpec {
  readonly id: string;
  readonly prefix?: string;
  readonly open: string;
  readonly close: string;
}

/**
 * Function registry entry: implement your own safe operations here.
 * Receives bracketID so behavior can differ by bracket.
 */
export type SafeInterpolationFunction = (
  args: unknown[],
  context: SafeInterpolationContext,
  info: { readonly bracketID: string },
) => unknown;

/**
 * Registry mapping function names (in expressions) to implementations.
 */
export type SafeInterpolationFunctionRegistry = Record<
  string,
  SafeInterpolationFunction
>;

/**
 * Strategy for handling expressions that resolve to missing/undefined values.
 */
export type SafeMissingValueStrategy =
  | "leave" // leave the original expression text in place
  | "empty" // replace with empty string
  | "throw" // throw an error
  | ((
    exprText: string,
    info: {
      readonly context: SafeInterpolationContext;
      readonly bracketID: string;
    },
  ) => string);

/**
 * Hook that is called whenever a *path* is resolved, before being used or
 * passed further down. You can transform the value depending on the path or
 * bracket type (e.g. different behavior for `${}` vs `%{}`).
 */
export interface SafeResolvedPathParams {
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly bracketID: string;
  readonly context: SafeInterpolationContext;
}

export type SafeResolvedPathHook = (
  params: SafeResolvedPathParams,
) => unknown;

/**
 * Options for the safeInterpolate() function.
 */
export interface SafeInterpolationOptions {
  /**
   * One or more delimiter configurations. First match wins.
   */
  readonly brackets: readonly SafeBracketSpec[];

  /**
   * Escape function for resolved values. Receives the value, the *expression
   * text*, the context, and the bracket spec.
   * Defaults to `defaultEscape`.
   */
  readonly escape?: (
    value: unknown,
    expr: string,
    context: SafeInterpolationContext,
    bracket: SafeBracketSpec,
  ) => string;

  /**
   * Registry of safe functions callable from expressions.
   * Example: upper(name), len(items), etc.
   */
  readonly functions?: SafeInterpolationFunctionRegistry;

  /**
   * Handling of missing values (e.g. unknown paths or undefined results).
   * Defaults to "leave".
   */
  readonly onMissing?: SafeMissingValueStrategy;

  /**
   * Hook called whenever a path is resolved, before its value is returned.
   * You can normalize, coerce, or otherwise transform path values depending
   * on the path and bracketID.
   */
  readonly resolvedPath?: SafeResolvedPathHook;

  /**
   * Maximum recursion depth for backtick template-in-template behavior.
   * Defaults to 5.
   */
  readonly maxDepth?: number;
}

/**
 * Internal representation of a parsed template: literal or expression part.
 */
type TemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "expr"; exprText: string; bracket: SafeBracketSpec };

// -----------------------------------------------------------------------------
// Compiled template representation
// -----------------------------------------------------------------------------

/**
 * A compiled expression: original text + its bracket + parsed AST.
 */
export interface CompiledTemplateExpr {
  readonly exprText: string;
  readonly bracket: SafeBracketSpec;
  readonly ast: Expr;
}

/**
 * A compiled part: either a literal or a pre-parsed expression.
 */
export type CompiledTemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "expr"; compiled: CompiledTemplateExpr };

/**
 * A compiled template: parts plus the options it was compiled with.
 *
 * NOTE: options are stored by reference; do not mutate them between render calls
 * unless you know what you’re doing.
 */
export interface CompiledTemplate {
  readonly parts: readonly CompiledTemplatePart[];
  readonly options: SafeInterpolationOptions;
}

// -----------------------------------------------------------------------------
// Expression AST & parser (with backtick templates)
// -----------------------------------------------------------------------------

type Expr =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "path"; parts: (string | number)[] }
  | { type: "call"; name: string; args: Expr[] }
  | { type: "backtick"; raw: string }; // raw contents inside backticks

class Tokenizer {
  #pos = 0;
  #tokens: string[];

  constructor(input: string) {
    this.#tokens = this.#lex(input);
  }

  #lex(str: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    const reIdent = /^[A-Za-z_][A-Za-z0-9_]*/;
    const reNum = /^[0-9]+(?:\.[0-9]+)?/;

    while (i < str.length) {
      const ch = str[i];

      // whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // double-quote or single-quote string literal
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        let val = "";
        while (i < str.length) {
          const c = str[i];
          if (c === "\\") {
            if (i + 1 < str.length) {
              // simple escape: skip backslash and include next char
              val += str[i + 1];
              i += 2;
              continue;
            }
          }
          if (c === quote) {
            i++;
            break;
          }
          val += c;
          i++;
        }
        tokens.push(`"${val}"`);
        continue;
      }

      // backtick template literal (our own, not JS)
      if (ch === "`") {
        i++;
        let val = "";
        while (i < str.length) {
          const c = str[i];
          if (c === "\\") {
            if (i + 1 < str.length) {
              // simple escape inside backticks
              val += str[i + 1];
              i += 2;
              continue;
            }
          }
          if (c === "`") {
            i++;
            break;
          }
          val += c;
          i++;
        }
        tokens.push("`" + val + "`");
        continue;
      }

      // identifier
      const identMatch = str.slice(i).match(reIdent);
      if (identMatch) {
        tokens.push(identMatch[0]);
        i += identMatch[0].length;
        continue;
      }

      // number
      const numMatch = str.slice(i).match(reNum);
      if (numMatch) {
        tokens.push(numMatch[0]);
        i += numMatch[0].length;
        continue;
      }

      // punctuation
      tokens.push(ch);
      i++;
    }

    return tokens;
  }

  peek(): string | undefined {
    return this.#tokens[this.#pos];
  }

  next(): string | undefined {
    return this.#tokens[this.#pos++];
  }

  done(): boolean {
    return this.#pos >= this.#tokens.length;
  }
}

function parseExpression(exprText: string): Expr {
  const t = new Tokenizer(exprText);
  const expr = parseCallOrPathOrLiteral(t);
  if (!t.done()) {
    throw new Error(`Unexpected token '${t.peek()}' after expression`);
  }
  return expr;
}

function parseCallOrPathOrLiteral(t: Tokenizer): Expr {
  const tok = t.peek();

  if (tok === undefined) {
    throw new Error("Empty expression");
  }

  // Backtick template literal
  if (tok.startsWith("`")) {
    t.next();
    const raw = tok.slice(1, -1);
    return { type: "backtick", raw };
  }

  // Literal string ("..." or '...'), already normalized to `"value"`
  if (tok.startsWith('"')) {
    t.next();
    return {
      type: "literal",
      value: tok.slice(1, -1),
    };
  }

  // Literal boolean / null
  if (tok === "true" || tok === "false") {
    t.next();
    return { type: "literal", value: tok === "true" };
  }
  if (tok === "null") {
    t.next();
    return { type: "literal", value: null };
  }

  // Literal number
  if (/^[0-9]/.test(tok)) {
    t.next();
    const num = Number(tok);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number literal: ${tok}`);
    }
    return { type: "literal", value: num };
  }

  // Identifier: could be function call or path
  if (/^[A-Za-z_]/.test(tok)) {
    const name = t.next()!;

    // Function call? name(...)
    if (t.peek() === "(") {
      t.next(); // "("
      const args: Expr[] = [];
      while (t.peek() !== ")") {
        args.push(parseCallOrPathOrLiteral(t));
        if (t.peek() === ",") {
          t.next(); // ","
        } else {
          break;
        }
      }
      if (t.peek() !== ")") {
        throw new Error("Expected ')' at end of argument list");
      }
      t.next(); // ")"
      return { type: "call", name, args };
    }

    // Path: name(.prop | [index])*
    const parts: (string | number)[] = [name];
    while (t.peek() === "." || t.peek() === "[") {
      if (t.peek() === ".") {
        t.next(); // "."
        const ident = t.next();
        if (!ident || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
          throw new Error(`Expected identifier after '.', got '${ident}'`);
        }
        parts.push(ident);
      } else {
        // array indexing: [number]
        t.next(); // "["
        const idxTok = t.next();
        if (!idxTok || !/^[0-9]+$/.test(idxTok)) {
          throw new Error(`Expected numeric index in '[]', got '${idxTok}'`);
        }
        const idx = Number(idxTok);
        if (t.peek() !== "]") {
          throw new Error("Expected ']' after index");
        }
        t.next(); // "]"
        parts.push(idx);
      }
    }

    return { type: "path", parts };
  }

  throw new Error(`Unexpected token in expression: '${tok}'`);
}

// -----------------------------------------------------------------------------
// Evaluator
// -----------------------------------------------------------------------------

function resolvePath(
  ctx: SafeInterpolationContext,
  parts: readonly (string | number)[],
): unknown {
  let current: unknown = ctx;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    // deno-lint-ignore no-explicit-any
    const obj = current as any;
    current = obj[part];
  }
  return current;
}

function evalExpr(
  ast: Expr,
  ctx: SafeInterpolationContext,
  opts: SafeInterpolationOptions,
  bracket: SafeBracketSpec,
  depth: number,
  interpolateInternal: (
    template: string,
    context: SafeInterpolationContext,
    options: SafeInterpolationOptions,
    depth: number,
  ) => string,
): unknown {
  switch (ast.type) {
    case "literal":
      return ast.value;

    case "path": {
      const raw = resolvePath(ctx, ast.parts);
      const hook = opts.resolvedPath;
      if (hook) {
        return hook({
          path: ast.parts,
          value: raw,
          bracketID: bracket.id,
          context: ctx,
        });
      }
      return raw;
    }

    case "call": {
      const fn = opts.functions?.[ast.name];
      if (!fn) {
        throw new Error(`Unknown function: ${ast.name}`);
      }
      const argVals = ast.args.map((a) =>
        evalExpr(a, ctx, opts, bracket, depth, interpolateInternal)
      );
      return fn(argVals, ctx, { bracketID: bracket.id });
    }

    case "backtick": {
      const maxDepth = opts.maxDepth ?? 5;
      if (depth >= maxDepth) {
        throw new Error("Maximum interpolation recursion depth exceeded");
      }
      // Inner string is recursively interpolated with the same options.
      return interpolateInternal(ast.raw, ctx, opts, depth + 1);
    }
  }
}

// -----------------------------------------------------------------------------
// Template scanner (with curlyDepth + string/backtick skipping)
// -----------------------------------------------------------------------------

function scanTemplate(
  template: string,
  brackets: readonly SafeBracketSpec[],
): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  let literalBuffer = "";

  const flushLiteral = () => {
    if (literalBuffer.length > 0) {
      parts.push({ kind: "literal", text: literalBuffer });
      literalBuffer = "";
    }
  };

  const len = template.length;

  while (i < len) {
    const ch = template[i];

    // Escape: "\X" -> treat "\" and next char as literal (so "\${" => "${")
    if (ch === "\\" && i + 1 < len) {
      literalBuffer += template[i + 1];
      i += 2;
      continue;
    }

    let matched = false;

    for (const b of brackets) {
      const prefix = b.prefix ?? "";
      const sig = prefix + b.open;

      if (sig.length === 0) continue; // invalid, skip

      if (template.startsWith(sig, i)) {
        // Found start of interpolation
        flushLiteral();
        i += sig.length;

        const close = b.close;
        const startExpr = i;
        let foundClose = false;

        const isCurlyPair = b.open === "{" && b.close === "}";
        let curlyDepth = 0;

        // Scan forward until we find an un-ignored close
        while (i < len) {
          const chInner = template[i];

          // Escaped char inside expression: skip next
          if (chInner === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }

          // Skip backtick template content: `...`
          if (chInner === "`") {
            i++;
            while (i < len) {
              const c2 = template[i];
              if (c2 === "\\" && i + 1 < len) {
                i += 2;
                continue;
              }
              if (c2 === "`") {
                i++;
                break;
              }
              i++;
            }
            continue;
          }

          // Skip double-quoted strings: "..."
          if (chInner === '"') {
            i++;
            while (i < len) {
              const c2 = template[i];
              if (c2 === "\\" && i + 1 < len) {
                i += 2;
                continue;
              }
              if (c2 === '"') {
                i++;
                break;
              }
              i++;
            }
            continue;
          }

          // Skip single-quoted strings: '...'
          if (chInner === "'") {
            i++;
            while (i < len) {
              const c2 = template[i];
              if (c2 === "\\" && i + 1 < len) {
                i += 2;
                continue;
              }
              if (c2 === "'") {
                i++;
                break;
              }
              i++;
            }
            continue;
          }

          // Curly-depth tracking for ${ ... } style brackets
          if (isCurlyPair) {
            if (chInner === "{") {
              curlyDepth++;
              i++;
              continue;
            }
            if (chInner === "}") {
              if (curlyDepth === 0) {
                // This is the closing brace for the interpolation
                foundClose = true;
                break;
              }
              // Closing an inner curly block
              curlyDepth = Math.max(0, curlyDepth - 1);
              i++;
              continue;
            }
          }

          // For non-curly bracket types, check close token explicitly
          if (!isCurlyPair && template.startsWith(close, i)) {
            foundClose = true;
            break;
          }

          i++;
        }

        if (!foundClose) {
          throw new Error(
            `Unclosed interpolation (missing '${close}') starting at index ${startExpr}`,
          );
        }

        const exprText = template.slice(startExpr, i).trim();
        i += close.length;

        parts.push({
          kind: "expr",
          exprText,
          bracket: b,
        });

        matched = true;
        break;
      }
    }

    if (!matched) {
      literalBuffer += ch;
      i++;
    }
  }

  flushLiteral();
  return parts;
}

/**
 * Compile a template once into a reusable, efficient representation.
 *
 * This performs:
 *   - scanTemplate() over the string
 *   - parseExpression() for each expression
 *
 * Any parse errors will be thrown here at compile time (developer bug).
 */
export function compileSafeTemplate(
  template: string,
  options: SafeInterpolationOptions,
): CompiledTemplate {
  const rawParts = scanTemplate(template, options.brackets);

  const compiledParts: CompiledTemplatePart[] = rawParts.map((p) => {
    if (p.kind === "literal") {
      return { kind: "literal", text: p.text };
    }

    // Pre-parse expression once; any syntax error is a programmer error and
    // should surface at compile time.
    const ast = parseExpression(p.exprText);

    return {
      kind: "expr",
      compiled: {
        exprText: p.exprText,
        bracket: p.bracket,
        ast,
      },
    };
  });

  return {
    parts: compiledParts,
    options,
  };
}

/**
 * Render a previously compiled template with a given context.
 *
 * This reuses:
 *  - pre-scanned parts
 *  - pre-parsed ASTs for expressions
 *
 * It keeps the same semantics as safeInterpolate():
 *  - parse/eval errors are treated as "missing" and delegated to onMissing
 *  - undefined values are also delegated to onMissing
 */
export function renderCompiledTemplate(
  compiled: CompiledTemplate,
  context: SafeInterpolationContext,
): string {
  const { parts, options } = compiled;
  const escapeFn = options.escape ??
    ((value: unknown): string => defaultEscape(value));
  const onMissing = options.onMissing ?? "leave";

  const chunks: string[] = [];

  // We route backtick recursion through the existing internal engine so
  // we don't duplicate that logic. evalExpr already expects an
  // interpolateInternal function, which we satisfy with safeInterpolateInternal.
  const interpolateInternal = (
    template: string,
    ctx: SafeInterpolationContext,
    opts: SafeInterpolationOptions,
    depth: number,
  ): string => {
    // NOTE: this uses the non-compiled path for nested backticks.
    // That’s acceptable for now; the big win is avoiding re-parse for
    // the top-level template and its expressions.
    // You could later add a compiled-subtemplate cache here if needed.
    // deno-lint-ignore no-explicit-any
    return (safeInterpolateInternal as any)(template, ctx, opts, depth);
  };

  for (const part of parts) {
    if (part.kind === "literal") {
      chunks.push(part.text);
      continue;
    }

    const { exprText, bracket, ast } = part.compiled;
    let value: unknown;

    try {
      value = evalExpr(
        ast,
        context,
        options,
        bracket,
        /* depth */ 0,
        interpolateInternal,
      );
    } catch (err) {
      // Same behavior as safeInterpolateInternal: treat parse/eval errors
      // as "missing" and delegate to onMissing.
      if (onMissing === "throw") {
        throw err;
      }
      if (typeof onMissing === "function") {
        chunks.push(onMissing(exprText, { context, bracketID: bracket.id }));
      } else if (onMissing === "empty") {
        // nothing
      } else {
        // "leave"
        chunks.push(
          reconstructPlaceholder({
            kind: "expr",
            exprText,
            bracket,
          } as unknown as Extract<TemplatePart, { kind: "expr" }>),
        );
      }
      continue;
    }

    if (value === undefined) {
      if (onMissing === "throw") {
        throw new Error(
          `Missing interpolation value for '${exprText}' (bracketID=${bracket.id})`,
        );
      }
      if (typeof onMissing === "function") {
        chunks.push(onMissing(exprText, { context, bracketID: bracket.id }));
      } else if (onMissing === "empty") {
        // nothing
      } else {
        // "leave"
        chunks.push(
          reconstructPlaceholder({
            kind: "expr",
            exprText,
            bracket,
          } as unknown as Extract<TemplatePart, { kind: "expr" }>),
        );
      }
      continue;
    }

    chunks.push(escapeFn(value, exprText, context, bracket));
  }

  return chunks.join("");
}

// -----------------------------------------------------------------------------
// Internal implementation with depth tracking
// -----------------------------------------------------------------------------

function reconstructPlaceholder(
  part: Extract<TemplatePart, { kind: "expr" }>,
): string {
  const prefix = part.bracket.prefix ?? "";
  return `${prefix}${part.bracket.open}${part.exprText}${part.bracket.close}`;
}

function safeInterpolateInternal(
  template: string,
  context: SafeInterpolationContext,
  options: SafeInterpolationOptions,
  depth: number,
): string {
  const parts = scanTemplate(template, options.brackets);
  const escapeFn = options.escape ??
    ((value: unknown): string => defaultEscape(value));
  const onMissing = options.onMissing ?? "leave";

  let out = "";

  for (const part of parts) {
    if (part.kind === "literal") {
      out += part.text;
      continue;
    }

    const exprText = part.exprText;
    const bracket = part.bracket;
    let value: unknown;

    try {
      const ast = parseExpression(exprText);
      value = evalExpr(
        ast,
        context,
        options,
        bracket,
        depth,
        safeInterpolateInternal,
      );
    } catch (err) {
      // Treat parse/eval errors as "missing" and delegate to onMissing
      if (onMissing === "throw") {
        throw err;
      }
      if (typeof onMissing === "function") {
        out += onMissing(exprText, { context, bracketID: bracket.id });
      } else if (onMissing === "empty") {
        // nothing
      } else {
        // "leave"
        out += reconstructPlaceholder(part);
      }
      continue;
    }

    if (value === undefined) {
      // Missing or undefined value
      if (onMissing === "throw") {
        throw new Error(
          `Missing interpolation value for '${exprText}' (bracketID=${bracket.id})`,
        );
      }
      if (typeof onMissing === "function") {
        out += onMissing(exprText, { context, bracketID: bracket.id });
      } else if (onMissing === "empty") {
        // nothing
      } else {
        // "leave"
        out += reconstructPlaceholder(part);
      }
      continue;
    }

    out += escapeFn(value, exprText, context, bracket);
  }

  return out;
}

// -----------------------------------------------------------------------------
// Public API: safeInterpolate()
// -----------------------------------------------------------------------------

export function safeInterpolate(
  template: string,
  context?: SafeInterpolationContext,
  options?: SafeInterpolationOptions,
): string {
  return safeInterpolateInternal(
    template,
    context,
    options ??
      { brackets: [{ id: "typical", prefix: "$", open: "{", close: "}" }] },
    0,
  );
}
