// node-decorator.ts
//
// Single-line annotation / decorator processor for mdast trees.
//
// This plugin looks for paragraphs whose first text line begins with a
// configurable decorator start (default: "@"), for example:
//
//   @id section-123
//
// It then replaces that paragraph with a structured `semantic-decorator`
// node carrying:
//   - `name`: the decorator command / name (e.g. "id")
//   - `decorator`: the full decorator string after the marker
//   - `pi`: parsed POSIX-style processing instructions
//   - `attrs`: optional parsed JSON5 attributes
//
// The plugin itself does *not* wire these annotations to headings,
// siblings, or other nodes. It is designed as a low-level building block
// so that other plugins or application code can later interpret these
// nodes as decorations on nearby content.

import type { Paragraph, Root, Text } from "types/mdast";
import type { Node, Parent } from "types/unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import {
  instructionsFromText,
  PosixStylePI,
} from "../../../universal/posix-pi.ts";

/**
 * A semantic decorator extracted from a single-line paragraph.
 *
 * Example source:
 *   "@id section-foo --flag key=value"
 *
 * Parsed as:
 *   name: "id"
 *   decorator: "id section-foo --flag key=value"
 *   pi: parsed flags/tokens from the decorator
 *   attrs: parsed JSON5 object from trailing "{ ... }", if present
 *
 * These nodes are emitted by {@link nodeDecoratorPlugin}. The plugin
 * does not interpret or attach these decorators to other nodes; it
 * merely exposes them as structured annotations that other plugins or
 * later code can use to connect semantic IDs to parents, siblings, or
 * arbitrary parts of the tree.
 */
export interface SemanticDecorator extends Node {
  type: "semantic-decorator";
  kind: string; // the kind of decorator (@, etc.)
  /** The decorator name (e.g. "id"). */
  name: string;
  /**
   * The decorator string immediately following the `decoratorStart`
   * character(s). For "@id section-foo", this would be
   * `"id section-foo"`.
   */
  decorator: string;
  /** Parsed Processing Instructions (flags/tokens). */
  pi: PosixStylePI;
  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  attrs?: Record<string, unknown>;
}

/**
 * Type guard for {@link SemanticDecorator} nodes.
 *
 * Safe to use with `unknown`, plain `Node`, or mdast node unions:
 *
 * ```ts
 * if (isSemanticDecorator(node)) {
 *   console.log(node.name, node.decorator, node.pi);
 * }
 * ```
 */
export function isSemanticDecorator(
  node: Node | null | undefined,
): node is SemanticDecorator {
  return node?.type === "semantic-decorator";
}

/**
 * Options for {@link nodeDecoratorPlugin}.
 */
export interface NodeDecoratorOptions {
  /**
   * String that must appear at the start of the (trimmed) line to
   * indicate an annotation/decorator. Defaults to "@".
   *
   * For example, with the default "@", the line:
   *   "@id foo"
   * will be parsed such that the decorator text becomes "id foo".
   */
  decoratorStart?: string;

  /**
   * Optional callback invoked when a decorator line is found. Receives
   * the original `Paragraph` and the freshly constructed
   * `SemanticDecorator` node.
   *
   * If this callback returns a `SemanticDecorator`, that value will be
   * used as the final node. If it returns `undefined`, the original
   * `SemanticDecorator` is preserved.
   */
  onDecorator?: (
    encountered: Paragraph,
    node: SemanticDecorator,
  ) => SemanticDecorator | void;
}

/**
 * remark plugin that converts single-line decorator paragraphs into
 * `semantic-decorator` nodes.
 *
 * Behavior:
 * - Scans `paragraph` nodes.
 * - If the first text child starts with `decoratorStart` (default "@"),
 *   it takes the rest of the line as the decorator text, parses it via
 *   `instructionsFromText`, and constructs a `SemanticDecorator`.
 * - Replaces the paragraph with the resulting `semantic-decorator` node,
 *   preserving `position` and any existing `data`.
 *
 * This plugin does not perform any wiring or decoration itself; it is
 * intended as a primitive that other plugins can use to attach semantic
 * IDs or annotations to nearby nodes.
 */
export const nodeDecoratorPlugin: Plugin<[NodeDecoratorOptions?], Root> = (
  options,
) => {
  const decoratorStart = options?.decoratorStart ?? "@";
  const onDecorator = options?.onDecorator;

  return (tree) => {
    visit<Root, "paragraph">(tree, "paragraph", (node, index, parent) => {
      if (!parent || typeof index !== "number") return;

      const paragraph = node as Paragraph;

      // Find the first text child; we only care about a leading decorator
      const firstText = paragraph.children.find(
        (child): child is Text => child.type === "text",
      );
      if (!firstText) return;

      const raw = firstText.value;
      const trimmed = raw.trimStart();

      // Must start with the decoratorStart string (e.g. "@")
      if (!trimmed.startsWith(decoratorStart)) return;

      // Strip the start marker, get rest of line
      const decorator = trimmed.slice(decoratorStart.length).trimStart();
      if (!decorator) return;

      const { pi, attrs, cmdLang: name } = instructionsFromText(decorator);
      if (!name) return;

      let semanticNode: SemanticDecorator = {
        type: "semantic-decorator",
        kind: decoratorStart,
        name,
        decorator,
        pi,
        attrs,
        data: paragraph.data,
        position: paragraph.position,
      };

      if (onDecorator) {
        const result = onDecorator(paragraph, semanticNode);
        if (result) {
          semanticNode = result;
        }
      }

      (parent as Parent).children.splice(index, 1, semanticNode);
    });
  };
};
