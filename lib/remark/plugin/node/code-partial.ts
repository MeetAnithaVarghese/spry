/**
 * @module code-partial
 *
 * `codePartials` is a tiny remark plugin that scans for CodeFrontmatter `code`
 * nodes whose first Processing Instruction (PI) token is `PARTIAL` and then
 * invokes a user-supplied `collect()` callback for each such node.
 *
 * It is intended to be added *after* the `codeFrontmatter` plugin:
 *
 * ```ts
 * import { remark } from "remark";
 * import codeFrontmatter from "./enriched-cell.ts";
 * import codePartials from "./code-partial.ts";
 *
 * const processor = remark()
 *   .use(codeFrontmatter)
 *   .use(codePartials, {
 *     collect(node, data) {
 *       // node is an mdast `code` node
 *       // data is the attached CodeFrontmatterData
 *     },
 *   });
 * ```
 *
 * A code fence like:
 *
 * ```ts PARTIAL --name foo { group: "alpha" }
 * console.log("hi");
 * ```
 *
 * will be detected as a “partial” and passed to `collect()`.
 */

import { globToRegExp, isGlob, normalize } from "@std/path";
import { z, ZodType } from "@zod/zod";
import type { Code, Node, Root, RootContent } from "types/mdast";
import { Plugin } from "unified";
import { jsonToZod } from "../../../universal/zod-aide.ts";
import { flexibleNodeIssues } from "../../mdast/issue.ts";
import {
  DataSupplierNode,
  safeNodeDataFactory,
} from "../../mdast/safe-data.ts";
import {
  codeFrontmatterNDF,
  CodeWithFrontmatterNode,
} from "./code-frontmatter.ts";

/** Render function for partials */
type InjectContentFn = (
  locals: Record<string, unknown>,
  onError?: (message: string, content: string, error?: unknown) => string,
) =>
  | { content: string; interpolate: boolean; locals: Record<string, unknown> }
  | Promise<
    { content: string; interpolate: boolean; locals: Record<string, unknown> }
  >;

export const codePartialSchema = z.object({
  identity: z.string().min(1),
  source: z.string().min(1),

  // Optional argument validation for locals passed to .content()
  argsZodSchema: z.instanceof(ZodType).optional(),
  argsZodSchemaSpec: z.string().optional(),

  // The renderer (typed & guarded)
  content: z.custom<InjectContentFn>(
    (v): v is InjectContentFn =>
      typeof v === "function" &&
      // deno-lint-ignore ban-types
      (v as Function).length >= 1 &&
      // deno-lint-ignore ban-types
      (v as Function).length <= 2,
    {
      message:
        "content must be a function (locals, onError?) => { content, interpolate, locals } | Promise<...>",
    },
  ),

  // optional injection metadata
  injection: z.object({
    globs: z.array(z.string()).min(1),
    mode: z.enum(["prepend", "append", "both"]),
    wrap: z.custom<(content: string) => string>(),
  }).optional(),
}).strict();

export type CodePartial = z.infer<typeof codePartialSchema>;

export const CODEPARTIAL_KEY = "codePartial" as const;
export type CodePartialKey = typeof CODEPARTIAL_KEY;
export const codePartialIssues = flexibleNodeIssues("issues");
export const codePartialSNDF = safeNodeDataFactory<CodePartialKey, CodePartial>(
  CODEPARTIAL_KEY,
  codePartialSchema,
  {
    onAttachSafeParseError: ({ node, error }) => {
      codePartialIssues.add(node, {
        severity: "error",
        message: String(error),
        error,
      });
      return null;
    },
  },
);

export type CodePartialNode<N extends Node = Code> =
  & CodeWithFrontmatterNode<N>
  & DataSupplierNode<N, CodePartialKey, CodePartial>;

export interface CodePartialsOptions {
  /**
   * Decides whether or not a particular CodeFrontmatter node is a partial code node.
   */
  isPartial?: (
    ec: CodeWithFrontmatterNode,
  ) => {
    identity: string;
    flags: Record<string, unknown>;
    zodSchemaSpec?: Record<string, unknown>;
  } | false;

  /**
   * Callback invoked for each `code` node that:
   * - is an CodeFrontmatter node, and
   * - has its first PI positional token equal to `PARTIAL` (case-insensitive).
   *
   * `node` is the underlying mdast `code` node; `data` is the attached
   * CodeFrontmatterData at `node.data.codeFrontmatter` (or custom storeKey if
   * you wired it that way and call this plugin with a custom matcher).
   */
  collect?: (node: CodePartialNode) => void;

  /**
   * Callback invoked if there are "registration time" issues with the partial
   */
  registerIssue?: (
    ec: CodeWithFrontmatterNode,
    message: string,
    content: string,
    error?: unknown,
  ) => void;
}

/**
 * A typical partial looks liked ```lang PARTIAL <identity:string> { ...optional Zod parse spec... }\n```
 */
export function typicalIsCodePartialNode(
  ec: CodeWithFrontmatterNode,
): ReturnType<Required<Pick<CodePartialsOptions, "isPartial">>["isPartial"]> {
  const { pi, attrs } = ec.data.codeFM;
  if (pi.posCount > 1 && pi.pos[0] == "PARTIAL") {
    return { identity: pi.pos[1], flags: pi.flags, zodSchemaSpec: attrs };
  }
  return false;
}

/**
 * remark plugin that locates CodeFrontmatter “partial” cells and calls `collect()`.
 *
 * This plugin assumes that `codeFrontmatter` has already run on the tree:
 *
 * ```ts
 * remark().use(codeFrontmatter).use(codePartials, { collect });
 * ```
 */
export const codePartials: Plugin<[CodePartialsOptions?], Root> = (
  options = {},
) => {
  const { collect, isPartial = typicalIsCodePartialNode, registerIssue } =
    options;

  return function transformer(tree: Root) {
    const walk = (node: Root | RootContent): void => {
      if (node.type === "code") {
        if (codePartialSNDF.is(node)) return;
        if (codeFrontmatterNDF.is(node)) {
          const ipn = isPartial(node);
          if (ipn) {
            const cp = codePartial(
              ipn.identity,
              ipn.flags,
              node.value,
              ipn.zodSchemaSpec,
              {
                registerIssue: registerIssue
                  ? (message, content, error) =>
                    registerIssue(node, message, content, error)
                  : undefined,
              },
            );
            codePartialSNDF.attach(node, cp);
            collect?.(node as CodePartialNode);
          }
        }
      }

      // descend
      // deno-lint-ignore no-explicit-any
      const maybeChildren: any = node as any;
      const children = maybeChildren.children as RootContent[] | undefined;
      if (children && Array.isArray(children)) {
        for (const c of children) walk(c);
      }
    };

    walk(tree);
  };
};

/**
 * Build a (possibly injectable) Partial from the fenced block’s `PI` and `content`.
 *
 * Flags parsed from `PI` (via parsedTextComponents):
 *   --inject <glob>   (repeatable; optional – if absent, the partial is "plain")
 *   --prepend         (optional; if neither --prepend/--append given, default "prepend")
 *   --append          (optional; --prepend + --append => "both")
 *
 * Examples:
 *   fbPartial("report_wrapper --inject reports/**\/*.sql --prepend", "...text...");
 *   fbPartial("footer --inject **\/*.sql --append", "-- footer");
 *   fbPartial("enclose --inject **\/*.sql --prepend --append", "-- begin\n...\n-- end");
 *   fbPartial("plain_partial", "no injection flags => plain partial");
 */
export function codePartial(
  identity: string,
  flags: Record<string, unknown>,
  source: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    registerIssue?: (message: string, content: string, error?: unknown) => void;
  },
): CodePartial {
  // Collect optional injection globs
  const injectGlobs = flags.inject === undefined
    ? []
    : Array.isArray(flags.inject)
    ? (flags.inject as string[])
    : [String(flags.inject)];

  const hasFlag = (k: string) =>
    k in flags && flags[k] !== false && flags[k] !== undefined;

  let hasPrepend = hasFlag("prepend");
  const hasAppend = hasFlag("append");
  if (!hasPrepend && !hasAppend) hasPrepend = true;

  const injection: CodePartial["injection"] = injectGlobs.length
    ? {
      globs: injectGlobs,
      mode: hasPrepend && hasAppend ? "both" : hasAppend ? "append" : "prepend", // default if neither specified
      wrap: (text: string) => {
        let result = text;
        if (hasPrepend) {
          result = `${source}\n${result}`;
        }
        if (hasAppend) {
          result = `${result}\n${source}`;
        }
        return result;
      },
    }
    : undefined;

  // Optional Zod schema for locals
  const argsZodSchemaSpec = JSON.stringify(
    zodSchemaSpec && Object.keys(zodSchemaSpec).length > 0
      ? zodSchemaSpec
      : undefined,
  );

  let argsZodSchema: ZodType | undefined;
  if (argsZodSchemaSpec) {
    try {
      argsZodSchema = jsonToZod(JSON.stringify({
        type: "object",
        properties: JSON.parse(argsZodSchemaSpec),
        additionalProperties: true,
      }));
    } catch (error) {
      argsZodSchema = undefined;
      init?.registerIssue?.(
        `Invalid Zod schema spec: ${argsZodSchemaSpec}`,
        source,
        error,
      );
    }
  }

  // The content renderer with runtime locals validation (if provided)
  const content: InjectContentFn = (locals, onError) => {
    if (argsZodSchema) {
      const parsed = z.safeParse(argsZodSchema, locals);
      if (!parsed.success) {
        const message =
          `Invalid arguments passed to partial '${identity}': ${
            z.prettifyError(parsed.error)
          }\n` +
          `Partial '${identity}' expected arguments ${argsZodSchemaSpec}`;
        return {
          content: onError ? onError(message, source, parsed.error) : message,
          interpolate: false,
          locals,
        };
      }
    }
    return { content: source, interpolate: true, locals };
  };

  return codePartialSchema.parse({
    identity,
    argsZodSchema,
    argsZodSchemaSpec,
    source,
    content,
    injection,
  });
}

type PartialRender = Awaited<ReturnType<InjectContentFn>>;

/**
 * Unified collection of Partials. It also maintains an index for injectable
 * matching (by glob) and exposes a `compose` helper to apply the best-match
 * wrapper around a rendered content partial’s result.
 */
export function codePartialsCollection() {
  const catalog = new Map<string, CodePartialNode>();

  // ---------- Injectable indexing ----------
  type IndexEntry = {
    identity: string;
    re: RegExp;
    wc: number;
    len: number;
  };
  let index: IndexEntry[] = [];

  const wildcardCount = (g: string): number => {
    const starStar = (g.match(/\*\*/g) ?? []).length * 2;
    const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
    return starStar + singles;
  };

  const toRegex = (glob: string): RegExp => {
    if (!isGlob(glob)) {
      const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${exact}$`);
    }
    return globToRegExp(glob, {
      extended: true,
      globstar: true,
      caseInsensitive: false,
    });
    // If you prefer case-insensitive, flip the flag above.
  };

  const rebuildIndex = () => {
    const entries: IndexEntry[] = [];
    for (const cpn of catalog.values()) {
      const { codePartial } = cpn.data;
      const inj = codePartial.injection;
      if (!inj) continue;
      for (const g of inj.globs) {
        const gg = normalize(g);
        entries.push({
          identity: codePartial.identity,
          re: toRegex(gg),
          wc: wildcardCount(gg),
          len: gg.length,
        });
      }
    }
    index = entries;
  };

  const findInjectableForPath = (
    path?: string,
  ): CodePartial | undefined => {
    if (!path) return;
    const p = normalize(path);
    const hits = index
      .filter((c) => c.re.test(p))
      .sort((a, b) => (a.wc - b.wc) || (b.len - a.len));
    if (!hits.length) return;
    const chosenId = hits[0].identity;
    return catalog.get(chosenId)?.data.codePartial;
  };
  // ----------------------------------------

  return {
    catalog,

    register: (
      cpn: CodePartialNode,
      onDuplicate?: (cp: CodePartial) => "overwrite" | "throw" | "ignore",
    ) => {
      const { codePartial } = cpn.data;
      const found = catalog.get(codePartial.identity);
      if (found && onDuplicate) {
        const action = onDuplicate(codePartial);
        if (action === "throw") {
          throw new Deno.errors.AlreadyExists(
            `Partial '${codePartial.identity}' already exists in fbPartialsCollection`,
          );
        }
        if (action === "ignore") return;
        // default is overwrite
      }
      catalog.set(codePartial.identity, cpn);
      rebuildIndex();
    },

    get: (identity: string) => catalog.get(identity),

    /**
     * Compose the best matching injectable (if any) around a prior render result.
     * - Looks up the most specific injection by path (glob, fewer wildcards, longer literal).
     * - Renders the wrapper with the same locals.
     * - Prepends/appends/both according to the injection mode.
     */
    async compose(
      result: PartialRender,
      ctx?: {
        path?: string;
        onError?: (msg: string, content: string, err?: unknown) => string;
      },
    ): Promise<PartialRender> {
      const wrapper = findInjectableForPath(ctx?.path);
      if (!wrapper?.injection) return result;

      // Render wrapper using same locals; fail closed if wrapper indicates invalid args.
      let wrapperText: string;
      try {
        const wr = await wrapper.content(result.locals);
        if (!wr.interpolate) {
          const msg = `Injectable '${wrapper.identity}' failed to render`;
          const text = ctx?.onError
            ? ctx.onError(msg, result.content)
            : `${msg}: wrapper reported invalid arguments`;
          return { content: text, interpolate: false, locals: result.locals };
        }
        wrapperText = wr.content;
      } catch (err) {
        const msg = `Injectable '${wrapper.identity}' failed to render`;
        const text = ctx?.onError
          ? ctx.onError(msg, result.content, err)
          : `${msg}: ${String(err)}`;
        return { content: text, interpolate: false, locals: result.locals };
      }

      // Merge according to mode
      const { mode } = wrapper.injection;
      let merged = result.content;
      if (mode === "prepend" || mode === "both") {
        merged = `${wrapperText}\n${merged}`;
      }
      if (mode === "append" || mode === "both") {
        merged = `${merged}\n${wrapperText}`;
      }

      return {
        content: merged,
        interpolate: result.interpolate,
        locals: result.locals,
      };
    },

    /** Utility: find the (injectable) partial chosen for a path */
    findInjectableForPath,
  };
}

export default codePartials;
