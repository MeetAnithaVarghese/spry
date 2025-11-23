// resource_test.ts
// Deno 2.5+ test suite for resource.ts using synthetic loaders only.

import {
  isLocalResource,
  isRemoteResource,
  isUtf8BinaryEncoded,
  isUtf8TextEncoded,
  provenanceFromPaths,
  type Resource,
  type ResourceProvenance,
  resourcesFactory,
  type ResourceStrategy,
} from "./resource.ts";

import { assert, assertEquals } from "@std/assert";

/**
 * Synthetic in-memory data for tests. No real I/O.
 */
const REMOTE_TEXT_DATA: Record<string, string> = {
  "https://example.com/hello.txt": "REMOTE-HELLO",
  "https://example.com/config.json": '{"remote":true}',
};

const REMOTE_BINARY_DATA: Record<string, Uint8Array> = {
  "https://example.com/image.png": new Uint8Array([1, 2, 3, 4]),
};

const LOCAL_TEXT_DATA: Record<string, string> = {
  "data/local.txt": "LOCAL-TEXT",
  "data/local.json": '{"local":true}',
};

const LOCAL_BINARY_DATA: Record<string, Uint8Array> = {
  "data/local.png": new Uint8Array([5, 6, 7, 8]),
};

/**
 * Helper: binary-safe Response body wrapper
 * Wraps Uint8Array in Blob so Deno’s Response type accepts it.
 */
function blobify(data: Uint8Array): Blob {
  // Force the backing buffer to be seen as an ArrayBuffer (not ArrayBufferLike).
  const ab = data.buffer as ArrayBuffer;
  return new Blob([ab]);
}

/**
 * Helper: synthetic fetch-like function for remote resources.
 */
function syntheticRemoteFetch(
  input: RequestInfo | URL | string,
): Response {
  const key = typeof input === "string" ? input : input.toString();

  if (key in REMOTE_TEXT_DATA) {
    const body = REMOTE_TEXT_DATA[key];
    return new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (key in REMOTE_BINARY_DATA) {
    const body = REMOTE_BINARY_DATA[key];
    return new Response(blobify(body), {
      headers: { "content-type": "image/png" },
    });
  }

  return new Response("NOT-FOUND", { status: 404 });
}

/**
 * Helper: synthetic fetch-like function for local resources.
 */
function syntheticLocalFetch(
  input: RequestInfo | URL | string,
): Response {
  const key = typeof input === "string" ? input : input.toString();

  if (key in LOCAL_TEXT_DATA) {
    const body = LOCAL_TEXT_DATA[key];
    return new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (key in LOCAL_BINARY_DATA) {
    const body = LOCAL_BINARY_DATA[key];
    return new Response(blobify(body), {
      headers: { "content-type": "image/png" },
    });
  }

  return new Response("NOT-FOUND", { status: 404 });
}

Deno.test("resourcesFactory core behavior", async (t) => {
  const rf = resourcesFactory<ResourceProvenance, ResourceStrategy>({
    onFetchRemoteURL: (input, _init, prov, strat) => {
      void prov;
      void strat;
      return Promise.resolve(syntheticRemoteFetch(input));
    },

    onFetchLocalFS: (input, _init, prov, strat) => {
      void prov;
      void strat;
      return Promise.resolve(syntheticLocalFetch(input));
    },
  });

  await t.step(
    "provenanceFromPaths + strategies classify correctly",
    async () => {
      const provs = provenanceFromPaths([
        "https://example.com/hello.txt",
        "https://example.com/image.png",
        "data/local.txt",
        "data/local.png",
      ]);

      const stratIter = rf.strategies(provs);
      const collected: Resource<ResourceProvenance, ResourceStrategy>[] = [];

      for await (const r of stratIter) {
        collected.push(r);
      }

      assertEquals(collected.length, 4);

      const byPath = new Map(
        collected.map((r) => [r.provenance.path, r] as const),
      );

      const remoteText = byPath.get("https://example.com/hello.txt")!;
      const remoteBin = byPath.get("https://example.com/image.png")!;
      const localText = byPath.get("data/local.txt")!;
      const localBin = byPath.get("data/local.png")!;

      assert(isRemoteResource(remoteText));
      assert(isRemoteResource(remoteBin));
      assert(isLocalResource(localText));
      assert(isLocalResource(localBin));

      assert(isUtf8TextEncoded(remoteText));
      assert(isUtf8BinaryEncoded(remoteBin));
      assert(isUtf8TextEncoded(localText));
      assert(isUtf8BinaryEncoded(localBin));
    },
  );

  await t.step(
    "resources() with overrides uses synthetic loaders",
    async () => {
      const provs = provenanceFromPaths([
        "https://example.com/hello.txt",
        "data/local.txt",
      ]);

      const stratIter = rf.strategies(provs);
      const resIter = rf.resources(stratIter);

      const seen: Record<string, string> = {};
      for await (const { resource, text } of rf.textResources(resIter)) {
        seen[resource.provenance.path] = text;
      }

      assertEquals(seen["https://example.com/hello.txt"], "REMOTE-HELLO");
      assertEquals(seen["data/local.txt"], "LOCAL-TEXT");
    },
  );

  await t.step("binaryResources() reads synthetic binary data", async () => {
    const provs = provenanceFromPaths([
      "https://example.com/image.png",
      "data/local.png",
    ]);

    const stratIter = rf.strategies(provs);
    const resIter = rf.resources(stratIter);

    const seen: Record<string, Uint8Array> = {};
    for await (const { resource, bytes } of rf.binaryResources(resIter)) {
      seen[resource.provenance.path] = bytes;
    }

    assertEquals(
      seen["https://example.com/image.png"],
      REMOTE_BINARY_DATA["https://example.com/image.png"],
    );
    assertEquals(
      seen["data/local.png"],
      LOCAL_BINARY_DATA["data/local.png"],
    );
  });

  await t.step("stream() and reader() provide streaming access", async () => {
    const provs = provenanceFromPaths([
      "https://example.com/hello.txt",
      "data/local.txt",
    ]);

    const stratIter = rf.strategies(provs);
    const resIter = rf.resources(stratIter);

    const results: Record<string, string> = {};

    for await (const r of resIter) {
      const reader = await r.reader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      const total = chunks.reduce(
        (acc, chunk) => {
          const arr = new Uint8Array(acc.length + chunk.length);
          arr.set(acc, 0);
          arr.set(chunk, acc.length);
          return arr;
        },
        new Uint8Array(),
      );

      results[r.provenance.path] = new TextDecoder().decode(total);
    }

    assertEquals(results["https://example.com/hello.txt"], "REMOTE-HELLO");
    assertEquals(results["data/local.txt"], "LOCAL-TEXT");
  });

  await t.step(
    "uniqueResources() de-duplicates by target+provenance",
    async () => {
      const provs = provenanceFromPaths([
        "https://example.com/hello.txt",
        "https://example.com/hello.txt",
        "data/local.txt",
        "data/local.txt",
      ]);

      const stratIter = rf.strategies(provs);
      const resIter = rf.resources(stratIter);
      const uniqIter = rf.uniqueResources(resIter);

      const paths: string[] = [];
      for await (const r of uniqIter) {
        paths.push(r.provenance.path);
      }

      assertEquals(
        paths.sort(),
        ["data/local.txt", "https://example.com/hello.txt"].sort(),
      );
    },
  );
});
