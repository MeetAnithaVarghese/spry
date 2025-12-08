// render.ts
// Core rendering engine, content-agnostic, strongly typed.

// ---- Low-level primitives ----

export type BodyInput = string | Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Shape: map of string names to concrete memory values.
 * Keys are restricted to string to avoid keyof Shape including number | symbol.
 */
export type MemoryShape<MemoryValue> = Record<string, MemoryValue>;

/**
 * Memory store for a given Shape.
 *
 * - `get` / `set` are the usual key-value operations.
 * - `list` is used for scanning for injectors.
 * - `memoize` is the hook the renderer calls when it wants to store
 *   a rendered result; the implementation knows how to construct Shape[Name].
 */
export interface Memory<
  MemoryValue,
  Shape extends MemoryShape<MemoryValue>,
  Memoizable,
> {
  get<Name extends keyof Shape>(
    name: Name,
  ): Shape[Name] | undefined | Promise<Shape[Name] | undefined>;

  injectables?():
    | AsyncIterable<[keyof Shape, Shape[keyof Shape]]>
    | Iterable<[keyof Shape, Shape[keyof Shape]]>;

  memoize?(
    rendered: string,
    memoize: Memoizable,
    rawBody: string,
  ): void | Promise<void>;
}

/**
 * Content describes how the renderer views a "block" or "source" S.
 * S might be an mdast node, DB row, etc. The core knows nothing
 * about S beyond what Content exposes.
 */
export interface Content<S, Memoizable> {
  /**
   * Raw body for this content item.
   */
  body(source: S): Promise<BodyInput> | BodyInput;

  /**
   * Path is a stable identifier for injection matching and logging.
   * Examples: "file.md:42", "code:sql:users", etc.
   */
  path?(source: S): string | undefined;

  /**
   * Should this content be subject to interpolation?
   * If omitted, the engine assumes "not interpolatable".
   */
  isInterpolatable?(source: S): boolean;

  /**
   * Should this content be subject to injections?
   * If omitted, the engine assumes "not injectable".
   */
  isInjectable?(path: string | undefined, source: S): boolean;

  /**
   * Locals visible to the interpolator for this content.
   * These are passed through to the Interpolator as `locals`.
   */
  locals?(
    source: S,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;

  /**
   * Should the rendered output be memoized into Memory?
   * If so, return a Memoize directive.
   */
  isMemoizable?(source: S): Memoizable | false;
}

/**
 * Injection context provided to an injection-capable memory value.
 *
 * An injector decides:
 * - whether it applies to this (source, path, body),
 * - and returns a new body (string) if it wants to mutate,
 *   or `undefined` if it does nothing.
 */
export interface InjectionContext<S> {
  readonly path?: string;
  readonly source: S;
  readonly body: string;
}

/**
 * InjectionProvider: any MemoryValue that wants to participate in
 * injections implements this method.
 *
 * The engine doesn’t care how patterns, globs, modes, etc. work; all of
 * that lives inside the provider implementation.
 */
export interface InjectionProvider<S> {
  inject(
    context: InjectionContext<S>,
  ): string | undefined | Promise<string | undefined>;
}

/**
 * Type guard: checks whether a value is an InjectionProvider for this `S`
 * by looking for an `inject` method.
 *
 * Any MemoryValue that also implements InjectionProvider<S> will be
 * treated as an injection-capable value by the engine.
 */
export function isInjectionProviderForSource<S, MemoryValue>(
  value: MemoryValue,
): value is MemoryValue & InjectionProvider<S> {
  const candidate = value as { inject?: unknown };
  return typeof candidate.inject === "function";
}

/**
 * Interpolator takes a full string and returns a fully interpolated string.
 * It can be safe or unsafe; the engine doesn't care how it works internally.
 */
export interface Interpolator<
  S,
  MemoryValue,
  Shape extends MemoryShape<MemoryValue>,
  Memoizable,
> {
  interpolate(
    input: string,
    options: {
      path?: string;
      content: S;
      memory: Memory<MemoryValue, Shape, Memoizable>;
      globals?: Record<string, unknown>;
      locals: Record<string, unknown>;
    },
  ):
    | { text: string; error?: unknown }
    | Promise<{ text: string; error?: unknown }>;
}

/**
 * Minimal event bus interface; adapt your existing event-bus.ts to this.
 */
export interface EventBus<EventMap> {
  emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): void;
}

/**
 * Events emitted by the renderer. Extend as needed.
 */
export interface RenderEvents<S, Memoizable> {
  "render:start": { path?: string };
  "render:end": {
    source: S;
    path?: string;
    mutation: "mutated" | "unmodified" | "error";
    error?: unknown;
    length: number;
  };
  "injection:applied": {
    source: S;
    path?: string;
    templateName?: string;
  };
  "memory:write": {
    source: S;
    interpolated: string;
    memoize: Memoizable;
    rawBody: string;
  };
}

/**
 * Strategy/environment/configuration for the renderer.
 */
export interface RenderStrategy<
  S,
  MemoryValue,
  Shape extends MemoryShape<MemoryValue>,
  Memoizable,
> {
  content: Content<S, Memoizable>;
  memory: Memory<MemoryValue, Shape, Memoizable>;
  interpolator: Interpolator<S, MemoryValue, Shape, Memoizable>;
  globals?: Record<string, unknown>;
  bus?: EventBus<RenderEvents<S, Memoizable>>;
}

/**
 * Result of rendering a single content item.
 */
export interface RenderResult {
  text: string;
  mutation: "mutated" | "unmodified" | "error";
  error?: unknown;
}

/**
 * Renderer interface: render one or many content items.
 */
export interface Renderer<S> {
  renderOne(source: S): Promise<RenderResult>;

  renderAll(
    sources: Iterable<S> | AsyncIterable<S>,
  ): Promise<{ results: RenderResult[] }>;
}

/**
 * Utility: normalize BodyInput to string.
 */
export async function bodyToString(body: BodyInput): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce(
    (acc, cur) => {
      const arr = new Uint8Array(acc.length + cur.length);
      arr.set(acc, 0);
      arr.set(cur, acc.length);
      return arr;
    },
    new Uint8Array(),
  );
  return new TextDecoder().decode(total);
}

/**
 * Helper: normalize AsyncIterable | Iterable into AsyncIterable without `any`.
 */
async function* toAsyncIterable<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
  const asyncIterator = (iterable as AsyncIterable<T>)[Symbol.asyncIterator];
  if (typeof asyncIterator === "function") {
    // Already AsyncIterable
    for await (const item of iterable as AsyncIterable<T>) {
      yield item;
    }
    return;
  }

  // Synchronous Iterable
  for (const item of iterable as Iterable<T>) {
    yield item;
  }
}

// ---- Core engine ----

/**
 * Create a materializer from a RenderStrategy.
 *
 * Responsibilities:
 * 1. Accept content and extract body via Content.body.
 * 2. Resolve a path via Content.path for logging and injection context.
 * 3. Use Content.isInjectable(path) and apply injections from any
 *    MemoryValue that implements InjectionProvider<S> (via type guard).
 *    Each injector decides on its own whether to mutate the body.
 * 4. Run the Interpolator over the (possibly injected) body, providing
 *    ctx, memory, path, content, and Content.locals as `locals`.
 * 5. Use Content.isMemoizable and Content.memoized to let Memory.memoize
 *    store the output back into Memory.
 */
export function renderer<
  S,
  MemoryValue,
  Shape extends MemoryShape<MemoryValue>,
  Memoizable,
>(
  rs: RenderStrategy<S, MemoryValue, Shape, Memoizable>,
): Renderer<S> {
  const { content, memory, interpolator, globals, bus } = rs;

  async function applyInjections(
    path: string | undefined,
    source: S,
    body: string,
  ): Promise<string> {
    const injectable = content.isInjectable?.(path, source) ?? false;
    if (!injectable) return body;

    if (!memory.injectables) return body;

    const listResult = memory.injectables();
    const asyncList = toAsyncIterable(listResult);

    let result = body;

    for await (const [name, value] of asyncList) {
      // Any memory value that implements InjectionProvider<S> participates.
      if (!isInjectionProviderForSource<S, MemoryValue>(value)) continue;

      const injected = await value.inject({
        path,
        source,
        body: result,
      });

      if (typeof injected !== "string") continue;

      result = injected;
      bus?.emit("injection:applied", {
        source,
        path,
        templateName: String(name),
      });
    }

    return result;
  }

  async function renderOne(source: S): Promise<RenderResult> {
    const path = content.path?.(source);
    bus?.emit("render:start", { path });

    const rawBodyInput = await content.body(source);
    const rawBody = await bodyToString(rawBodyInput);

    // 3. Injections (if applicable).
    const bodyWithInjections = await applyInjections(path, source, rawBody);

    // 4. Interpolation (if applicable).
    const locals = (await content.locals?.(source)) ?? {};
    let interpolated = bodyWithInjections;
    let error: unknown;
    if (content.isInterpolatable?.(source)) {
      const { text, error: interpError } = await interpolator.interpolate(
        bodyWithInjections,
        {
          path,
          content: source,
          memory,
          globals,
          locals,
        },
      );
      interpolated = text;
      error = interpError;
    } else {
      error = undefined;
    }

    // Mutation is relative to the original raw body (pre-injections, pre-interpolation).
    const mutation: RenderResult["mutation"] = error
      ? "error"
      : interpolated === rawBody
      ? "unmodified"
      : "mutated";

    // 5. Memoization hook.
    const memoize = content.isMemoizable?.(source);
    if (memoize && memory.memoize) {
      await memory.memoize(interpolated, memoize, rawBody);
      bus?.emit("memory:write", { source, interpolated, memoize, rawBody });
    }

    bus?.emit("render:end", {
      source,
      path,
      mutation,
      error,
      length: interpolated.length,
    });

    return { text: interpolated, mutation, error };
  }

  async function renderAll(
    sources: Iterable<S> | AsyncIterable<S>,
  ): Promise<{ results: RenderResult[] }> {
    const results: RenderResult[] = [];
    const iterable = toAsyncIterable(sources as AsyncIterable<S> | Iterable<S>);
    for await (const source of iterable) {
      // Intentional sequential rendering to preserve ordering and memory semantics.
      const res = await renderOne(source);
      results.push(res);
    }
    return { results };
  }

  return { renderOne, renderAll };
}
