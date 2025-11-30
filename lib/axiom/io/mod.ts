/**
 * Ontology I/O and orchestration helpers:
 *
 * - Acquiring markdown via Resource + VFile (vfileResourcesFactory)
 * - Configuring the remark/unified pipeline + plugins
 * - Producing MDAST roots + mdText helpers for each markdown resource
 */

import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "types/mdast";
import { unified } from "unified";

import docFrontmatterPlugin from "../remark/doc-frontmatter.ts";

import {
  provenanceFromPaths,
  type ResourceProvenance,
  type ResourceStrategy,
} from "../../universal/resource.ts";

import {
  isVFileResource,
  type MarkdownProvenance,
  vfileResourcesFactory,
} from "./resource.ts";

import { basename, dirname, resolve } from "@std/path";
import { nodeSrcText } from "../mdast/node-src-text.ts";
import { resolveImportSpecs } from "../remark/code-import.ts";
import { insertCodeImportNodes } from "../remark/code-insert.ts";
import { nodeDecoratorPlugin } from "../remark/node-decorator.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Yielded<T> = T extends Generator<infer Y> ? Y
  : T extends AsyncGenerator<infer Y> ? Y
  : never;

// ---------------------------------------------------------------------------
// Remark / unified orchestration
// ---------------------------------------------------------------------------

export function mardownParserPipeline() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"]) // extracts to YAML node but does not parse
    .use(remarkDirective) // creates directives from :[x] ::[x] and :::x
    .use(docFrontmatterPlugin) // parses extracted YAML and stores at md AST root
    .use(remarkGfm) // support GitHub flavored markdown
    .use(resolveImportSpecs, {
      interpolationCtx: (_root, vfile) => ({
        cwd: Deno.cwd(),
        env: Deno.env.toObject(),
        mdSrcAbsPath: resolve(vfile.path),
        mdSrcDirname: dirname(resolve(vfile.path)),
      }),
    }) // find code cells which want to be imported from local/remote files
    .use(insertCodeImportNodes) // generate code cells found by resolveImportSpecs
    .use(nodeDecoratorPlugin); // look for @id and transform to node.type == "decorator"
}

// ---------------------------------------------------------------------------
// markdownASTs — bridge from Resources → VFile + MDAST + mdText
// ---------------------------------------------------------------------------

export interface MarkdownASTsOptions<
  P extends ResourceProvenance = MarkdownProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> {
  /**
   * Optional preconfigured unified pipeline.
   * Defaults to `mardownParserPipeline()` with a shared code partials collection.
   */
  readonly pipeline?: ReturnType<typeof mardownParserPipeline>;

  /**
   * Optional preconfigured VFile-capable ResourcesFactory.
   * If omitted, `vfileResourcesFactory()` is used with its defaults.
   */
  readonly factory?: ReturnType<typeof vfileResourcesFactory<P, S>>;
}

/**
 * Async generator that:
 *
 * 1. Uses a VFile-aware ResourcesFactory to load markdown text into VFiles.
 * 2. Parses each VFile into an MDAST Root using the provided pipeline.
 * 3. Attaches `mdText` helpers via nodeSrcText() (offsets, slicing, sections).
 *
 * Yields objects shaped as:
 *
 * {
 *   resource: VFileCapableResource<P, S>;
 *   file: VFile;
 *   mdastRoot: Root;
 *   mdText: {
 *     nodeOffsets(node: Node): [number, number] | undefined;
 *     sliceForNode(node: Node): string;
 *     sectionRangesForHeadings(headings: Heading[]): { start: number; end: number }[];
 *   };
 * }
 */
export async function* markdownASTs<
  P extends ResourceProvenance = MarkdownProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  provenances: readonly string[] | Iterable<P> | AsyncIterable<P>,
  options: MarkdownASTsOptions<P, S> = {},
) {
  const pipeline = options.pipeline ?? mardownParserPipeline();
  const rf = options.factory ?? vfileResourcesFactory<P, S>({});

  // ---------------------------------------------------------------------------
  // Normalize input → provenance iterable
  // ---------------------------------------------------------------------------

  let provenanceIter: Iterable<P> | AsyncIterable<P>;

  if (
    Array.isArray(provenances) &&
    provenances.every((x) => typeof x === "string")
  ) {
    // Only treat as paths when it's really string[]
    provenanceIter = provenanceFromPaths(provenances as string[]) as
      | Iterable<P>
      | AsyncIterable<P>;
  } else {
    // Anything else (including P[]) is treated as Iterable<P> / AsyncIterable<P>
    provenanceIter = provenances as Iterable<P> | AsyncIterable<P>;
  }

  // ---------------------------------------------------------------------------
  // Build resources → filter to VFile resources → parse into mdast
  // ---------------------------------------------------------------------------

  const strategies = rf.strategies(provenanceIter);
  const rawResources = rf.resources(strategies);
  const resources = rf.uniqueResources(rawResources);

  for await (const r of resources) {
    if (!isVFileResource<P, S>(r)) continue;

    const resource = r;
    const file = resource.file;
    const text = String(file.value ?? "");

    const mdastRoot = pipeline.parse(file) as Root;
    await pipeline.run(mdastRoot, file);

    const nst = nodeSrcText(mdastRoot, text);

    yield {
      resource,
      file,
      mdastRoot,
      nodeSrcText: nst,
      mdSrcText: text,
      fileRef: resource.strategy.target === "remote-url"
        ? (() => basename(file.path))
        : ((node?: RootContent) => {
          const f = basename(file.path);
          const l = node?.position?.start?.line;
          if (typeof l !== "number") return f;
          return `${f}:${l}`;
        }),
    };
  }
}

export type MarkdownEncountered = Yielded<
  Awaited<ReturnType<typeof markdownASTs>>
>;
