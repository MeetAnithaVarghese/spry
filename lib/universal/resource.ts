/**
 * Core resource loading pipeline for Spry:
 *
 * 1. provenanceFromPaths() – turn string paths into ResourceProvenance
 * 2. strategies()          – assign ResourceStrategy + lazy loaders + handle globs
 * 3. resources()           – apply plugins and optional fetch overrides
 *
 * This file intentionally stays "core": no markdown, no domain-specific plugins.
 */

import { expandGlob } from "@std/fs";
import { contentType } from "@std/media-types";

/* -------------------------------------------------------------------------- */
/*                               Core types                                   */
/* -------------------------------------------------------------------------- */

export type ResourcePath = string;
export type ResourceLabel = string;
export type MimeType = string;

export type ResourceProvenance = {
  readonly path: ResourcePath;
  readonly label?: ResourceLabel;
  readonly mimeType?: MimeType;
};

export type ResourceStrategy = {
  readonly target: "remote-url" | "local-fs";
  readonly encoding: "utf8-text" | "utf8-binary";
};

export type Resource<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly provenance: P;
  readonly strategy: S;

  readonly text: () => Promise<string>;
  readonly safeText: (defaultText?: string) => Promise<string | Error>;

  readonly bytes: () => Promise<Uint8Array>;
  readonly safeBytes: (
    defaultBytes?: Uint8Array,
  ) => Promise<Uint8Array | Error>;

  readonly stream: () => Promise<ReadableStream<Uint8Array>>;
  readonly reader: () => Promise<ReadableStreamDefaultReader<Uint8Array>>;
};

/* -------------------------------------------------------------------------- */
/*                            Mime / encoding helpers                         */
/* -------------------------------------------------------------------------- */

const detectMimeFromPath = (path: ResourcePath): MimeType | undefined => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = path.slice(dot); // includes '.'
  const mime = contentType(ext);
  return mime ? mime.split(";", 1)[0].trim().toLowerCase() : undefined;
};

const isTextMime = (mime?: MimeType): boolean => {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m.endsWith("+json") ||
    m === "application/xml" ||
    m.endsWith("+xml")
  );
};

const detectEncoding = (mime?: MimeType): ResourceStrategy["encoding"] =>
  isTextMime(mime) ? "utf8-text" : "utf8-binary";

/* -------------------------------------------------------------------------- */
/*                       Fetch overrides / default fetchers                   */
/* -------------------------------------------------------------------------- */

export type FetchOverride<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = (
  input: RequestInfo | URL | string,
  init: RequestInit | undefined,
  provenance: P,
  strategy: S,
) => Promise<Response>;

const defaultRemoteFetch = async <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  input: RequestInfo | URL | string,
  init: RequestInit | undefined,
  _prov: P,
  _strat: S,
): Promise<Response> => {
  return await fetch(input, init);
};

const defaultLocalFetch = async <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  _input: RequestInfo | URL | string,
  _init: RequestInit | undefined,
  prov: P,
  _strat: S,
): Promise<Response> => {
  const path = prov.path;
  const data = await Deno.readFile(path);
  const mime = prov.mimeType ?? detectMimeFromPath(path) ??
    "application/octet-stream";
  return new Response(data, {
    headers: { "content-type": mime },
  });
};

/* -------------------------------------------------------------------------- */
/*                        Phase 1: Provenance factory                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn plain paths into ResourceProvenance objects.
 *
 * - `path` is the original string
 * - `label` defaults to the path
 * - `mimeType` is guessed from the file extension (if any)
 */
export function* provenanceFromPaths(
  paths: Iterable<ResourcePath>,
): Iterable<ResourceProvenance> {
  for (const path of paths) {
    const mime = detectMimeFromPath(path);
    yield {
      path,
      label: path,
      ...(mime ? { mimeType: mime } : null),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                     Phase 2: Strategies & loaders                          */
/* -------------------------------------------------------------------------- */

export type StrategiesInit<
  P extends ResourceProvenance = ResourceProvenance,
> = {
  /**
   * Control glob handling for a given provenance.
   *
   * - return `false`      → never treat this provenance as a glob.
   * - return `true`       → always treat as a glob candidate.
   * - return `"auto"`     → treat as glob if it has glob chars (* ? [).
   *
   * If absent, globs are disabled by default.
   */
  readonly isGlob?: (prov: P) => boolean | "auto";
};

const hasGlobChar = (s: string): boolean =>
  s.includes("*") || s.includes("?") || s.includes("[");

const tryParseHttpUrl = (path: string): URL | undefined => {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

async function* createResourcesForProvenance<
  P extends ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  origProv: P,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  // Ensure mimeType is set if we can infer it.
  const mime = origProv.mimeType ?? detectMimeFromPath(origProv.path);
  const prov =
    (mime && !origProv.mimeType
      ? { ...origProv, mimeType: mime }
      : origProv) as P;

  const url = tryParseHttpUrl(prov.path);
  const target: ResourceStrategy["target"] = url ? "remote-url" : "local-fs";
  const encoding = detectEncoding(prov.mimeType);
  const baseStrategy: ResourceStrategy = { target, encoding };
  const strategy = baseStrategy as S;

  const getFetcher = () =>
    strategy.target === "remote-url"
      ? defaultRemoteFetch<P, S>
      : defaultLocalFetch<P, S>;

  const text = async (): Promise<string> => {
    const fetcher = getFetcher();
    const res = await fetcher(prov.path, undefined, prov, strategy);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    return await res.text();
  };

  const safeText = async (
    defaultText?: string,
  ): Promise<string | Error> => {
    try {
      return await text();
    } catch (err) {
      if (defaultText !== undefined) return defaultText;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const bytes = async (): Promise<Uint8Array> => {
    const fetcher = getFetcher();
    const res = await fetcher(prov.path, undefined, prov, strategy);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  };

  const safeBytes = async (
    defaultBytes?: Uint8Array,
  ): Promise<Uint8Array | Error> => {
    try {
      return await bytes();
    } catch (err) {
      if (defaultBytes) return defaultBytes;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const stream = async (): Promise<ReadableStream<Uint8Array>> => {
    const fetcher = getFetcher();
    const res = await fetcher(prov.path, undefined, prov, strategy);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const body = res.body;
    if (!body) {
      throw new Error(`No body for ${prov.path}`);
    }
    // Body is already a ReadableStream<Uint8Array> in web/Deno fetch.
    return body;
  };

  const reader = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> =>
    (await stream()).getReader();

  const resource: Resource<P, S> = {
    provenance: prov,
    strategy,
    text,
    safeText,
    bytes,
    safeBytes,
    stream,
    reader,
  };

  yield resource;
}

/**
 * Phase 2: assign strategies and attach basic loaders.
 *
 * - Classifies each provenance as `remote-url` or `local-fs`.
 * - Detects MIME and encoding (`utf8-text` vs `utf8-binary`).
 * - Handles glob expansion (if configured).
 * - Attaches lazy `text()`, `bytes()`, `stream()`, `reader()` loaders
 *   using default fetchers.
 */
export async function* strategies<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  provenances: Iterable<P> | AsyncIterable<P>,
  init?: StrategiesInit<P>,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  const isGlob = init?.isGlob;

  for await (const prov of provenances) {
    const path = prov.path;
    const url = tryParseHttpUrl(path);

    // Glob handling only for non-URLs.
    if (!url && isGlob) {
      const decision = isGlob(prov);
      const treatAsGlob = decision === true ||
        (decision === "auto" && hasGlobChar(path));

      if (treatAsGlob) {
        for await (const entry of expandGlob(path)) {
          const childProv: P = {
            ...prov,
            path: entry.path as ResourcePath,
          };
          yield* createResourcesForProvenance<P, S>(childProv);
        }
        continue;
      }
    }

    yield* createResourcesForProvenance<P, S>(prov);
  }
}

/* -------------------------------------------------------------------------- */
/*                  Phase 3: Resource plugins + fetch overrides               */
/* -------------------------------------------------------------------------- */

export type ResourcePlugin<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = (
  resource: Resource<P, S>,
) => Resource<P, S> | void | Promise<Resource<P, S> | void>;

export type ResourceInit<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly plugins?: readonly ResourcePlugin<P, S>[];

  /**
   * Optional override for remote HTTP(S) fetching.
   * Signature matches `fetch(input, init)` plus provenance + strategy.
   */
  readonly onFetchRemoteURL?: FetchOverride<P, S>;

  /**
   * Optional override for local filesystem fetching.
   * Signature matches `fetch(input, init)` plus provenance + strategy.
   */
  readonly onFetchLocalFS?: FetchOverride<P, S>;
};

const makeLoadersWithOverrides = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  base: Resource<P, S>,
  init: ResourceInit<P, S>,
): Pick<
  Resource<P, S>,
  "text" | "safeText" | "bytes" | "safeBytes" | "stream" | "reader"
> => {
  const prov = base.provenance;
  const strat = base.strategy;

  const fetcher: FetchOverride<P, S> = strat.target === "remote-url"
    ? (init.onFetchRemoteURL ?? defaultRemoteFetch<P, S>)
    : (init.onFetchLocalFS ?? defaultLocalFetch<P, S>);

  const text = async (): Promise<string> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    return await res.text();
  };

  const safeText = async (
    defaultText?: string,
  ): Promise<string | Error> => {
    try {
      return await text();
    } catch (err) {
      if (defaultText !== undefined) return defaultText;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const bytes = async (): Promise<Uint8Array> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  };

  const safeBytes = async (
    defaultBytes?: Uint8Array,
  ): Promise<Uint8Array | Error> => {
    try {
      return await bytes();
    } catch (err) {
      if (defaultBytes) return defaultBytes;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const stream = async (): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const body = res.body;
    if (!body) {
      throw new Error(`No body for ${prov.path}`);
    }
    return body;
  };

  const reader = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> =>
    (await stream()).getReader();

  return { text, safeText, bytes, safeBytes, stream, reader };
};

/**
 * Phase 3: apply plugins and optional fetch overrides to Resources.
 *
 * - If fetch overrides are provided, they replace the base text/bytes/stream/reader loaders.
 * - Plugins can enrich or transform a Resource (1:1).
 */
export async function* resources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  init?: ResourceInit<P, S>,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  const plugins = init?.plugins ?? [];
  const hasOverrides = !!init?.onFetchRemoteURL || !!init?.onFetchLocalFS;

  for await (const base of src) {
    let r: Resource<P, S> = base;

    if (hasOverrides && init) {
      const loaders = makeLoadersWithOverrides(r, init);
      r = { ...r, ...loaders };
    }

    for (const plugin of plugins) {
      const out = await plugin(r);
      if (out) r = out;
    }

    yield r;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Helpers: unique + text/bytes                       */
/* -------------------------------------------------------------------------- */

export async function* uniqueResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  const seen = new Set<string>();

  for await (const r of src) {
    const provKey = JSON.stringify(r.provenance);
    const key = `${r.strategy.target}:${provKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    yield r;
  }
}

/**
 * Materialize text from Resources.
 *
 * - Calls `safeText()`
 * - If it returns a string, yields `{ resource, text }`
 * - If it returns an Error:
 *   - If `onError` returns a replacement, yields that.
 *   - Otherwise skips the resource.
 */
export async function* textResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  options?: {
    readonly onError?: (
      resource: Resource<P, S>,
      error: Error,
    ) =>
      | { resource: Resource<P, S>; text: string }
      | false
      | Promise<{ resource: Resource<P, S>; text: string } | false>;
  },
) {
  for await (const resource of src) {
    const result = await resource.safeText();
    if (typeof result === "string") {
      yield { resource, text: result };
      continue;
    }

    const error = result instanceof Error ? result : new Error(String(result));
    const replaced = await options?.onError?.(resource, error);
    if (replaced) yield replaced;
  }
}

/**
 * Materialize bytes from Resources.
 *
 * - Calls `safeBytes()`
 * - If it returns Uint8Array, yields `{ resource, bytes }`
 * - If it returns an Error:
 *   - If `onError` returns a replacement, yields that.
 *   - Otherwise skips the resource.
 */
export async function* binaryResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  options?: {
    readonly onError?: (
      resource: Resource<P, S>,
      error: Error,
    ) =>
      | { resource: Resource<P, S>; bytes: Uint8Array }
      | false
      | Promise<{ resource: Resource<P, S>; bytes: Uint8Array } | false>;
  },
) {
  for await (const resource of src) {
    const result = await resource.safeBytes();
    if (result instanceof Uint8Array) {
      yield { resource, bytes: result };
      continue;
    }

    const error = result instanceof Error ? result : new Error(String(result));
    const replaced = await options?.onError?.(resource, error);
    if (replaced) yield replaced;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Type guards                                  */
/* -------------------------------------------------------------------------- */

export const isRemoteResource = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { target: "remote-url" }> =>
  r.strategy.target === "remote-url";

export const isLocalResource = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { target: "local-fs" }> =>
  r.strategy.target === "local-fs";

export const isUtf8TextEncoded = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { encoding: "utf8-text" }> =>
  r.strategy.encoding === "utf8-text";

export const isUtf8BinaryEncoded = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { encoding: "utf8-binary" }> =>
  r.strategy.encoding === "utf8-binary";

/* -------------------------------------------------------------------------- */
/*                        Factory: resourcesFactory                           */
/* -------------------------------------------------------------------------- */

export type ResourcesFactoryInit<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = StrategiesInit<P> & ResourceInit<P, S>;

export type ResourcesFactory<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly init: ResourcesFactoryInit<P, S>;

  /**
   * Register one or more plugins to be applied in order.
   * Mutates the factory's plugin list.
   */
  use: (...plugins: ResourcePlugin<P, S>[]) => void;

  /**
   * Phase 2: classify provenances and attach strategies + base loaders.
   */
  strategies: (
    provenances: Iterable<P> | AsyncIterable<P>,
  ) => AsyncIterable<Resource<P, S>>;

  /**
   * Phase 3: apply fetch overrides and plugins.
   */
  resources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  ) => AsyncIterable<Resource<P, S>>;

  uniqueResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  ) => AsyncIterable<Resource<P, S>>;

  textResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
    options?: Parameters<typeof textResources<P, S>>[1],
  ) => AsyncIterable<{ resource: Resource<P, S>; text: string }>;

  binaryResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
    options?: Parameters<typeof binaryResources<P, S>>[1],
  ) => AsyncIterable<{ resource: Resource<P, S>; bytes: Uint8Array }>;
};

/**
 * Create a factory that binds common init (glob rules, fetch overrides, plugins)
 * and exposes typed helpers:
 *
 *   const rf = resourcesFactory<ResourceProvenance, ResourceStrategy>(init);
 *   rf.use(myPlugin);
 *   const strat = rf.strategies(provs);
 *   for await (const r of rf.resources(strat)) { ... }
 */
export function resourcesFactory<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  init: ResourcesFactoryInit<P, S> = {},
): ResourcesFactory<P, S> {
  const plugins: ResourcePlugin<P, S>[] = [...(init.plugins ?? [])];

  const factoryInit: ResourcesFactoryInit<P, S> = {
    ...init,
    plugins,
  };

  return {
    init: factoryInit,

    use: (...more) => {
      plugins.push(...more);
    },

    strategies: (provenances) =>
      strategies<P, S>(provenances, {
        isGlob: factoryInit.isGlob,
      }),

    resources: (res) =>
      resources<P, S>(res, {
        plugins,
        onFetchRemoteURL: factoryInit.onFetchRemoteURL,
        onFetchLocalFS: factoryInit.onFetchLocalFS,
      }),

    uniqueResources: (res) => uniqueResources<P, S>(res),

    textResources: (res, options) => textResources<P, S>(res, options),

    binaryResources: (res, options) => binaryResources<P, S>(res, options),
  };
}
