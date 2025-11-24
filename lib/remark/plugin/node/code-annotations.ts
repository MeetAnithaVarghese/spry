/**
 * CodeAnnotations is a structured enrichment type for remark `code` nodes.
 * It parses fenced code blocks' content for Spry `@` annotations.
 *
 * The output is stored on each **mdast** `code` node at:
 *
 *   `node.data[codeAnns] = [{ language, annotations, annsCatalog }]`
 */

import { z } from "@zod/zod";
import type { Code, Root, RootContent } from "types/mdast";
import { visit } from "unist-util-visit";
import {
  AnnotationCatalog,
  extractAnnotationsFromTextSync,
} from "../../../universal/code-comments.ts";
import {
  getLanguageByIdOrAlias,
  type LanguageSpec,
} from "../../../universal/code.ts";
import { DataSupplierNode, nodeDataFactory } from "../../mdast/safe-data.ts";
import { codeFrontmatterNDF } from "./code-frontmatter.ts";

/** The structured enrichment attached to a code node by this plugin. */
export type CodeAnnotations<Anns extends Record<string, unknown>> = {
  readonly annotations?: Anns;
  readonly annsCatalog: AnnotationCatalog<Anns>;
  readonly factory: ReturnType<typeof annotationsFactory<Anns>>;
};

export const CODEANNS_KEY = "codeAnns" as const;
export type CodeAnnsKey = typeof CODEANNS_KEY;
export const codeAnnsNDF = nodeDataFactory<
  CodeAnnsKey,
  CodeAnnotations<Record<string, unknown>>
>(CODEANNS_KEY);

export type CodeWithAnnotationsNode<Anns extends Record<string, unknown>> =
  DataSupplierNode<Code, CodeAnnsKey, CodeAnnotations<Anns>>;

/**
 * Type guard: returns true if a `RootContent` node is a `code` node
 * that already carries CodeWithAnnotationsNode at the default store key.
 */
export function isCodeWithAnnotationsNode<Anns extends Record<string, unknown>>(
  node: RootContent,
): node is CodeWithAnnotationsNode<Anns> {
  if (node.type === "code" && node.data && CODEANNS_KEY in node.data) {
    return true;
  }
  return false;
}

/** Configuration options for the CodeAnnotations plugin. */
export interface CodeAnnotationsOptions<Anns extends Record<string, unknown>> {
  /** If defined, checks whether to ingest annotations from code value (`source`) */
  ingest?: (code: Code) => false | {
    language: LanguageSpec;
    prefix?: string; // TODO: should we just introduce a `normalize: () => string` for more flexibility?
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  };
  /**
   * If defined, this callback is called whenever code cells are enriched
   */
  collect?: (node: CodeWithAnnotationsNode<Anns>) => void;
}

/**
 * Core helper: discover and attach code annotations to a single `Code` node.
 * - Idempotent: if `CODEANNS_KEY` is already present, it reuses the existing data.
 * - Returns the annotated node (narrowed) or `undefined` if nothing was attached.
 */
export function discoverCodeAnnotations<Anns extends Record<string, unknown>>(
  node: Code,
  init: {
    language: LanguageSpec;
    prefix?: string;
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  },
): CodeWithAnnotationsNode<Anns> | undefined {
  // deno-lint-ignore no-explicit-any
  const untyped = node as any;
  const data = (untyped.data ??= {});

  // Already annotated: reuse
  if (data[CODEANNS_KEY]) {
    return node as CodeWithAnnotationsNode<Anns>;
  }

  const factory = annotationsFactory<Anns>(init);
  const annsCatalog = factory.catalog(node.value);
  const annotations = factory.transform(annsCatalog);

  data[CODEANNS_KEY] = {
    annotations,
    annsCatalog,
    factory,
  } satisfies CodeAnnotations<Anns>;

  return node as CodeWithAnnotationsNode<Anns>;
}

/**
 * Default ingest behavior when the user does NOT provide CodeAnnotationsOptions.ingest.
 *
 * Logic:
 *   1. If code-frontmatter enrichment exists AND
 *   2. "--annotations" flag is set
 *   → derive language and return an ingest-init object.
 */
export function defaultIngest(
  code: Code,
): false | {
  language: LanguageSpec;
  prefix?: string;
  defaults?: Partial<Record<string, unknown>>;
  schema?: z.ZodType;
} {
  // Case: rely on code-frontmatter
  if (!codeFrontmatterNDF.is(code)) return false;
  const { codeFM } = code.data;

  const flags = codeFM?.pi?.flags ?? {};
  const enabled = Boolean(flags.annotations);
  if (!enabled) return false;

  // Determine language
  const langId: string | undefined = codeFM.lang ?? code.lang ?? undefined;
  if (!langId) return false;

  const language = getLanguageByIdOrAlias(langId);
  if (!language) return false;

  return { language };
}

/**
 * CodeAnnotations remark plugin.
 *
 * @param options - See {@link CodeAnnotationsOptions}.
 * @returns A remark transformer that annotates `code` nodes with {@link CodeAnnotations}.
 */
export default function codeAnnotations(
  options: CodeAnnotationsOptions<Record<string, unknown>> = {},
) {
  const { ingest = defaultIngest, collect } = options;

  return function transformer(tree: Root) {
    visit(tree, "code", (node) => {
      let annotated:
        | CodeWithAnnotationsNode<Record<string, unknown>>
        | undefined;

      const answer = ingest(node);
      if (answer) {
        annotated = discoverCodeAnnotations<Record<string, unknown>>(
          node,
          answer,
        );
        if (annotated) {
          collect?.(annotated);
        }
      }
    });
  };
}

export function annotationsFactory<Anns extends Record<string, unknown>>(
  init: {
    language: LanguageSpec;
    prefix?: string;
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  },
) {
  function transform(
    catalog: Awaited<
      ReturnType<typeof extractAnnotationsFromTextSync<unknown>>
    >,
    opts?: { prefix?: string; defaults?: Partial<Anns> },
  ) {
    const { prefix, defaults } = opts ?? init;
    const annotations = prefix
      ? (catalog.items
        .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix))
        .map((it) =>
          [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        ))
      : catalog.items.map((it) => [it.key!, it.value ?? it.raw] as const);
    const found = annotations.length;
    if (found == 0) {
      if (!defaults) return undefined;
      if (Object.keys(defaults).length == 0) return undefined;
    }
    return { ...defaults, ...Object.fromEntries(annotations) } as Anns;
  }

  function catalog(source: string, language?: LanguageSpec) {
    return extractAnnotationsFromTextSync<Anns>(
      source,
      language ?? init?.language,
      {
        tags: { multi: true, valueMode: "json" },
        kv: false,
        yaml: false,
        json: false,
      },
    );
  }

  return { ...init, catalog, transform };
}
