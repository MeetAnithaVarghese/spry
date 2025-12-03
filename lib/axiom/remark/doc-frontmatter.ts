/**
 * @module document-frontmatter
 *
 * Remark plugin that:
 * - Assumes remark-frontmatter has already run.
 * - Finds the first `yaml` node in the tree.
 * - Parses it as YAML.
 * - Optionally validates it with a Zod schema (safeParse).
 * - Stores a rich parsedFM payload on:
 *   - the yaml node: node.data.parsedFM
 *   - the document root: root.data.documentFrontmatter
 *   - the VFile: file.data.frontmatter (fm only, for convenience)
 */

import { parse as YAMLparse } from "@std/yaml";
import { z } from "@zod/zod";
import type { Node, Root, RootContent } from "types/mdast";
import type { Plugin } from "unified";
import type { VFile } from "vfile";
import { safeInterpolate } from "../../interpolate/safe.ts";
import { dataBag } from "../mdast/data-bag.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Dict = Record<string, unknown>;

export const parsedFrontmatterDataBag = dataBag<
  "parsedFM",
  ParsedFrontmatter<Dict>,
  Node
>("parsedFM");

export const docFrontmatterDataBag = dataBag<
  "documentFrontmatter",
  DocumentFrontmatter<Record<string, unknown>>,
  Root
>("documentFrontmatter");

export interface ParsedFrontmatter<FM extends Dict = Dict> {
  fm: FM;
  yamlErr?: Error;
  // Always present when a schema is supplied (even if it failed)
  zodParseResult?: z.ZodSafeParseResult<FM>;
}

export type YamlWithParsedFrontmatter<FM extends Dict = Dict> =
  & Extract<RootContent, { type: "yaml" }>
  & {
    data: {
      parsedFM: ParsedFrontmatter<FM>;
      [key: string]: unknown;
    };
  };

export interface DocumentFrontmatter<FM extends Dict = Dict> {
  node: YamlWithParsedFrontmatter<FM>;
  parsed: ParsedFrontmatter<FM>;
}

export interface DocumentFrontmatterOptions<FM extends Dict = Dict> {
  // Optional Zod schema to validate the parsed YAML
  readonly schema?: z.ZodType<FM, Any, Any>;
  // If true, remove the YAML block from tree.children after parsing
  readonly removeYamlNode?: boolean;
  // after loading frontmatter and before assignign to doc, interpolate
  readonly interpolate?: <Context>() => {
    contextKeyName: "project" | string;
    context: Context;
    locals: Record<string, unknown>;
  };
}

function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null;
}

/**
 * Plugin implementation.
 */
export const documentFrontmatter: Plugin<
  [DocumentFrontmatterOptions?],
  Root
> = function documentFrontmatterPlugin(options?: DocumentFrontmatterOptions) {
  return function transform(tree: Root, file?: VFile): void {
    const yamlIndex = tree.children.findIndex(
      (n): n is Extract<RootContent, { type: "yaml" }> => n.type === "yaml",
    );

    if (yamlIndex < 0) return;

    const yamlNode = tree.children[yamlIndex] as Extract<
      RootContent,
      { type: "yaml" }
    >;

    let rawFM = typeof yamlNode.value === "string" ? yamlNode.value : "";
    if (rawFM && rawFM.length > 0 && options?.interpolate) {
      const iu = options.interpolate();
      rawFM = safeInterpolate(rawFM, {
        [iu.contextKeyName]: iu.context, // fully custom, can be anything passed from project init location
        env: Deno.env.toObject(),
        ...iu.locals,
      });
    }

    let yamlErr: Error | undefined;
    let parsedYaml: unknown = {};

    try {
      parsedYaml = YAMLparse(rawFM);
      if (!isObject(parsedYaml)) {
        parsedYaml = {};
      }
    } catch (err) {
      yamlErr = err instanceof Error ? err : new Error(String(err));
      parsedYaml = {};
    }

    type FM = Dict;

    let fm: FM = parsedYaml as FM;

    const schema = options?.schema as z.ZodType<FM> | undefined;

    // This will always be defined when a schema is supplied (even if it fails)
    let zodParseResult: z.ZodSafeParseResult<FM> | undefined;

    if (schema) {
      const result = schema.safeParse(parsedYaml);
      zodParseResult = result;
      if (result.success) {
        fm = result.data as FM;
      }
    }

    const parsedFM: ParsedFrontmatter<FM> = {
      fm,
      ...(yamlErr ? { yamlErr } : null),
      ...(schema ? { zodParseResult } : null),
    };

    // Attach to yaml node
    const nodeData = (yamlNode.data ??= {} as Dict);
    (nodeData as Any).parsedFM = parsedFM;

    docFrontmatterDataBag.attach(tree, {
      node: yamlNode as YamlWithParsedFrontmatter<FM>,
      parsed: parsedFM,
    });

    // Also expose plain fm via VFile for ecosystem compatibility
    if (file) {
      const fdata = (file.data ??= {} as Dict);
      // just the fm object, not the full parsedFM
      (fdata as Any).frontmatter = fm;
    }

    // Optionally remove the YAML node itself from the AST
    if (options?.removeYamlNode) {
      tree.children.splice(yamlIndex, 1);
    }
  };
};

export default documentFrontmatter;
