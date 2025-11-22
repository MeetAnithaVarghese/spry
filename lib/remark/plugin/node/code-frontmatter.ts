/**
 * CodeFrontmatter is a structured enrichment type for remark `code` nodes.
 * It parses fenced code blocks for Processing Instructions (PI) and
 * JSON5/YAML attribute objects, and attaches precise metadata that
 * typically makes the `code` cell executable or instructional for
 * further code generation or code execution.
 *
 * Concretely, it extracts:
 *
 * 1) **Processing Instructions (PI)** — flags/tokens that look like CLI args:
 *    - Long form: `--flag`, `--flag=value`, `--flag value`
 *    - Short form: `-f`, `-f=value`, `-f value`
 *    - **Bare tokens** (no leading dashes) are also recorded
 *    - Repeated flags merge their values into **arrays**
 *    - Values that look numeric (e.g. `9`) can be coerced to numbers
 *
 * 2) **ATTRS** — trailing object-literal in braces, parsed as **JSON5**:
 *    - Example: <code>```ts --env=prod { priority: 3, note: 'ok' }</code>
 *    - Saved as a plain object on the node under `data[codeFM].attrs`
 *
 * The output is stored on each **mdast** `code` node at:
 *
 *   `node.data[codeFM] = { lang, meta, pi, attrs }`
 *
 * @example
 * ```ts
 * import { remark } from "remark";
 * import codeFrontmatter from "./code-frontmatter.ts";
 *
 * const md = [
 *   "```bash --env prod -L 9 tag tag { priority: 3, note: 'ok' }",
 *   "echo hi",
 *   "```",
 * ].join("\n");
 *
 * const tree = remark().use(codeFrontmatter, {
 *   // optional
 *   normalizeFlagKey: (k) => (k === "L" ? "level" : k),
 *   coerceNumbers: true,        // "9" -> 9
 *   onAttrsParseError: "ignore" // ignore invalid JSON5 instead of throwing
 * }).parse(md);
 *
 * // Walk to a code node and inspect:
 * const code = (tree.children.find(n => n.type === "code") as any);
 * const cell = code.data.codeFrontmatter;
 *
 * console.log(cell.lang);            // "bash"
 * console.log(cell.pi.pos);          // ["env","L","tag","tag","level","key"]
 * console.log(cell.pi.flags.env);    // "prod"
 * console.log(cell.pi.flags.level);  // 9  (coerced)
 * console.log(cell.attrs.priority);  // 3  (from JSON5)
 * ```
 *
 * @remarks
 * - This plugin is **idempotent**; running it more than once will reuse
 *   node data and not duplicate work.
 * - Designed to be used standalone or as a helper for selector engines
 *   and Markdown-driven execution/orchestration engines.
 * - Does not mutate the code content; only attaches metadata on `node.data`.
 */

import type { Code, Node, Root } from "types/mdast";
import { Plugin } from "unified";
import { visit } from "unist-util-visit";
import {
  getLanguageByIdOrAlias,
  LanguageSpec,
} from "../../../universal/code.ts";
import {
  instructionsFromText,
  PosixStylePI,
} from "../../../universal/posix-pi.ts";
import { DataSupplierNode, nodeDataFactory } from "../../mdast/safe-data.ts";

/** The structured enrichment attached to a code node by this plugin. */
export interface CodeFrontmatter {
  /** The language of the code fence (e.g. "ts", "bash"). */
  readonly lang?: string;
  /** The specification of the language code fence. */
  readonly langSpec?: LanguageSpec;
  /** The raw `meta` string on the code fence (if any). */
  readonly meta?: string;
  /** Parsed Processing Instructions (flags/tokens). */
  readonly pi: PosixStylePI;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  readonly attrs?: Record<string, unknown>;
  /** Parsed Processing Instructions (flags/tokens). */
}

export const CODEFM_KEY = "codeFM" as const;
export type CodeFrontmatterKey = typeof CODEFM_KEY;
export const codeFrontmatterNDF = nodeDataFactory<
  CodeFrontmatterKey,
  CodeFrontmatter
>(CODEFM_KEY);

export type CodeWithFrontmatterNode<N extends Node = Code> = DataSupplierNode<
  N,
  CodeFrontmatterKey,
  CodeFrontmatter
>;

/** Configuration options for the CodeFrontmatter plugin. */
export interface CodeFrontmatterOptions {
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
   * - `"throw"`: rethrow the parsing error to the pipeline.
   * - `"store"`: store the raw string under `attrs.__raw` and keep `{}` otherwise.
   */
  onAttrsParseError?: "ignore" | "throw" | "store";
  /**
   * If true, numeric string values like `"9"` are coerced to numbers `9`
   * for flag values parsed from `--key value` / `-k value` (two-token form)
   * and from `--key=9` / `-k=9` key-value form.
   */
  coerceNumbers?: boolean;
  /**
   * If defined, this callback is called whenever code cells are enriched
   */
  collect?: (node: CodeWithFrontmatterNode) => void;
}

/**
 * CodeFrontmatter remark plugin.
 *
 * @param options - See {@link CodeFrontmatterOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link CodeFrontmatter}.
 *
 * @example
 * ```ts
 * import { remark } from "remark";
 * import codeFrontmatter from "./code-frontmatter.ts";
 *
 * const processor = remark().use(codeFrontmatter, {
 *   normalizeFlagKey: (k) => k.toLowerCase(),
 *   onAttrsParseError: "ignore",
 *   coerceNumbers: true,
 * });
 *
 * const tree = processor.parse("```bash --env prod { ok: true }\necho\n```");
 * // Walk to a code node and read `node.data.codeFrontmatter`.
 * ```
 */
export const codeFrontmatter: Plugin<[CodeFrontmatterOptions?], Root> = (
  options = {},
) => {
  const { collect } = options;

  return function transformer(tree: Root) {
    visit(tree, "code", (node) => {
      // deno-lint-ignore no-explicit-any
      const untypedNode = node as any;
      const data = (untypedNode.data ??= {});
      if (!data[CODEFM_KEY]) {
        const parsed = parseFrontmatterFromCode(untypedNode, options);
        if (parsed) data[CODEFM_KEY] = parsed;
      }
      collect?.(node as CodeWithFrontmatterNode);
    });
  };
};

/**
 * Parses a single mdast `code` node into {@link CodeFrontmatter}.
 * Safe to call directly (the plugin uses this under the hood).
 *
 * @param node - An mdast `code` node.
 * @param options - See {@link CodeFrontmatterOptions}.
 * @returns Parsed {@link CodeFrontmatter} or `null` if `node.type !== "code"`.
 *
 * @example
 * ```ts
 * import { parseCodeFrontmatterFromCode } from "./code-frontmatter.ts";
 *
 * const cell = parseCodeFrontmatterFromCode(codeNode, { coerceNumbers: true });
 * if (cell) {
 *   console.log(cell.pi.flags, cell.attrs);
 * }
 * ```
 */
export function parseFrontmatterFromCode(
  // deno-lint-ignore no-explicit-any
  node: any,
  options: CodeFrontmatterOptions = {},
): CodeFrontmatter | null {
  if (!node || node.type !== "code") return null;

  const lang = (node.lang ?? "") as string;
  const meta = (node.meta ?? "") as string;

  if (meta.trim().length == 0) return null;

  const { pi, attrs } = instructionsFromText(`${lang} ${meta}`.trim(), options);

  // Attach language for convenience; keep `meta` in case callers want it.
  return {
    lang: lang || undefined,
    langSpec: getLanguageByIdOrAlias(lang),
    meta: meta || undefined,
    pi,
    attrs,
  };
}

export default codeFrontmatter;
