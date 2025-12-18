export function safeJsonStringify(
  value: unknown,
  space?: string | number,
): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    },
    space,
  );
}

/**
 * Dedent template literal output if the first line is whitespace-only.
 * Removes the first blank line, then strips the smallest common indent.
 */
export function dedentIfFirstLineBlank(s: string): string {
  if (s.length === 0) return s;
  const normalized = s.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "") return s;

  // drop first (blank) line
  lines.shift();

  // Find minimal indent of non-empty lines
  let minIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (minIndent === null || indent < minIndent) minIndent = indent;
  }

  if (minIndent && minIndent > 0) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let remove = 0;
      while (remove < minIndent && (l[remove] === " " || l[remove] === "\t")) {
        remove++;
      }
      lines[i] = l.slice(remove);
    }
  }

  return lines.join("\n");
}

/*
Examples/helpers for interpolation in String Template Literals.

1. Basic SQL block

```md
${block`
SELECT ${ctx.cols.join(", ")}
FROM ${ctx.table}
WHERE active = TRUE;
`}
```

2. SQL block with local variables

```md
${block({ t: ctx.table, cols: ctx.cols })`
SELECT ${cols.join(", ")}
FROM ${t};
`}
```

3. Using block as a function (explicit lambda)

```md
${block({ t: ctx.table, where: ctx.where }, ({ t, where }) => `
SELECT * FROM ${t}
${where ? `WHERE ${where}` : ""};
`)}
```

Reusable renderer function

```ts
function renderInsert(table: string, cols: string[], values: string[][]) {
  return block({ table, cols, values })`
    INSERT INTO ${table} (${cols.join(", ")})
    VALUES
    ${values.map(v => `(${v.join(", ")})`).join(",\n")};
  `;
}
```

Behavior Summary:

| Form                          | Locals allowed | Auto-dedent | Type-safe | Notes                       |
| ----------------------------- | -------------- | ----------- | --------- | --------------------------- |
| `block(() => \`...`)`         | ❌            | ✅          | ✅        | simplest form               |
| `block({x}, ({x}) => \`...`)` | ✅            | ✅          | ✅        | functional form             |
| `` block\`...\` ``            | ❌            | ✅          | ✅        | tagged template             |
| `` block({x})\`...\` ``       | ✅            | ✅          | ✅        | tagged template with locals |

This makes `block()` the **universal inline code cell function** — usable as:

* a lightweight `() => string` IIFE,
* a true string-template tag,
* or a tag that carries its own local scope for clarity and DRYness.

Summary of helpers:

* - `block`: dual-mode helper for scoped multi-line fragments with automatic
*   dedent/trim. Works as a function or a tagged template; supports "locals".
* - `mapJoin`, `joinText`, `lines`: ergonomic list/loop composition with clear separators.
* - `indent`, `trimBlock`: whitespace control for nested fragments.
* - `when`, `unless`, `ifElse`: compact conditional inclusion of text.

Tips:

- Use `block` for any multi-line fragment where indentation would otherwise leak
  into the output. It dedents automatically (based on a blank first line) and
  trims trailing/leading whitespace.
- Prefer `mapJoin`/`joinText`/`lines` over ad-hoc map(...).join(...) in templates
  to keep separators obvious and avoid stray commas or blank lines.
- `when`/`unless`/`ifElse` make small conditionals readable inline without
  wrapping everything in larger functions.

This keeps the general interpolation layer lightweight, readable, and reusable
for any text generation you do with string template literals.
*/

/* -------------------------------------------------------------------------------------------------
 * block
 * -------------------------------------------------------------------------------------------------
 *
 * `block` — universal inline fragment builder with auto-dedent & trim.
 *
 * Supports four forms:
 *
 * 1) Function-IIFE style
 *    ${block(() => `
 *      Title
 *      Subtitle
 *    `)}
 *
 * 2) Function-IIFE with "locals"
 *    ${block({ title: "Hello" }, ({ title }) => `
 *      # ${title}
 *    `)}
 *
 * 3) Tagged template style
 *    ${block`
 *      Line A
 *      Line B: ${ctx.value}
 *    `}
 *
 * 4) Tagged template style with "locals"
 *    ${block({ a: 1, b: 2 })`
 *      Sum: ${v => String(v.a + v.b)}
 *    `}
 *
 * In all cases, the returned string is dedented (first-blank-line convention) and trimmed.
 */

/** A tag function type for `block({locals})` and `block.with(locals)` forms. */
export type BlockTag = (
  strings: TemplateStringsArray,
  ...exprs: readonly unknown[]
) => string;

/**
 * Render the tagged template with optional `locals`:
 * - Arrays are flattened
 * - null/undefined => ""
 * - If an expr is a function and `locals` exist, we call it as `(locals) => string`
 */
function renderBlockTag(
  strings: TemplateStringsArray,
  exprs: readonly unknown[],
  locals?: Record<string, unknown>,
): string {
  const stringify = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(stringify).join("");
    if (v == null) return "";
    return String(v);
  };

  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? "";
    if (i < exprs.length) {
      const e = exprs[i];
      if (typeof e === "function" && locals) {
        out += (e as (v: Record<string, unknown>) => string)(locals);
      } else {
        out += stringify(e);
      }
    }
  }
  return dedentIfFirstLineBlank(out).trim();
}

/**
 * `block` — universal inline fragment helper with auto-dedent & trim.
 *
 * Supported forms:
 *   1) IIFE (no locals):         block(() => ` ... `)
 *   2) IIFE (with locals):       block({a:1}, ({a}) => ` ... `)
 *   3) Tagged template:          block` ... ${expr} ...`
 *   4) Tagged template + locals: block({a:1})` ... ${v => v.a} ...`
 *   5) Via helper:               block.with({a:1})` ... `
 */

// Overloads that return a string
export function block(f: () => string): string;
export function block<T extends Record<string, unknown>>(
  vars: T,
  f: (v: T) => string,
): string;
export function block(
  strings: TemplateStringsArray,
  ...exprs: readonly unknown[]
): string;

// Overload that returns a tag function when only locals are provided
export function block<T extends Record<string, unknown>>(vars: T): BlockTag;

// Implementation
export function block(...args: unknown[]): string | BlockTag {
  // IIFE no locals: block(() => `...`)
  if (typeof args[0] === "function" && args.length === 1) {
    const s = (args[0] as () => string)();
    return dedentIfFirstLineBlank(String(s)).trim();
  }

  // IIFE with locals: block(vars, (v) => `...`)
  if (
    typeof args[0] === "object" && args[0] !== null &&
    typeof args[1] === "function"
  ) {
    const s = (args[1] as (v: Record<string, unknown>) => string)(
      args[0] as Record<string, unknown>,
    );
    return dedentIfFirstLineBlank(String(s)).trim();
  }

  // Tagged template: block`...`
  if (Array.isArray(args[0]) && "raw" in args[0]) {
    return renderBlockTag(args[0] as TemplateStringsArray, args.slice(1));
  }

  // Tagged template with locals (curried): block({…})`...`
  if (typeof args[0] === "object" && args[0] !== null && args.length === 1) {
    const locals = args[0] as Record<string, unknown>;
    const tag: BlockTag = (strings, ...exprs) =>
      renderBlockTag(strings, exprs, locals);
    return tag;
  }

  throw new Error("Invalid block() usage");
}

/** Explicit helper: block.with({locals})` ... ` */
block.with = function withBlock<T extends Record<string, unknown>>(
  vars: T,
): BlockTag {
  const locals = vars as Record<string, unknown>;
  return (strings, ...exprs) => renderBlockTag(strings, exprs, locals);
};

/* -------------------------------------------------------------------------------------------------
 * Looping & joining helpers
 * -------------------------------------------------------------------------------------------------
 *
 * These helpers keep template loops concise and make separators explicit.
 */

/** Map a list through a renderer and join with a separator (default: newline). */
export function mapJoin<T>(
  items: readonly T[],
  render: (x: T, i: number) => string,
  sep = "\n",
): string {
  return items.map(render).join(sep);
}

/** Join truthy/non-empty strings with a separator (default: newline). */
export function joinText(
  parts: readonly (string | false | undefined | null)[],
  sep = "\n",
): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

/** Join arguments as separate lines, skipping falsy/empty inputs. */
export function lines(
  ...rows: Array<string | false | undefined | null>
): string {
  return joinText(rows, "\n");
}

/* -------------------------------------------------------------------------------------------------
 * Conditional composition helpers
 * -------------------------------------------------------------------------------------------------
 *
 * Keep conditionals readable inside template literals.
 */

/** Include `s` only when `cond` is truthy. */
export function when(cond: unknown, s: string): string {
  return cond ? s : "";
}

/** Include `s` only when `cond` is falsy. */
export function unless(cond: unknown, s: string): string {
  return cond ? "" : s;
}

/** Ternary helper returning `a` or `b` based on `cond`. */
export function ifElse(cond: unknown, a: string, b = ""): string {
  return cond ? a : b;
}

/* -------------------------------------------------------------------------------------------------
 * Whitespace & formatting helpers
 * -------------------------------------------------------------------------------------------------
 *
 * Useful when composing nested blocks in template literals.
 */

/** Indent every non-empty line by `n` spaces (default 2). */
export function indent(s: string, n = 2): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l.trim().length ? pad + l : l))
    .join("\n");
}

/** Trim leading and trailing whitespace from a multi-line fragment. */
export function trimBlock(s: string): string {
  return s.trim();
}

export function minWhitespaceIndent(text: string): number {
  const match = text.match(/^[ \t]*(?=\S)/gm);
  return match ? match.reduce((r, a) => Math.min(r, a.length), Infinity) : 0;
}

export function unindentWhitespace(
  text: string,
  removeInitialNewLine = true,
): string {
  const indent = minWhitespaceIndent(text);
  const regex = new RegExp(`^[ \\t]{${indent}}`, "gm");
  const result = text.replace(regex, "");
  return removeInitialNewLine ? result.replace(/^\n/, "") : result;
}

export function singleLineTrim(text: string): string {
  return text.replace(/(\r\n|\n|\r)/gm, "")
    .replace(/\s+(?=(?:[^\'"]*[\'"][^\'"]*[\'"])*[^\'"]*$)/g, " ")
    .trim();
}

export type TemplateLiteralIndexedTextSupplier = (index: number) => string;

/**
 * String template literal tag utility that wraps the literals and will
 * retrieve literals with sensitivity to indented whitespace. If
 * @param literals literals supplied to template literal string function
 * @param suppliedExprs expressions supplied to template literal string function
 * @param options whitespace sensitivity options
 * @returns a function that will wrap the literal and return unindented text
 */
export function whitespaceSensitiveTemplateLiteralSupplier(
  literals: TemplateStringsArray,
  suppliedExprs: unknown[],
  options?: {
    readonly unindent?: boolean | RegExp;
    readonly removeInitialNewLine?: boolean;
  },
): TemplateLiteralIndexedTextSupplier {
  const { unindent = true, removeInitialNewLine = true } = options ?? {};
  let literalSupplier = (index: number) => literals[index];
  if (unindent) {
    if (typeof unindent === "boolean") {
      // we want to auto-detect and build our regExp for unindenting so let's
      // build a sample of what the original text might look like so we can
      // compute the "minimum" whitespace indent
      let originalText = "";
      for (let i = 0; i < suppliedExprs.length; i++) {
        originalText += literals[i] + `\${expr${i}}`;
      }
      originalText += literals[literals.length - 1];
      const match = originalText.match(/^[ \t]*(?=\S)/gm);
      const minWhitespaceIndent = match
        ? match.reduce((r, a) => Math.min(r, a.length), Infinity)
        : 0;
      if (minWhitespaceIndent > 0) {
        const unindentRegExp = new RegExp(
          `^[ \\t]{${minWhitespaceIndent}}`,
          "gm",
        );
        literalSupplier = (index: number) => {
          let text = literals[index];
          if (index == 0 && removeInitialNewLine) {
            text = text.replace(/^\n/, "");
          }
          return text.replace(unindentRegExp!, "");
        };
      }
    } else {
      literalSupplier = (index: number) => {
        let text = literals[index];
        if (index == 0 && removeInitialNewLine) {
          text = text.replace(/^\n/, "");
        }
        return text.replace(unindent, "");
      };
    }
  }
  return literalSupplier;
}
