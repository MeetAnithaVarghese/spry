// node-src-text.ts
//
// Utilities for mapping MDAST/UNIST nodes back to their originating source
// text and for computing heading-based section ranges.
//
// - nodeOffsetsInSource(source, node) → [start, end] offsets
// - sliceSourceForNode(source, node, stringifier?) → exact substring or
//   stringified fallback
// - computeSectionRangesForHeadings(root, source, headings) → non-overlapping
//   section ranges driven by headings
// - nodeSrcText(root, source, stringifier?) → convenient adapter bundling
//   the above helpers for a given document
//
// The stringifier is injected and defaults to `remark().stringify`, but can
// be overridden for testing or alternative pipelines.

import type { Node } from "types/unist";
import type { Heading, Root, RootContent } from "types/mdast";
import { remark } from "remark";

// ---------------------------------------------------------------------------
// Position helpers (strictly typed)
// ---------------------------------------------------------------------------

export interface PositionPoint {
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
}

export interface Position {
  readonly start?: PositionPoint;
  readonly end?: PositionPoint;
}

function getPosition(node: Node): Position | undefined {
  const pos = (node as Node & { position?: Position }).position;
  if (!pos || !pos.start || !pos.end) return undefined;
  return pos;
}

// ---------------------------------------------------------------------------
// Offsets + slicing
// ---------------------------------------------------------------------------

/**
 * Compute [start, end] offsets in `source` for a given node, if possible.
 *
 * Uses:
 * - `position.start.offset` / `position.end.offset` when available, or
 * - `line` / `column` plus the source text when offsets are absent.
 */
export function nodeOffsetsInSource(
  source: string,
  node: Node,
): [number, number] | undefined {
  const pos = getPosition(node);
  if (!pos || !pos.start || !pos.end) return undefined;

  const start = pos.start;
  const end = pos.end;

  if (
    typeof start.offset === "number" &&
    typeof end.offset === "number"
  ) {
    return [start.offset, end.offset];
  }

  const lines = source.split(/\r?\n/);

  const startLineIdx = (start.line ?? 1) - 1;
  const endLineIdx = (end.line ?? 1) - 1;
  const startCol = (start.column ?? 1) - 1;
  const endCol = (end.column ?? 1) - 1;

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

// ---------------------------------------------------------------------------
// Stringifier + slicing
// ---------------------------------------------------------------------------

/**
 * A function that turns a Root MDAST into a string representation.
 * Typically `remark().stringify(root)`.
 */
export type RootStringifier = (root: Root) => string;

const defaultStringifier: RootStringifier = (root: Root) =>
  remark().stringify(root);

/**
 * Slice the original source text that corresponds to the given node.
 *
 * If offsets are unavailable, falls back to re-stringifying the node via
 * the provided `stringifier` (defaults to remark's stringifier).
 */
export function sliceSourceForNode(
  source: string,
  node: Node,
  stringifier: RootStringifier = defaultStringifier,
): string {
  const offsets = nodeOffsetsInSource(source, node);
  if (offsets) {
    const [start, end] = offsets;
    return source.slice(start, end);
  }

  // Fallback: as a last resort, re-stringify this node
  const root: Root = { type: "root", children: [node as RootContent] };
  return stringifier(root);
}

// ---------------------------------------------------------------------------
// Section ranges
// ---------------------------------------------------------------------------

export interface SectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Given the root, source, and a list of selected heading nodes that are
 * direct children of the root, compute non-overlapping section ranges:
 * each from a heading's start to the next heading of same or higher depth
 * (or end-of-file).
 *
 * Overlapping/adjacent ranges are merged.
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
      if (r.end > last.end) {
        (last as { end: number }).end = r.end;
      }
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Convenience adapter
// ---------------------------------------------------------------------------

/**
 * Convenience adapter that binds `source` and `root` and returns helpers:
 *
 * - nodeOffsets(node)
 * - sliceForNode(node)
 * - sectionRangesForHeadings(headings)
 */
export function nodeSrcText(
  root: Root,
  source: string,
  stringifier: RootStringifier = defaultStringifier,
) {
  return {
    nodeOffsets: (node: Node) => nodeOffsetsInSource(source, node),
    sliceForNode: (node: Node) => sliceSourceForNode(source, node, stringifier),
    sectionRangesForHeadings: (headings: Heading[]) =>
      computeSectionRangesForHeadings(root, source, headings),
  };
}
