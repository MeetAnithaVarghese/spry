/**
 * Markdown AST I/O and source-related helpers:
 *
 * - Acquiring markdown from files / URLs / stdin
 * - Configuring the remark processor + plugins
 * - Computing byte ranges for nodes and heading-based sections
 * - Slicing original source text for nodes / sections
 */

import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Code, Heading, Node, Root, RootContent } from "types/mdast";
import { unified } from "unified";

import { remark } from "remark";

import { VFile } from "vfile";
import docFrontmatterPlugin from "../plugin/doc/doc-frontmatter.ts";
import documentSchemaPlugin, {
  boldParagraphSectionRule,
  colonParagraphSectionRule,
} from "../plugin/doc/doc-schema.ts";
import codeFrontmatterPlugin, {
  codeFrontmatterNDF,
} from "../plugin/node/code-frontmatter.ts";
import codePartialsPlugin, {
  codePartialsCollection,
} from "../plugin/node/code-partial.ts";
import headingFrontmatterPlugin, {
  isCodeConsumedAsHeadingFrontmatterNode,
} from "../plugin/node/heading-frontmatter.ts";
import { classifiersFromFrontmatter } from "../plugin/node/node-classify-fm.ts";
import nodeClassifierPlugin from "../plugin/node/node-classify.ts";
import nodeIdentitiesPlugin from "../plugin/node/node-identities.ts";

import { basename, relative } from "@std/path";

import {
  Source,
  SourceLabel,
  SourceProvenance,
  sources,
  uniqueSources,
} from "../../universal/resource.ts";
import { codePartialSNDF } from "../plugin/node/code-partial.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Yielded<T> = T extends Generator<infer Y> ? Y
  : T extends AsyncGenerator<infer Y> ? Y
  : never;

// ---------------------------------------------------------------------------
// Remark orchestration
// ---------------------------------------------------------------------------

export function mardownParserPipeline(init: {
  readonly codePartialsCollec?: ReturnType<typeof codePartialsCollection>;
} = {}) {
  const { codePartialsCollec } = init;

  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"]) // extracts to YAML node but does not parse
    .use(remarkDirective) // creates directives from :[x] ::[x] and :::x
    .use(docFrontmatterPlugin) // parses extract YAML and stores at md AST root
    .use(remarkGfm) // support GitHub flavored markdown
    .use(headingFrontmatterPlugin) // find closest YAML blocks near headings and attached to heading.data[headingFM]
    .use(codeFrontmatterPlugin, { // finds code cells and extract posix PI and attributes to treat as "code frontmatter"
      coerceNumbers: true, // "9" -> 9
      onAttrsParseError: "ignore", // ignore invalid JSON5 instead of throwing
    })
    .use(codePartialsPlugin, {
      // finds code cells marked as `PARTIAL` and store them (should come after codeFrontmatterPlugin)
      collect: (cp) => {
        codePartialsCollec?.register(cp);
      },
    })
    .use(nodeClassifierPlugin, {
      // classifies nodes using instructions from markdown document and headings frontmatter
      // be sure that all frontmatter plugins are run before this
      classifiers: classifiersFromFrontmatter(),
    })
    .use(nodeIdentitiesPlugin, {
      // establish identities last, after everything else is done for stability
      identityFromNode: (node) => {
        if (node.type === "code") {
          const code = node as Code;
          if (codePartialSNDF.is(code)) {
            return {
              supplier: "code-partial",
              identity: code.data.codePartial.identity,
            };
          } else if (
            codeFrontmatterNDF.is(code) &&
            !isCodeConsumedAsHeadingFrontmatterNode(code)
          ) {
            if (code.data.codeFM.pi.posCount > 0) {
              return {
                supplier: "code",
                identity: code.data.codeFM.pi.pos[0],
              };
            }
          }
        }
        return false;
      },
      identityFromHeadingFM: (fm, node) => {
        if (!fm?.id || node.type !== "heading") return false as const;
        return {
          supplier: "headFM",
          identity: String(fm.id),
        };
      },
    })
    .use(documentSchemaPlugin, {
      // this plugin maintains node indexes so if you plan on mutating the AST,
      // do it before this plugin
      namespace: "prime",
      enrichWithBelongsTo: true,
      includeDefaultHeadingRule: true,
      sectionRules: [
        boldParagraphSectionRule(),
        colonParagraphSectionRule(),
      ],
    });
}

/**
 * Typed metadata attached to each VFile created from a Source.
 *
 * Stored as `file.data.resource`.
 */
export interface ResourceMeta<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
> {
  readonly origin: Source<PathKey, SP>;
  readonly label: SourceLabel;
  readonly nature: Source<PathKey, SP>["nature"];
  readonly provenance: SP;
}

/**
 * A VFile whose `data.resource` field carries typed resource metadata.
 */
export type ResourceVFile<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
> = VFile & {
  data: VFile["data"] & {
    resource: ResourceMeta<PathKey, SP>;
  };
};

/**
 * Async generator that materializes `VFile` instances for each Source.
 *
 * Each yielded file has:
 *
 * - `file.value` → text contents
 * - `file.path`  → derived from `origin.label` (override via `pathFromSource`)
 * - `file.data.resource` → strongly-typed `ResourceMeta`
 *
 * Error behavior mirrors `textSources()`:
 *
 * - If loading succeeds → yields `{ origin, file }`.
 * - If loading fails:
 *   - If `options.onError` is provided → caller may return a replacement file
 *     or `false` to skip.
 *   - If `options.onError` is absent or returns `false` → skips that source.
 */
export async function* vfiles<
  PathKey extends string = "path",
  SP extends SourceProvenance<PathKey> = SourceProvenance<PathKey>,
>(
  srcs:
    | Iterable<Source<PathKey, SP>>
    | AsyncIterable<Source<PathKey, SP>>,
  options?: {
    /**
     * Optional working directory for created vfiles.
     */
    readonly cwd?: string | URL;

    /**
     * Optional override for the vfile path derived from a Source.
     * Defaults to `origin.label`.
     */
    readonly pathFromSource?: (
      origin: Source<PathKey, SP>,
    ) => string | undefined;

    /**
     * Error handler. Can:
     * - return a replacement `{ origin, file }` to keep the record
     * - return `false` to skip this source entirely
     */
    readonly onError?: (
      origin: Source<PathKey, SP>,
      error: Error,
    ) =>
      | {
        origin: Source<PathKey, SP>;
        file: ResourceVFile<PathKey, SP>;
        text: string;
        fileRef: (node: Node, relTo?: string) => string;
      }
      | false
      | Promise<
        | {
          origin: Source<PathKey, SP>;
          file: ResourceVFile<PathKey, SP>;
          text: string;
          fileRef: (node: Node, relTo?: string) => string;
        }
        | false
      >;
  },
) {
  const { cwd, pathFromSource } = options ?? {};

  for await (const origin of srcs) {
    const loaded = await origin.safeText();

    if (typeof loaded === "string") {
      const path = pathFromSource?.(origin) ?? origin.label;

      const file = new VFile({
        value: loaded,
        path,
        cwd: String(cwd),
      }) as ResourceVFile<PathKey, SP>;

      file.data.resource = {
        origin,
        label: origin.label,
        nature: origin.nature,
        provenance: origin.provenance,
      };

      const fileRef = (node: Node, relTo?: string) => {
        const file = relTo
          ? relative(relTo, origin.label)
          : basename(origin.label);
        if (origin.nature === "remote-url") return file;
        const line = node?.position?.start?.line;
        if (typeof line !== "number") return file;
        return `${file}:${line}`;
      };

      yield { origin, file, text: loaded, fileRef };
      continue;
    }

    // Handle error case
    const error = loaded instanceof Error ? loaded : new Error(String(loaded));
    const replaced = await options?.onError?.(origin, error);

    if (replaced) {
      // Trust caller's typing of ResourceVFile
      yield replaced;
    }
    // if we get to here we've ignored the file
  }
}

export async function* markdownASTs(
  src: Iterable<SourceProvenance> | AsyncIterable<SourceProvenance>,
  options?: Parameters<typeof vfiles>[1] & {
    readonly mdParsePipeline?: ReturnType<typeof mardownParserPipeline>;
    readonly codePartialsCollec?: ReturnType<typeof codePartialsCollection>;
  },
) {
  // we maintain a single partials collection across all markdown files
  const mdpp = options?.mdParsePipeline ??
    mardownParserPipeline({ codePartialsCollec: options?.codePartialsCollec });
  for await (
    const vf of vfiles(uniqueSources(sources(src)), options)
  ) {
    const mdastRoot = mdpp.parse(vf.file);
    await mdpp.run(mdastRoot);
    yield {
      ...vf,
      mdastRoot,
      mdText: {
        nodeOffsets: (node: Node) => nodeOffsetsInSource(vf.text, node),
        sliceForNode: (node: Node) => sliceSourceForNode(vf.text, node),
        sectionRangesForHeadings: (headings: Heading[]) =>
          computeSectionRangesForHeadings(mdastRoot, vf.text, headings),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Source acquisition
// ---------------------------------------------------------------------------

export function nodeOffsetsInSource(
  source: string,
  node: Node,
): [number, number] | undefined {
  const pos = node.position as Any;
  if (!pos || !pos.start || !pos.end) return undefined;

  const start = pos.start as Any;
  const end = pos.end as Any;

  if (
    typeof start.offset === "number" &&
    typeof end.offset === "number"
  ) {
    return [start.offset, end.offset];
  }

  const lines = source.split(/\r?\n/);

  const startLineIdx = (start.line as number ?? 1) - 1;
  const endLineIdx = (end.line as number ?? 1) - 1;
  const startCol = (start.column as number ?? 1) - 1;
  const endCol = (end.column as number ?? 1) - 1;

  if (
    startLineIdx < 0 || startLineIdx >= lines.length ||
    endLineIdx < 0 || endLineIdx >= lines.length
  ) {
    return undefined;
  }

  const indexFromLineCol = (lineIdx: number, col: number): number => {
    let idx = 0;
    for (let i = 0; i < lineIdx; i++) {
      // +1 for newline
      idx += lines[i].length + 1;
    }
    return idx + col;
  };

  const startOffset = indexFromLineCol(startLineIdx, startCol);
  const endOffset = indexFromLineCol(endLineIdx, endCol);
  return [startOffset, endOffset];
}

/**
 * Slice the original source text that corresponds to the given node.
 *
 * If offsets are unavailable, falls back to re-stringifying the node via remark.
 */
export function sliceSourceForNode(
  source: string,
  node: Node,
): string {
  const offsets = nodeOffsetsInSource(source, node);
  if (offsets) {
    const [start, end] = offsets;
    return source.slice(start, end);
  }

  // Fallback: as a last resort, re-stringify this node
  const root: Root = { type: "root", children: [node as RootContent] };
  return remark().stringify(root);
}

// ---------------------------------------------------------------------------
// Section ranges
// ---------------------------------------------------------------------------

export interface SectionRange {
  start: number;
  end: number;
}

/**
 * Given the root, source, and a list of selected heading nodes that are
 * direct children of the root, compute non-overlapping section ranges:
 * each from a heading's start to the next heading of same or higher depth
 * (or end-of-file).
 */
export function computeSectionRangesForHeadings(
  root: Root,
  source: string,
  headings: Heading[],
): SectionRange[] {
  const children = root.children ?? [];
  if (children.length === 0 || headings.length === 0) return [];

  // Map heading node -> its index in root.children (only for direct children)
  const indexByNode = new Map<Heading, number>();
  children.forEach((child, idx) => {
    if (child.type === "heading") {
      indexByNode.set(child as Heading, idx);
    }
  });

  const indices: number[] = [];
  for (const h of headings) {
    const idx = indexByNode.get(h);
    if (idx !== undefined) indices.push(idx);
  }
  if (indices.length === 0) return [];

  indices.sort((a, b) => a - b);

  const ranges: SectionRange[] = [];

  for (const idx of indices) {
    const heading = children[idx] as Heading;
    const depth = heading.depth ?? 1;

    const offsets = nodeOffsetsInSource(source, heading as RootContent);
    if (!offsets) continue;
    const [startOffset] = offsets;

    // Find next heading of same or higher depth
    let endOffset = source.length;
    for (let j = idx + 1; j < children.length; j++) {
      const candidate = children[j];
      if (candidate.type === "heading") {
        const ch = candidate as Heading;
        const cDepth = ch.depth ?? 1;
        if (cDepth <= depth) {
          const nextOffsets = nodeOffsetsInSource(
            source,
            candidate as RootContent,
          );
          if (nextOffsets) {
            endOffset = nextOffsets[0];
          }
          break;
        }
      }
    }

    ranges.push({ start: startOffset, end: endOffset });
  }

  // Merge overlapping/adjacent ranges
  ranges.sort((a, b) => a.start - b.start);
  const merged: SectionRange[] = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1]!;
    if (r.start <= last.end) {
      // overlap or adjacency: extend the existing range
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}
