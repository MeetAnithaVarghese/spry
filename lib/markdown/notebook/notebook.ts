/**
 * Programmable-Markdown "Notebook" core.
 *
 * This module turns a Markdown document into a notebook-like model that separates
 * prose from code so higher layers can program against Markdown without guessing
 * about structure. It is intentionally minimal: it parses, classifies, and
 * annotates—never executes or transforms—so you can plug it into your own
 * validators, generators, runners, and exporters.
 *
 * What it does (invariants):
 * - Input forms: accepts a single { provenance, content } object, or an async
 *   stream/iterator of those. Content may be a full document string or a
 *   ReadableStream<Uint8Array>.
 * - Frontmatter: YAML frontmatter is recognized only at the head of the
 *   document and parsed with @std/yaml. Failures are reported as
 *   "frontmatter-parse" issues.
 * - Cells:
 *   - Every fenced code block becomes a code cell (kind: "code").
 *   - All other top-level content is partitioned into markdown cells (kind:
 *     "markdown").
 *   - Delimiters: H2 headings (##) and thematic breaks (---) start a new
 *     markdown cell; the delimiter belongs to the following slice.
 * - Fence meta:
 *   - Language is captured from the fence processing instructions (PI) string
 *     (defaults to "text").
 *   - Trailing "{ ... }" in the fence PI is parsed with JSON5 into attrs.
 *   - Any leading text before "{ ... }" is preserved as `pi`.
 *   - JSON5 parse errors are reported as "fence-issue" issues and attrs
 *     falls back to {}.
 * - Locations: all cells include best-effort startLine and endLine based on
 *   mdast positions, enabling precise diagnostics and tooling.
 * - AST cache: for markdown cells, the mdast node slice is cached so callers
 *   can traverse or re-stringify without reparsing.
 *
 * What it does not do (non-goals):
 * - No execution, kernel, or runtime metadata.
 * - No schema or attribute resolution beyond JSON5 parsing.
 * - No plugin system here; compose your own higher-level layers for
 *   validation, execution, export, etc.
 *
 * Key types:
 * - Notebook<Provenance, FM, Attrs, I>: a parsed document with
 *   - fm: frontmatter object ({} if none)
 *   - cells: CodeCell | MarkdownCell list, in order
 *   - issues: structured parse/lint findings (extensible)
 *   - ast: mdast cache (per-cell and pre/post-code ranges)
 *   - provenance: identifier for the document source
 * - CodeCell: { kind: "code", language, source, attrs, pi?, parsedPI?, startLine?, endLine? }
 * - MarkdownCell: { kind: "markdown", markdown, text, startLine?, endLine? }
 * - IssueDisposition: "error" | "warning" | "lint"
 * - Issue union: "frontmatter-parse" | "fence-issue" | "fence-attrs-json5-parse"
 *
 * DX with generics:
 * - Use the defaults for quick starts, or specialize:
 *   - FM for strongly typed frontmatter
 *   - Attrs for typed fence attributes
 *   - I to extend the base Issue shape (for example, { origin?: string })
 *
 * Public API:
 * - normalizeSources(input): async iterable of [provenance, string].
 *   Normalizes heterogeneous inputs to full document strings.
 * - notebooks(input): async generator of Notebook<...>.
 *   Parses one or many documents or streams into notebooks in order.
 *
 * Error and lint reporting:
 * - Frontmatter YAML failures → "frontmatter-parse" (disposition: "error")
 * - Invalid fence attrs JSON5 → "fence-issue" (disposition: "warning")
 * - Additional parser-level notices may be surfaced as "lint" to enrich
 *   downstream UX.
 *
 * Performance and streaming notes:
 * - Input may be streamed (async iterator or ReadableStream), but each document
 *   is parsed as a whole Markdown string.
 * - Use normalizeSources to handle mixed inputs before handing them to notebooks.
 *
 * Intended use:
 * - Acts as the parse stage for programmable Markdown pipelines.
 * - Enables linting, validation, and code extraction with typed frontmatter and
 *   fence attributes.
 * - Facilitates generation of SQL, TypeScript, or CLI code from code cells while
 *   preserving human-readable context.
 * - Serves as a foundation for building executable or richly annotated
 *   documentation notebooks.
 *
 * Dependencies: remark (with frontmatter, GFM, stringify), mdast-util-to-string,
 * @std/yaml, and json5.
 */
import { parse as YAMLparse } from "jsr:@std/yaml@^1";
import type { Root, RootContent } from "npm:@types/mdast@^4";
import JSON5 from "npm:json5@^2";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import remarkFrontmatter from "npm:remark-frontmatter@^5";
import remarkGfm from "npm:remark-gfm@^4";
import remarkStringify from "npm:remark-stringify@^11";
import { remark } from "npm:remark@^15";
import {
  hasEitherFlagOfType,
  hasFlagOfType,
  parseClineFlags,
} from "../../universal/cline.ts";
import {
  Cell,
  CodeCell,
  FenceIssue,
  FrontmatterIssue,
  isDefinitionNode,
  isHrNode,
  isHtmlNode,
  Issue,
  isYamlNode,
  MarkdownCell,
  normalizeSources,
  Notebook,
  posEndLine,
  posStartLine,
  Source,
  SourceStream,
} from "../governedmd.ts";

/**
 * Parse one or many Markdown documents into notebooks.
 * `FM` and `Attrs` are inferred; `I` allows extended issue shapes (defaults to base `Issue`).
 */
export async function* notebooks<
  Provenance,
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  input: SourceStream<Provenance>,
): AsyncGenerator<Notebook<Provenance, FM, Attrs, I>> {
  for await (const [provenance, src, srcSupplied] of normalizeSources(input)) {
    const nb = await parseDocument<Provenance, FM, Attrs, I>(
      provenance,
      src,
      srcSupplied,
    );
    yield nb;
  }
}

/* =========================== Internal Parser ========================= */

export const remarkProcessor = remark()
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkStringify);

/** Parse a single Markdown document into a Notebook<FM, Attrs, I>. */
async function parseDocument<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance>,
>(provenance: Provenance, source: string, srcSupplied: Source<Provenance>) {
  type Dict = Record<string, unknown>;

  const issues: I[] = [];

  const tree = remarkProcessor.parse(source) as Root;

  const { fm, fmEndIdx } = await (async () => {
    type FMParseResult = { fm: FM; fmEndIdx: number };
    const children = Array.isArray(tree.children)
      ? (tree.children as ReadonlyArray<unknown>)
      : [];
    let fmRaw: Dict = {};
    let fmEndIdx = 0;

    for (let i = 0; i < children.length; i++) {
      const n = children[i];

      if (isYamlNode(n)) {
        const original = typeof n.value === "string" ? n.value : "";
        const raw = await srcSupplied.transformFrontmatter?.(original) ??
          original;
        try {
          fmRaw = (YAMLparse(raw) as Dict) ?? {};
        } catch (error) {
          const base: FrontmatterIssue<Provenance> = {
            kind: "frontmatter-parse",
            provenance,
            message: "Frontmatter YAML failed to parse.",
            raw,
            error,
            startLine: posStartLine(n),
            endLine: posEndLine(n),
            disposition: "error",
          };
          issues.push(base as unknown as I);
          fmRaw = {};
        }
        fmEndIdx = i + 1;
        continue;
      }

      // Header-only constructs we skip over when scanning FM header region
      if (
        isYamlNode(n) || isHrNode(n) || isHtmlNode(n) || isDefinitionNode(n)
      ) {
        fmEndIdx = i + 1;
        continue;
      }

      fmEndIdx = i;
      break;
    }
    if (fmEndIdx === 0) fmEndIdx = 0;

    return { fm: fmRaw as FM, fmEndIdx } as FMParseResult;
  })();

  // Helpers local to this parse:

  const isTopLevelDelimiter = (n: RootContent) =>
    (n.type === "heading" && n.depth === 2) || n.type === "thematicBreak";

  const isCodeNode = (
    n: RootContent,
  ): n is Extract<RootContent, { type: "code" }> => n.type === "code";

  const stringifyNodes = (nodes: RootContent[]) => {
    const root: Root = { type: "root", children: nodes };
    return String(remarkProcessor.stringify(root));
  };

  const plainTextOfNodes = (nodes: RootContent[]) =>
    nodes.map((n) => mdToString(n)).join("\n").trim();

  const rangePos = (nodes: RootContent[]) => {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const start = posStartLine(first);
    const end = posEndLine(last);
    return { start, end };
  };

  const tryParseFenceAttrs = (metaText?: string): Attrs => {
    if (!metaText) return {} as unknown as Attrs;
    const trimmed = metaText.trim();
    const jsonish = trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed
      : `{${trimmed}}`;
    try {
      return JSON5.parse(jsonish) as Attrs;
    } catch (error) {
      const base: FenceIssue<Provenance> = {
        kind: "fence-issue",
        provenance,
        message: "Invalid JSON5 in fence attributes.",
        metaText: jsonish,
        error,
        disposition: "warning",
      };
      issues.push(base as unknown as I);
      return {} as unknown as Attrs;
    }
  };

  const cells: Cell<Provenance, Attrs>[] = [];

  // mdast cache we’ll fill during parse
  const mdastByCell: Array<ReadonlyArray<RootContent> | null> = [];
  const codeCellIndices: number[] = [];
  const nodesBeforeFirstCode: RootContent[] = [];
  const nodesAfterLastCode: RootContent[] = [];

  // We keep only location state for markdown slices: start index in tree.children
  let sliceStart: number | null = null;
  let seenFirstCode = false;

  const flushMarkdown = (endExclusive: number) => {
    if (sliceStart === null || endExclusive <= sliceStart) {
      sliceStart = null;
      return;
    }
    const rawSlice = tree.children.slice(
      sliceStart,
      endExclusive,
    ) as ReadonlyArray<unknown>;
    const nodes = rawSlice.filter((n): n is RootContent =>
      !isYamlNode(n)
    ) as RootContent[];
    if (!nodes.length) {
      sliceStart = null;
      return;
    }

    // Record into "before first code" if we haven't seen any code yet
    if (!seenFirstCode) nodesBeforeFirstCode.push(...nodes);

    const markdown = stringifyNodes(nodes);
    const text = plainTextOfNodes(nodes);
    const { start, end } = rangePos(nodes);
    const mdCell: MarkdownCell<Provenance> = {
      kind: "markdown",
      provenance,
      markdown,
      text,
      startLine: start,
      endLine: end,
    };
    cells.push(mdCell);
    mdastByCell.push(nodes); // cache mdast for this markdown cell
    sliceStart = null;
  };

  // Walk top-level children after FM
  for (let i = fmEndIdx; i < tree.children.length; i++) {
    const maybeNode = tree.children[i] as unknown;

    // Skip YAML nodes entirely (they are header artifacts)
    if (isYamlNode(maybeNode)) {
      continue;
    }

    // We can only treat non-yaml as RootContent now.
    const node = maybeNode as RootContent;

    if (isTopLevelDelimiter(node)) {
      // delimiter splits markdown cells; delimiter itself belongs to the following slice
      flushMarkdown(i);
      sliceStart = i; // start new markdown slice at this delimiter
      continue;
    }

    if (isCodeNode(node)) {
      // close any open markdown cell before emitting a code cell
      flushMarkdown(i);

      const lang = node.lang ?? "text";
      const metaRaw = typeof node.meta === "string" ? node.meta : undefined;

      // Extract trailing {...} JSON5 as attrs; prefix (if any) as processing instructions (PI)
      let attrs = {} as Attrs;
      let pi: string | undefined;
      let parsedPI: ReturnType<typeof parsedProcessingInstructions> | undefined;
      if (metaRaw) {
        const m = metaRaw.match(/\{.*\}$/);
        if (m) {
          attrs = tryParseFenceAttrs(m[0]);
          pi = metaRaw.replace(m[0], "").trim() || undefined;
        } else {
          pi = metaRaw.trim();
        }
        parsedPI = pi ? parsedProcessingInstructions(pi) : undefined;
      }

      const codeCell: CodeCell<Provenance, Attrs> = {
        kind: "code",
        provenance,
        language: lang,
        source: String(node.value ?? ""),
        attrs,
        pi: pi,
        parsedPI: parsedPI,
        startLine: posStartLine(node),
        endLine: posEndLine(node),
        isVirtual: false,
      };

      if (srcSupplied.import && parsedPI && "import" in parsedPI.flags) {
        const importSrc = parsedPI.flags["import"];
        if (typeof importSrc !== "boolean") {
          const isRefToBinary = parsedPI.flags["is-binary"] ? true : false;
          if (isRefToBinary) {
            codeCell.sourceElaboration = {
              isRefToBinary: true,
              encoding: "UTF-8",
              importedFrom: typeof importSrc === "string"
                ? importSrc
                : importSrc[0],
            };
          } else {
            const original = codeCell.source;
            codeCell.source = await srcSupplied.import(importSrc, codeCell);
            codeCell.sourceElaboration = {
              isRefToBinary: false,
              importedFrom: importSrc,
              original,
            };
          }
        }
      }

      cells.push(codeCell);
      mdastByCell.push(null); // code cell: no mdast nodes
      codeCellIndices.push(cells.length - 1);
      seenFirstCode = true;
      continue;
    }

    // Accumulate into current markdown slice
    if (sliceStart === null) sliceStart = i;
  }

  // Flush trailing markdown slice
  flushMarkdown(tree.children.length);

  // Compute appendix after last code cell
  if (codeCellIndices.length > 0) {
    const last = codeCellIndices[codeCellIndices.length - 1];
    for (let idx = last + 1; idx < cells.length; idx++) {
      const nodes = mdastByCell[idx];
      if (nodes) nodesAfterLastCode.push(...nodes);
    }
  }

  return {
    fm,
    cells,
    issues,
    ast: {
      mdastByCell,
      nodesBeforeFirstCode,
      nodesAfterLastCode,
      codeCellIndices,
    },
    provenance,
    source: srcSupplied,
  } satisfies Notebook<Provenance, FM, Attrs, I>;
}

/**
 * Convenience wrapper around parseClineFlags() that also exposes
 * `firstToken`, `secondToken`, and an embedded `hasFlagOfType` helper.
 *
 * Example:
 *   const r = parsedProcessingInstructions(
 *     'deploy service-A --env prod --debug',
 *     { env: "" as string, debug: false as boolean },
 *   );
 *
 *   r.firstToken      // "deploy"
 *   r.secondToken     // "service-A"
 *   r.flags.env       // "prod"
 *   r.flags.debug     // true
 *
 *   if (r.hasFlagOfType("debug", "boolean")) {
 *     // here TS knows r.flags.debug is boolean
 *   }
 *
 *   if (r.hasEitherFlagOfType("debug", "D", "boolean")) {
 *     // here TS knows r.flags.debug and r.flags.D is boolean
 *   }
 */
export function parsedProcessingInstructions<
  B extends Record<string, unknown> = Record<string, unknown>,
>(
  argv: readonly string[] | string,
  base?: B,
) {
  const { bareTokens, flags } = parseClineFlags(argv, base);

  const firstToken = bareTokens[0];
  const secondToken = bareTokens[1];

  function boundHasFlagOfType<
    K extends string,
    Expected extends
      | "string"
      | "number"
      | "boolean"
      | "object"
      | "function"
      | "undefined",
    F extends Record<string, unknown> = typeof flags,
  >(
    key: K,
    expectedType?: Expected,
    flagsParam: F = flags as F,
  ): flagsParam is
    & F
    & {
      [P in K]: Expected extends "string" ? string
        : Expected extends "number" ? number
        : Expected extends "boolean" ? boolean
        : Expected extends "object" ? object
        // deno-lint-ignore ban-types
        : Expected extends "function" ? Function
        : Expected extends "undefined" ? undefined
        : never;
    } {
    return hasFlagOfType(
      flagsParam as Record<string, unknown>,
      key,
      expectedType,
    );
  }

  function boundHasEitherFlagOfType<
    K1 extends string,
    K2 extends string,
    Expected extends
      | "string"
      | "number"
      | "boolean"
      | "object"
      | "function"
      | "undefined",
    F extends Record<string, unknown> = typeof flags,
  >(
    key1: K1,
    key2: K2,
    expectedType?: Expected,
    flagsParam: F = flags as F,
  ): flagsParam is
    & F
    & {
      [P in K1 | K2]: Expected extends "string" ? string
        : Expected extends "number" ? number
        : Expected extends "boolean" ? boolean
        : Expected extends "object" ? object
        // deno-lint-ignore ban-types
        : Expected extends "function" ? Function
        : Expected extends "undefined" ? undefined
        : never;
    } {
    return hasEitherFlagOfType(
      flagsParam as Record<string, unknown>,
      key1,
      key2,
      expectedType,
    );
  }

  return {
    firstToken,
    secondToken,
    bareTokens,
    flags,
    hasFlagOfType: boundHasFlagOfType,
    hasEitherFlagOfType: boundHasEitherFlagOfType,
  };
}
