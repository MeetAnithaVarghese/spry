import type { RootContent } from "npm:@types/mdast@^4";
import {
  hasEitherFlagOfType,
  hasFlagOfType,
  parseClineFlags,
} from "../universal/cline.ts";
import { isAsyncIterator } from "../universal/collectable.ts";

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
> // TODO: strongly type parsedPI record?
 = {
  kind: "code";
  provenance: Provenance;
  language: string; // fence lang or "text"
  source: string; // fence body
  attrs: Attrs; // JSON5 from fence meta {...}
  pi?: string; // processing instructions are CLI-ish tokens before {...}
  parsedPI?: ReturnType<typeof parsedProcessingInstructions>; // meta prefix before {...}
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

export function isYamlNode(n: unknown): n is YamlNode {
  return hasType(n) && (n as { type?: unknown }).type === "yaml";
}

export function isHrNode(n: unknown): n is HrNode {
  return hasType(n) && (n as { type?: unknown }).type === "thematicBreak";
}

export function isHtmlNode(n: unknown): n is HtmlNode {
  return hasType(n) && (n as { type?: unknown }).type === "html";
}

export function isDefinitionNode(n: unknown): n is DefinitionNode {
  return hasType(n) && (n as { type?: unknown }).type === "definition";
}

export function posStartLine(n: unknown): number | undefined {
  const p = (n as WithPosition | undefined)?.position?.start?.line;
  return typeof p === "number" ? p : undefined;
}

export function posEndLine(n: unknown): number | undefined {
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
