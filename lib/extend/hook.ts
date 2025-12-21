/**
 * @module hook
 *
 * Hook definition, implementation, and execution primitives for Spry extensions.
 *
 * This module provides a **runtime-safe, Zod-backed hook system** that allows:
 *
 * - Library authors to define hooks declaratively using Zod schemas
 * - Extension authors to implement hooks without generics or explicit typing
 * - Hosts to discover, validate, execute, and observe hook implementations
 *
 * Design goals:
 *
 * - Strong runtime guarantees (Zod validation, defensive wrappers)
 * - Zero decorator usage (pure functions + symbols)
 * - Reflection-friendly (safe scanning of unknown modules)
 * - Progressive capability injection (issues, event bus, AbortSignal)
 * - No dependency on any specific framework or AST system
 *
 * Core concepts:
 *
 * - `hookDefn(...)`
 *     Defines a hook contract (id, schema, issues, optional event bus).
 *
 * - `hook(...)` / `hook.async(...)`
 *     Wraps an implementation with:
 *       - Zod input/output validation
 *       - Defensive error capture
 *       - Non-enumerable HookImpl metadata
 *
 * - `HookDefn.collect(...)`
 *     Discovers hook implementations across modules or module specifiers,
 *     applies multi-module resolution policies, injects optional surfaces,
 *     and optionally executes implementations.
 *
 * - Issue handling
 *     Each hook definition owns an isolated `IssueSink` that records:
 *       - Validation failures
 *       - Execution errors
 *       - Surface mismatches
 *       - ZodError details when available
 *
 * - Event bus (optional)
 *     Hook definitions may opt into a typed EventTarget-based bus for
 *     structured, observable communication between host and implementations.
 *
 * This module intentionally avoids:
 * - Class inheritance
 * - Decorators
 * - Global registries
 * - Implicit side effects
 *
 * All behavior is explicit, inspectable, and testable.
 */
import * as z from "@zod/zod";

// deno-lint-ignore no-explicit-any
type Any = any;

export const HOOK_DEFN_META = Symbol.for("spry.ext.hookDefn.meta");
export const HOOK_IMPL_META = Symbol.for("spry.ext.hookImpl.meta");

export type HookId = string;

export type HookDefnMeta = Readonly<{
  kind: "hookDefn";
  id: HookId;
  name?: string;
}>;

export type HookImplMeta = Readonly<{
  kind: "hookImpl";
  id: HookId;
  name?: string;
}>;

/* -------------------------------------------------------------------------- */
/* Reflection helpers (for extension.ts and other scanners)                    */
/* -------------------------------------------------------------------------- */

/**
 * "Erased" hook defn/impl types for reflective consumers.
 * These avoid requiring generic parameters outside this module.
 */
export type AnyHookDefn = HookDefn<
  readonly z.ZodTypeAny[],
  z.ZodTypeAny,
  HookEventMap
>;

export type AnyHookImpl = HookImpl<
  readonly z.ZodTypeAny[],
  z.ZodTypeAny
>;

export function isHookDefn(v: unknown): v is AnyHookDefn {
  if (!v || typeof v !== "object") return false;
  const meta = (v as Record<symbol, unknown>)[HOOK_DEFN_META];
  return !!meta && typeof meta === "object" &&
    (meta as Any).kind === "hookDefn";
}

export function getHookDefnMeta(defn: AnyHookDefn): HookDefnMeta {
  // This property is guaranteed by HookDefn type; still, keep it defensive.
  const meta = (defn as unknown as Record<symbol, unknown>)[HOOK_DEFN_META];
  return meta as HookDefnMeta;
}

/**
 * True if `v` is a hook implementation created by hook()/hook.async().
 * extension.ts uses this to scan module exports.
 */
export function isHookImpl(v: unknown): v is AnyHookImpl {
  if (typeof v !== "function") return false;
  const meta = (v as unknown as Record<symbol, unknown>)[HOOK_IMPL_META];
  return !!meta && typeof meta === "object" &&
    (meta as Any).kind === "hookImpl";
}

/**
 * Extract hook implementation metadata (id/name).
 * extension.ts uses this to determine hookId and optional hookName.
 */
export function getHookImplMeta(fn: AnyHookImpl): HookImplMeta | undefined {
  const meta = (fn as unknown as Record<symbol, unknown>)[HOOK_IMPL_META];
  if (!meta || typeof meta !== "object") return undefined;
  if ((meta as Any).kind !== "hookImpl") return undefined;
  return meta as HookImplMeta;
}

/* -------------------------------------------------------------------------- */
/* Issues (strong TS + ZodError detail when available)                         */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = "info" | "warn" | "error";

export type ZodErrorDetail = Readonly<{
  name: "ZodError";
  message: string;
  issues: ReadonlyArray<
    Readonly<{
      path: ReadonlyArray<string | number>;
      message: string;
      code?: string;
    }>
  >;
}>;

export type HookIssue = Readonly<{
  ts: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  hookId?: HookId;
  hookName?: string;
  moduleSpecifier?: string;
  exportName?: string;
  detail?: unknown;
  cause?: unknown;
  zodError?: ZodErrorDetail;
}>;

export type IssueSink = Readonly<{
  list(): ReadonlyArray<HookIssue>;
  clear(): void;

  add(issue: Omit<HookIssue, "ts"> & Partial<Pick<HookIssue, "ts">>): HookIssue;

  info(
    code: string,
    message: string,
    fields?: Partial<Omit<HookIssue, "ts" | "severity" | "code" | "message">>,
  ): HookIssue;
  warn(
    code: string,
    message: string,
    fields?: Partial<Omit<HookIssue, "ts" | "severity" | "code" | "message">>,
  ): HookIssue;
  error(
    code: string,
    message: string,
    fields?: Partial<Omit<HookIssue, "ts" | "severity" | "code" | "message">>,
  ): HookIssue;
}>;

// Runtime surface schema (optional to use in your hook signatures)
export const IssueSinkSchema: z.ZodType<IssueSink> = z.object({
  list: z.function({ input: [], output: z.array(z.unknown()) }),
  clear: z.function({ input: [], output: z.void() }),
  add: z.function({ input: [z.unknown()], output: z.unknown() }),
  info: z.function({
    input: [z.string(), z.string(), z.unknown().optional()],
    output: z.unknown(),
  }),
  warn: z.function({
    input: [z.string(), z.string(), z.unknown().optional()],
    output: z.unknown(),
  }),
  error: z.function({
    input: [z.string(), z.string(), z.unknown().optional()],
    output: z.unknown(),
  }),
}) as Any;

function nowIso() {
  return new Date().toISOString();
}

function toErrorLike(e: unknown) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  const any = e as Any;
  if (any && typeof any === "object") {
    const message = typeof any.message === "string" ? any.message : String(e);
    const name = typeof any.name === "string" ? any.name : undefined;
    const stack = typeof any.stack === "string" ? any.stack : undefined;
    return { name, message, stack };
  }
  return { message: String(e) };
}

function extractZodErrorDetail(e: unknown): ZodErrorDetail | undefined {
  const ZodErrorCtor = (z as Any).ZodError;
  if (typeof ZodErrorCtor !== "function") return undefined;

  if (e instanceof ZodErrorCtor) {
    const any = e as Any;
    const issues = Array.isArray(any.issues) ? any.issues : [];
    return {
      name: "ZodError",
      message: typeof any.message === "string" ? any.message : "ZodError",
      issues: issues.map((it: Any) => ({
        path: Array.isArray(it.path) ? it.path : [],
        message: typeof it.message === "string"
          ? it.message
          : String(it.message ?? ""),
        code: typeof it.code === "string" ? it.code : undefined,
      })),
    };
  }
  return undefined;
}

function createIssueSink(
  seed?: Partial<Pick<HookIssue, "hookId" | "hookName">>,
): IssueSink {
  const store: HookIssue[] = [];

  const add: IssueSink["add"] = (issue) => {
    const zodError = extractZodErrorDetail(issue.cause) ??
      extractZodErrorDetail(issue.detail);
    const normalized: HookIssue = {
      ts: issue.ts ?? nowIso(),
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      hookId: issue.hookId ?? seed?.hookId,
      hookName: issue.hookName ?? seed?.hookName,
      moduleSpecifier: issue.moduleSpecifier,
      exportName: issue.exportName,
      detail: issue.detail,
      cause: issue.cause,
      zodError,
    };
    store.push(normalized);
    return normalized;
  };

  return Object.freeze({
    list: () => store.slice(),
    clear: () => {
      store.length = 0;
    },
    add,
    info: (code, message, fields) =>
      add({ severity: "info", code, message, ...(fields ?? {}) }),
    warn: (code, message, fields) =>
      add({ severity: "warn", code, message, ...(fields ?? {}) }),
    error: (code, message, fields) =>
      add({ severity: "error", code, message, ...(fields ?? {}) }),
  });
}

/* -------------------------------------------------------------------------- */
/* Optional Event Bus (EventTarget + CustomEvent + AbortSignal)                */
/* -------------------------------------------------------------------------- */

export type HookEventMap = Record<string, unknown>;

export type HookBus<E extends HookEventMap> = Readonly<{
  target: EventTarget;

  emit<K extends keyof E & string>(type: K, detail: E[K]): void;

  on<K extends keyof E & string>(
    type: K,
    handler: (detail: E[K], ev: CustomEvent<E[K]>) => void,
    opts?: Readonly<{ signal?: AbortSignal }>,
  ): () => void;

  once<K extends keyof E & string>(
    type: K,
    opts?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<E[K]>;
}>;

function createHookBus<E extends HookEventMap>(): HookBus<E> {
  const target = new EventTarget();

  const emit: HookBus<E>["emit"] = (type, detail) => {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  };

  const on: HookBus<E>["on"] = (type, handler, opts) => {
    const listener = (ev: Event) => {
      const ce = ev as CustomEvent<E[typeof type]>;
      handler(ce.detail, ce);
    };
    target.addEventListener(type, listener as EventListener, {
      signal: opts?.signal,
    });
    return () => {
      try {
        target.removeEventListener(type, listener as EventListener);
      } catch {
        // ignore
      }
    };
  };

  const once: HookBus<E>["once"] = (type, opts) =>
    new Promise<E[typeof type]>((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }

      const off = on(type, (detail) => {
        off();
        resolve(detail);
      });

      if (signal) {
        const abortListener = () => {
          try {
            off();
          } catch {
            // ignore
          }
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });

  return Object.freeze({ target, emit, on, once });
}

/* -------------------------------------------------------------------------- */
/* Compile-time typing from Zod schemas                                        */
/* -------------------------------------------------------------------------- */

type ArgsFromSchemas<I extends readonly z.ZodTypeAny[]> = {
  [K in keyof I]: z.infer<I[K]>;
};

type RetFromSchema<O extends z.ZodTypeAny> = z.infer<O>;

export type HookFn<I extends readonly z.ZodTypeAny[], O extends z.ZodTypeAny> =
  (
    ...args: ArgsFromSchemas<I>
  ) => RetFromSchema<O>;

export type HookFnAsync<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
> = (
  ...args: ArgsFromSchemas<I>
) => Promise<RetFromSchema<O>>;

/* -------------------------------------------------------------------------- */
/* HookDefn object (contains schema, doesn’t subtype ZodFunction)              */
/* -------------------------------------------------------------------------- */

export type HookDefn<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
  E extends HookEventMap,
> = Readonly<{
  readonly [HOOK_DEFN_META]: HookDefnMeta;

  readonly id: HookId;
  readonly name?: string;

  /** Underlying Zod function schema used for wrapping and runtime validation. */
  readonly schema: z.ZodFunction<Any, Any>;

  /** Per-hook issue store. */
  readonly issues: IssueSink;

  /** Optional per-hook event bus. */
  readonly bus?: HookBus<E>;

  findIn(
    modExports: Record<string, unknown>,
    opts?: Readonly<{
      moduleSpecifier?: string;
      exportNameFilter?: (exportName: string) => boolean;
      strictModuleDuplicates?: boolean;
    }>,
  ): ReadonlyArray<HookImpl<I, O>>;

  collect(
    modOrSpecifier:
      | Record<string, unknown>
      | string
      | URL
      | ReadonlyArray<Record<string, unknown> | string | URL>,
    opts?: Readonly<{
      moduleSpecifier?: string;
      exportNameFilter?: (exportName: string) => boolean;
      multiModulePolicy?: "allow" | "first-wins" | "last-wins" | "error";
      strict?: boolean;
      run?: Readonly<{
        args: unknown[];
        injectIssuesIntoFirstArg?: boolean;
        injectBusIntoFirstArg?: boolean;
        validateSurfaces?: boolean;
      }>;
    }>,
  ): Promise<
    Readonly<
      {
        implementations: ReadonlyArray<HookImpl<I, O>>;
        executed?: ReadonlyArray<Any>;
      }
    >
  >;
}>;

export type HookImpl<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
> = HookFn<I, O> & {
  readonly [HOOK_IMPL_META]: HookImplMeta;
  readonly __exportName__?: string;
  readonly __moduleSpecifier__?: string;
};

export function hookDefn<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
  E extends HookEventMap = HookEventMap,
>(
  id: HookId,
  def: Readonly<{ input: I; output: O }>,
  opts: Readonly<{ name?: string; bus?: boolean }> = {},
): HookDefn<I, O, E> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("hookDefn: id must be a non-empty string");
  }

  const issues = createIssueSink({ hookId: id, hookName: opts.name });
  const schema = z.function({
    input: [...def.input],
    output: def.output,
  }) as Any;

  const bus = opts.bus ? createHookBus<E>() : undefined;

  const meta: HookDefnMeta = { kind: "hookDefn", id, name: opts.name };

  const findIn: HookDefn<I, O, E>["findIn"] = (modExports, scanOpts) => {
    const moduleSpecifier = scanOpts?.moduleSpecifier;
    const filter = scanOpts?.exportNameFilter ?? (() => true);
    const strictDup = scanOpts?.strictModuleDuplicates ?? false;

    if (!modExports || typeof modExports !== "object") {
      issues.error(
        "HOOK_FIND_INVALID_EXPORTS",
        "findIn expected a module exports object",
        {
          moduleSpecifier,
          detail: { typeof: typeof modExports },
        },
      );
      return [];
    }

    const found: HookImpl<I, O>[] = [];
    let alreadyFound = false;

    for (const [exportName, value] of Object.entries(modExports)) {
      if (!filter(exportName)) continue;

      const im = (value as Any)?.[HOOK_IMPL_META] as HookImplMeta | undefined;
      if (!im || im.kind !== "hookImpl") continue;
      if (im.id !== id) continue;

      if (typeof value !== "function") {
        issues.error(
          "HOOK_IMPL_NOT_FUNCTION",
          "hook implementation export is not a function",
          {
            moduleSpecifier,
            exportName,
            detail: { exportType: typeof value },
          },
        );
        continue;
      }

      if (alreadyFound) {
        const msg =
          `duplicate implementations in one module for hook id "${id}" (export "${exportName}")`;
        issues.error("HOOK_DUPLICATE_IN_MODULE", msg, {
          moduleSpecifier,
          exportName,
        });
        if (strictDup) throw new Error(msg);
        continue;
      }

      alreadyFound = true;

      try {
        Object.defineProperty(value as Any, "__exportName__", {
          value: exportName,
        });
        Object.defineProperty(value as Any, "__moduleSpecifier__", {
          value: moduleSpecifier,
        });
      } catch {
        // ignore
      }

      found.push(value as HookImpl<I, O>);
    }

    return found;
  };

  const collect: HookDefn<I, O, E>["collect"] = async (
    modOrSpecifier,
    collectOpts,
  ) => {
    const strict = collectOpts?.strict ?? false;
    const multiPolicy = collectOpts?.multiModulePolicy ?? "allow";

    const sources = Array.isArray(modOrSpecifier)
      ? modOrSpecifier
      : [modOrSpecifier];
    const allFound: HookImpl<I, O>[] = [];

    for (const src of sources) {
      try {
        if (typeof src === "string" || src instanceof URL) {
          const spec = String(src);
          const mod = (await import(spec)) as Record<string, unknown>;
          allFound.push(
            ...findIn(mod, {
              moduleSpecifier: spec,
              exportNameFilter: collectOpts?.exportNameFilter,
            }),
          );
        } else {
          allFound.push(
            ...findIn(src, {
              moduleSpecifier: collectOpts?.moduleSpecifier,
              exportNameFilter: collectOpts?.exportNameFilter,
            }),
          );
        }
      } catch (e) {
        issues.error(
          "HOOK_IMPORT_OR_SCAN_FAILED",
          "failed to import/scan module for hook implementations",
          {
            moduleSpecifier: typeof src === "string" || src instanceof URL
              ? String(src)
              : collectOpts?.moduleSpecifier,
            cause: toErrorLike(e),
            zodError: extractZodErrorDetail(e),
          },
        );
        if (strict) throw e;
      }
    }

    let implementations: HookImpl<I, O>[] = [];

    if (allFound.length <= 1) {
      implementations = allFound;
    } else {
      const detail = allFound.map((f) => ({
        exportName: (f as Any).__exportName__,
        moduleSpecifier: (f as Any).__moduleSpecifier__,
      }));
      const msg =
        `multiple implementations found for hook id "${id}" (${allFound.length})`;

      if (multiPolicy === "allow") {
        issues.warn("HOOK_MULTI_IMPL_ALLOW", msg, { detail });
        implementations = allFound;
      } else if (multiPolicy === "first-wins") {
        issues.warn("HOOK_MULTI_IMPL_FIRST_WINS", msg, { detail });
        implementations = [allFound[0]];
      } else if (multiPolicy === "last-wins") {
        issues.warn("HOOK_MULTI_IMPL_LAST_WINS", msg, { detail });
        implementations = [allFound[allFound.length - 1]];
      } else {
        issues.error("HOOK_MULTI_IMPL_ERROR", msg, { detail });
        implementations = [];
        if (strict) throw new Error(msg);
      }
    }

    if (!collectOpts?.run) return { implementations } as const;

    const injectIssuesIntoFirstArg = collectOpts.run.injectIssuesIntoFirstArg ??
      true;
    const injectBusIntoFirstArg = collectOpts.run.injectBusIntoFirstArg ?? true;
    const validateSurfaces = collectOpts.run.validateSurfaces ?? true;
    const originalArgs = collectOpts.run.args ?? [];

    const executed = await Promise.all(
      implementations.map(async (fn) => {
        const moduleSpecifier = (fn as Any).__moduleSpecifier__ as
          | string
          | undefined;
        const exportName = (fn as Any).__exportName__ as string | undefined;

        let args = originalArgs;

        if (
          originalArgs.length > 0 && originalArgs[0] &&
          typeof originalArgs[0] === "object"
        ) {
          const first = originalArgs[0] as Any;
          let nextFirst = first;
          let mutated = false;

          if (injectIssuesIntoFirstArg) {
            if ("issues" in first) {
              if (validateSurfaces) {
                try {
                  IssueSinkSchema.parse(first.issues);
                } catch (e) {
                  issues.warn(
                    "ISSUES_SURFACE_INVALID",
                    "firstArg.issues invalid; overwriting with defn.issues",
                    {
                      moduleSpecifier,
                      exportName,
                      cause: toErrorLike(e),
                      zodError: extractZodErrorDetail(e),
                    },
                  );
                  nextFirst = { ...nextFirst, issues };
                  mutated = true;
                }
              }
            } else {
              nextFirst = { ...nextFirst, issues };
              mutated = true;
            }
          }

          if (injectBusIntoFirstArg && bus) {
            if (!("bus" in first)) {
              nextFirst = { ...nextFirst, bus };
              mutated = true;
            }
          }

          if (mutated) args = [nextFirst, ...originalArgs.slice(1)];
        }

        try {
          const r = (fn as Any)(...args);
          const value = r instanceof Promise ? await r : r;
          return {
            moduleSpecifier,
            exportName,
            status: "fulfilled" as const,
            value,
          };
        } catch (e) {
          issues.error(
            "HOOK_EXEC_FAILED",
            "hook implementation execution failed",
            {
              moduleSpecifier,
              exportName,
              cause: toErrorLike(e),
              zodError: extractZodErrorDetail(e),
            },
          );
          return {
            moduleSpecifier,
            exportName,
            status: "rejected" as const,
            reason: toErrorLike(e),
          };
        }
      }),
    );

    if (strict) {
      const failures = executed.filter((x) => x.status === "rejected");
      if (failures.length) {
        throw new Error(
          `hook "${id}" execution had ${failures.length} failure(s); see defn.issues for details`,
        );
      }
    }

    return { implementations, executed } as const;
  };

  const defn = Object.freeze({
    [HOOK_DEFN_META]: meta,
    id,
    name: opts.name,
    schema,
    issues,
    bus,
    findIn,
    collect,
  }) as HookDefn<I, O, E>;

  return defn;
}

/* -------------------------------------------------------------------------- */
/* hook(defn, impl): runtime validation + defensive issue recording             */
/* -------------------------------------------------------------------------- */

export function hook<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
  E extends HookEventMap,
>(
  defn: HookDefn<I, O, E>,
  impl: HookFn<I, O>,
  opts: Readonly<{ name?: string }> = {},
): HookImpl<I, O> {
  const meta = defn[HOOK_DEFN_META];
  const issues = defn.issues;

  // Defensive wrapper: always record and rethrow
  const guarded = ((...args: Any[]) => {
    try {
      return (impl as Any)(...args);
    } catch (e) {
      issues.error("HOOK_IMPL_THROW", "hook implementation threw", {
        exportName: opts.name ?? meta.name,
        cause: toErrorLike(e),
        zodError: extractZodErrorDetail(e),
      });
      throw e;
    }
  }) as Any;

  let wrapped: Any;
  try {
    wrapped = (defn.schema as Any).implement(guarded);
  } catch (e) {
    issues.error(
      "HOOK_WRAP_FAILED",
      "failed to wrap hook implementation with zod",
      {
        exportName: opts.name ?? meta.name,
        cause: toErrorLike(e),
        zodError: extractZodErrorDetail(e),
      },
    );
    throw e;
  }

  Object.defineProperty(wrapped, HOOK_IMPL_META, {
    value: {
      kind: "hookImpl",
      id: meta.id,
      name: opts.name ?? meta.name,
    } satisfies HookImplMeta,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrapped as HookImpl<I, O>;
}

hook.async = function hookAsync<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
  E extends HookEventMap,
>(
  defn: HookDefn<I, O, E>,
  impl: HookFnAsync<I, O>,
  opts: Readonly<{ name?: string }> = {},
): HookImpl<I, O> {
  const meta = defn[HOOK_DEFN_META];
  const issues = defn.issues;

  const guarded = (async (...args: Any[]) => {
    try {
      return await (impl as Any)(...args);
    } catch (e) {
      issues.error(
        "HOOK_IMPL_ASYNC_THROW",
        "async hook implementation rejected/threw",
        {
          exportName: opts.name ?? meta.name,
          cause: toErrorLike(e),
          zodError: extractZodErrorDetail(e),
        },
      );
      throw e;
    }
  }) as Any;

  let wrapped: Any;
  try {
    wrapped = (defn.schema as Any).implementAsync(guarded);
  } catch (e) {
    issues.error(
      "HOOK_WRAP_ASYNC_FAILED",
      "failed to wrap async hook implementation with zod",
      {
        exportName: opts.name ?? meta.name,
        cause: toErrorLike(e),
        zodError: extractZodErrorDetail(e),
      },
    );
    throw e;
  }

  Object.defineProperty(wrapped, HOOK_IMPL_META, {
    value: {
      kind: "hookImpl",
      id: meta.id,
      name: opts.name ?? meta.name,
    } satisfies HookImplMeta,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrapped as HookImpl<I, O>;
};
