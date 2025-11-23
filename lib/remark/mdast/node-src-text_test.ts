// node-src-text_test.ts
//
// Tests for node-src-text.ts using synthetic nodes only (no real parsing).

import {
  computeSectionRangesForHeadings,
  nodeOffsetsInSource,
  nodeSrcText,
  type RootStringifier,
  type SectionRange,
  sliceSourceForNode,
} from "./node-src-text.ts";

import type { Heading, Root, RootContent } from "types/mdast";
import type { Node } from "types/unist";

import { assertEquals, assertExists } from "jsr:@std/assert@1";

// Helper to create a generic node with a position using offsets
function makeNodeWithOffsets(
  start: number,
  end: number,
): Node {
  return {
    type: "test-node",
    position: {
      start: { offset: start, line: 1, column: start + 1 },
      end: { offset: end, line: 1, column: end + 1 },
    },
  } as Node;
}

function makeNodeWithLineCol(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): Node {
  return {
    type: "test-node",
    position: {
      start: { line: startLine, column: startCol, offset: undefined },
      end: { line: endLine, column: endCol, offset: undefined },
    },
  } as Node;
}

Deno.test("nodeOffsetsInSource uses explicit offsets when present", () => {
  const source = "abcdefg"; // 7 chars
  const node = makeNodeWithOffsets(2, 5);
  const off = nodeOffsetsInSource(source, node);
  assertExists(off);
  assertEquals(off, [2, 5]);
});

Deno.test("nodeOffsetsInSource computes offsets from line/column when offsets are missing", () => {
  const source = "abc\ndef\nxyz";
  // Layout with indices:
  // "abc\n" → indices 0..3
  // "def\n" → indices 4..7
  // "xyz"   → indices 8..10
  // So line 2, col 2 → index 5 ("e")
  //    line 3, col 3 → index 10 ("z")
  const node = makeNodeWithLineCol(2, 2, 3, 3);
  const off = nodeOffsetsInSource(source, node);
  assertExists(off);
  assertEquals(off, [5, 10]);
});

Deno.test("sliceSourceForNode uses offsets path when available", () => {
  const source = "abcdefg";
  const node = makeNodeWithOffsets(1, 4);
  const slice = sliceSourceForNode(source, node);
  assertEquals(slice, "bcd");
});

Deno.test("sliceSourceForNode falls back to stringifier when offsets unavailable", () => {
  const source = "irrelevant";
  const node: Node = {
    type: "paragraph",
    // No position
  } as Node;

  const customStringifier: RootStringifier = (root: Root) => {
    // A trivially predictable stringifier for testing
    return JSON.stringify(root);
  };

  // This path should call the stringifier because there is no position
  const slice = sliceSourceForNode(source, node, customStringifier);

  const expectedRoot: Root = {
    type: "root",
    children: [node as RootContent],
  };
  const expected = JSON.stringify(expectedRoot);

  assertEquals(slice, expected);
});

Deno.test("computeSectionRangesForHeadings computes and merges ranges", () => {
  const source = "abcdefg"; // indices 0..6

  // Heading 1 at [0, 2)
  const h1: Heading = {
    type: "heading",
    depth: 1,
    children: [],
    position: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 2, line: 1, column: 3 },
    },
  };

  // Heading 2 at [3, 5)
  const h2: Heading = {
    type: "heading",
    depth: 1,
    children: [],
    position: {
      start: { offset: 3, line: 1, column: 4 },
      end: { offset: 5, line: 1, column: 6 },
    },
  };

  const root: Root = {
    type: "root",
    children: [h1, h2],
  };

  const ranges = computeSectionRangesForHeadings(root, source, [h1, h2]);

  // Because the implementation merges overlapping/adjacent ranges,
  // we should end up with a single [0, source.length) range.
  assertEquals(ranges.length, 1);
  const [only] = ranges as [SectionRange];
  assertEquals(only.start, 0);
  assertEquals(only.end, source.length);
});

Deno.test("nodeSrcText adapter bundles helpers correctly", () => {
  const source = "abc\ndef\nxyz";
  const root: Root = {
    type: "root",
    children: [],
  };

  const adapter = nodeSrcText(root, source);

  const node = makeNodeWithLineCol(1, 1, 1, 3); // "ab"
  const offsets = adapter.nodeOffsets(node);
  assertExists(offsets);
  assertEquals(offsets, [0, 2]);

  const slice = adapter.sliceForNode(node);
  assertEquals(slice, "ab");
});
