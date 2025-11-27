import { Code } from "types/mdast";
import { getLanguageByIdOrAlias, LanguageSpec } from "../../universal/code.ts";
import { defineNodeData, NodeWithData } from "../../universal/data-bag.ts";
import {
  instructionsFromText,
  PosixStylePI,
} from "../../universal/posix-pi.ts";

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

/**
 * Lazyily-initialized frontmatter (meta data) extracted from `code` nodes which
 * look like ```lang meta -O --options { attrs }
 */
export const codeFmDefn = defineNodeData("codeFM" as const)<
  CodeFrontmatter,
  Code
>({
  merge: true,
  initOnFirstAccess: true,
  init: (node, defn) => {
    const parsed = parseFrontmatterFromCode(node, {
      coerceNumbers: true,
      onAttrsParseError: "ignore",
    });
    if (parsed) defn.factory.attach(node, parsed);
  },
});

export const codeFrontmatterNDF = codeFmDefn.factory;

export type CodeWithFrontmatterNode = NodeWithData<typeof codeFmDefn>;

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
  options: {
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
  } = {},
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
