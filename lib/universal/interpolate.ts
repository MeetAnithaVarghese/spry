/**
 * unsafeInterpolator(ctx, { useCache?, ctxName? })
 * Dynamic, full-power template-literal interpolation with a configurable
 * context variable name exposed inside the template (default: `ctx`).
 *
 * SECURITY WARNING: Executes arbitrary JS in template expressions.
 * Use ONLY with trusted templates and data.
 */

/* ---------------------------
   Example (trusted template)
---------------------------
type Ctx = { app: string; version: string; util: { up: (s: string) => string } };

const { interpolate } = unsafeInterpolator<Ctx>(
  { app: "Spry", version: "2.4.0", util: { up: (s) => s.toUpperCase() } },
  { useCache: true, ctxName: "globals" }, // expose as `globals` instead of `ctx`
);

const out = interpolate(
  "Hello ${user}! ${globals.app}@${globals.version} -> ${globals.util.up(user)} sum=${a+b}",
  { user: "Zoya", a: 2, b: 3 },
);
// -> "Hello Zoya! Spry@2.4.0 -> ZOYA sum=5"
*/

export type UnsafeInterpolatorConfig = {
  /** Enable function caching per (template, local-keys-signature, ctxName). Default: true */
  useCache?: boolean;
  /** Identifier presented to templates for the bound global context. Default: "ctx" */
  ctxName?: string;
  /** How many partials or recursions can be stacked */
  recursionLimit?: number;
};

export function unsafeInterpolator<Context extends Record<string, unknown>>(
  ctx: Readonly<Context>,
  { useCache = true, ctxName = "ctx", recursionLimit = 9 }:
    UnsafeInterpolatorConfig = {},
) {
  const IDENT_RX = /^[A-Za-z_$][\w$]*$/;

  const assertValidIdentifier = (name: string, label = "identifier") => {
    if (!IDENT_RX.test(name)) {
      throw new Error(
        `Invalid ${label} "${name}". Use a simple JavaScript identifier.`,
      );
    }
  };

  assertValidIdentifier(ctxName, "ctxName");

  // cache: template -> ctxName -> sig -> compiled
  const cache = new Map<
    string,
    Map<
      string,
      Map<string, (c: Context, l: Record<string, unknown>) => Promise<string>>
    >
  >();

  function splitTemplateIntoParts(
    src: string,
  ): Array<{ type: "lit" | "expr"; value: string }> {
    const parts: Array<{ type: "lit" | "expr"; value: string }> = [];
    let i = 0, litStart = 0;

    while (i < src.length) {
      if (src[i] === "$" && src[i + 1] === "{") {
        // push preceding literal
        if (i > litStart) {
          parts.push({ type: "lit", value: src.slice(litStart, i) });
        }
        // scan balanced ${ ... }
        i += 2;
        let depth = 1;
        const exprStart = i;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          else if (ch === '"' || ch === "'" || ch === "`") {
            // skip quoted/template strings to avoid premature brace counting
            const quote = ch;
            i++;
            while (i < src.length) {
              const c = src[i];
              if (c === "\\") {
                i += 2;
                continue;
              }
              if (c === quote) {
                i++;
                break;
              }
              // Handle template literal ${...} correctly by nesting
              if (quote === "`" && c === "$" && src[i + 1] === "{") {
                // enter nested ${ in template literal
                i += 2;
                let d = 1;
                while (i < src.length && d > 0) {
                  const cc = src[i];
                  if (cc === "\\") {
                    i += 2;
                    continue;
                  }
                  if (cc === "{") d++;
                  else if (cc === "}") d--;
                  else if (cc === "`") {
                    /* keep going; still inside template */
                  }
                  i++;
                }
                continue;
              }
              i++;
            }
            continue;
          }
          i++;
        }
        const expr = src.slice(exprStart, i - 1);
        parts.push({ type: "expr", value: expr });
        litStart = i;
        continue;
      }
      i++;
    }
    if (litStart < src.length) {
      parts.push({ type: "lit", value: src.slice(litStart) });
    }
    return parts;
  }

  function compile(source: string, keys: readonly string[]) {
    if (keys.includes(ctxName)) {
      throw new Error(
        `Local key "${ctxName}" conflicts with ctxName. Rename the local or choose a different ctxName.`,
      );
    }
    for (const k of keys) assertValidIdentifier(k, `local key`);

    const decls = keys.map((k) => `const ${k} = __l[${JSON.stringify(k)}];`)
      .join("\n");
    const ctxDecl = `const ${ctxName} = __ctx;`;

    const parts = splitTemplateIntoParts(source);
    const js = parts.map((p) =>
      p.type === "lit" ? JSON.stringify(p.value) : `(${p.value})`
    ).join(" + ");

    const body = [
      `"use strict";`,
      decls,
      ctxDecl,
      `return ${js};`,
    ].join("\n");

    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as FunctionConstructor;
    return new AsyncFunction("__ctx", "__l", body) as (
      c: Context,
      l: Record<string, unknown>,
    ) => Promise<string>;
  }

  async function interpolate<LocalContext extends Record<string, unknown>>(
    template: string,
    locals: Readonly<LocalContext>,
    stack?: { template: string }[],
  ): Promise<string> {
    if (stack && stack.length > recursionLimit) {
      return `Recursion stack exceeded max: ${recursionLimit} (${
        stack.map((s) => s.template).join(" → ")
      })`;
    }

    const keys = Object.keys(locals);
    const sig = keys.slice().sort().join("|");

    if (!useCache) {
      const fn = compile(template, keys);
      return fn(ctx, locals as Record<string, unknown>);
    }

    let byCtx = cache.get(template);
    if (!byCtx) {
      byCtx = new Map();
      cache.set(template, byCtx);
    }

    let bySig = byCtx.get(ctxName);
    if (!bySig) {
      bySig = new Map();
      byCtx.set(ctxName, bySig);
    }

    let fn = bySig.get(sig);
    if (!fn) {
      fn = compile(template, keys);
      bySig.set(sig, fn);
    }

    return await fn(ctx, locals as Record<string, unknown>);
  }

  return { interpolate, ctx };
}
