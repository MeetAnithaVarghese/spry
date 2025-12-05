import { Code, Node } from "types/mdast";
import { getLanguageByIdOrAlias, LanguageSpec } from "../../universal/code.ts";
import {
  instructionsFromText,
  PosixStylePI,
} from "../../universal/posix-pi.ts";
import { dataBag } from "./data-bag.ts";

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
  /**
   * The raw `meta` string on the code fence.
   * Must be present and non-empty (after trimming) for the node to have
   * "code frontmatter".
   */
  readonly meta: string;
  /** Parsed Processing Instructions (flags / positional tokens). */
  readonly pi: PosixStylePI;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  readonly attrs?: Record<string, unknown>;
}

/**
 * Additional options for {@link codeFrontmatter}.
 *
 * These are passed through to {@link instructionsFromText}, plus an
 * extra flag controlling whether the result is cached on the node.
 */
export type CodeFrontmatterOptions =
  & Parameters<typeof instructionsFromText>[1]
  & {
    /**
     * If `true` (default), cache the parsed frontmatter on the `code` node
     * as `data.codeFM` so subsequent calls are O(1).
     *
     * If `false`, the node is never mutated and frontmatter is parsed on
     * every call.
     */
    readonly cacheableInCodeNodeData?: boolean;

    /**
     * If transform is passed in, first the lang and meta are allowed to be
     * interpolated or otherwise modified before use.
     */
    readonly transform?: (
      lang?: string | null | undefined,
      meta?: string | null | undefined,
    ) => false | {
      lang?: string | null | undefined;
      meta?: string | null | undefined;
    };
  };

/**
 * Typed accessor for `code.data.codeFM`.
 */
const codeFmDataBag = dataBag<"codeFM", CodeFrontmatter, Code>("codeFM");

/**
 * Parse a single mdast `code` node into {@link CodeFrontmatter}, caching it
 * along the way. This is a pure function with respect to the return value:
 * caching is an optional optimization on the node itself.
 *
 * Parsing behavior:
 * - If `node.meta` is missing or whitespace-only, returns `null`.
 * - The "command string" passed to {@link instructionsFromText} is
 *   `${node.lang ?? ""} ${node.meta}` (trimmed), so the language identifier
 *   participates in PI parsing (e.g. `ts --tag alpha`).
 *
 * Caching behavior:
 * - When `options.cacheableInCodeNodeData !== false`, the parsed
 *   {@link CodeFrontmatter} is stored on the node as `data.codeFM` and
 *   reused on future calls.
 *
 * @param node    An mdast `code` node (or any node; non-code is ignored).
 * @param options Options forwarded to {@link instructionsFromText}, plus
 *                `cacheableInCodeNodeData` to control caching.
 * @returns Parsed {@link CodeFrontmatter}, or `null` if `meta` is empty.
 */
export function codeFrontmatter(
  node: Node,
  options?: CodeFrontmatterOptions,
): CodeFrontmatter | null {
  // Guard: must be a `code` node.
  if (!node || node.type !== "code") return null;
  const code = node as Code;

  let codeLang = code.lang;
  let codeMeta = code.meta;
  if (options?.transform) {
    const newValues = options.transform(code.lang, code.meta);
    if (newValues) {
      codeLang = newValues.lang;
      codeMeta = newValues.meta;
    }
  }

  const rawMeta = codeMeta ?? "";
  if (rawMeta.trim().length === 0) return null;

  const { cacheableInCodeNodeData = true, ...instrOptions } = options ?? {};

  // Try to reuse cached frontmatter, if present.
  if (cacheableInCodeNodeData && codeFmDataBag.is(code)) {
    return (code.data as Record<string, unknown> & { codeFM: CodeFrontmatter })
      .codeFM;
  }

  const command = `${codeLang ?? ""} ${rawMeta}`.trim();

  const ir = instructionsFromText(
    command,
    instrOptions as Parameters<typeof instructionsFromText>[1],
  );

  const lang = code.lang || undefined;

  const codeFM: CodeFrontmatter = {
    lang,
    langSpec: lang ? getLanguageByIdOrAlias(lang) : undefined,
    meta: rawMeta,
    ...ir,
  };

  if (cacheableInCodeNodeData) {
    codeFmDataBag.attach(code, codeFM);
  }

  return codeFM;
}
