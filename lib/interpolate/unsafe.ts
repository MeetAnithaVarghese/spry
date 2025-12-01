/**
 * Unsafe JavaScript-backed template interpolation and partial execution.
 *
 * This module provides two layers:
 *
 * 1. `unsafeInterpolator(ctx, config?)`
 *    - A low-level, **fully dynamic** template-literal style interpolator.
 *    - Binds a *global* context (`ctx`) and per-call *locals`.
 *    - Compiles expressions like `${foo + bar}` into real JS and executes them.
 *
 *    SECURITY WARNING: This executes arbitrary JavaScript inside `${...}`.
 *    Use only with trusted templates and trusted data.
 *
 * 2. `unsafeInterpFactory(ctx, options?)`
 *    - A higher-level helper that:
 *      - Wraps `unsafeInterpolator`.
 *      - Integrates with `PartialContent<Locals>` and `PartialCollection<Locals>`.
 *      - Exposes a `partial(name, locals?)` function to templates, which:
 *          - Resolves a partial by name from the collection.
 *          - Renders it (with strict/non-strict locals validation).
 *          - Optionally re-interpolates the partial content recursively.
 *
 * Typical usage:
 * - Dynamic code cell / runbook rendering in Spry.
 * - Trusted “programmable content” where authors can run arbitrary JS.
 * - Layering partials / fragments with type-safe locals and runtime Zod validation.
 */

import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import type { PartialCollection, PartialContent } from "./partial.ts";
import { partialContentCollection } from "./partial.ts";

/* ---------------------------
   Example (trusted template)
---------------------------
type Ctx = { app: string; version: string; util: { up: (s: string) => string } };

const { interpolate } = unsafeInterpolator<Ctx>(
  { app: "Spry", version: "2.4.0", util: { up: (s) => s.toUpperCase() } },
  { useCache: true, ctxName: "globals" }, // expose as `globals` instead of `ctx`
);

const out = await interpolate(
  "Hello ${user}! ${globals.app}@${globals.version} -> ${globals.util.up(user)} sum=${a+b}",
  { user: "Zoya", a: 2, b: 3 },
);
// -> "Hello Zoya! Spry@2.4.0 -> ZOYA sum=5"
*/

/**
 * Configuration for the low-level unsafe interpolator.
 */
export type UnsafeInterpolatorConfig = {
  /** Enable function caching per (template, local-keys-signature, ctxName). Default: true. */
  useCache?: boolean;
  /** Identifier presented to templates for the bound global context. Default: "ctx". */
  ctxName?: string;
  /** Maximum recursion depth when re-entering partials. Default: 9. */
  recursionLimit?: number;
};

/**
 * Create an unsafe, JS-backed interpolator for a given global context.
 *
 * @template Context shape of the global interpolation context
 * @param ctx global context bound into every template under `ctxName`
 * @param config optional configuration for caching and recursion limits
 */
export function unsafeInterpolator<
  Context extends Record<string, unknown>,
>(
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

  /**
   * Split a template-like string into literal and expression segments.
   * `${...}` expressions are tracked as separate parts.
   */
  function splitTemplateIntoParts(
    src: string,
  ): Array<{ type: "lit" | "expr"; value: string }> {
    const parts: Array<{ type: "lit" | "expr"; value: string }> = [];
    let i = 0;
    let litStart = 0;

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

  /**
   * Compile a template string plus local keys into an async function:
   *
   *   (ctx, locals) => Promise<string>
   *
   * This is where the actual JavaScript `eval` happens, via `AsyncFunction`.
   */
  function compile(source: string, keys: readonly string[]) {
    if (keys.includes(ctxName)) {
      throw new Error(
        `Local key "${ctxName}" conflicts with ctxName. Rename the local or choose a different ctxName.`,
      );
    }
    for (const k of keys) assertValidIdentifier(k, "local key");

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

  /**
   * Interpolate a template string with per-call `locals`.
   *
   * - Uses the global `ctx` bound at factory time.
   * - Uses a simple key-signature to cache compiled functions when enabled.
   *
   * @template LocalContext shape of the per-call locals object
   */
  async function interpolate<
    LocalContext extends Record<string, unknown>,
  >(
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

/**
 * Result of a higher-level unsafe interpolation attempt that may:
 * - leave the source unmodified,
 * - mutate it via interpolation/partials,
 * - or fail with an error.
 */
export type UnsafeInterpolationResult =
  & { status: false | "unmodified" | "mutated" }
  & (
    | { status: "mutated"; source: string }
    | { status: "unmodified"; source: string }
    | { status: false; source: string; error: unknown }
  );

/**
 * Factory for a higher-level unsafe interpolator integrated with partials.
 *
 * This:
 * - Creates a shared `unsafeInterpolator` bound to a default “prime” context.
 * - Optionally wires in a `PartialCollection<FragmentLocals>` so templates
 *   can call a `partial(name, locals?)` function to render named fragments.
 * - Uses an `interpCtx` callback to build context for:
 *     - `"default"`: initial global interpolation context.
 *     - `"prime"`: per-call context, given the current “prime” ctx.
 *     - `"partial"`: per-partial context, given the prime ctx and partial.
 *
 * @template Context       shape of the primary (prime) context for interpolation
 * @template FragmentLocals shape of the locals objects used by partials
 */
export function unsafeInterpFactory<
  Context extends Record<string, unknown>,
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
>(
  opts?: {
    /**
     * Build interpolation context for different purposes:
     * - "default": one-time base context (no options provided).
     * - "prime": per-call context from the prime ctx passed to `interpolateUnsafely`.
     * - "partial": per-partial context from the prime ctx and the partial.
     */
    interpCtx?: (
      purpose: "default" | "prime" | "partial",
      options?: {
        readonly prime: Context;
        readonly partial?: PartialContent<FragmentLocals>;
      },
    ) => Record<string, unknown>;
    /**
     * Optional partials collection used when templates call `partial(name, locals?)`.
     * If omitted, partial calls in templates will fall back to a diagnostic comment.
     */
    partialsCollec?: PartialCollection<FragmentLocals>;
  },
) {
  const {
    interpCtx,
    partialsCollec = partialContentCollection<FragmentLocals>(),
  } = opts ?? {};

  // Construct the default global interpolation context (may be empty).
  const defaultCtx = (interpCtx?.("default", undefined) ??
    {}) as Context;
  const unsafeInterp = unsafeInterpolator<Context>(defaultCtx);

  /**
   * Higher-level unsafe interpolation entry point.
   *
   * - Accepts a “prime” context that carries:
   *   - `source`: the string to interpolate.
   *   - `interpolate`: boolean flag to control whether interpolation runs.
   *   - `partials?`: information used to name the partial execution helper.
   * - Returns:
   *   - `{ status: "mutated", source }` if interpolation changed the content.
   *   - `{ status: "unmodified", source }` if the result equals the input.
   *   - `{ status: false, error, source }` if interpolation threw.
   *
   * SECURITY WARNING: This executes arbitrary JS inside `${...}`.
   * Do not use with untrusted templates or data.
   */
  async function interpolateUnsafely(
    ctx: Context & {
      readonly source: string;
      readonly interpolate?: boolean;
      readonly selfRefKeyName?: string;
      readonly partials?: {
        readonly execFnName: string;
        readonly localVarName: string;
      };
    },
  ): Promise<UnsafeInterpolationResult> {
    const {
      source,
      interpolate,
      selfRefKeyName = "SELF",
      partials: {
        execFnName: partialExecFnName,
        localVarName: partialLocalVarName,
      } = { execFnName: "partial", localVarName: "PARTIAL" },
    } = ctx;

    if (!interpolate) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, {
        // Per-call “prime” context
        ...(interpCtx?.("prime", { prime: ctx }) ?? {}),
        [selfRefKeyName]: ctx,
        safeJsonStringify,
        // Expose a `partial(name, locals?)` helper
        [partialExecFnName]: async (
          name: string,
          partialLocals?: FragmentLocals,
        ): Promise<string> => {
          const found = partialsCollec.get(name);
          if (!found) {
            const available = Array.from(partialsCollec.catalog.keys()).join(
              ", ",
            );
            return `/* partial '${name}' not found (available: ${available}) */`;
          }

          // Build locals for the partial. We deliberately treat this as
          // FragmentLocals, but runtime Zod/Schemaless validation in the partial
          // will enforce/relax the shape (strictArgs vs non-strict).
          const localsForPartial: FragmentLocals = {
            safeJsonStringify,
            ...(interpCtx?.("partial", { prime: ctx, partial: found }) ?? {}),
            ...(partialLocals ?? {} as FragmentLocals),
            [partialLocalVarName]: found,
            [selfRefKeyName]: ctx,
          } as FragmentLocals;

          const partialResult = await found.content(localsForPartial);

          // If partial render fails or locals are invalid, we “fail closed”
          // by returning the partial’s own content (likely an error message).
          if (partialResult.status !== "ok" || !partialResult.interpolate) {
            return partialResult.content;
          }

          // Recursively interpolate the partial content using the locals returned
          // by the partial render, with a simple stack to guard recursion depth.
          return await unsafeInterp.interpolate(
            partialResult.content,
            partialResult.locals,
            [{ template: partialResult.content }],
          );
        },
      });

      if (mutated !== source) {
        return { status: "mutated", source: mutated };
      }
      return { status: "unmodified", source };
    } catch (error) {
      return { status: false, error, source };
    }
  }

  return {
    /** Low-level, JS-backed interpolator bound to the default context. */
    unsafeInterp,
    /** High-level integration with prime context, partials collection, and recursion. */
    interpolateUnsafely,
  };
}
