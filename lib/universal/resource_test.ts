// resource_test.ts
// Deno 2.5+ test suite for resource.ts using synthetic loaders only.

import {
  binaryResources,
  collectBinaryResources,
  collectResources,
  collectTextResources,
  isLocalResource,
  isRemoteResource,
  isUtf8BinaryEncoded,
  isUtf8TextEncoded,
  provenanceFromPaths,
  readSafeBytes,
  readSafeBytesWith,
  readSafeText,
  readSafeTextWith,
  readTextWith,
  relativeTo,
  type Resource,
  resourceFromPath,
  resourceFromPathWith,
  type ResourceProvenance,
  resourcesFactory,
  type ResourceStrategy,
  textResources,
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
      for await (const { resource, text } of textResources(resIter)) {
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
    for await (const { resource, bytes } of binaryResources(resIter)) {
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

Deno.test("relativeTo creates local and remote relatives", async (t) => {
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

  const provs = provenanceFromPaths([
    "https://example.com/hello.txt",
    "data/local.txt",
  ]);

  const stratIter = rf.strategies(provs);
  const resIter = rf.resources(stratIter);

  const byPath = new Map<
    string,
    Resource<ResourceProvenance, ResourceStrategy>
  >();
  for await (const r of resIter) {
    byPath.set(r.provenance.path, r);
  }

  const remoteBase = byPath.get("https://example.com/hello.txt")!;
  const localBase = byPath.get("data/local.txt")!;

  await t.step("remote base resolves relative remote paths", () => {
    const rel = relativeTo(remoteBase);

    const { provenance, strategy } = rel.path("config.json");
    assertEquals(provenance.path, "https://example.com/config.json");
    assertEquals(provenance.label, "https://example.com/config.json");
    assertEquals(provenance.mimeType, "application/json");
    assertEquals(strategy.target, "remote-url");
    assertEquals(strategy.url?.toString(), "https://example.com/config.json");

    const child = rel.resource("config.json");
    assertEquals(child.provenance.path, "https://example.com/config.json");
    assert(isRemoteResource(child));
    assert(isUtf8TextEncoded(child));
  });

  await t.step("local base resolves relative local paths", () => {
    const rel = relativeTo(localBase);

    const { provenance, strategy } = rel.path("local.json");
    assertEquals(provenance.path, "data/local.json");
    assertEquals(provenance.label, "data/local.json");
    assertEquals(provenance.mimeType, "application/json");
    assertEquals(strategy.target, "local-fs");
    assertEquals(strategy.url, undefined);

    const child = rel.resource("local.json");
    assertEquals(child.provenance.path, "data/local.json");
    assert(isLocalResource(child));
    assert(isUtf8TextEncoded(child));
  });
});

Deno.test("single-call helpers (non-pipeline API)", async (t) => {
  // Monkeypatch global fetch and Deno.readFile so single-call helpers
  // still use synthetic data only.
  const originalFetch = globalThis.fetch;
  const originalReadFile = Deno.readFile;

  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (input: RequestInfo | URL | string) =>
    Promise.resolve(syntheticRemoteFetch(input));

  // deno-lint-ignore no-explicit-any
  (Deno as any).readFile = (path: string | URL) => {
    const key = typeof path === "string" ? path : path.toString();

    if (key in LOCAL_BINARY_DATA) {
      return LOCAL_BINARY_DATA[key];
    }

    if (key in LOCAL_TEXT_DATA) {
      return new TextEncoder().encode(LOCAL_TEXT_DATA[key]);
    }

    // Match defaultLocalFetch behavior: read error should cause safe helpers
    // to fall back to defaults.
    throw new Error("NOT-FOUND");
  };

  try {
    await t.step("resourceFromPath + readText/readBytes", async () => {
      const rRemote = resourceFromPath("https://example.com/hello.txt");
      assert(isRemoteResource(rRemote));
      assert(isUtf8TextEncoded(rRemote));
      const txt = await rRemote.text();
      assertEquals(txt, "REMOTE-HELLO");

      const rLocal = resourceFromPath("data/local.txt");
      assert(isLocalResource(rLocal));
      assert(isUtf8TextEncoded(rLocal));
      const ltxt = await rLocal.text();
      assertEquals(ltxt, "LOCAL-TEXT");

      const rLocalBin = resourceFromPath("data/local.png");
      assert(isLocalResource(rLocalBin));
      assert(isUtf8BinaryEncoded(rLocalBin));
      const bytes = await rLocalBin.bytes();
      assertEquals(bytes, LOCAL_BINARY_DATA["data/local.png"]);
    });

    await t.step("readSafeText and readSafeBytes basics", async () => {
      const okText = await readSafeText("https://example.com/hello.txt");
      assertEquals(okText, "REMOTE-HELLO");

      const defaultText = await readSafeText(
        "https://example.com/does-not-exist.txt",
        "DEFAULT-TEXT",
      );
      assertEquals(defaultText, "DEFAULT-TEXT");

      const okBytes = await readSafeBytes("data/local.png");
      assert(okBytes instanceof Uint8Array);
      assertEquals(okBytes, LOCAL_BINARY_DATA["data/local.png"]);

      const defaultBuf = new Uint8Array([9, 9, 9]);
      const fallbackBytes = await readSafeBytes(
        "data/does-not-exist.png",
        defaultBuf,
      );
      assert(fallbackBytes instanceof Uint8Array);
      assertEquals(fallbackBytes, defaultBuf);
    });

    await t.step(
      "resourceFromPathWith and readTextWith use init overrides",
      async () => {
        const init = {
          onFetchRemoteURL: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticRemoteFetch(input)),
          onFetchLocalFS: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticLocalFetch(input)),
        };

        const rWithRemote = await resourceFromPathWith(
          "https://example.com/hello.txt",
          init,
        );
        const txtRemote = await rWithRemote.text();
        assertEquals(txtRemote, "REMOTE-HELLO");

        const txtLocal = await readTextWith("data/local.txt", init);
        assertEquals(txtLocal, "LOCAL-TEXT");
      },
    );

    await t.step(
      "readSafeTextWith and readSafeBytesWith honor defaults",
      async () => {
        const init = {
          onFetchRemoteURL: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticRemoteFetch(input)),
          onFetchLocalFS: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticLocalFetch(input)),
        };

        const okText = await readSafeTextWith(
          "https://example.com/hello.txt",
          init,
        );
        assertEquals(okText, "REMOTE-HELLO");

        const defaultText = await readSafeTextWith(
          "https://example.com/missing.txt",
          init,
          "DEFAULT-REMOTE",
        );
        assertEquals(defaultText, "DEFAULT-REMOTE");

        const okBytes = await readSafeBytesWith("data/local.png", init);
        assert(okBytes instanceof Uint8Array);
        assertEquals(okBytes, LOCAL_BINARY_DATA["data/local.png"]);

        const defaultBuf = new Uint8Array([7, 7]);
        const fallbackBytes = await readSafeBytesWith(
          "data/missing.png",
          init,
          defaultBuf,
        );
        assert(fallbackBytes instanceof Uint8Array);
        assertEquals(fallbackBytes, defaultBuf);
      },
    );

    await t.step(
      "collectResources / collectTextResources / collectBinaryResources",
      async () => {
        const init = {
          isGlob: () => false as const,
          onFetchRemoteURL: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticRemoteFetch(input)),
          onFetchLocalFS: (
            input: RequestInfo | URL | string,
            _init: RequestInit | undefined,
            _prov: ResourceProvenance,
            _strat: ResourceStrategy,
          ) => Promise.resolve(syntheticLocalFetch(input)),
        };

        const pathsText = [
          "https://example.com/hello.txt",
          "data/local.txt",
        ];

        const resources = await collectResources(pathsText, init);
        assertEquals(resources.length, 2);
        assert(
          resources.some((r) =>
            r.provenance.path === "https://example.com/hello.txt" &&
            isRemoteResource(r)
          ),
        );
        assert(
          resources.some((r) =>
            r.provenance.path === "data/local.txt" &&
            isLocalResource(r)
          ),
        );

        const textResults = await collectTextResources(pathsText, init);
        const textByPath: Record<string, string> = {};
        for (const { resource, text } of textResults) {
          textByPath[resource.provenance.path] = text;
        }
        assertEquals(
          textByPath["https://example.com/hello.txt"],
          "REMOTE-HELLO",
        );
        assertEquals(textByPath["data/local.txt"], "LOCAL-TEXT");

        const pathsBin = [
          "https://example.com/image.png",
          "data/local.png",
        ];
        const binResults = await collectBinaryResources(pathsBin, init);
        const bytesByPath: Record<string, Uint8Array> = {};
        for (const { resource, bytes } of binResults) {
          bytesByPath[resource.provenance.path] = bytes;
        }
        assertEquals(
          bytesByPath["https://example.com/image.png"],
          REMOTE_BINARY_DATA["https://example.com/image.png"],
        );
        assertEquals(
          bytesByPath["data/local.png"],
          LOCAL_BINARY_DATA["data/local.png"],
        );
      },
    );
  } finally {
    // restore globals
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).readFile = originalReadFile;
  }
});
