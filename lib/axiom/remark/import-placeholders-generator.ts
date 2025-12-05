/**
 * Final stage of the code-import pipeline.
 *
 * This plugin consumes the metadata produced by `resolveImportSpecs`
 * (from code-import.ts) and performs the actual transformation of the
 * Markdown document:
 *
 *   • For each spec block with `importSpecs` attached:
 *        – Generates new code nodes via `prepareCodeNodes`
 *        – Attaches provenance metadata (`generated`)
 *        – Inserts or replaces the original spec node
 *
 * The module therefore acts as the “inserter” while code-import.ts acts
 * as the “analyzer”.
 *
 * Together, they form a two-stage pipeline:
 *
 *    1. resolveImportSpecs  → detects + parses import logic
 *    2. insertCodeImportNodes → materializes + inserts new nodes
 *
 * This keeps concerns clean:
 *   - Parsing/import resolution never mutates the tree
 *   - Insertion logic is isolated and explicit
 */
import type { Code, Node, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import {
  CodeImportSpecProvenance,
  isCodeImport,
  prepareCodeNodes,
} from "./import-specs-resolver.ts";

export type ImportPlaceholder = {
  readonly isImportPlaceholder: true;
  readonly importSpecProvenance: CodeImportSpecProvenance;
  readonly isImportSpecBinaryHint: boolean;
};

export function isImportPlaceholder(
  node: Node,
): node is Code & ImportPlaceholder {
  return node && node.type === "code" &&
      "isImportPlaceholder" in node &&
      node.isImportPlaceholder &&
      "provenance" in node && node.provenance
    ? true
    : false;
}

export interface CodeImportInsertOptions {
  readonly retainAfterInjections?: (code: Code) => boolean;
  readonly consumeEdges?: (
    edges: { generatedBy: Node; placeholder: Node }[],
    vfile: VFile,
    tree: Root,
  ) => void;
}

/**
 * remark plugin that *inserts* generated code nodes for each import-spec block.
 *
 * Workflow:
 *   1. locate every `code` node that has `importSpecs` (added by resolveImportSpecs)
 *   2. run `prepareCodeNodes()` to create imported `code` nodes
 *   3. attach provenance to generated nodes via `codeGenNDF`
 *   4. mutate the AST:
 *        • if retainAfterInjections(node) is true → keep original block
 *          and insert generated nodes immediately after it
 *        • else → replace the original block entirely with the generated nodes
 *
 * The plugin batches mutations and applies them bottom-up to avoid
 * index shifting during traversal.
 *
 * @param options Optional configuration:
 *   - retainAfterInjections: decides whether the original spec block is kept
 *   - readLocalFsTextIntoValue: determines if local files are read into node.value
 *
 * @returns A unified-compatible transformer that mutates the MDAST.
 */
export const insertImportPlaceholders: Plugin<
  [CodeImportInsertOptions?],
  Root
> = (
  options,
) => {
  return (tree: Root, vfile: VFile) => {
    const { retainAfterInjections = () => true } = options ?? {};

    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Code[];
      mode: "retain-after-injections" | "remove-before-injections";
    }[] = [];

    visit(tree, "code", (code: Code, index, parent) => {
      if (parent == null || index == null) return;
      if (!isCodeImport(code)) return;

      const mode = retainAfterInjections == undefined
        ? "retain-after-injections" as const
        : (retainAfterInjections(code)
          ? "retain-after-injections" as const
          : "remove-before-injections" as const);

      const imported = Array.from(prepareCodeNodes(code));

      if (imported.length) {
        if (options?.consumeEdges) {
          options.consumeEdges(
            imported.map((generated) => ({
              generatedBy: code,
              placeholder: generated,
            })),
            vfile,
            tree,
          );
        }

        mutations.push({ parent, index, injected: imported, mode });
      }
    });

    // Apply mutations after traversal, from right to left.
    mutations.sort((a, b) => b.index - a.index);

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        // Replace spec node with injected nodes
        parent.children.splice(index, 1, ...injected);
      } else {
        // retain-after-injections: keep spec; insert injected nodes after it
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};

export default insertImportPlaceholders;
