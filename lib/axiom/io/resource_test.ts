// vfile-resource_test.ts
//
// Tests vfileResourcesFactory + vfilePlugin using synthetic loaders only
// (no real filesystem or network I/O).

import {
  type Resource,
  type ResourceProvenance,
  resourcesFactory,
  type ResourceStrategy,
} from "../../universal/resource.ts";

import {
  isVFileResource,
  type VFileCapableResource,
  vfileResourcesFactory,
} from "./resource.ts";

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";

/* -------------------------------------------------------------------------- */
/*                      Synthetic in-memory data + fetch                       */
/* -------------------------------------------------------------------------- */

const TEXT_DATA: Record<string, string> = {
  "https://example.com/doc1.md": "abcdefg",
  "local/doc2.md": "# Title\n\nBody text\n",
};

const BINARY_DATA: Record<string, Uint8Array> = {
  "https://example.com/image.png": new Uint8Array([1, 2, 3]),
};

function syntheticFetch(
  input: RequestInfo | URL,
  _init?: RequestInit,
): Response {
  const key = typeof input === "string" ? input : input.toString();

  if (key in TEXT_DATA) {
    return new Response(TEXT_DATA[key], {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }

  if (key in BINARY_DATA) {
    const body = BINARY_DATA[key];
    // Use ArrayBuffer so types line up with BlobPart expectations.
    return new Response(new Blob([body.buffer as ArrayBuffer]), {
      headers: { "content-type": "image/png" },
    });
  }

  return new Response("NOT FOUND", { status: 404 });
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

Deno.test(
  "vfileResourcesFactory + vfilePlugin with synthetic loaders",
  async (t) => {
    const rf = vfileResourcesFactory<ResourceProvenance, ResourceStrategy>({
      makeFactory: (init) =>
        resourcesFactory<ResourceProvenance, ResourceStrategy>({
          ...init,
          onFetchRemoteURL: (input, initReq, _prov, _strat) =>
            Promise.resolve(syntheticFetch(input, initReq)),
          onFetchLocalFS: (input, initReq, _prov, _strat) =>
            Promise.resolve(syntheticFetch(input, initReq)),
        }),
    });

    const provenances: ResourceProvenance[] = [
      { path: "https://example.com/doc1.md", mimeType: "text/markdown" },
      { path: "local/doc2.md", mimeType: "text/markdown" },
      { path: "https://example.com/image.png", mimeType: "image/png" }, // binary
    ];

    await t.step(
      "text resources are enriched with VFile, binary is not",
      async () => {
        const stratIter = rf.strategies(provenances);
        const resIter = rf.resources(stratIter);

        const vfileResources: Array<
          VFileCapableResource<ResourceProvenance, ResourceStrategy>
        > = [];

        for await (const r of resIter) {
          if (isVFileResource(r)) {
            vfileResources.push(r);
          }
        }

        // Only the two markdown/text resources should be enriched
        assertEquals(vfileResources.length, 2);

        const byPath = new Map(
          vfileResources.map((r) => [r.provenance.path, r]),
        );

        const r1 = byPath.get("https://example.com/doc1.md");
        const r2 = byPath.get("local/doc2.md");

        assertExists(r1);
        assertExists(r2);

        assertExists(r1.file);
        assertExists(r2.file);
        assertEquals(r1.file.value, TEXT_DATA["https://example.com/doc1.md"]);
        assertEquals(r2.file.value, TEXT_DATA["local/doc2.md"]);

        assertExists(r1.file.data.provenance);
        assertEquals(r1.file.data.provenance, r1.provenance);
        assertEquals(r2.file.data.provenance, r2.provenance);

        const pathsWithFile = vfileResources.map((r) => r.provenance.path);
        assert(pathsWithFile.includes("https://example.com/doc1.md"));
        assert(pathsWithFile.includes("local/doc2.md"));
        assert(!pathsWithFile.includes("https://example.com/image.png"));
      },
    );

    await t.step(
      "onTextError hook can observe failures and skip resources",
      async () => {
        const errors: Array<
          {
            origin: Resource<ResourceProvenance, ResourceStrategy>;
            error: Error;
          }
        > = [];

        const rfErr = vfileResourcesFactory<
          ResourceProvenance,
          ResourceStrategy
        >({
          makeFactory: (init) =>
            resourcesFactory<ResourceProvenance, ResourceStrategy>({
              ...init,
              onFetchRemoteURL: (input, initReq, _prov, _strat) =>
                Promise.resolve(syntheticFetch(input, initReq)),
              onFetchLocalFS: (input, initReq, _prov, _strat) =>
                Promise.resolve(syntheticFetch(input, initReq)),
            }),
          onTextError: (origin, error) => {
            errors.push({ origin, error });
            // Return false (not async) to match the expected type
            return false;
          },
        });

        const missing: ResourceProvenance[] = [
          { path: "https://example.com/missing.md", mimeType: "text/markdown" },
        ];

        const stratIter = rfErr.strategies(missing);
        const resIter = rfErr.resources(stratIter);

        const vfileResources: Array<
          VFileCapableResource<ResourceProvenance, ResourceStrategy>
        > = [];

        for await (const r of resIter) {
          if (isVFileResource(r)) {
            vfileResources.push(r);
          }
        }

        // No VFile-capable resources should be produced because onTextError returns false
        assertEquals(vfileResources.length, 0);

        // But the error hook should have been called once
        assertEquals(errors.length, 1);
        assertEquals(
          errors[0].origin.provenance.path,
          "https://example.com/missing.md",
        );
        assert(errors[0].error instanceof Error);
      },
    );
  },
);
