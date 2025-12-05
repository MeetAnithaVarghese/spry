/**
 * Content fragments (“partials”) with type-safe locals and injectable wrappers.
 *
 * This module models a reusable unit of content called a **partial** –
 * also known as a content fragment, wrapper, or template snippet.
 *
 * A partial:
 * - Has an identity and raw source text.
 * - Optionally validates its `locals` via a Zod schema or a simple JSON schema spec.
 * - Renders via a standard `(locals, onError?) => PartialRenderResult<Locals>`
 *   function (sync or async).
 *
 * Partials may also be **injectable**:
 * - They declare one or more path globs.
 * - When a rendered fragment is associated with a path, the best-matching
 *   injectable acts as a wrapper and is prepended / appended / both around
 *   the fragment’s content.
 *
 * Typical uses:
 * - Content wrappers for SQL / Markdown / code files.
 * - Shared headers / footers / envelopes for generated text.
 * - Context-aware decoration of content based on file paths.
 */

import { globToRegExp, isGlob, normalize } from "@std/path";
import z, { ZodType } from "@zod/zod";
import { jsonToZod } from "../universal/zod-aide.ts";

/** Error handler used by renderers to turn errors into user-visible content. */
export type InjectErrorHandler = (
  message: string,
  content: string,
  error?: unknown,
) => string;

/** Render lifecycle status for a partial. */
export type RenderStatus = "ok" | "invalid-args" | "render-error";

/**
 * Result of rendering a partial or a composed partial+wrapper.
 *
 * @template Locals shape of the locals object carried through rendering
 */
export interface PartialRenderResult<Locals> {
  /** Overall status of this render. */
  readonly status: RenderStatus;
  /** Final rendered text. */
  readonly content: string;
  /**
   * Whether downstream interpolation is allowed / expected.
   * - `true` for successfully rendered content.
   * - `false` when locals are invalid or a render error occurred.
   */
  readonly interpolate: boolean;
  /** Locals used for rendering (possibly enriched or normalized). */
  readonly locals: Locals;
  /** Optional error instance when status is not `"ok"`. */
  readonly error?: unknown;
}

/**
 * Render function for a content fragment (partial).
 *
 * Takes:
 * - `locals`: runtime values used by the fragment.
 * - `onError?`: optional handler to turn validation / render errors into
 *   user-visible content.
 *
 * Returns a `PartialRenderResult<Locals>` (sync or async).
 */
export type InjectContentFn<Locals = Record<string, unknown>> = (
  locals: Locals,
  onError?: InjectErrorHandler,
) =>
  | PartialRenderResult<Locals>
  | Promise<PartialRenderResult<Locals>>;

/** Injection mode describing how a wrapper is applied to inner content. */
export type InjectionMode = "prepend" | "append" | "both";

/**
 * Injection configuration attached to a partial that can act as a wrapper.
 *
 * The matching is done against normalized paths using glob patterns.
 */
export interface InjectionConfig {
  /** Glob patterns for which this partial should act as a wrapper. */
  readonly globs: readonly string[];
  /** How this wrapper is merged with inner content. */
  readonly mode: InjectionMode;
}

/**
 * Initialization options for injection configuration.
 *
 * You can specify `mode` directly or use the `prepend` / `append` flags.
 * If neither `mode` nor flags are given, the default is `"prepend"`.
 */
export interface InjectionInit {
  /** Glob patterns for which this partial should act as a wrapper. */
  globs: string[];
  /** If true, wrapper goes before inner content. */
  prepend?: boolean;
  /** If true, wrapper goes after inner content. */
  append?: boolean;
  /**
   * Explicit mode; when provided, it overrides `prepend` / `append` flags.
   * Useful for clarity in code and tests.
   */
  mode?: InjectionMode;
}

/**
 * Initialization options for creating a typed partial.
 *
 * @template Locals shape of the locals object
 */
export interface PartialContentInit<Locals> {
  /**
   * Optional Zod schema used to validate `locals`.
   * If provided, this takes precedence over `schemaSpec`.
   */
  schema?: ZodType<Locals>;
  /**
   * Optional JSON-like schema spec for `locals`.
   * If `schema` is not provided, this will be converted to a Zod schema
   * using `jsonToZod`.
   *
   * Shape example:
   *   {
   *     name: { type: "string" },
   *     age: { type: "number" }
   *   }
   */
  schemaSpec?: Record<string, unknown>;
  /**
   * Optional injection configuration describing how this partial can act
   * as a wrapper for other rendered content.
   */
  inject?: InjectionInit;
  /**
   * When true, invalid `locals` cause:
   *   - `status: "invalid-args"`
   *   - `interpolate: false`
   *   - `error` populated with the Zod error
   *
   * When false (default), implementations are free to be more lenient,
   * but the default implementation still fails closed.
   */
  strictArgs?: boolean;
}

/**
 * A single partial / content fragment.
 *
 * @template Locals shape of the `locals` object accepted by this partial
 */
export interface PartialContent<
  Locals = Record<string, unknown>,
  Provenance = unknown,
> {
  /** Unique name for this fragment. */
  readonly identity: string;
  /** Original text content of the fragment. */
  readonly source: string;
  /** Where the source came from (mdast node, etc.) */
  readonly provenance: Provenance;
  /**
   * Optional Zod schema used to validate `locals`.
   * May have been provided directly or derived from `schemaSpec`.
   */
  readonly schema?: ZodType<Locals>;
  /**
   * Optional raw JSON spec used to build `schema`.
   * Useful for introspection and debugging.
   */
  readonly schemaSpec?: Record<string, unknown>;
  /** Rendering function (sync or async). */
  readonly content: InjectContentFn<Locals>;
  /** Optional injection configuration for wrapper behavior. */
  readonly injection?: InjectionConfig;
}

/** Policies for handling duplicate identities on registration. */
export type DuplicatePolicy = "overwrite" | "throw" | "ignore";

/**
 * Registration options for the collection.
 */
export interface RegisterOptions {
  /** Policy for handling duplicates (default: `"overwrite"`). */
  onDuplicate?: DuplicatePolicy;
}

/**
 * Definition of the collection that manages partials and injection.
 *
 * @template Locals shape of the locals used for rendering
 */
export interface PartialCollection<Locals = Record<string, unknown>> {
  /** Internal catalog of partials by identity (read-only handle). */
  readonly catalog: ReadonlyMap<string, PartialContent<Locals>>;

  /**
   * Register a new partial / content fragment in the collection.
   *
   * Handles duplicates using `options.onDuplicate`:
   * - `"throw"`: error if the identity already exists.
   * - `"ignore"`: keep the existing fragment.
   * - `"overwrite"` (default): replace existing fragment.
   *
   * Rebuilds the injection index whenever a new fragment is registered.
   *
   * @param partial the fragment / partial to register
   * @param options duplicate handling options
   */
  register(partial: PartialContent<Locals>, options?: RegisterOptions): void;

  /**
   * Lookup a partial / content fragment by identity.
   *
   * @param identity name of the fragment
   * @returns the stored fragment, if present
   */
  get(identity: string): PartialContent<Locals> | undefined;

  /**
   * Compose a previously rendered fragment with its best-matching
   * injectable wrapper (if any).
   *
   * Steps:
   * - Find the injectable partial for `ctx.path` (if any).
   * - Render the wrapper using the original `result.locals`.
   * - If wrapper rendering fails or rejects its locals, fail closed:
   *   - `status` is `"render-error"` or `"invalid-args"`
   *   - `interpolate` is `false`
   * - Merge wrapper and inner content based on the wrapper’s `mode`
   *   (`prepend`, `append`, or `both`).
   *
   * @param result previously rendered fragment
   * @param ctx optional path for injection lookup and error handler
   * @returns new render result with wrapper applied (or original if none)
   */
  compose(
    result: PartialRenderResult<Locals>,
    ctx?: {
      path?: string;
      onError?: InjectErrorHandler;
    },
  ): Promise<PartialRenderResult<Locals>>;

  /**
   * High-level helper that:
   * - Renders a partial by identity.
   * - Then applies the best-matching injectable wrapper (if any).
   *
   * This is the main entry point for “render this identity for this path”.
   *
   * @param ctx rendering context
   * @returns fully rendered (and possibly wrapped) result
   */
  renderWithInjection(ctx: {
    identity: string;
    path?: string;
    locals: Locals;
    onError?: InjectErrorHandler;
  }): Promise<PartialRenderResult<Locals>>;

  /**
   * Utility: resolve the injectable partial that best matches the given path.
   *
   * Selection rules:
   * - Filter injectables whose globs match the normalized path.
   * - Prefer fewer wildcards (more specific patterns).
   * - Break ties with longer literal globs.
   *
   * @param path path-like string to match against injectable globs
   * @returns the chosen wrapper fragment, if any
   */
  findInjectableForPath(path?: string): PartialContent<Locals> | undefined;

  /**
   * Debug helper: returns a snapshot of the internal injection index
   * used for glob ranking. Useful in tests and diagnostics.
   */
  debugIndex(): ReadonlyArray<{
    identity: string;
    pattern: string;
    wildcardScore: number;
    length: number;
  }>;
}

/**
 * Resolve the injection mode from `InjectionInit`.
 *
 * Precedence:
 * - If `init.mode` is provided, it wins.
 * - Else, if `prepend` and/or `append` set, map to `"prepend" | "append" | "both"`.
 * - Else default to `"prepend"`.
 */
function resolveInjectionMode(init: InjectionInit): InjectionMode {
  if (init.mode) return init.mode;
  const { prepend, append } = init;
  if (prepend && append) return "both";
  if (append) return "append";
  // default when neither is set: prepend
  return "prepend";
}

/**
 * Build an `InjectionConfig` from `InjectionInit`.
 *
 * Normalizes globs and computes the final `mode`.
 */
function buildInjectionConfig(init: InjectionInit): InjectionConfig {
  const globs = init.globs.map((g) => normalize(g));
  const mode = resolveInjectionMode(init);
  return { globs, mode };
}

/**
 * Create a `PartialContent<Locals>` instance from raw text and optional
 * initialization options.
 *
 * The resulting partial (content fragment) can:
 * - Validate `locals` against a Zod schema (`schema`) or a JSON spec (`schemaSpec`).
 * - Act as a *plain* fragment (no injection), or as an *injectable* wrapper
 *   when `inject` is provided.
 *
 * @template Locals shape of the locals object
 *
 * @param identity unique name for this fragment / partial
 * @param source raw text content of the fragment
 * @param init optional schema and injection configuration
 */
export function partialContent<
  Locals = Record<string, unknown>,
  Provenance = unknown,
>(
  identity: string,
  source: string,
  provenance: Provenance,
  init: PartialContentInit<Locals> = {},
): PartialContent<Locals, Provenance> {
  const { schema: providedSchema, schemaSpec, inject, strictArgs = true } =
    init;

  let schema: ZodType<Locals> | undefined = providedSchema;
  let normalizedSpec: Record<string, unknown> | undefined = schemaSpec;

  // If no explicit schema was given but we have a JSON spec, build one.
  if (!schema && schemaSpec && Object.keys(schemaSpec).length > 0) {
    try {
      const jsonSchema = JSON.stringify({
        type: "object",
        properties: schemaSpec,
        additionalProperties: true,
      });
      const built = jsonToZod(jsonSchema);
      schema = built as ZodType<Locals>;
      normalizedSpec = schemaSpec;
    } catch (error) {
      // If schema construction fails, we simply skip validation.
      schema = undefined;
      normalizedSpec = undefined;
      // Caller can decide whether to log this; we don’t throw here to keep DX smooth.
      console.warn(
        `partialContent('${identity}'): failed to build schema from schemaSpec`,
        error,
      );
    }
  }

  const injection = inject ? buildInjectionConfig(inject) : undefined;

  // Core render function: validate locals (if schema exists) and return source.
  const content: InjectContentFn<Locals> = (
    initialLocals,
    onError,
  ): PartialRenderResult<Locals> => {
    let locals = initialLocals;

    // Validation step (if schema exists)
    if (schema) {
      const parsed = schema.safeParse(locals);

      if (!parsed.success) {
        const message =
          `Invalid arguments passed to partial '${identity}': ${
            z.prettifyError(parsed.error)
          }` +
          (normalizedSpec
            ? `\nPartial '${identity}' expected arguments matching schemaSpec`
            : "");

        if (strictArgs) {
          // Strict mode: fail-closed
          const rendered = onError
            ? onError(message, source, parsed.error)
            : message;
          return {
            status: "invalid-args",
            content: rendered,
            interpolate: false,
            locals,
            error: parsed.error,
          };
        } else {
          // Non-strict mode: warn, but continue with original locals
          console.warn(
            `partialContent('${identity}'): non-strict mode, ignoring invalid locals`,
            parsed.error,
          );
        }
      } else {
        // Valid: use parsed data for downstream; ensures type-safe locals.
        locals = parsed.data;
      }
    }

    try {
      return {
        status: "ok",
        content: source,
        interpolate: true,
        locals,
      };
    } catch (error) {
      const message = `Partial '${identity}' failed to render`;
      const rendered = onError
        ? onError(message, source, error)
        : `${message}: ${String(error)}`;
      return {
        status: "render-error",
        content: rendered,
        interpolate: false,
        locals,
        error,
      };
    }
  };

  return {
    identity,
    source,
    schema,
    schemaSpec: normalizedSpec,
    content,
    injection,
    provenance,
  };
}

/**
 * Convenience helper: create a plain partial with type-safe locals but no
 * injection behavior or schema.
 *
 * @template Locals shape of the locals object
 */
export function createPlainPartial<
  Locals = Record<string, unknown>,
  Provenance = unknown,
>(
  identity: string,
  source: string,
  provenance: Provenance,
): PartialContent<Locals, Provenance> {
  return partialContent<Locals, Provenance>(identity, source, provenance);
}

/**
 * Convenience helper: create an injectable partial with type-safe locals.
 *
 * @template Locals shape of the locals object
 */
export function createInjectablePartial<
  Locals = Record<string, unknown>,
  Provenance = unknown,
>(
  identity: string,
  source: string,
  provenance: Provenance,
  inject: InjectionInit,
): PartialContent<Locals, Provenance> {
  return partialContent<Locals, Provenance>(identity, source, provenance, {
    inject,
  });
}

/**
 * Factory for a collection of typed content fragments / partials.
 *
 * The collection:
 * - Stores fragments by identity.
 * - Indexes *injectable* fragments by their glob patterns.
 * - Resolves the best wrapper / injector for a given path.
 * - Can compose a rendered fragment with its matching injectable
 *   wrapper via `compose`.
 * - Offers a high-level `renderWithInjection` helper that performs both
 *   inner render and wrapper application in one call.
 *
 * @template Locals shape of the locals used for rendering
 */
export function partialContentCollection<
  Locals = Record<string, unknown>,
>(): PartialCollection<
  Locals
> {
  const catalog = new Map<string, PartialContent<Locals>>();

  // ---------- Injectable indexing ----------
  type IndexEntry = {
    identity: string;
    re: RegExp;
    wildcardScore: number;
    length: number;
    pattern: string;
  };
  let index: IndexEntry[] = [];

  const wildcardCount = (g: string): number => {
    const starStar = (g.match(/\*\*/g) ?? []).length * 2;
    const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
    return starStar + singles;
  };

  const toRegex = (glob: string): RegExp => {
    if (!isGlob(glob)) {
      const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${exact}$`);
    }
    return globToRegExp(glob, {
      extended: true,
      globstar: true,
      caseInsensitive: false,
    });
  };

  const rebuildIndex = () => {
    const entries: IndexEntry[] = [];
    for (const codePartial of catalog.values()) {
      const inj = codePartial.injection;
      if (!inj) continue;
      for (const g of inj.globs) {
        const pattern = normalize(g);
        entries.push({
          identity: codePartial.identity,
          re: toRegex(pattern),
          wildcardScore: wildcardCount(pattern),
          length: pattern.length,
          pattern,
        });
      }
    }
    index = entries;
  };

  const findInjectableForPath = (
    path?: string,
  ): PartialContent<Locals> | undefined => {
    if (!path) return;
    const p = normalize(path);
    const hits = index
      .filter((c) => c.re.test(p))
      .sort(
        (a, b) =>
          (a.wildcardScore - b.wildcardScore) ||
          (b.length - a.length),
      );
    if (!hits.length) return;
    const chosenId = hits[0].identity;
    return catalog.get(chosenId);
  };
  // ----------------------------------------

  const register = (
    partial: PartialContent<Locals>,
    options?: RegisterOptions,
  ) => {
    const policy = options?.onDuplicate ?? "overwrite";
    const found = catalog.get(partial.identity);
    if (found) {
      if (policy === "throw") {
        throw new Deno.errors.AlreadyExists(
          `Partial '${partial.identity}' already exists in collection`,
        );
      }
      if (policy === "ignore") return;
      // default is overwrite
    }
    catalog.set(partial.identity, partial);
    rebuildIndex();
  };

  const compose = async (
    result: PartialRenderResult<Locals>,
    ctx?: {
      path?: string;
      onError?: InjectErrorHandler;
    },
  ): Promise<PartialRenderResult<Locals>> => {
    // If inner result is already an error, do not attempt wrapping.
    if (result.status !== "ok") return result;

    const wrapper = findInjectableForPath(ctx?.path);
    if (!wrapper?.injection) return result;

    // Render wrapper using same locals; fail closed if wrapper indicates invalid args.
    let wrapperResult: PartialRenderResult<Locals>;
    try {
      wrapperResult = await wrapper.content(result.locals, ctx?.onError);
    } catch (error) {
      const msg = `Injectable '${wrapper.identity}' failed to render`;
      const text = ctx?.onError
        ? ctx.onError(msg, result.content, error)
        : `${msg}: ${String(error)}`;
      return {
        status: "render-error",
        content: text,
        interpolate: false,
        locals: result.locals,
        error,
      };
    }

    if (wrapperResult.status !== "ok" || !wrapper.injection) {
      const msg = `Injectable '${wrapper.identity}' failed to render`;
      const text = ctx?.onError
        ? ctx.onError(msg, result.content, wrapperResult.error)
        : `${msg}: wrapper reported status '${wrapperResult.status}'`;
      return {
        status: "render-error",
        content: text,
        interpolate: false,
        locals: result.locals,
        error: wrapperResult.error,
      };
    }

    // Merge according to mode
    const { mode } = wrapper.injection;
    let merged = result.content;
    if (mode === "prepend" || mode === "both") {
      merged = `${wrapperResult.content}\n${merged}`;
    }
    if (mode === "append" || mode === "both") {
      merged = `${merged}\n${wrapperResult.content}`;
    }

    return {
      status: "ok",
      content: merged,
      interpolate: result.interpolate && wrapperResult.interpolate,
      locals: result.locals,
    };
  };

  const renderWithInjection = async (ctx: {
    identity: string;
    path?: string;
    locals: Locals;
    onError?: InjectErrorHandler;
  }): Promise<PartialRenderResult<Locals>> => {
    const base = catalog.get(ctx.identity);
    if (!base) {
      const message = `Partial '${ctx.identity}' not found`;
      const content = ctx.onError
        ? ctx.onError(message, "", undefined)
        : message;
      return {
        status: "render-error",
        content,
        interpolate: false,
        locals: ctx.locals,
      };
    }

    const inner = await base.content(ctx.locals, ctx.onError);
    return compose(inner, { path: ctx.path, onError: ctx.onError });
  };

  const debugIndex = (): ReadonlyArray<{
    identity: string;
    pattern: string;
    wildcardScore: number;
    length: number;
  }> =>
    index.map(({ identity, pattern, wildcardScore, length }) => ({
      identity,
      pattern,
      wildcardScore,
      length,
    }));

  return {
    catalog,
    register,
    get: (identity: string) => catalog.get(identity),
    compose,
    renderWithInjection,
    findInjectableForPath,
    debugIndex,
  };
}
