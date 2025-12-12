// deno-lint-ignore-file require-await
import { assertEquals, assertNotEquals } from "@std/assert";
import { instructionsFromText } from "./posix-pi.ts";
import {
  compileSafeTemplate,
  defaultEscape,
  renderCompiledTemplate,
  renderCompiledTemplateAsync,
  safeInterpolate,
  safeInterpolateAsync,
  SafeInterpolationContext,
  SafeInterpolationOptions,
  SafeString,
} from "./flexible-interpolator.ts";

Deno.test("Safe Interpolator - simple ${} with HTML escaping", () => {
  const ctx: SafeInterpolationContext = {
    user: {
      name: "<Shahid>",
      title: "Mr.",
      last: "Shah",
      orders: [1, 2, 3],
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "html", prefix: "$", open: "{", close: "}" },
    ],
    functions: {
      upper: ([v]) => String(v).toUpperCase(),
      len: ([v]) => Array.isArray(v) ? v.length : 0,
    },
    escape: (value, _expr, _ctx, _bracket) => {
      // For this test, always HTML-escape
      return defaultEscape(value);
    },
  };

  const template =
    "Hello ${ user.name } (escaped) - total orders: ${ len(user.orders) }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Hello &lt;Shahid&gt; (escaped) - total orders: 3",
  );
});

Deno.test("Safe Interpolator - simple ${} with HTML escaping (async)", async () => {
  const ctx: SafeInterpolationContext = {
    user: {
      name: "<Shahid>",
      title: "Mr.",
      last: "Shah",
      orders: [1, 2, 3],
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "html", prefix: "$", open: "{", close: "}" },
    ],
    functions: {
      upper: async ([v]) => String(v).toUpperCase(),
      len: async ([v]) => Array.isArray(v) ? v.length : 0,
    },
    escape: async (value, _expr, _ctx, _bracket) => {
      return defaultEscape(value);
    },
  };

  const template =
    "Hello ${ user.name } (escaped) - total orders: ${ len(user.orders) }";

  const rendered = await safeInterpolateAsync(template, ctx, opts);
  assertEquals(
    rendered,
    "Hello &lt;Shahid&gt; (escaped) - total orders: 3",
  );
});

Deno.test("Safe Interpolator - backtick recursion with nested interpolation", () => {
  const ctx: SafeInterpolationContext = {
    user: {
      name: "Shahid",
      title: "Mr.",
      last: "Shah",
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "html", prefix: "$", open: "{", close: "}" },
    ],
    functions: {
      greet: ([s]) => `GREETING(${s})`,
    },
    // Keep escaping simple here so we can see raw values
    escape: (value) => String(value),
  };

  const template =
    "Outer: ${ greet(`Hello ${ user.title } ${ user.last }`) } for ${ user.name }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Outer: GREETING(Hello Mr. Shah) for Shahid",
  );
});

Deno.test("Safe Interpolator - backtick recursion with nested interpolation (async)", async () => {
  const ctx: SafeInterpolationContext = {
    user: {
      name: "Shahid",
      title: "Mr.",
      last: "Shah",
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "html", prefix: "$", open: "{", close: "}" },
    ],
    functions: {
      greet: async ([s]) => `GREETING(${s})`,
    },
    escape: async (value) => String(value),
  };

  const template =
    "Outer: ${ greet(`Hello ${ user.title } ${ user.last }`) } for ${ user.name }";

  const rendered = await safeInterpolateAsync(template, ctx, opts);
  assertEquals(
    rendered,
    "Outer: GREETING(Hello Mr. Shah) for Shahid",
  );
});

Deno.test("Safe Interpolator - resolvedPath transforms values per bracket", () => {
  const ctx: SafeInterpolationContext = {
    meta: {
      slug: "  my-page  ",
      title: "My Page",
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "slug", prefix: "$", open: "{", close: "}" },
      { id: "title", open: "{{", close: "}}" },
    ],
    escape: (value) => String(value),
    resolvedPath: ({ path, value, bracketID }) => {
      if (bracketID === "slug" && path.join(".") === "meta.slug") {
        return String(value).trim().replace(/\s+/g, "-").toLowerCase();
      }
      return value;
    },
  };

  const template = "Slug: ${ meta.slug } | Title: {{ meta.title }}";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Slug: my-page | Title: My Page",
  );
});

Deno.test("Safe Interpolator - resolvedPath transforms values per bracket (async)", async () => {
  const ctx: SafeInterpolationContext = {
    meta: {
      slug: "  my-page  ",
      title: "My Page",
    },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "slug", prefix: "$", open: "{", close: "}" },
      { id: "title", open: "{{", close: "}}" },
    ],
    escape: async (value) => String(value),
    resolvedPath: async ({ path, value, bracketID }) => {
      if (bracketID === "slug" && path.join(".") === "meta.slug") {
        return String(value).trim().replace(/\s+/g, "-").toLowerCase();
      }
      return value;
    },
  };

  const template = "Slug: ${ meta.slug } | Title: {{ meta.title }}";

  const rendered = await safeInterpolateAsync(template, ctx, opts);
  assertEquals(
    rendered,
    "Slug: my-page | Title: My Page",
  );
});

Deno.test("Safe Interpolator - missing values and onMissing strategies", () => {
  const ctx: SafeInterpolationContext = {
    user: { name: "Shahid" },
  };

  const baseOpts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (v) => String(v),
  };

  const template = "Hello ${ user.name } ${ user.missing }";

  // leave
  const optsLeave: SafeInterpolationOptions = {
    ...baseOpts,
    onMissing: "leave",
  };
  const renderedLeave = safeInterpolate(template, ctx, optsLeave);
  assertEquals(
    renderedLeave,
    "Hello Shahid ${user.missing}",
  );

  // empty
  const optsEmpty: SafeInterpolationOptions = {
    ...baseOpts,
    onMissing: "empty",
  };
  const renderedEmpty = safeInterpolate(template, ctx, optsEmpty);
  assertEquals(
    renderedEmpty,
    "Hello Shahid ",
  );

  // custom
  const optsCustom: SafeInterpolationOptions = {
    ...baseOpts,
    onMissing: (expr, info) => `[MISSING:${info.bracketID}:${expr}]`,
  };
  const renderedCustom = safeInterpolate(template, ctx, optsCustom);
  assertEquals(
    renderedCustom,
    "Hello Shahid [MISSING:html:user.missing]",
  );
});

Deno.test("Safe Interpolator - missing values and onMissing strategies (async)", async () => {
  const ctx: SafeInterpolationContext = {
    user: { name: "Shahid" },
  };

  const baseOpts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: async (v) => String(v),
  };

  const template = "Hello ${ user.name } ${ user.missing }";

  // custom async onMissing
  const optsCustomAsync: SafeInterpolationOptions = {
    ...baseOpts,
    onMissing: async (expr, info) =>
      `[MISSING-ASYNC:${info.bracketID}:${expr}]`,
  };
  const renderedCustomAsync = await safeInterpolateAsync(
    template,
    ctx,
    optsCustomAsync,
  );
  assertEquals(
    renderedCustomAsync,
    "Hello Shahid [MISSING-ASYNC:html:user.missing]",
  );
});

Deno.test("Safe Interpolator - SafeString is passed through escape", () => {
  const ctx: SafeInterpolationContext = {
    raw: "<b>Bold</b>",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (value) => defaultEscape(value),
    resolvedPath: ({ value, path }) => {
      if (path.join(".") === "raw") {
        return SafeString.from(String(value));
      }
      return value;
    },
  };

  const template = "Raw: ${ raw }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Raw: <b>Bold</b>",
  );
});

Deno.test("Safe Interpolator - SafeString is passed through escape (async)", async () => {
  const ctx: SafeInterpolationContext = {
    raw: "<b>Bold</b>",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: async (value) => defaultEscape(value),
    resolvedPath: async ({ value, path }) => {
      if (path.join(".") === "raw") {
        return SafeString.from(String(value));
      }
      return value;
    },
  };

  const template = "Raw: ${ raw }";

  const rendered = await safeInterpolateAsync(template, ctx, opts);
  assertEquals(
    rendered,
    "Raw: <b>Bold</b>",
  );
});

Deno.test("Safe Interpolator - '}' inside double-quoted string in expression", () => {
  const ctx: SafeInterpolationContext = {
    text: "ok",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (value) => String(value),
    functions: {
      echo: ([v]) => String(v),
    },
  };

  const template = 'Brace: ${ echo("a}b") } and ${ text }';

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Brace: a}b and ok",
  );
});

Deno.test("Safe Interpolator - '}' inside backtick string inside expression", () => {
  const ctx: SafeInterpolationContext = {
    n: 42,
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (v) => String(v),
    functions: {
      show: ([v]) => `<<${v}>>`,
    },
  };

  const template = "Backtick brace: ${ show(`val}ue ${ n }`) } done";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Backtick brace: <<val}ue 42>> done",
  );
});

Deno.test("Safe Interpolator - records inside function", () => {
  const ctx: SafeInterpolationContext = {
    n: 42,
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{
      id: "instructionsFromText",
      open: "{{",
      close: "}}",
    }],
    escape: (v) => String(v),
    functions: {
      show: ([v]) => `<<${v}>>`,
    },
    onMissing: (expr) => {
      const ir = instructionsFromText(expr);
      return `<<${JSON.stringify(ir.attrs)}>>`;
    },
  };

  const template =
    'instructionsFromText inside brackets: {{ show { x: "y" } }} done';

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    'instructionsFromText inside brackets: <<{"x":"y"}>> done',
  );
});

Deno.test("Safe Interpolator - escaped ${ is not interpolated", () => {
  const ctx: SafeInterpolationContext = {
    user: { name: "Shahid" },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (v) => String(v),
  };

  const template = "Literal: \\${ user.name } and real: ${ user.name }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Literal: ${ user.name } and real: Shahid",
  );
});

Deno.test("Safe Interpolator - escaped backtick inside expression", () => {
  const ctx: SafeInterpolationContext = {
    user: { name: "Shahid" },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (v) => String(v),
    functions: {
      ident: ([v]) => v,
    },
  };

  const template =
    "Expr with backtick: ${ ident(`Hello \\`world\\` ${ user.name }`) }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Expr with backtick: Hello `world` Shahid",
  );
});

Deno.test("Safe Interpolator - backticks with maxDepth=0 are left as-is", () => {
  const ctx: SafeInterpolationContext = { v: "X" };

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (v) => String(v),
    functions: {
      id: ([v]) => v,
    },
    maxDepth: 0,
  };

  const template = "Too deep: ${ id(`Level ${ v }`) }";

  const rendered = safeInterpolate(template, ctx, opts);

  // Current engine behavior: this expression does not evaluate and is treated
  // like a "missing" expr with onMissing="leave", so it is reconstructed with
  // trimmed expression text: ${id(`Level ${ v }`)}.
  assertEquals(
    rendered,
    "Too deep: ${id(`Level ${ v }`)}",
  );
});

Deno.test("Safe Interpolator - compiled template reused with different contexts", () => {
  const template = "Hello ${ user.name } – orders: ${ len(user.orders) }";

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: (value) => String(value), // keep escaping simple for this test
    functions: {
      len: ([v]) => Array.isArray(v) ? v.length : 0,
    },
  };

  const compiled = compileSafeTemplate(template, opts);

  const ctx1: SafeInterpolationContext = {
    user: { name: "Shahid", orders: [1, 2, 3] },
  };
  const ctx2: SafeInterpolationContext = {
    user: { name: "Alice", orders: [10] },
  };

  const rendered1 = renderCompiledTemplate(compiled, ctx1);
  const rendered2 = renderCompiledTemplate(compiled, ctx2);

  // Compiled template should behave the same as safeInterpolate
  const direct1 = safeInterpolate(template, ctx1, opts);
  const direct2 = safeInterpolate(template, ctx2, opts);

  assertEquals(rendered1, "Hello Shahid – orders: 3");
  assertEquals(rendered2, "Hello Alice – orders: 1");

  // And compiled vs direct must match
  assertEquals(rendered1, direct1);
  assertEquals(rendered2, direct2);
});

Deno.test("Safe Interpolator - compiled template reused with different contexts (async)", async () => {
  const template = "Hello ${ user.name } – orders: ${ len(user.orders) }";

  const opts: SafeInterpolationOptions = {
    brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
    escape: async (value) => String(value),
    functions: {
      len: async ([v]) => Array.isArray(v) ? v.length : 0,
    },
  };

  const compiled = compileSafeTemplate(template, opts);

  const ctx1: SafeInterpolationContext = {
    user: { name: "Shahid", orders: [1, 2, 3] },
  };
  const ctx2: SafeInterpolationContext = {
    user: { name: "Alice", orders: [10] },
  };

  const rendered1 = await renderCompiledTemplateAsync(compiled, ctx1);
  const rendered2 = await renderCompiledTemplateAsync(compiled, ctx2);

  const direct1 = await safeInterpolateAsync(template, ctx1, opts);
  const direct2 = await safeInterpolateAsync(template, ctx2, opts);

  assertEquals(rendered1, "Hello Shahid – orders: 3");
  assertEquals(rendered2, "Hello Alice – orders: 1");

  assertEquals(rendered1, direct1);
  assertEquals(rendered2, direct2);
});

Deno.test(
  "Safe Interpolator - async function behaves differently in sync vs async API",
  async () => {
    const ctx: SafeInterpolationContext = {
      user: { name: "Shahid" },
    };

    const opts: SafeInterpolationOptions = {
      brackets: [{ id: "html", prefix: "$", open: "{", close: "}" }],
      escape: (v) => String(v),
      functions: {
        // async function returning a Promise
        upper: async ([v]) => String(v).toUpperCase(),
      },
    };

    const template = "Hello ${ upper(user.name) }";

    const syncRendered = safeInterpolate(template, ctx, opts);
    const asyncRendered = await safeInterpolateAsync(template, ctx, opts);

    // The async API should give us the "real" value
    assertEquals(asyncRendered, "Hello SHAHID");

    // The sync API does *not* await the Promise; its output should differ
    assertNotEquals(syncRendered, asyncRendered);
  },
);

Deno.test("Safe Interpolator - per-bracket escape overrides global escape", () => {
  const ctx: SafeInterpolationContext = {
    v: "<Tag>",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "upper",
        prefix: "$",
        open: "{",
        close: "}",
        escape: (value) => String(value).toUpperCase(),
      },
      {
        id: "global",
        open: "{{",
        close: "}}",
      },
    ],
    // Global escape wraps in brackets
    escape: (value) => `[${String(value)}]`,
  };

  const template = "Upper: ${ v } | Global: {{ v }}";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Upper: <TAG> | Global: [<Tag>]",
  );
});

Deno.test("Safe Interpolator - per-bracket functions override global registry", () => {
  const ctx: SafeInterpolationContext = { v: "X" };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "local",
        prefix: "$",
        open: "{",
        close: "}",
        functions: {
          fmt: ([v]) => `LOCAL:${v}`,
        },
      },
      {
        id: "global",
        open: "{{",
        close: "}}",
      },
    ],
    escape: (v) => String(v),
    functions: {
      fmt: ([v]) => `GLOBAL:${v}`,
    },
  };

  const template = "Local: ${ fmt(v) } | Global: {{ fmt(v) }}";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Local: LOCAL:X | Global: GLOBAL:X",
  );
});

Deno.test("Safe Interpolator - per-bracket onMissing overrides global onMissing", () => {
  const ctx: SafeInterpolationContext = {};

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "one",
        prefix: "$",
        open: "{",
        close: "}",
        onMissing: (expr) => `[ONE:${expr}]`,
      },
      {
        id: "two",
        open: "{{",
        close: "}}",
      },
    ],
    escape: (v) => String(v),
    onMissing: (expr) => `[GLOBAL:${expr}]`,
  };

  const template = "A ${ missing } | B {{ missing }}";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "A [ONE:missing] | B [GLOBAL:missing]",
  );
});

Deno.test("Safe Interpolator - per-bracket resolvedPath overrides global", () => {
  const ctx: SafeInterpolationContext = {
    meta: { slug: "  My Page  " },
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "local",
        prefix: "$",
        open: "{",
        close: "}",
        resolvedPath: ({ path, value }) => {
          if (path.join(".") === "meta.slug") {
            return "local";
          }
          return value;
        },
      },
      {
        id: "global",
        open: "{{",
        close: "}}",
      },
    ],
    escape: (v) => String(v),
    resolvedPath: ({ path, value }) => {
      if (path.join(".") === "meta.slug") {
        return "global";
      }
      return value;
    },
  };

  const template = "Local: ${ meta.slug } | Global: {{ meta.slug }}";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Local: local | Global: global",
  );
});

Deno.test("Safe Interpolator - per-bracket maxDepth overrides global", () => {
  const ctx: SafeInterpolationContext = { v: "X" };

  const opts: SafeInterpolationOptions = {
    brackets: [
      { id: "html", prefix: "$", open: "{", close: "}" },
      {
        id: "deep",
        prefix: "%",
        open: "{",
        close: "}",
        maxDepth: 2,
      },
    ],
    escape: (v) => String(v),
    functions: {
      id: ([v]) => v,
    },
    maxDepth: 0,
  };

  const template =
    "Shallow: ${ id(`Level ${ v }`) } | Deep: %{ id(`Level ${ v }`)}";

  const rendered = safeInterpolate(template, ctx, opts);

  assertEquals(
    rendered,
    "Shallow: ${id(`Level ${ v }`)} | Deep: Level X",
  );
});

Deno.test("Safe Interpolator - onRawExpr treats inner content as raw and ignores nested brackets", () => {
  const ctx: SafeInterpolationContext = {
    foo: "X",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: (expr, info) => `RAW(${info.bracketID}:${expr})`,
      },
      {
        id: "html",
        prefix: "$",
        open: "{",
        close: "}",
      },
    ],
    escape: (v) => String(v),
  };

  const template = "Raw [[ some ${ foo } here ]] and ${ foo }";

  const rendered = safeInterpolate(template, ctx, opts);
  assertEquals(
    rendered,
    "Raw RAW(raw:some ${ foo } here) and X",
  );
});

Deno.test(
  "Safe Interpolator - onRawExpr non-greedy close uses first matching close",
  () => {
    const ctx: SafeInterpolationContext = {};

    const opts: SafeInterpolationOptions = {
      brackets: [
        {
          id: "raw",
          open: "[[",
          close: "]]",
          onRawExpr: (expr) => `<<${expr}>>`,
        },
      ],
      escape: (v) => String(v),
    };

    const template = "X [[ one ]] Y [[ two ]] Z";

    const rendered = safeInterpolate(template, ctx, opts);
    assertEquals(
      rendered,
      "X <<one>> Y <<two>> Z",
    );
  },
);

Deno.test(
  "Safe Interpolator - onRawExpr ignores close inside quotes and uses next real close",
  () => {
    const ctx: SafeInterpolationContext = {};

    const opts: SafeInterpolationOptions = {
      brackets: [
        {
          id: "raw",
          open: "[[",
          close: "]]",
          onRawExpr: (expr) => `<<${expr}>>`,
        },
      ],
      escape: (v) => String(v),
    };

    const template = 'A [[ before "]]" after ]] B';

    const rendered = safeInterpolate(template, ctx, opts);
    assertEquals(
      rendered,
      'A <<before "]]" after>> B',
    );
  },
);

Deno.test("Safe Interpolator - onRawExpr (async) with raw handling", async () => {
  const ctx: SafeInterpolationContext = {
    foo: "X",
  };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: async (expr, info) => `RAW-ASYNC(${info.bracketID}:${expr})`,
      },
      {
        id: "html",
        prefix: "$",
        open: "{",
        close: "}",
      },
    ],
    escape: async (v) => String(v),
  };

  const template = "Raw [[ some ${ foo } here ]] and ${ foo }";

  const rendered = await safeInterpolateAsync(template, ctx, opts);
  assertEquals(
    rendered,
    "Raw RAW-ASYNC(raw:some ${ foo } here) and X",
  );
});

Deno.test("Safe Interpolator - onRawExpr='onMissing' delegates to global onMissing", () => {
  const ctx = {};

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: "onMissing",
      },
    ],
    escape: (v) => String(v),
    onMissing: (expr, info) => `GLOBAL-MISS(${info.bracketID}:${expr})`,
  };

  const template = "A [[ some ${ weird } expr ]] B";

  const rendered = safeInterpolate(template, ctx, opts);

  assertEquals(
    rendered,
    "A GLOBAL-MISS(raw:some ${ weird } expr) B",
  );
});

Deno.test("Safe Interpolator - onRawExpr='onMissing' uses bracket-level onMissing override", () => {
  const ctx = {};

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: "onMissing",
        onMissing: (expr, info) => `LOCAL-MISS(${info.bracketID}:${expr})`,
      },
    ],
    escape: (v) => String(v),
    onMissing: (expr) => `GLOBAL(${expr})`,
  };

  const template = "X [[ hello ${ test } ]] Y";

  const rendered = safeInterpolate(template, ctx, opts);

  assertEquals(
    rendered,
    "X LOCAL-MISS(raw:hello ${ test }) Y",
  );
});

Deno.test("Safe Interpolator - missing onRawExpr behaves as onMissing", () => {
  const ctx = {};

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        // no onRawExpr
      },
    ],
    escape: (v) => String(v),
    onMissing: (expr, info) => `MISS(${info.bracketID}:${expr})`,
  };

  const template = "T [[ some raw stuff ]] Z";

  const rendered = safeInterpolate(template, ctx, opts);

  assertEquals(
    rendered,
    "T MISS(raw:some raw stuff) Z",
  );
});

Deno.test("Safe Interpolator - onRawExpr='onMissing' async path", async () => {
  const ctx = {};

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: "onMissing",
      },
    ],
    escape: async (v) => String(v),
    onMissing: async (expr, info) => `ASYNC-MISS(${info.bracketID}:${expr})`,
  };

  const template = "A [[ something ${ deep } ]] B";

  const rendered = await safeInterpolateAsync(template, ctx, opts);

  assertEquals(
    rendered,
    "A ASYNC-MISS(raw:something ${ deep }) B",
  );
});

Deno.test("Safe Interpolator - onRawExpr function still works after API change", () => {
  const ctx = { x: "Y" };

  const opts: SafeInterpolationOptions = {
    brackets: [
      {
        id: "raw",
        open: "[[",
        close: "]]",
        onRawExpr: (expr, info) => `RAW(${info.bracketID}:${expr})`,
      },
    ],
    escape: (v) => String(v),
  };

  const template = "K [[ a ${ x } b ]] Z";

  const rendered = safeInterpolate(template, ctx, opts);

  assertEquals(
    rendered,
    "K RAW(raw:a ${ x } b) Z",
  );
});
