// io_test.ts
//
// Synthetic tests for markdownASTs() with no real filesystem or network I/O.

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";

import { mardownParserPipeline, markdownASTs } from "./io.ts";

import { vfileResourcesFactory } from "../mdast/vfile-resource.ts";

import type {
  ResourceProvenance,
  ResourceStrategy,
} from "../../universal/resource.ts";

import type { Heading, Root } from "types/mdast";

// Synthetic in-memory "files"
const TEXT_FIXTURES: Record<string, string> = {
  "a.md": "# Title A\n\nParagraph A\n",
  "b.md": "# Title B\n\nParagraph B\n",
  "dup.md": "# Duplicate\n\nSame file twice\n",
  "remote.md": "# Remote\n\nFrom URL\n",
};

function makeSyntheticFactory() {
  return vfileResourcesFactory<ResourceProvenance, ResourceStrategy>({
    // Synthetic local loader: input is ignored, we use provenance.path
    onFetchLocalFS: (
      _input,
      _init,
      prov,
      _strat,
    ) => {
      const text = TEXT_FIXTURES[prov.path];
      if (text === undefined) {
        return Promise.resolve(
          new Response("Not found", { status: 404 }),
        );
      }
      return Promise.resolve(
        new Response(text, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
      );
    },

    // Synthetic remote loader: use the URL to derive the key
    onFetchRemoteURL: (
      input,
      _init,
      _prov,
      _strat,
    ) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      const key = url.pathname.split("/").pop() ?? "";
      const text = TEXT_FIXTURES[key] ?? TEXT_FIXTURES["remote.md"];

      return Promise.resolve(
        new Response(text, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
      );
    },
  });
}

Deno.test("markdownASTs with string[] paths and synthetic loaders", async () => {
  const factory = makeSyntheticFactory();
  const pipeline = mardownParserPipeline();

  const seenPaths: string[] = [];
  const seenHeadings: string[] = [];

  const provs = ["a.md", "b.md"] as const;

  for await (
    const { resource, file, mdastRoot, nodeSrcText } of markdownASTs<
      ResourceProvenance,
      ResourceStrategy
    >(provs, { factory, pipeline })
  ) {
    const prov = resource.provenance;
    seenPaths.push(prov.path);

    // Basic VFile checks
    assertExists(file);
    assert(typeof file.path === "string");
    assertEquals(file.path, prov.label ?? prov.path);

    // Basic MDAST checks
    const root = mdastRoot as Root;
    assertEquals(root.type, "root");
    assert(Array.isArray(root.children));

    const headings = root.children.filter((n) =>
      n.type === "heading"
    ) as Heading[];
    assert(headings.length >= 1);

    // Use mdText helpers on the first heading
    const firstHeading = headings[0]!;
    const slice = nodeSrcText.sliceForNode(firstHeading);
    seenHeadings.push(slice.trim());
  }

  // We should have processed both files
  assertEquals(seenPaths.sort(), ["a.md", "b.md"]);
  // Headings should come from the first-line markdown headings
  assertEquals(
    seenHeadings.sort(),
    ["# Title A", "# Title B"],
  );
});

Deno.test("markdownASTs with ResourceProvenance iterable and deduplication", async () => {
  const factory = makeSyntheticFactory();
  const pipeline = mardownParserPipeline();

  const provs: ResourceProvenance[] = [
    { path: "dup.md", label: "dup", mimeType: "text/markdown" },
    { path: "dup.md", label: "dup", mimeType: "text/markdown" },
  ];

  const seenRoots: Root[] = [];
  const seenSlices: string[] = [];

  for await (
    const { file, mdastRoot, nodeSrcText } of markdownASTs<
      ResourceProvenance,
      ResourceStrategy
    >(provs, { factory, pipeline })
  ) {
    // Because markdownASTs uses uniqueResources(), we should only see
    // this duplicative provenance once.
    seenRoots.push(mdastRoot as Root);

    const headings = mdastRoot.children.filter((n) =>
      n.type === "heading"
    ) as Heading[];

    assert(headings.length >= 1);
    const slice = nodeSrcText.sliceForNode(headings[0]!);
    seenSlices.push(slice.trim());

    // sanity check VFile content
    assertEquals(String(file.value).includes("Duplicate"), true);
  }

  assertEquals(seenRoots.length, 1);
  assertEquals(seenSlices.length, 1);
  assertEquals(seenSlices[0], "# Duplicate");
});

Deno.test("markdownASTs handles remote-style URLs via synthetic remote loader", async () => {
  const factory = makeSyntheticFactory();
  const pipeline = mardownParserPipeline();

  const provs = ["https://example.com/remote.md"];

  const headingsSeen: string[] = [];

  for await (
    const { file, mdastRoot, nodeSrcText } of markdownASTs<
      ResourceProvenance,
      ResourceStrategy
    >(provs, { factory, pipeline })
  ) {
    assertExists(file);
    const root = mdastRoot as Root;

    const headings = root.children.filter((n) =>
      n.type === "heading"
    ) as Heading[];

    assert(headings.length >= 1);
    const slice = nodeSrcText.sliceForNode(headings[0]!);
    headingsSeen.push(slice.trim());
  }

  assertEquals(headingsSeen.length, 1);
  assertEquals(headingsSeen[0], "# Remote");
});
