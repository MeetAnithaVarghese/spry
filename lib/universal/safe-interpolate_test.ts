// safe-interpolate_test.ts

import { assertEquals } from "@std/assert";
import {
  compileSafeTemplate,
  defaultEscape,
  renderCompiledTemplate,
  safeInterpolate,
  SafeInterpolationContext,
  SafeInterpolationOptions,
  SafeString,
} from "./safe-interpolate.ts";

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
