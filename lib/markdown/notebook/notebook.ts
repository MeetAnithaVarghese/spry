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
 *   - Language is captured from the fence info string (defaults to "text").
 *   - Trailing "{ ... }" in the fence info is parsed with JSON5 into attrs.
 *   - Any leading text before "{ ... }" is preserved as `info`.
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
 * - CodeCell: { kind: "code", language, source, attrs, info?, startLine?, endLine? }
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
import { isAsyncIterator } from "../../universal/collectable.ts";

/* =========================== Public Types =========================== */

export type Source<Provenance> = {
  provenance: Provenance;
  content: string | ReadableStream<Uint8Array>;
  import?: (
    src: string | string[],
    cell: CodeCell<Provenance>,
  ) => string | Promise<string>;
  transformFrontmatter?: (fmRaw: string) => string | Promise<string>;
};

export type SourceStream<Provenance> =
  | Source<Provenance>
  | AsyncIterable<Source<Provenance>>
  | AsyncIterator<Source<Provenance>>;

/** Includes "lint" for enrichment/lint-stage findings. */
export type IssueDisposition = "error" | "warning" | "lint";

export type MarkdownIssue<Provenance> = {
  kind: string;
  provenance: Provenance;
  message: string;
  startLine?: number;
  endLine?: number;
  disposition: IssueDisposition;
  error?: unknown;
};

export type FrontmatterIssue<Provenance> = MarkdownIssue<Provenance> & {
  kind: "frontmatter-parse";
  raw: unknown;
  error: unknown;
};

export type FenceIssue<Provenance> = MarkdownIssue<Provenance> & {
  kind: "fence-issue";
  metaText?: string;
  error: unknown;
};

/** Base Issue union (non-generic) */
export type Issue<Provenance> =
  | FrontmatterIssue<Provenance>
  | FenceIssue<Provenance>;

export type ImportInstructionInfoFlags = {
  import: string | string[];
  "is-binary": boolean; // designed for ease of use by users in cells (not for devs)
};

/**
 * DX note:
 * - Juniors can just use Notebook without generics.
 * - Seniors can supply a richer issue type that extends `Issue`:
 *     type MyIssue = Issue & { origin?: string; plugin?: string };
 *     type MyNotebook = Notebook<FM, Attrs, MyIssue>;
 */
export type CodeCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> // TODO: strongly type parsedInfo record?
 = {
  kind: "code";
  provenance: Provenance;
  language: string; // fence lang or "text"
  source: string; // fence body
  attrs: Attrs; // JSON5 from fence meta {...}
  info?: string; // meta prefix before {...}
  parsedInfo?: ReturnType<typeof parsedTextFlags>; // meta prefix before {...}
  startLine?: number;
  endLine?: number;
  sourceElaboration?:
    & {
      isRefToBinary: boolean;
    }
    & (
      | {
        isRefToBinary: false;
        importedFrom: string | string[];
        original: string;
      }
      | {
        isRefToBinary: true;
        importedFrom: string;
        encoding: "UTF-8";
        rs?: ReadableStream<Uint8Array>;
      }
    );
  isVirtual: boolean; // true if not found in markdown but "generated" via live-include
};

export type MarkdownCell<Provenance> = {
  kind: "markdown";
  provenance: Provenance;
  markdown: string; // normalized markdown slice
  text: string; // plain text best-effort
  startLine?: number;
  endLine?: number;
};

export type Cell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> =
  | CodeCell<Provenance, Attrs>
  | MarkdownCell<Provenance>;

/** Per-notebook, cache of top-level mdast computed during parse (no need to re-parse later). */
export type NotebookAstCache = {
  /** For each notebook cell index: markdown cells -> mdast nodes; code cells -> null */
  readonly mdastByCell: ReadonlyArray<ReadonlyArray<RootContent> | null>;
  /** All mdast nodes after frontmatter up to (not including) the first code cell */
  readonly nodesBeforeFirstCode: ReadonlyArray<RootContent>;
  /** All mdast nodes after the last code cell (appendix) */
  readonly nodesAfterLastCode: ReadonlyArray<RootContent>;
  /** Indices of code cells in `cells` */
  readonly codeCellIndices: ReadonlyArray<number>;
};

export type Notebook<
  Provenance,
  FM extends Record<string, unknown> = Record<string, unknown>,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = {
  fm: FM; // {} if none/empty
  cells: Cell<Provenance, Attrs>[];
  issues: I[]; // allows extended issue types that include the base Issue shape
  /** mdast cache produced by the core parser (no need to re-parse later) */
  ast: NotebookAstCache;
  provenance: Provenance;
  source: Source<Provenance>;
};

/* =========================== Public API ============================== */

function isSourceObject<Provenance>(x: unknown): x is Source<Provenance> {
  return typeof x === "object" && x !== null &&
    "content" in (x as Record<string, unknown>);
}

/**
 * Normalize heterogeneous inputs of { content: string|ReadableStream } to full-document strings.
 * Note: We intentionally *do not* propagate `identity` here to keep the downstream API stable.
 * If you later want identity-aware parsing, we can thread it through a separate helper.
 */
export async function* normalizeSources<Provenance>(
  input: SourceStream<Provenance>,
): AsyncIterable<[Provenance, string, Source<Provenance>]> {
  // Single Source object
  if (isSourceObject<Provenance>(input)) {
    const { provenance, content } = input;
    if (typeof content === "string") {
      yield [provenance, content, input];
      return;
    }
    throw new TypeError("Unsupported Source.content type");
  }

  // Async iterator / async iterable of Source
  const it = isAsyncIterator(input)
    ? (input as AsyncIterator<Source<Provenance>>)
    : (input as AsyncIterable<Source<Provenance>>)[Symbol.asyncIterator]();

  while (true) {
    const { value, done } = await it.next();
    if (done) break;
    if (!isSourceObject(value)) {
      throw new TypeError("Stream yielded a non-Source value");
    }
    const { provenance, content } = value;
    if (typeof content === "string") {
      yield [provenance, content, value];
    } else if (isReadableStream(content)) {
      yield [provenance, await readStreamToText(content), value];
    } else {
      throw new TypeError("Unsupported Source.content type");
    }
  }
}

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

      // Extract trailing {...} JSON5 as attrs; prefix (if any) as info
      let attrs = {} as Attrs;
      let info: string | undefined;
      let parsedInfo: ReturnType<typeof parsedTextFlags> | undefined;
      if (metaRaw) {
        const m = metaRaw.match(/\{.*\}$/);
        if (m) {
          attrs = tryParseFenceAttrs(m[0]);
          info = metaRaw.replace(m[0], "").trim() || undefined;
        } else {
          info = metaRaw.trim();
        }
        parsedInfo = info ? parsedTextFlags(info) : undefined;
      }

      const codeCell: CodeCell<Provenance, Attrs> = {
        kind: "code",
        provenance,
        language: lang,
        source: String(node.value ?? ""),
        attrs,
        info,
        parsedInfo,
        startLine: posStartLine(node),
        endLine: posEndLine(node),
        isVirtual: false,
      };

      if (srcSupplied.import && parsedInfo && "import" in parsedInfo.flags) {
        const importSrc = parsedInfo.flags["import"];
        if (typeof importSrc !== "boolean") {
          const isRefToBinary = parsedInfo.flags["is-binary"] ? true : false;
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

/** Minimal POSIX-like tokenizer:
 * - Splits on whitespace.
 * - Respects single quotes: everything literal until next `'`.
 * - Respects double quotes: everything literal until next `"`, supports `\"` and `\\` escaping within.
 * - Outside quotes, `\x` becomes `x` (escapes next char).
 */
function tokenizePosix(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let q: '"' | "'" | null = null;

  const isSpace = (c: string) => /\s/.test(c);

  while (i < s.length) {
    const ch = s[i];

    if (q) {
      // Inside quotes
      if (q === '"' && ch === "\\") {
        // In double quotes, allow \" and \\ (treat \X as X)
        if (i + 1 < s.length) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
      }
      if (ch === q) {
        q = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // Outside quotes
    if (isSpace(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      // skip contiguous spaces
      i++;
      while (i < s.length && isSpace(s[i])) i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      q = ch as '"' | "'";
      i++;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < s.length) {
        cur += s[i + 1];
        i += 2;
        continue;
      }
      // trailing backslash -> treat literally
      cur += ch;
      i++;
      continue;
    }

    cur += ch;
    i++;
  }

  if (cur) out.push(cur);
  return out;
}

/**
 * Parse POSIX-style CLI args into `{ bareTokens, flags }`.
 *
 * Input may be either:
 *  - `string[]` (e.g., `Deno.args`) — processed directly, or
 *  - `string`  — tokenized internally using a minimal POSIX-like tokenizer
 *                (whitespace splits; supports single/double quotes; backslash
 *                escapes outside and inside double-quotes).
 *
 * Supports:
 * - Long flags: `--key value` or `--key=value`
 * - Short flags: `-k value` or `-k=value`
 * - Bare flags: `--key` or `-k` (boolean true)
 * - Bare tokens (no leading `-`): collected into `bareTokens: string[]`
 *
 * Behavior:
 * - `flags` merges onto an optional `base` record; first occurrence wins vs base.
 * - Repeated flags are promoted/collected into `string[]`.
 * - Bare tokens that are not consumed as flag values are captured in `bareTokens`.
 *
 * @example
 * ```ts
 * const a1 = ["build", "--out=dist", "-v", "src/main.ts", "--tag", "a", "--tag", "b"];
 * const r1 = parsedTextFlags(a1, { v: false as boolean });
 * // r1.bareTokens: ["build", "src/main.ts"]
 * // r1.flags: { out: "dist", v: true, tag: ["a", "b"] }
 *
 * const a2 = `build "src/main.ts" --out=dist --tag a --tag "b c" -v`;
 * const r2 = parsedTextFlags(a2);
 * // r2.bareTokens: ["build", "src/main.ts"]
 * // r2.flags: { out: "dist", tag: ["a", "b c"], v: true }
 * ```
 *
 * @template T - Optional initial record type for flags.
 * @param argv - CLI as array or single string to be tokenized.
 * @param base - Optional defaults or to drive the flags result typing.
 * @returns Object with `bareTokens` and `flags`.
 */
export function parsedTextFlags<
  T extends Record<string, string | string[] | boolean> = Record<
    string,
    string | string[] | boolean
  >,
>(
  argv: readonly string[] | string,
  base?: T,
) {
  const tokens = Array.isArray(argv)
    ? argv as readonly string[]
    : tokenizePosix(argv as string);
  const flagsOut: Record<string, string | string[] | boolean> = base
    ? { ...base }
    : {};
  const seenFromArg = new Set<string>();
  const bareTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Non-flag token: either a bare token or a value consumed by a previous flag.
    if (!token.startsWith("-")) {
      // Only recorded as bare when encountered standalone.
      bareTokens.push(token);
      continue;
    }

    const isLong = token.startsWith("--");
    const prefixLen = isLong ? 2 : 1;

    const eqIdx = token.indexOf("=");
    const key = eqIdx === -1
      ? token.slice(prefixLen)
      : token.slice(prefixLen, eqIdx);
    if (!key) continue;

    // Resolve value:
    // 1) --k=v or -k=v  => value after '='
    // 2) --k v or -k v  => next token if not a flag (also consumes it)
    // 3) --k or -k      => boolean true
    let val: string | boolean;
    if (eqIdx !== -1) {
      val = token.slice(eqIdx + 1);
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      val = tokens[++i]; // consume next token as the flag value
      // Note: Because we only push non-dash tokens to bareTokens when encountered,
      // consumed values won't appear among bareTokens.
    } else {
      val = true;
    }

    const current = flagsOut[key];

    if (Array.isArray(current)) {
      flagsOut[key] = [...current, String(val)];
    } else if (seenFromArg.has(key)) {
      if (typeof current === "string") {
        flagsOut[key] = [current, String(val)];
      } else if (current === true) {
        flagsOut[key] = ["true", String(val)];
      } else {
        flagsOut[key] = [String(val)];
      }
    } else {
      flagsOut[key] = val;
    }

    seenFromArg.add(key);
  }

  return {
    firstToken: bareTokens.length > 0 ? bareTokens[0] : undefined,
    secondToken: bareTokens.length > 1 ? bareTokens[1] : undefined,
    bareTokens,
    flags: flagsOut as T,
  };
}

/* =========================== Tiny Runtime & Type Guards ============== */

/** mdast position helper shapes (kept local, no `any`) */
type Pos = { line?: number };
type Position = { start?: Pos; end?: Pos };
type WithPosition = { position?: Position };

/** Treat unknown node shapes safely */
type YamlNode = { type: "yaml"; value?: string } & WithPosition;
type HrNode = { type: "thematicBreak" } & WithPosition;
type HtmlNode = { type: "html" } & WithPosition;
type DefinitionNode = { type: "definition" } & WithPosition;

function hasType(x: unknown): x is { type?: unknown } {
  return typeof x === "object" && x !== null &&
    "type" in (x as Record<string, unknown>);
}

function isYamlNode(n: unknown): n is YamlNode {
  return hasType(n) && (n as { type?: unknown }).type === "yaml";
}

function isHrNode(n: unknown): n is HrNode {
  return hasType(n) && (n as { type?: unknown }).type === "thematicBreak";
}

function isHtmlNode(n: unknown): n is HtmlNode {
  return hasType(n) && (n as { type?: unknown }).type === "html";
}

function isDefinitionNode(n: unknown): n is DefinitionNode {
  return hasType(n) && (n as { type?: unknown }).type === "definition";
}

function posStartLine(n: unknown): number | undefined {
  const p = (n as WithPosition | undefined)?.position?.start?.line;
  return typeof p === "number" ? p : undefined;
}

function posEndLine(n: unknown): number | undefined {
  const p = (n as WithPosition | undefined)?.position?.end?.line;
  return typeof p === "number" ? p : undefined;
}

export function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && x instanceof ReadableStream;
}

async function readStreamToText(
  rs: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = rs.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
