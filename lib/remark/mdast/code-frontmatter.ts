import { Code } from "types/mdast";
import { getLanguageByIdOrAlias, LanguageSpec } from "../../universal/code.ts";
import { defineNodeData, NodeWithData } from "../../universal/data-bag.ts";
import {
  instructionsFromText,
  PosixStylePI,
} from "../../universal/posix-pi.ts";

/**
 * Structured enrichment attached to a `code` node.
 *
 * A frontmatter string like:
 *
 * ```md
 * ```ts --tag alpha -L 9 { priority: 5 }
 * console.log("hi");
 * ```
 * ```
 *
 * is parsed into:
 * - `lang` / `langSpec`
 * - `pi` (processing instructions: flags + positional tokens)
 * - `attrs` (JSON5-like `{ ... }` tail)
 */
export interface CodeFrontmatter {
  /** The language of the code fence (e.g. "ts", "bash"). */
  readonly lang?: string;
  /** The specification of the language code fence. */
  readonly langSpec?: LanguageSpec;
  /** The raw `meta` string on the code fence (if any). */
  readonly meta?: string;
  /** Parsed Processing Instructions (flags / positional tokens). */
  readonly pi: PosixStylePI;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  readonly attrs?: Record<string, unknown>;
}

/**
 * Options for parsing / enriching a single code node.
 *
 * These are passed through to {@link instructionsFromText}.
 */
export interface ParseFrontmatterOptions {
  /**
   * Optional normalization for flag keys (e.g. convert short `"L"` -> `"level"`).
   * Applied to:
   * - `--key=value`
   * - `--key value`
   * - Short form `-k`, `-k=value`, `-k value`
   * - Bare tokens (so `"tag"` can be left as-is or normalized)
   */
  normalizeFlagKey?: (key: string) => string;

  /**
   * How to handle invalid JSON5 inside the `{ ... }` ATTRS object.
   * - `"ignore"` (default): swallow parse errors and produce `{}`.
   * - `"throw"`: rethrow the parsing error to the caller.
   * - `"store"`: store the raw string under `attrs.__raw` and keep `{}` otherwise.
   */
  onAttrsParseError?: "ignore" | "throw" | "store";

  /**
   * If true, numeric string values like `"9"` are coerced to numbers `9`
   * for flag values parsed from `--key value` / `-k value` (two-token form)
   * and from `--key=9` / `-k=9` key-value form.
   */
  coerceNumbers?: boolean;
}

/**
 * Backwards-compatible alias kept for callers that used the old remark plugin.
 */
export type CodeFrontmatterOptions = ParseFrontmatterOptions;

/**
 * Data-bag definition for `code` frontmatter:
 *
 *   node.data.codeFM: CodeFrontmatter
 */
export const codeFmDefn = defineNodeData("codeFM" as const)<
  CodeFrontmatter,
  Code
>({
  initOnFirstAccess: true,
  init: (node, ctx) => {
    const parsed = parseFrontmatterFromCode(node, { coerceNumbers: true });
    if (!parsed) return;

    ctx.factory.attach(node, parsed);
  },
});

/**
 * The underlying data factory for frontmatter.
 *
 * You usually don't need this directly; prefer {@link ensureCodeFrontmatter}.
 */
export const codeFrontmatterNDF = codeFmDefn.factory;

/**
 * mdast `Code` node enriched with `data.codeFM`.
 */
export type CodeWithFrontmatterNode = NodeWithData<typeof codeFmDefn>;

/**
 * Parse a single mdast `code` node into {@link CodeFrontmatter}.
 *
 * This is a pure function and **does not** mutate the node. The higher-level
 * {@link ensureCodeFrontmatter} helper uses this and also attaches the result
 * into `node.data.codeFM` via the data-bag factory.
 *
 * @param node    An mdast `code` node.
 * @param options Parsing options (see {@link ParseFrontmatterOptions}).
 * @returns Parsed {@link CodeFrontmatter}, or `null` if `meta` is empty.
 *
 * @example
 * ```ts
 * import { parseFrontmatterFromCode } from "./code-frontmatter.ts";
 *
 * const fm = parseFrontmatterFromCode(codeNode, { coerceNumbers: true });
 * if (fm) {
 *   console.log(fm.pi.flags, fm.attrs);
 * }
 * ```
 */
export function parseFrontmatterFromCode(
  node: Code,
  options: ParseFrontmatterOptions = {},
): CodeFrontmatter | null {
  if (!node || node.type !== "code") return null;

  const lang = (node.lang ?? "") as string;
  const meta = (node.meta ?? "") as string;

  if (meta.trim().length === 0) return null;

  const { pi, attrs } = instructionsFromText(
    `${lang} ${meta}`.trim(),
    options,
  );

  return {
    lang: lang || undefined,
    langSpec: getLanguageByIdOrAlias(lang),
    meta: meta || undefined,
    pi,
    attrs,
  };
}

/**
 * Ensure that a `code` node has parsed frontmatter attached at
 * `node.data.codeFM`, returning the parsed structure.
 *
 * - If `codeFM` is already present, it is returned as-is.
 * - Otherwise, {@link parseFrontmatterFromCode} is called.
 *   - If parsing yields `null` (no meta), this returns `null` and **does not**
 *     attach anything.
 *   - If parsing succeeds, the result is attached via the data-bag factory and
 *     returned.
 *
 * Defaults:
 * - `coerceNumbers: true` to match the old plugin’s behavior.
 * - `onAttrsParseError: "ignore"` (implemented inside `instructionsFromText`).
 *
 * @param node    mdast `code` node to enrich.
 * @param options Optional parsing options.
 * @returns The attached {@link CodeFrontmatter}, or `null` if nothing to attach.
 *
 * @example
 * ```ts
 * import { ensureCodeFrontmatter } from "./code-frontmatter.ts";
 *
 * visit(tree, "code", (node) => {
 *   const fm = ensureCodeFrontmatter(node);
 *   if (!fm) return;
 *   console.log(fm.pi.flags, fm.attrs);
 * });
 * ```
 */
export function ensureCodeFrontmatter(
  node: Code,
  options: CodeFrontmatterOptions = { coerceNumbers: true },
): CodeFrontmatter | null {
  // If already enriched, just return existing value.
  const existing = codeFrontmatterNDF.get(node);
  if (existing) return existing;

  const parsed = parseFrontmatterFromCode(node, options);
  if (!parsed) return null;

  const enrichedNode = codeFrontmatterNDF.attach(node, parsed);
  return enrichedNode.data.codeFM;
}
