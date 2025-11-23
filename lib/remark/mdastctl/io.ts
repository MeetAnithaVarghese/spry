/**
 * Markdown AST I/O and orchestration helpers:
 *
 * - Acquiring markdown via Resource + VFile (vfileResourcesFactory)
 * - Configuring the remark/unified pipeline + plugins
 * - Producing MDAST roots + mdText helpers for each markdown resource
 */

import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Code, Root } from "types/mdast";
import { unified } from "unified";

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
  codePartialSNDF,
} from "../plugin/node/code-partial.ts";
import headingFrontmatterPlugin, {
  isCodeConsumedAsHeadingFrontmatterNode,
} from "../plugin/node/heading-frontmatter.ts";
import { injectedNodes } from "../plugin/node/injected-nodes.ts";
import { classifiersFromFrontmatter } from "../plugin/node/node-classify-fm.ts";
import nodeClassifierPlugin from "../plugin/node/node-classify.ts";
import nodeIdentitiesPlugin from "../plugin/node/node-identities.ts";

import {
  provenanceFromPaths,
  type ResourceProvenance,
  type ResourceStrategy,
} from "../../universal/resource.ts";

import {
  isVFileResource,
  type MarkdownProvenance,
  vfileResourcesFactory,
} from "../mdast/vfile-resource.ts";

import { nodeSrcText } from "../mdast/node-src-text.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Yielded<T> = T extends Generator<infer Y> ? Y
  : T extends AsyncGenerator<infer Y> ? Y
  : never;

// ---------------------------------------------------------------------------
// Remark / unified orchestration
// ---------------------------------------------------------------------------

export function mardownParserPipeline(init: {
  readonly codePartialsCollec?: ReturnType<typeof codePartialsCollection>;
} = {}) {
  const { codePartialsCollec } = init;

  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"]) // extracts to YAML node but does not parse
    .use(remarkDirective) // creates directives from :[x] ::[x] and :::x
    .use(docFrontmatterPlugin) // parses extracted YAML and stores at md AST root
    .use(remarkGfm) // support GitHub flavored markdown
    .use(injectedNodes) // generate code cells from local/remote files
    .use(headingFrontmatterPlugin) // attach nearest YAML blocks to headings
    .use(codeFrontmatterPlugin, { // treat code cell PIs + attrs as "code frontmatter"
      coerceNumbers: true,
      onAttrsParseError: "ignore",
    })
    .use(codePartialsPlugin, {
      // collects PARTIAL code cells
      collect: (cp) => {
        codePartialsCollec?.register(cp);
      },
    })
    .use(nodeClassifierPlugin, {
      // classify nodes using document + heading frontmatter
      classifiers: classifiersFromFrontmatter(),
    })
    .use(nodeIdentitiesPlugin, {
      // establish identities last, after all other enrichment
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
   * Optional shared code partials collection. If provided and no pipeline is
   * given, it will be wired into the default pipeline.
   */
  readonly codePartialsCollec?: ReturnType<typeof codePartialsCollection>;

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
  const codePartialsCollec = options.codePartialsCollec ??
    codePartialsCollection();

  const pipeline = options.pipeline ??
    mardownParserPipeline({ codePartialsCollec });

  const rf = options.factory ??
    vfileResourcesFactory<P, S>({});

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
    await pipeline.run(mdastRoot);

    const nst = nodeSrcText(mdastRoot, text);

    yield {
      resource,
      file,
      mdastRoot,
      nodeSrcText: nst,
      mdSrcText: text,
    };
  }
}
